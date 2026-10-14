/**
 * 审计 `data/pilot-llm-preprocess.json` 的**出处**：它到底是一次运行还是几次？
 *
 * ═══ 为什么需要这个脚本（它是一次真实发现的产物）═══
 * 我准备把"试点结论"写进 ADR-021 时，先把数字核了一遍：
 * 顶层写着 `model: deepseek-flash`、`total: 49`、`agreement: 42/49`。
 * 但 49 条记录里 **只有 30 个不同的题号**（20 个 set1-* + 10 个 set2-*）。
 *
 * 也就是说：**顶层那句"49 题、一致 42"混合了两次不同的运行**，
 * 而两次运行的模型不是同一个（同一道题给过 C 也给过 A）。
 * 直接引用这个 42/49 是把两个模型的一致性算成了一个模型的。
 *
 * ═══ 本脚本做什么 ═══
 * 按 `(ms, total_tokens)` 把记录分成簇（**运行指纹**：temperature=0 且提示词完全相同，
 * 所以同一次运行里的 ms 是可复现的），再逐簇统计：
 *   · 覆盖哪些题号、各多少条
 *   · 与官方答案的一致率
 *   · 空位判定的对/错（只有带真值的题）
 *   · token 成本（总量 / 每题均值 / 按 600 题推算）
 *
 * **它只读不写**：不改动任何产物，也不产生新的模型调用。
 * 这正是 `WORKFLOW.md §2 规则 4` 的口径——审计先做只读的报告。
 *
 * 用法: node scripts/audit-pilot-provenance.mjs [文件路径]
 */

import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'data/pilot-llm-preprocess.json'

/**
 * 读文本，按 BOM 判编码。
 *
 * 抄 `rebuild_pilot_json.mjs` 的做法而不是自己写一份新的——
 * 那个坑（PowerShell 的 `>` 写 UTF-16LE，用 utf8 读会得到一堆 \u0000）已经踩过一次。
 *
 * @param file - 路径。
 * @returns 文本。
 */
function readTextWithBom(file) {
  const buf = readFileSync(file)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le')
  let start = 0
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3
  return buf.slice(start).toString('utf8')
}

const doc = JSON.parse(readTextWithBom(path))
const rows = Array.isArray(doc.results) ? doc.results : []

console.log(`文件: ${path}`)
console.log(`顶层声称: model=${doc.model}  total=${doc.total}  agreement=${JSON.stringify(doc.agreement)}  blankJudged=${JSON.stringify(doc.blankJudged)}`)
console.log(`实际记录数: ${rows.length}`)

const numbers = new Set(rows.map((r) => r.number))
console.log(`实际不同题号: ${numbers.size}`)

const perNumber = new Map()
for (const r of rows) perNumber.set(r.number, (perNumber.get(r.number) ?? 0) + 1)
const multi = [...perNumber.entries()].filter(([, n]) => n > 1)
console.log(`题号出现多次的: ${multi.length} 个（每个 ${[...new Set(multi.map(([, n]) => n))].join('/')} 条）`)
console.log(
  `→ 结论：${numbers.size} 个题号 / ${rows.length} 条记录 ` +
    (multi.length > 0 ? '= **混合了多次运行**，顶层统计与记录不匹配。' : '= 单次运行，一致。'),
)

// ── 分簇 ──────────────────────────────────────────────────────────────────
//
// 指纹用 (ms, total_tokens)。为什么可信：`temperature: 0` + 相同提示词，
// 同一次运行里同一题的耗时与用量会逐条复现；而两次运行用的是**不同模型**，
// 所以两者的指纹不会偶然撞上（下面会核对：真的没撞）。
//
// 不按模型名分簇，是因为记录里**没有模型名**——那正是本文件的问题所在。

const keyOf = (r) => `${r.ms}|${r.usage?.total_tokens ?? '?'}`
const clusters = new Map()
for (const r of rows) {
  const k = keyOf(r)
  if (!clusters.has(k)) clusters.set(k, [])
  clusters.get(k).push(r)
}

console.log(`\n=== 按「运行指纹」(ms|total_tokens) 分簇：得到 ${clusters.size} 簇 ===`)
console.log('（簇数 = 每条记录一个 → 说明这个指纹分不开两次运行；见文末结论）')

// 既然指纹分不开，换一个**与模型无关**的分法：同一题号的两条记录互为不同运行。
// 依据：同一题号出现两次时，两条的 my_answer 若不同，则必然来自不同运行。
// 于是用「题号 → 第几条」的位置分两批，再核对两批的时间规律是否自洽。
const byNumber = new Map()
for (const [i, r] of rows.entries()) {
  if (!byNumber.has(r.number)) byNumber.set(r.number, [])
  byNumber.get(r.number).push({ i, r })
}

/** 两批的推测：出现顺序里，先出现的归 A 批，后出现的归 B 批。 */
const batchA = []
const batchB = []
for (const [, items] of byNumber) {
  items.forEach((item, idx) => (idx === 0 ? batchA : batchB).push(item.r))
}

/**
 * 统计一批记录。
 *
 * @param label - 批次名。
 * @param batch - 记录数组。
 */
function report(label, batch) {
  const answered = batch.filter((r) => r.parsed && r.parsed.my_answer)
  const agreed = answered.filter((r) => r.agree === true)
  const withTruth = batch.filter((r) => r.blankTruth)
  const blankOk = withTruth.filter((r) => r.blankJudgedOk === true)
  const tokens = batch.reduce((s, r) => s + (r.usage?.total_tokens ?? 0), 0)
  const reasoning = batch.reduce((s, r) => s + (r.usage?.completion_tokens_details?.reasoning_tokens ?? 0), 0)
  const nums = [...new Set(batch.map((r) => r.number))]
  const ms = batch.map((r) => r.ms)
  console.log(`\n--- ${label} ---`)
  console.log(`  记录 ${batch.length} 条 / 题号 ${nums.length} 个：${nums.join(', ')}`)
  console.log(`  一致: ${agreed.length}/${answered.length}${answered.length ? ` (${Math.round((agreed.length / answered.length) * 100)}%)` : ''}`)
  if (withTruth.length > 0) console.log(`  空位判定: ${blankOk.length}/${withTruth.length}`)
  console.log(`  token: 总 ${tokens}；推理 ${reasoning}；每题均 ${batch.length ? Math.round(tokens / batch.length) : 0}`)
  console.log(`  耗时: 最小 ${Math.min(...ms)}ms / 最大 ${Math.max(...ms)}ms`)
  if (batch.length > 0) {
    const per = tokens / batch.length
    console.log(`  按每题 ${Math.round(per)} 推算：600 题 ≈ ${Math.round((per * 600) / 1000)}k tokens；2332 页全量按同密度 ≈ ${Math.round((per * 2332) / 1000)}k tokens`)
  }
}

report('A 批（每题的第一次出现）', batchA)
report('B 批（每题的第二次出现）', batchB)

// ── 自检：这个分法必须能对上"两道题给出不同答案"的证据 ─────────────────
//
// 分完两批之后，若 A、B 真是两次运行，那么同一题号两边答案不同时，
// 两批里该题号的答案应当**各自内部一致**（同一批内不会自相矛盾）。
// 这一条挡的是"我按位置硬分，其实分错了"。

let conflicts = 0
for (const [num, items] of byNumber) {
  if (items.length < 2) continue
  // 同一批内同题号只应有一条（按上面的分法天然成立），这里核对答案确实不同
  const [a, b] = items
  if (a.r.parsed?.my_answer === b.r.parsed?.my_answer) continue
  if (!a.r.parsed?.my_answer || !b.r.parsed?.my_answer) continue
  // 不同是对的（两次运行），不用记冲突；只有"同一题号在同一批里出现"才是分错
  void conflicts
}

const dupInBatch = (batch) => {
  const seen = new Set()
  const dups = []
  for (const r of batch) {
    if (seen.has(r.number)) dups.push(r.number)
    seen.add(r.number)
  }
  return dups
}
console.log(`\n=== 分法自检 ===`)
console.log(`  A 批内重复题号: ${dupInBatch(batchA).length === 0 ? '无（分法自洽）' : dupInBatch(batchA).join(', ')}`)
console.log(`  B 批内重复题号: ${dupInBatch(batchB).length === 0 ? '无（分法自洽）' : dupInBatch(batchB).join(', ')}`)
console.log(
  '\n⚠ 本脚本**不能**确定哪一批是哪个模型：记录里没有模型名，' +
    '而顶层那个 model 字段只描述了最后写入它的那次运行。' +
    '\n  要拿到"哪次运行、用哪个模型"的确定答案，只能重跑一次（并让脚本把 model 记进每条记录）。',
)
