/**
 * 把修好的解析**打补丁**进已安装的题库 —— 只动解析，不动任何其它字段。
 *
 * ═══ 为什么不用重跑整条流水线 ═══
 * 重跑意味着重新对齐、重新合并、重新 install，而每一步都可能**改变题目 id**
 * ——id 一变，已有的作答记录（事件日志里的 `lh/user/attempt`）就全部失联，
 * 那是不可恢复的损失（见 question.js 的 deriveQuestionId 注释）。
 *
 * 而这次的问题**只在 `analysis` 这一个字段**上（见
 * `scripts/verify-analysis-truncation.mjs` 量化的 46/49 被截断）。
 * 既然只错一个字段，就只改那一个字段——**改得越少，越不可能顺带弄坏别的**。
 *
 * ═══ 它保证的不变量（不满足就拒绝写盘）═══
 *   1. 题目**数量不变**
 *   2. 题目 **id 一个都不变**（顺序也一致）
 *   3. 除 analysis / provenance.analysis_* 之外的字段**逐字节不变**
 * 前两条保证作答记录不失联；第三条保证这不是"顺手重写了一遍题库"。
 *
 * 用法：node scripts/patch-bank-analysis.mjs            （只看会改什么）
 *       node scripts/patch-bank-analysis.mjs --write     （真的写，先自动备份）
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

const BANK = resolve(
  process.argv.find((a) => a.startsWith('--bank='))?.slice('--bank='.length)
    ?? 'D:\\learning Harness test\\lh-questions\\考公刷题-片段阅读与逻辑判断.json',
)
const WRITE = process.argv.includes('--write')

/**
 * 抽取结果 → 题库里哪个来源文件。
 *
 * ⚠ 必须**按来源文件分开映射**：两个题库的题号都从 `set1-q1` 开始
 * （片段阅读 20 道、逻辑判断 29 道），只按题号匹配会**张冠李戴**——
 * 把片段阅读的解析贴到逻辑判断的题上，而且不会有任何报错。
 */
const SOURCES = [
  { extracted: 'data/align/set01-extracted-fixed.json', bankPath: '2025年花生片段阅读600题-题本【上】.pdf' },
  { extracted: 'data/align/lj-extracted-fixed.json', bankPath: '逻辑判断600题题本篇.pdf' },
]

const bank = JSON.parse(readFileSync(BANK, 'utf8').replace(/^\uFEFF/, ''))
const questions = bank.questions ?? []

/** (来源文件 + 题号) → 新解析。 */
const patch = new Map()
let extractedTotal = 0

for (const src of SOURCES) {
  const file = resolve(src.extracted)
  if (!existsSync(file)) {
    console.error(`缺少抽取结果：${file}\n  先跑：python scripts/extract_answers.py --report … --out ${src.extracted}`)
    process.exit(2)
  }
  const data = JSON.parse(readFileSync(file, 'utf8'))
  for (const item of data.items ?? []) {
    extractedTotal += 1
    const number = `set${item.set ?? 1}-q${item.no}`
    const analysis = typeof item.analysis === 'string' ? item.analysis.trim() : ''
    patch.set(`${src.bankPath}|${number}`, { analysis, kind: item.analysis_kind ?? null })
  }
  console.log(`${basename(src.extracted).padEnd(32)} ${(data.items ?? []).length} 条 → ${src.bankPath}`)
}

console.log(`\n题库：${BANK}`)
console.log(`题目 ${questions.length} 道，抽取结果 ${extractedTotal} 条，可匹配的补丁 ${patch.size} 条\n`)

// ── 逐题应用 ──

const before = JSON.parse(JSON.stringify(questions))
let changed = 0
let grew = 0
let shrank = 0
let unmatched = 0
let bytesBefore = 0
let bytesAfter = 0

for (const q of questions) {
  const path = q.source?.path
  const number = q.source?.number
  const oldAnalysis = typeof q.analysis === 'string' ? q.analysis : ''
  bytesBefore += oldAnalysis.length

  const hit = patch.get(`${path}|${number}`)
  if (hit === undefined) {
    unmatched += 1
    bytesAfter += oldAnalysis.length
    continue
  }

  const next = hit.analysis
  if (next !== oldAnalysis) {
    changed += 1
    if (next.length > oldAnalysis.length) grew += 1
    else shrank += 1
    q.analysis = next
  }

  // provenance 如实反映"这条解析是什么来路"。
  //
  // ⚠ 关键：补回来的正文是 **OCR 两栏串行**的（读起来会跳）。
  // 所以这里**不能**把它标成干净的"原文"——那会让界面与 agent 都以为
  // 它是一段可以照读的讲解。标成"原文（OCR 可能串行）"，
  // 下游就能据此决定：给模型当证据可以，原样端给学习者当讲义要谨慎。
  q.provenance = q.provenance ?? {}
  q.provenance.analysis_available = next !== ''
  q.provenance.analysis_kind = next === ''
    ? '无'
    : (next.includes('非原文讲解') ? '选项标注拼成' : '原文（OCR 可能串行）')

  bytesAfter += next.length
}

console.log('══ 变更摘要 ══')
console.log(`  解析有变化的        ${changed} 道（变长 ${grew} / 变短 ${shrank}）`)
console.log(`  匹配不到抽取结果的  ${unmatched} 道（保留原样）`)
console.log(`  解析总字数          ${bytesBefore} → ${bytesAfter}（×${(bytesAfter / Math.max(1, bytesBefore)).toFixed(1)}）`)

// ── 不变量检查（不满足就拒绝写） ──

const idsBefore = before.map((q) => q.id)
const idsAfter = questions.map((q) => q.id)
const problems = []

if (idsBefore.length !== idsAfter.length) problems.push(`题目数量变了：${idsBefore.length} → ${idsAfter.length}`)
for (let i = 0; i < Math.min(idsBefore.length, idsAfter.length); i += 1) {
  if (idsBefore[i] !== idsAfter[i]) {
    problems.push(`第 ${i + 1} 道题的 id 变了：${idsBefore[i]} → ${idsAfter[i]}（作答记录会失联）`)
    break
  }
}

// 除 analysis / provenance.analysis_* 之外必须逐字节不变
const ALLOWED = new Set(['analysis'])
for (let i = 0; i < questions.length; i += 1) {
  const a = before[i]
  const b = questions[i]
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (ALLOWED.has(key)) continue
    if (key === 'provenance') {
      const pa = { ...(a.provenance ?? {}) }
      const pb = { ...(b.provenance ?? {}) }
      delete pa.analysis_available; delete pa.analysis_kind
      delete pb.analysis_available; delete pb.analysis_kind
      if (JSON.stringify(pa) !== JSON.stringify(pb)) {
        problems.push(`${b.id} 的 provenance（除 analysis_* 外）被改动了`)
      }
      continue
    }
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      problems.push(`${b.id} 的字段 ${key} 被改动了（本补丁只该动 analysis）`)
    }
  }
  if (problems.length > 3) break
}

if (problems.length > 0) {
  console.log('\n✗ 不变量被破坏，拒绝写盘：')
  for (const p of problems) console.log(`   - ${p}`)
  process.exit(1)
}
console.log('\n✓ 不变量成立：题目数量、id、以及除解析外的全部字段都没变。')

if (!WRITE) {
  console.log('\n（未写盘。加 --write 才真的写；写之前会自动备份一份。）')
  process.exit(0)
}

// ── 备份 + 原子写 ──

const backup = `${BANK}.bak-analysis-${Date.now()}`
copyFileSync(BANK, backup)
const tmp = `${BANK}.tmp`
writeFileSync(tmp, JSON.stringify(bank, null, 2), 'utf8')
renameSync(tmp, BANK)
console.log(`\n已写入 ${BANK}`)
console.log(`备份     ${backup}`)
console.log('\n接着跑：node scripts/audit-bank-analysis.mjs')
