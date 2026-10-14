/**
 * 查一个会话的 cwd 与实际跑过的工具调用。
 *
 * 为什么需要它：作者说"新工作区是空的"，而 workspace.json 里登记的路径是
 * `D:\leaning Harness test`（少一个 r，不存在）。要判断问题出在哪，
 * 必须知道三件事，且必须从**会话日志**里取（那才是事实源）：
 *   1. 会话 header 上的 cwd 是什么；
 *   2. 那个 cwd 目录里有没有产物；
 *   3. 会话里到底调用过哪些工具（尤其 index_learning_resources 有没有真跑）。
 *
 * 用法：node scripts/inspect-session-cwd.mjs <会话 id 前缀>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
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
 * 逐帧解压。
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

  console.log(`会话 ${id}`)
  console.log(`  工作区分组目录 : ${file.replace(`${SESSIONS}\\`, '').split('\\')[0]}`)
  console.log(`  header.cwd     : ${header.cwd ?? '(未记录)'}`)
  console.log(`  该 cwd 存在吗   : ${header.cwd !== undefined && existsSync(header.cwd) ? '是' : '否'}`)
  console.log(`  事件总数       : ${events.length}`)

  // 工具调用
  const calls = events.filter((e) => e.type === 'tool/call')
  console.log(`  工具调用 ${calls.length} 次:`)
  const byName = {}
  for (const c of calls) byName[c.data?.name] = (byName[c.data?.name] ?? 0) + 1
  for (const [n, k] of Object.entries(byName).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(k).padStart(3)}  ${n}`)
  }

  // 索引工具的结果
  const indexCalls = calls.filter((c) => c.data?.name === 'index_learning_resources')
  for (const c of indexCalls) {
    console.log(`\n  index_learning_resources 调用（seq ${c.seq}）:`)
    console.log(`    参数: ${String(c.data?.arguments).slice(0, 200)}`)
    // 找它后的第一个 tool/result
    const result = events.find((e) => e.type === 'tool/result' && e.seq > c.seq)
    if (result !== undefined) {
      const text = JSON.stringify(result.data?.message?.content ?? '').slice(0, 500)
      console.log(`    结果: ${text}`)
    }
  }
  console.log()
}
