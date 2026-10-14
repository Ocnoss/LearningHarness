/**
 * 检查宿主会话日志的可读性 —— 「记索引而不是抄内容」这条路线的可行性验证。
 *
 * 要回答的问题：
 *   1. 会话日志能否独立解压读取（不启动 dsh）？
 *   2. 里面的 seq 是否稳定可寻址（LH 的指针要靠它）？
 *   3. 压缩比是多少（决定"宿主的日志到底占多大"）？
 *
 * 用法：node scripts/inspect-host-session-log.mjs [会话目录名]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = 'C:\\Users\\Administrator\\.dsh\\sessions'

/**
 * 递归找出所有会话日志。
 *
 * 注意目录是两层的：sessions/<工作区分组>/<会话 id>/session.jsonl.zstd。
 * 所以不能只看第一层。
 *
 * @param dir - 起始目录。
 * @returns 每个日志的路径与压缩后大小。
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

const logs = findLogs(SESSIONS).sort((a, b) => b.size - a.size)
if (logs.length === 0) {
  console.error(`没有在 ${SESSIONS} 下找到任何会话日志`)
  process.exit(1)
}

const target = process.argv[2] === undefined ? logs[0] : { file: process.argv[2], size: 0 }
if (target === undefined) {
  console.error('没有找到任何会话日志')
  process.exit(1)
}

const raw = readFileSync(target.file)
const text = zstdDecompressSync(raw).toString('utf8')
const lines = text.split('\n').filter((l) => l.trim() !== '')

console.log(`文件: ${target.file.replace(`${SESSIONS}\\`, '')}`)
console.log(`压缩后: ${raw.length.toLocaleString()} 字节`)
console.log(`解压后: ${text.length.toLocaleString()} 字节`)
console.log(`压缩比: ${(text.length / raw.length).toFixed(1)} : 1`)
console.log(`事件数: ${lines.length.toLocaleString()}`)
console.log(`平均每条事件: ${Math.round(text.length / lines.length)} 字节`)

console.log(`\n=== 全部 ${logs.length} 个会话的压缩体积 ===`)
const totalCompressed = logs.reduce((s, l) => s + l.size, 0)
console.log(`  合计: ${(totalCompressed / 1024 / 1024).toFixed(2)} MB`)
console.log(`  最大: ${(logs[0].size / 1024).toFixed(0)} KB`)
console.log(`  中位: ${(logs[Math.floor(logs.length / 2)].size / 1024).toFixed(0)} KB`)

// 解析每条事件，检查寻址所需的字段
const events = lines.map((l) => JSON.parse(l))
const withSeq = events.filter((e) => typeof e.seq === 'number').length
const seqs = events.map((e) => e.seq).filter((s) => typeof s === 'number')

console.log(`\n带 seq 的事件: ${withSeq} / ${events.length}`)
if (seqs.length > 0) {
  let contiguous = true
  for (let i = 1; i < seqs.length; i += 1) {
    if (seqs[i] !== seqs[i - 1] + 1) {
      contiguous = false
      break
    }
  }
  console.log(`seq 连续（0..${seqs[seqs.length - 1]}）: ${contiguous ? '是' : '否'}`)
}

console.log(`\n事件类型分布（前 12）:`)
const counts = {}
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
for (const [type, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(6)}  ${type}`)
}

console.log(`\n头两条事件（看结构）:`)
for (const e of events.slice(0, 2)) {
  console.log(`  ${JSON.stringify(e).slice(0, 220)}`)
}
