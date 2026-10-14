/**
 * 量一量 LH 事件日志的**体积结构**，并把"再加一个字段/事件"的边际成本**实测**出来。
 *
 * ═══ 为什么要有这个量具 ═══
 * "这样会不会浪费存储"是一个每次加字段都会重新冒出来的问题。它必须能被**测量**回答，
 * 而不是被"应该没事"回答——本项目已经有过一次教训：ADR-014 的"单学者一年约 58 MB"
 * 是**实测**出来的，不是估出来的；而估出来的数字一旦被当成事实，
 * 就会同时误导存储决策与"要不要省着记"的取舍。
 *
 * 它测三件事：
 *   ① 日志的真实体积：总字节、行数、平均每行、时间跨度、字节/天、**gzip 后**的真实大小
 *      （压缩率直接算，不引用经验值）；
 *   ② 谁在占地方：按事件族/类型排行（条数、字节、占比）；
 *   ③ **边际成本**：把三个候选方案各造一条真事件，量它的字节数——
 *      · 新动词（如 `lh/schedule/hidden`）；
 *      · 复用 `updated` 打一个布尔补丁（`{ hidden: true }`）；
 *      · 复用已有的 `cancelled`（边际 = 0 字节，因为它已经在写了）。
 *
 * ═══ 用法 ═══
 *   node scripts/report-event-log-size.mjs
 *   node scripts/report-event-log-size.mjs --save-hides-per-day 5   # 换一个"每天隐藏几次"的假设
 *
 * 只读：它不写任何文件（除了把日志读进内存）。
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

import { eventLogPath, createEnvelope, PROVENANCE } from '@lh/event-store/store'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const v = Number(args[i + 1])
  return Number.isFinite(v) ? v : fallback
}
/** "每天隐藏几次"的假设——用来把单次成本外推成年化。 */
const HIDES_PER_DAY = argOf('--save-hides-per-day', 5)

const bytesOf = (s) => Buffer.byteLength(s, 'utf8')
const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
const pct = (n, total) => `${((n / total) * 100).toFixed(1)}%`

let logPath
try {
  logPath = eventLogPath()
} catch (error) {
  console.error(`定位不到事件日志：${error?.message ?? error}`)
  process.exit(1)
}
if (!existsSync(logPath)) {
  console.error(`事件日志还不存在：${logPath}（先用 LH 做点什么，它就有了）`)
  process.exit(1)
}

const text = readFileSync(logPath, 'utf8').replace(/^\uFEFF/, '')
const lines = text.split('\n').filter((l) => l.trim() !== '')
const fileBytes = statSync(logPath).size
const events = []
for (const line of lines) {
  try {
    events.push({ bytes: bytesOf(line) + 1, event: JSON.parse(line) })
  } catch {
    /* 半截行（写到一半被中断）不该让量具崩掉 */
  }
}

// ── ① 总览 ────────────────────────────────────────────────────────────────
const totalBytes = events.reduce((sum, e) => sum + e.bytes, 0)
const first = events.length > 0 ? events[0].event.timestamp : null
const last = events.length > 0 ? events[events.length - 1].event.timestamp : null
const spanDays = first !== null && last !== null ? Math.max(1, (Date.parse(last) - Date.parse(first)) / 86400000) : 1
const perDay = totalBytes / spanDays
const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 })

console.log('\n═══ LH 事件日志体积报告 ═══')
console.log(`文件        ${logPath}`)
console.log(`磁盘大小    ${mb(fileBytes)}（${fileBytes} 字节）`)
console.log(`有效行      ${lines.length} 行（解析失败 ${lines.length - events.length} 行）`)
console.log(`平均每行    ${(totalBytes / Math.max(1, events.length)).toFixed(0)} 字节`)
console.log(`时间跨度    ${first?.slice(0, 10) ?? '?'} ~ ${last?.slice(0, 10) ?? '?'}（${spanDays.toFixed(1)} 天）`)
console.log(`每天写入    ${kb(perDay)}/天　→　按此推算一年 ${mb(perDay * 365)}（未压缩）`)
console.log(`gzip 之后   ${mb(gz.length)}（压缩到 ${pct(gz.length, fileBytes)}，${(fileBytes / gz.length).toFixed(1)}×）`)
console.log(`　　　　　　按此推算一年 ${mb((gz.length / fileBytes) * perDay * 365)}（压缩后）`)

// ── ② 谁在占地方 ──────────────────────────────────────────────────────────
//
// 按"族"看（前两段，如 `lh/schedule`）比按具体动词看更有决策价值：
// 决定要不要省着记的时候，人关心的是"记录器占了 80% 还是 3%"。
const byFamily = new Map()
const byType = new Map()
for (const { bytes, event } of events) {
  const type = typeof event?.type === 'string' ? event.type : '(无 type)'
  const parts = type.split('/')
  const family = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : type
  const f = byFamily.get(family) ?? { count: 0, bytes: 0 }
  f.count += 1
  f.bytes += bytes
  byFamily.set(family, f)
  const t = byType.get(type) ?? { count: 0, bytes: 0 }
  t.count += 1
  t.bytes += bytes
  byType.set(type, t)
}

const rank = (map, n) =>
  [...map.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, n)
    .map(([name, v]) => ({ name, ...v, avg: v.bytes / v.count }))

console.log('\n── 按事件族（前两段）排行 ──')
for (const row of rank(byFamily, 12)) {
  console.log(
    `${row.name.padEnd(22)} ${String(row.count).padStart(6)} 条  ${mb(row.bytes).padStart(9)}  ${pct(row.bytes, totalBytes).padStart(6)}  平均 ${row.avg.toFixed(0)} 字节`,
  )
}

console.log('\n── 按事件类型排行（前 12）──')
for (const row of rank(byType, 12)) {
  console.log(
    `${row.name.padEnd(28)} ${String(row.count).padStart(6)} 条  ${mb(row.bytes).padStart(9)}  ${pct(row.bytes, totalBytes).padStart(6)}  平均 ${row.avg.toFixed(0)} 字节`,
  )
}

// 日程事件自己的真实成本（用真实数据，不估）
const scheduleRows = [...byType.entries()].filter(([name]) => name.startsWith('lh/schedule/'))
if (scheduleRows.length > 0) {
  const sc = scheduleRows.reduce((s, [, v]) => s + v.count, 0)
  const sb = scheduleRows.reduce((s, [, v]) => s + v.bytes, 0)
  console.log(
    `\n日程事件合计  ${sc} 条  ${mb(sb)}  占 ${pct(sb, totalBytes)}  平均 ${(sb / sc).toFixed(0)} 字节/条`,
  )
}

// ── ③ 边际成本：三个候选各造一条真事件，量字节 ────────────────────────────
//
// ⚠ 这里量的是**真信封**（用 @lh/event-store 的唯一构造点造），不是手写 JSON——
//   手写的会漏掉 provenance / session_ref / content_ref 那些固定字段，
//   而它们恰恰是这个问题的答案：信封的固定成本比 data 大得多。
const itemId = 'schedule-00000000'
const sample = (type, data) =>
  bytesOf(
    JSON.stringify(
      createEnvelope({
        actor: 'user',
        type,
        data,
        provenance: { plugin: '@lh/schedule', version: '0.1.0' },
        scope: `schedule/${itemId}`,
        sessionRef: 'session-00000000-0000-4000-8000-000000000000',
      }),
    ),
  ) + 1

const candidates = [
  { label: '新动词 lh/schedule/hidden（只带 item_id）', bytes: sample('lh/schedule/hidden', { item_id: itemId }) },
  { label: '新动词 + reason（带一句中文理由，约 12 字）', bytes: sample('lh/schedule/hidden', { item_id: itemId, reason: '不想再看到它了' }) },
  { label: '复用 updated 打布尔补丁 { hidden: true }', bytes: sample('lh/schedule/updated', { item_id: itemId, hidden: true }) },
  { label: '复用已有 cancelled（边际成本 = 0，因为它本来就要写）', bytes: 0 },
]

console.log('\n── 单次"隐藏"的边际成本（真信封实测）──')
for (const c of candidates) {
  const perYear = c.bytes * HIDES_PER_DAY * 365
  console.log(
    `${c.label.padEnd(46)} ${String(c.bytes).padStart(4)} 字节/次` +
      (c.bytes === 0 ? '' : `　按每天 ${HIDES_PER_DAY} 次 → 一年 ${mb(perYear)}　= 日志年增量的 ${pct(perYear, perDay * 365)}`),
  )
}

// ── ④ 与"日志自然增长"的对照 ──────────────────────────────────────────────
const baseline = perDay * 365
const hiddenPlan = candidates[1].bytes * HIDES_PER_DAY * 365
console.log('\n── 结论（数字说话）──')
console.log(`日志现在的自然增长      ${mb(baseline)}/年（未压缩，按最近 ${spanDays.toFixed(0)} 天的实测速率外推）`)
console.log(`其中"记一次坐标"这类    ${(() => {
  const trace = byFamily.get('lh/trace')
  return trace === undefined ? '(没有)' : `${pct(trace.bytes, totalBytes)}（lh/trace）`
})()}`)
console.log(
  `加"隐藏"（最贵那种）    ${mb(hiddenPlan)}/年　= 自然增长的 ${pct(hiddenPlan, baseline)}`,
)
console.log(`换成压缩后的口径        前者 ${mb((gz.length / fileBytes) * baseline)}/年 vs 后者 ${mb((gz.length / fileBytes) * hiddenPlan)}/年`)
console.log('')
console.log('（要省，省的地方不在这里：见上面的族排行。记录器是[动过就记]的性质，')
console.log('  日程是[人主动安排]的性质——前者一天几百条，后者一天几条。）')
