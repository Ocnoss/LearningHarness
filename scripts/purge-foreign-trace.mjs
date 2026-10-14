/**
 * 清除 LH 日志里的开发会话污染。
 *
 * 背景：坐标记录器第一版用 `global: true` 订阅整棵树的事件，而 preset 在进程内
 * 长期驻留、反复挂载，于是把**所有会话**都记进了 LH 日志——包括作者与 AI 的开发对话。
 * 修复后新增的记录已经只含学习会话，但**修复前写入的那些还在文件里**。
 *
 * 判据：`lh/trace/observed` 的 `session_ref` 对应的会话，其 preset 不是 `lh`。
 * 做法：逐帧解压宿主的会话 header 拿到 preset 映射，再据此过滤 LH 日志。
 *
 * 为什么用 Node 而不是 PowerShell：PS5 的 `-Encoding UTF8` 会写 BOM，
 * 而 BOM 会让 JSON 解析失败、进而让 preset 挂载失败（踩过一次）。
 *
 * 用法：
 *   node scripts/purge-foreign-trace.mjs          # 只报告，不改文件
 *   node scripts/purge-foreign-trace.mjs --write  # 实际执行（自动备份）
 */
import { readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const LH_LOG = 'D:\\LearningHarnessv0.1\\data\\events.jsonl'
const SESSIONS = 'C:\\Users\\Administrator\\.dsh\\sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const WRITE = process.argv.includes('--write')

/**
 * 只解第一帧即可拿到会话 header。
 * @param file - 日志文件路径。
 * @returns header 对象，取不到则 undefined。
 */
function readHeader(file) {
  const buf = readFileSync(file)
  const next = buf.indexOf(MAGIC, MAGIC.length)
  const end = next === -1 ? buf.length : next
  try {
    const text = zstdDecompressSync(buf.subarray(0, end)).toString('utf8')
    const first = text.split('\n').find((l) => l.trim() !== '')
    return first === undefined ? undefined : JSON.parse(first)
  } catch {
    return undefined
  }
}

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

// 会话 id → preset
const presetOf = new Map()
for (const file of findLogs(SESSIONS)) {
  const header = readHeader(file)
  if (header?.id !== undefined) presetOf.set(String(header.id), header.agentPreset ?? '(未记录)')
}

let text = readFileSync(LH_LOG, 'utf8')
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
const lines = text.split('\n').filter((l) => l.trim() !== '')

/** 保留的行与丢弃的行的理由统计。 */
const keep = []
const dropped = {}
let droppedCount = 0

for (const line of lines) {
  const event = JSON.parse(line)
  if (event.type !== 'lh/trace/observed') {
    keep.push(line)
    continue
  }
  const preset = presetOf.get(String(event.session_ref))
  if (preset === 'lh') {
    keep.push(line)
    continue
  }
  droppedCount += 1
  const key = `${preset ?? '(会话已不存在)'} ← ${String(event.session_ref).slice(0, 24)}`
  dropped[key] = (dropped[key] ?? 0) + 1
}

console.log(`日志共 ${lines.length} 条`)
console.log(`  保留 ${keep.length} 条`)
console.log(`  丢弃 ${droppedCount} 条（非学习会话的 trace）`)
for (const [key, n] of Object.entries(dropped).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(4)} 条   ${key}`)
}

if (!WRITE) {
  console.log('\n（未写入。加 --write 执行）')
  process.exit(0)
}

const backup = `${LH_LOG}.bak-${Date.now()}`
copyFileSync(LH_LOG, backup)
writeFileSync(LH_LOG, keep.length === 0 ? '' : `${keep.join('\n')}\n`, 'utf8')
console.log(`\n已写入。备份：${backup}`)
console.log(`剩余 ${keep.length} 条`)
