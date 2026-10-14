/**
 * lh-trace-reader —— LH 的坐标取回器。
 *
 * ═══ 它做什么 ═══
 * 把坐标 `(sessionId, seq)` 还原成宿主的**原始事件**。
 * 这是"只记坐标、不抄内容"（docs/archive/decisions/014）能成立的**唯一前提**——
 * 取不回原文，坐标就是没用的一串数字，记录器白写。
 *
 * ═══ 它解决的三个具体问题 ═══
 *
 * 1. **文件位置**：会话日志在 `$DSH_HOME/sessions/<工作区分组>/<会话 id>/session.jsonl.zstd`。
 *    目录是两层的，且分组名由工作区路径转义而来——所以按**会话 id 递归查找**，
 *    不去猜路径。
 *
 * 2. **物理格式**：日志是**多个 zstd 帧顺序拼接**（实测一个 4.7MB 文件里有 14,143 个
 *    `28 b5 2f fd` 魔数）。Node 的 `zstdDecompressSync` **只解第一帧**——
 *    对整个文件调用它会得到"解压后只有 177 字节"的假象。必须逐帧解。
 *
 * 3. **寻址**：`seq` **不是行号**（实测下标 24 处的事件 seq 是 40），所以必须建
 *    `seq → 行号` 的索引。好在实测确认了两件事：**带 seq 的行中 seq 无重复**，
 *    且**所有语义事件都带 seq**——因此 seq 可以当唯一坐标用。
 *
 * ═══ 为什么不做增量索引 ═══
 * 构建索引要整解压一次。实测 4.7MB / 14,143 帧耗时约 250ms，可以接受。
 * 但**没有做文件增长后的增量更新**——若取回期间宿主追加了事件，新事件不在索引里。
 * 这是已知限制：取回的是"截至读取时刻的日志"，对追溯用途足够。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 宿主会话日志的根目录。
 * 优先用环境变量 `DSH_HOME`，否则退回当前用户的 `.dsh`。
 */
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

/**
 * 逐帧解压拼接了多个 zstd 帧的缓冲。
 *
 * @param buffer - 文件内容。
 * @returns 解压后的文本；遇到解不开的帧就停在那里（宁可少读，也不拼出错误内容）。
 */
function decodeFramed(buffer) {
  const parts = []
  let pos = 0
  while (pos < buffer.length) {
    const next = buffer.indexOf(MAGIC, pos + MAGIC.length)
    const end = next === -1 ? buffer.length : next
    try {
      parts.push(zstdDecompressSync(buffer.subarray(pos, end)).toString('utf8'))
    } catch {
      break
    }
    pos = end
  }
  return parts.join('')
}

/**
 * 按会话 id 递归查找它的日志文件。
 *
 * 为什么递归找而不是拼路径：目录是两层的，且工作区分组名由 cwd 转义而来
 * （如 `--D-LearningHarnessv0.1--`），拼路径会把转义规则写死。
 *
 * @param sessionId - 会话 id。
 * @param dir - 起始目录。
 * @returns 文件绝对路径，找不到则 undefined。
 */
export function findSessionLog(sessionId, dir = SESSIONS_ROOT) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // 先看这一层是不是目标会话目录
      if (entry.name === sessionId) {
        const candidate = join(full, 'session.jsonl.zstd')
        try {
          readFileSync(candidate)
          return candidate
        } catch {
          /* 继续找 */
        }
      }
      const found = findSessionLog(sessionId, full)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * 一个会话的只读取回器。
 *
 * 构造时整解压一次并建索引；之后按 seq 取回是数组下标访问。
 */
export class TraceReader {
  /**
   * @param file - 会话日志文件路径。
   */
  constructor(file) {
    this.file = file
    const text = decodeFramed(readFileSync(file))

    /** 全部行（原文，未解析），下标即行号。 */
    this.lines = text.split('\n').filter((l) => l.trim() !== '')

    /** seq → 行号。 */
    this.bySeq = new Map()
    /** 解析后的 header（无 seq 的那一行）。 */
    this.header = undefined

    for (let i = 0; i < this.lines.length; i += 1) {
      let event
      try {
        event = JSON.parse(this.lines[i])
      } catch {
        continue
      }
      if (typeof event.seq === 'number') {
        // 实测 seq 无重复；若真遇到重复，保留先出现的那个并留痕，
        // 而不是静默覆盖——静默覆盖会让坐标指向错误的事件。
        if (!this.bySeq.has(event.seq)) this.bySeq.set(event.seq, i)
        else this.duplicateSeq = event.seq
      } else if (event.type === 'session') {
        this.header = event
      }
    }
  }

  /**
   * 按会话 id 打开一个取回器。
   *
   * @param sessionId - 会话 id。
   * @returns 取回器实例。
   * @throws 找不到该会话的日志时。
   */
  static open(sessionId) {
    const file = findSessionLog(sessionId)
    if (file === undefined) {
      throw new Error(`TraceReader: 找不到会话 ${sessionId} 的日志（在 ${SESSIONS_ROOT} 下递归查找）`)
    }
    return new TraceReader(file)
  }

  /**
   * 按 seq 取回一条事件。
   *
   * @param seq - 坐标里的序号。
   * @returns 事件对象，不存在则 undefined。
   */
  eventAt(seq) {
    const index = this.bySeq.get(seq)
    if (index === undefined) return undefined
    try {
      return JSON.parse(this.lines[index])
    } catch {
      return undefined
    }
  }

  /**
   * 批量取回一批 seq，按 seq 升序返回。
   *
   * @param seqs - 序号数组。
   * @returns 找到的事件数组（找不到的会被跳过）。
   */
  eventsAt(seqs) {
    const out = []
    for (const seq of [...seqs].sort((a, b) => a - b)) {
      const event = this.eventAt(seq)
      if (event !== undefined) out.push(event)
    }
    return out
  }

  /**
   * 取一段连续的 seq 区间（两端含）。
   *
   * @param from - 起始 seq。
   * @param to - 结束 seq。
   * @returns 找到的事件数组，按 seq 升序。
   */
  range(from, to) {
    const out = []
    for (const [seq] of [...this.bySeq].sort((a, b) => a[0] - b[0])) {
      if (seq < from) continue
      if (seq > to) break
      const event = this.eventAt(seq)
      if (event !== undefined) out.push(event)
    }
    return out
  }

  /**
   * 把一条事件渲染成给人看的文本。
   *
   * 为什么需要它：取回器会最先被用在"人或模型要读那段对话"的场景，
   * 而原始事件对象带着大量壳信息（信封、chunk、usage）。
   *
   * @param event - 宿主事件。
   * @returns 一行可读文本。
   */
  static render(event) {
    if (event === undefined) return '(事件不存在)'
    const seq = event.seq

    if (event.type === 'user/message') {
      const source = event.data?.source
      const kind = source?.kind ?? 'unknown'
      const who = kind === 'user' ? '学习者' : `注入(${source?.plugin ?? kind})`
      return `[seq ${seq}] ${who}：${textOf(event.data?.content)}`
    }

    if (event.type === 'assistant/message') {
      const source = event.data?.message?.source
      const model = source?.kind === 'model' ? `${source.model}` : '未知模型'
      return `[seq ${seq}] 助手(${model})：${textOf(event.data?.message?.content)}`
    }

    if (event.type === 'tool/call') {
      return `[seq ${seq}] 调用工具 ${event.data?.name}：${String(event.data?.arguments ?? '').slice(0, 120)}`
    }

    if (event.type === 'tool/result') {
      return `[seq ${seq}] 工具结果：${textOf(event.data?.message?.content)}`
    }

    return `[seq ${seq}] ${event.type}`
  }
}

/**
 * 从消息 content 里抽出纯文本。
 *
 * 消息的 content 是块数组（text / reasoning / tool_use 等），这里只拼文本块，
 * 因为取回器的用途是"给人看那段对话"，不是完整还原消息结构。
 *
 * @param content - 消息 content 字段。
 * @returns 拼接后的文本（已截断到合理长度）。
 */
function textOf(content) {
  if (typeof content === 'string') return content.slice(0, 400)
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'reasoning') parts.push('（思考过程）')
    else if (block?.type === 'tool_use') parts.push(`（调用工具 ${block.name}）`)
  }
  const joined = parts.join(' ')
  return joined.length > 400 ? `${joined.slice(0, 400)}…` : joined
}
