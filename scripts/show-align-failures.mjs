/**
 * 打印对齐报告里所有定位失败的题，并给出它们的诊断线索。
 *
 * 用法: node scripts/show-align-failures.mjs [报告路径]
 */

import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'data/align/set01-report.json'
const r = JSON.parse(readFileSync(path, 'utf8'))

const failed = r.results.filter((x) => !x.located)
const low = r.results.filter((x) => x.located && typeof x.similarity === 'number' && x.similarity < 0.9)

console.log(`共 ${r.results.length} 题，失败 ${failed.length}，低相似度 ${low.length}`)
console.log('')

if (failed.length) {
  console.log('=== 定位失败 ===')
  for (const x of failed) {
    console.log(`第${x.set}套 第${x.question_no}题（题本 p${x.question_page}）`)
    console.log(`  题干: ${String(x.stem_head).replace(/\n/g, ' ')}`)
    console.log(`  原因: ${x.reason}`)
    console.log(`  探针: ${JSON.stringify(x.probe)}`)
    console.log(`  该题在报告里的序号: #${x.index}`)
    console.log('')
  }
}

if (low.length) {
  console.log('=== 低相似度（模糊匹配勉强命中，最可能误配，应交给 LLM 复核）===')
  for (const x of low) {
    console.log(`  第${x.set}套 第${x.question_no}题  相似度=${x.similarity}  位置=${x.located_at}`)
    console.log(`     题干: ${String(x.stem_head).replace(/\n/g, ' ').slice(0, 50)}`)
  }
  console.log('')
}

console.log('=== 全部题的相似度分布 ===')
const sims = r.results.filter((x) => typeof x.similarity === 'number').map((x) => x.similarity)
if (sims.length) {
  const exact = sims.filter((s) => s === 1).length
  const fuzzy = sims.filter((s) => s < 1).length
  console.log(`  精确匹配=${exact}  模糊匹配=${fuzzy}  最低=${Math.min(...sims).toFixed(3)}`)
}
