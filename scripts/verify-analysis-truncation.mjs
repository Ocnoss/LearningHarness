/**
 * 验证"解析被截断"的根因，以及修法能挽回多少。
 *
 * ═══ 根因（已在源码里定位）═══
 * `scripts/extract_answers.py:44`
 *     RE_EXPLAIN = re.compile(r"【\s*实\s*战\s*解\s*析\s*】\s*([^\n【]*)")
 * 捕获类是 `[^\n【]*` —— **遇到第一个换行就停**。
 * 而这份资料的解析是多行的（双栏 PDF，一行约 26 字），
 * 于是**每一道题的解析都被截成了第一行**。
 *
 * 实测症状完全吻合：23 道"疑似截断"的解析**长度都恰好是 26 字**——
 * 那不是"跨页切断"的随机长度，是"一行的宽度"。
 *
 * ═══ 这个脚本做什么 ═══
 * 直接拿对齐报告里的 `answer_text_full`（**原文全文**，未经过任何截断）
 * 分别用旧/新正则抽取，比较长度。这样：
 *   · 不需要重跑 OCR 或整条流水线就能证明根因；
 *   · 也能量出"修完能多拿到多少字"，而不是只说"修好了"。
 *
 * 用法：node scripts/verify-analysis-truncation.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 旧正则：遇换行即停（现状）。 */
const OLD = /【\s*实\s*战\s*解\s*析\s*】\s*([^\n【]*)/

/**
 * 新正则：一直取到**下一个标记或块末尾**。
 *
 * 为什么可以跨换行：`answer_text_full` 已经**按题切好了**（对齐阶段做的），
 * 所以"到块末尾"不会串到下一题；而 `【` 是下一个区段的开始标记，必须停。
 * 结尾的推广文字由 `strip_promo` 另行切掉（那是另一层，不该混进这里）。
 */
const NEW = /【\s*实\s*战\s*解\s*析\s*】\s*([\s\S]*?)(?=【|$)/

/** 与 Python 端一致的推广文字清理（只做粗匹配，够用来比较长度）。 */
function stripPromo(text) {
  return text
    .replace(/公考最新资料|更新进度|微信\s*[A-Za-z0-9_]+|SKA\d+|QQ\s*群|公众号|扫码|关注/g, '')
    .trim()
}

const alignDir = 'data/align'
const reports = readdirSync(alignDir).filter((f) => f.endsWith('-report.json'))

let total = 0
let emptyOld = 0
let emptyNew = 0
let longer = 0
let sumOld = 0
let sumNew = 0
const samples = []

for (const file of reports) {
  const report = JSON.parse(readFileSync(join(alignDir, file), 'utf8'))
  const results = Array.isArray(report.results) ? report.results : []
  console.log(`\n══ ${file} —— ${results.length} 道（回答块来自 ${report.answer_file}）`)

  let localLonger = 0
  for (const r of results) {
    const block = r.answer_text_full ?? ''
    if (block === '') continue
    total += 1

    const mOld = OLD.exec(block)
    const mNew = NEW.exec(block)
    const aOld = stripPromo(mOld ? mOld[1] : '')
    const aNew = stripPromo(mNew ? mNew[1] : '')

    if (aOld === '') emptyOld += 1
    if (aNew === '') emptyNew += 1
    sumOld += aOld.length
    sumNew += aNew.length
    if (aNew.length > aOld.length) {
      longer += 1
      localLonger += 1
      if (samples.length < 6) {
        samples.push({ q: `${r.set ?? '-'}#${r.question_no}`, oldLen: aOld.length, newLen: aNew.length, old: aOld, fresh: aNew.slice(aOld.length, aOld.length + 90) })
      }
    }
  }
  console.log(`   旧正则拿到的平均长度 ${Math.round(sumOld / Math.max(1, total))} 字；本条里被截断的 ${localLonger} 道`)
}

console.log('\n══ 合计 ══')
console.log(`   参与比较      ${total} 道`)
console.log(`   旧正则截断的   ${longer} 道（新正则能多拿到内容）`)
console.log(`   旧空/新空      ${emptyOld} / ${emptyNew}`)
console.log(`   总字数        旧 ${sumOld} → 新 ${sumNew}（×${(sumNew / Math.max(1, sumOld)).toFixed(1)}）`)
console.log(`   平均每条      旧 ${Math.round(sumOld / Math.max(1, total))} 字 → 新 ${Math.round(sumNew / Math.max(1, total))} 字`)

console.log('\n══ 样本：旧正则截在这里，新正则补回了这些 ══')
for (const s of samples) {
  console.log(`\n  ${s.q}   ${s.oldLen} 字 → ${s.newLen} 字`)
  console.log(`     旧：${s.old}`)
  console.log(`     补：${s.fresh.replace(/\n/g, ' ')}…`)
}
