/**
 * 逐帧解压宿主会话日志。
 *
 * 背景：会话日志是**多个 zstd 帧顺序拼接**（文件里到处是 28 b5 2f fd 魔数），
 * 而 Node 的 zstdDecompressSync 只解第一帧——所以对整个文件调用它，
 * 会得到"解压后只有 177 字节"的假象（实际是 4.8MB）。
 * 正确做法是逐帧解，并把结果拼起来。
 *
 * 这个能力是「LH 记索引而不是抄内容」路线的前提：
 * 如果宿主的日志不能被独立读取，LH 就只能抄一份。
 *
 * 用法：node scripts/decode-host-session-log.mjs [日志路径]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = 'C:\\Users\\Administrator\\.dsh\\sessions'
/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 递归找出所有会话日志。
 * @param dir - 起始目录。
 * @returns 每个日志的路径与大小。
 */
function findLogs(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findLogs(full))
    else if (entry.name.startsWith('session.jsonl')) out.push({ file: full, size: statSync(full).size })
  }
  return out
}

/**
 * 逐帧解压一个拼接了多个 zstd 帧的缓冲。
 *
 * 做法：从当前位置向后找下一个魔数，把两段之间视为一个完整帧交给 zstd 解。
 * 最后一帧解到缓冲末尾。
 *
 * @param buf - 文件内容。
 * @returns 拼起来的解压文本。
 */
function decodeFramed(buffer) {
  const parts = []
  let pos = 0
  let frames = 0

  while (pos < buffer.length) {
    const next = buffer.indexOf(MAGIC, pos + MAGIC.length)
    const end = next === -1 ? buffer.length : next
    const frame = buffer.subarray(pos, end)
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'))
      frames += 1
    } catch (error) {
      // 单独一帧解不开就停下：宁可少读，也不要拼出错误的内容。
      return { text: parts.join(''), frames, failedAt: pos, error: error.message }
    }
    pos = end
  }

  return { text: parts.join(''), frames }
}

const logs = findLogs(SESSIONS).sort((a, b) => b.size - a.size)
const target = process.argv[2] === undefined ? logs[0] : { file: process.argv[2], size: 0 }

const raw = readFileSync(target.file)
const started = Date.now()
const { text, frames, failedAt, error } = decodeFramed(raw)
const elapsed = Date.now() - started

console.log(`文件: ${target.file.replace(`${SESSIONS}\\`, '')}`)
console.log(`压缩后: ${raw.length.toLocaleString()} 字节`)
console.log(`zstd 帧数: ${frames.toLocaleString()}`)
console.log(`解压后: ${text.length.toLocaleString()} 字节`)
console.log(`压缩比: ${(text.length / raw.length).toFixed(1)} : 1`)
console.log(`耗时: ${elapsed} ms`)
if (failedAt !== undefined) console.log(`⚠ 在第 ${failedAt} 字节处解帧失败: ${error}`)

const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`\n事件数: ${lines.length.toLocaleString()}`)

// 寻址所需字段：seq 必须稳定且连续，LH 的指针才靠得住
const events = []
let parseFailed = 0
for (const line of lines) {
  try {
    events.push(JSON.parse(line))
  } catch {
    parseFailed += 1
  }
}
console.log(`可解析: ${events.length.toLocaleString()}   解析失败: ${parseFailed}`)

const seqs = events.map((e) => e.seq).filter((s) => typeof s === 'number')
if (seqs.length > 0) {
  let contiguous = true
  for (let i = 1; i < seqs.length; i += 1) {
    if (seqs[i] !== seqs[i - 1] + 1) {
      contiguous = false
      break
    }
  }
  console.log(`带 seq: ${seqs.length}   范围: ${seqs[0]}..${seqs[seqs.length - 1]}   连续: ${contiguous ? '是' : '否'}`)
}

console.log(`\n事件类型分布（前 10）:`)
const counts = {}
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
for (const [type, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(7)}  ${type}`)
}

console.log(`\n单条平均: ${Math.round(text.length / Math.max(1, lines.length))} 字节`)
