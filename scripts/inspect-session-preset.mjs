/**
 * 查一个会话实际跑在哪个 preset 上。
 *
 * 为什么要这么查：宿主的会话 header 里 `agentPreset` 是【创建时的事实】，会被深冻结；
 * 而一个空白会话可以在创建后切换 preset，切换会写入 `agent-preset/selected` 事件。
 * 读取方必须取"最后一个 agent-preset/selected，没有则退回 header"
 * （宿主的 resolveSessionPreset 就是这个逻辑）。
 *
 * 如果我的记录器只读 header，就会把"用户选了 LH 但会话是从别的 preset 创建的"
 * 误判成非学习会话——这正是本次要验证的假设。
 *
 * 用法：node scripts/inspect-session-preset.mjs [会话 id 前缀]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = 'C:\\Users\\Administrator\\.dsh\\sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const filter = process.argv[2]

/**
 * 递归找出所有会话日志。
 * @param dir - 起始目录。
 * @returns 文件路径数组。
 */
function findLogs(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findLogs(full))
    else if (entry.name.startsWith('session.jsonl')) out.push(full)
  }
  return out
}

/**
 * 逐帧解压拼接的 zstd 缓冲。
 * @param buf - 文件内容。
 * @returns 解压文本。
 */
function decode(buf) {
  const parts = []
  let pos = 0
  while (pos < buf.length) {
    const next = buf.indexOf(MAGIC, pos + MAGIC.length)
    const end = next === -1 ? buf.length : next
    try {
      parts.push(zstdDecompressSync(buf.subarray(pos, end)).toString('utf8'))
    } catch {
      break
    }
    pos = end
  }
  return parts.join('')
}

for (const file of findLogs(SESSIONS)) {
  const text = decode(readFileSync(file))
  const events = text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const header = events.find((e) => e.type === 'session')
  if (header === undefined) continue
  const id = String(header.id)
  if (filter !== undefined && !id.includes(filter)) continue

  // 宿主的解析逻辑：最后一个 agent-preset/selected 胜出，否则退回 header
  const selections = events.filter((e) => e.type === 'agent-preset/selected')
  const effective =
    selections.length > 0 ? selections[selections.length - 1].data?.agentPreset : header.agentPreset

  console.log(`会话 ${id}`)
  console.log(`  header.agentPreset        = ${header.agentPreset ?? '(无)'}      ← 创建时的事实（冻结）`)
  console.log(`  agent-preset/selected 次数 = ${selections.length}`)
  for (const s of selections) console.log(`      选择为 ${s.data?.agentPreset}  (seq ${s.seq})`)
  console.log(`  ▶ 实际跑的 preset          = ${effective ?? '(无)'}`)
  console.log(`  事件总数 ${events.length}`)
  console.log()
}
