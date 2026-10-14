/**
 * 打印若干道对齐后的完整结果：题干、选项、配到的解析段原文。
 *
 * 这个视图是给人眼看的最后一道关：数字指标（相似度、单调性）说"对齐了"，
 * 但只有把题干和解析并排读一遍，才能确认"解析讲的确实是这道题"。
 *
 * 用法: node scripts/show-aligned-samples.mjs [报告路径] [起始题] [条数]
 */

import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'data/align/set01-report.json'
const from = Number(process.argv[3] ?? 1)
const count = Number(process.argv[4] ?? 3)

const r = JSON.parse(readFileSync(path, 'utf8'))
const items = r.results.slice(from - 1, from - 1 + count)

console.log(`题本: ${r.question_file}`)
console.log(`解析: ${r.answer_file}`)
console.log('')

for (const x of items) {
  console.log('═'.repeat(72))
  console.log(`第${x.set}套 第${x.question_no}题   (题本 p${x.question_page} → 解析位置 ${x.located_at})`)
  console.log('─'.repeat(72))
  console.log('【题干】')
  console.log(String(x.stem_full ?? x.stem_head).trim())
  if (x.options?.length) {
    console.log('【选项】')
    for (const o of x.options) console.log(`  ${o.label}. ${o.text}`)
  }
  console.log('【配到的解析段（前 120 字）】')
  console.log(String(x.answer_text_head ?? '').trim() || '(空)')
  console.log('')
}
