/**
 * 审计题库里的**解析质量**。
 *
 * ═══ 为什么需要它（作者实测反馈）═══
 * 作者原话：*"我在做题卡片中做错题后的解析要么不完整要么没有"*。
 * 这不是主观印象，是**可以量出来的三类**，而三类的修法完全不同：
 *
 *   1. **空**：题解资料里没有这一道（或抽取时没对上）→ 要补抽取/对齐；
 *   2. **拼凑型**：由选项标注拼成（文本里带"本条由选项标注拼成，非原文讲解"）
 *      —— 它不是讲解，是**看似有解析**的假象，用起来更有害；
 *   3. **被截断**：结尾没有句末标点 → 多半是**跨页/跨栏边界**把句子切断了
 *      （本项目已经踩过两栏 OCR 交错、页边界切题的坑）。
 *
 * 不分类的话，"解析不行"只会变成一句没法动手的抱怨。
 *
 * 用法：node scripts/audit-bank-analysis.mjs [题库文件]
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 默认题库目录（LH_WORKSPACE 优先，与插件同一套规则）。 */
function defaultBankDir() {
  const ws = process.env.LH_WORKSPACE
  if (typeof ws === 'string' && ws.trim() !== '') return join(resolve(ws.trim()), 'lh-questions')
  const install = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web', 'lh-install.json')
  try {
    const cfg = JSON.parse(readFileSync(install, 'utf8'))
    if (typeof cfg.workspace === 'string') return join(resolve(cfg.workspace), 'lh-questions')
  } catch {
    /* 没装配置就往上报错，让调用方显式给路径 */
  }
  return null
}

/** 句末标点：结尾是这些之一，才认为句子说完了。 */
const ENDS_OK = /[。！？…”』】）)!?]$/

/** 拼凑型解析的标记（抽取脚本在拼凑时会写上这句）。 */
const SYNTHETIC_MARK = '非原文讲解'

const argPath = process.argv[2]
let files = []

if (argPath !== undefined) {
  files = [resolve(argPath)]
} else {
  const dir = defaultBankDir()
  if (dir === null || !existsSync(dir)) {
    console.error('找不到题库目录。用法：node scripts/audit-bank-analysis.mjs <题库.json 或 目录>')
    process.exit(2)
  }
  files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f))
}

let totalQuestions = 0
let empty = 0
let synthetic = 0
let truncated = 0
let ok = 0

for (const file of files) {
  let bank
  try {
    bank = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    console.log(`跳过（读不了）：${file} — ${error.message}`)
    continue
  }
  const questions = Array.isArray(bank.questions) ? bank.questions : []
  if (questions.length === 0) continue

  const local = { empty: [], synthetic: [], truncated: [], ok: [] }
  for (const q of questions) {
    const a = typeof q.analysis === 'string' ? q.analysis.trim() : ''
    if (a === '') local.empty.push(q)
    else if (a.includes(SYNTHETIC_MARK)) local.synthetic.push(q)
    else if (!ENDS_OK.test(a)) local.truncated.push(q)
    else local.ok.push(q)
  }

  totalQuestions += questions.length
  empty += local.empty.length
  synthetic += local.synthetic.length
  truncated += local.truncated.length
  ok += local.ok.length

  const pct = (n) => `${String(n).padStart(3)} (${Math.round((n / questions.length) * 100)}%)`
  console.log(`\n══ ${file.split(/[\\/]/).pop()} —— ${questions.length} 道`)
  console.log(`   空解析        ${pct(local.empty.length)}`)
  console.log(`   拼凑型(非原文) ${pct(local.synthetic.length)}`)
  console.log(`   疑似被截断    ${pct(local.truncated.length)}`)
  console.log(`   看起来完整    ${pct(local.ok.length)}`)

  if (local.truncated.length > 0) {
    console.log('   --- 疑似截断的结尾（这类最容易"看着有、其实说了一半"）---')
    for (const q of local.truncated.slice(0, 5)) {
      console.log(`     ${q.id}  长度 ${q.analysis.trim().length}`)
      console.log(`        …${q.analysis.trim().slice(-55).replace(/\n/g, ' ')}`)
    }
  }
  if (local.synthetic.length > 0) {
    console.log('   --- 拼凑型样本（**不是讲解**，是选项标注的重排）---')
    for (const q of local.synthetic.slice(0, 2)) {
      console.log(`     ${q.id}: ${q.analysis.trim().slice(0, 100).replace(/\n/g, ' ')}`)
    }
  }
}

console.log(`\n══ 合计 ${totalQuestions} 道`)
console.log(`   空 ${empty} / 拼凑 ${synthetic} / 疑似截断 ${truncated} / 完整 ${ok}`)
const usable = ok
console.log(`   → **真正能当讲解用的只有 ${usable} 道（${Math.round((usable / Math.max(1, totalQuestions)) * 100)}%）**`)
console.log('')
console.log('   这三类的修法不同：空 → 补抽取或补来源；拼凑 → 别当讲解用，只能当提示；')
console.log('   截断 → 查跨页/跨栏边界（本项目踩过两栏 OCR 交错与页边界切题的坑）。')
