/**
 * 读对齐报告，人可读地打印。
 *
 * 为什么单独一个文件而不是 node -e：
 * 内联脚本要穿过 PowerShell 的引号层，实测被 `\"` 弄坏过两次
 * （报 Invalid string escape / Expression expected）。
 * 写成文件就完全不碰引号问题——这条规矩我立过，这次又踩了一次。
 *
 * 用法: node scripts/show-align-report.mjs [报告路径] [条数]
 */

import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'data/align/set01-report.json'
const limit = Number(process.argv[3] ?? 20)

const r = JSON.parse(readFileSync(path, 'utf8'))

console.log(`题本: ${r.question_file}   页: ${r.question_pages_used.join(',')}`)
console.log(`解析: ${r.answer_file}   页: ${r.answer_pages_used.join(',')}`)
console.log(`题本块数=${r.question_blocks}  比较=${r.compared}  探针字数=${r.probe_chars}`)
console.log(`定位成功=${r.verified_ok}  失败=${r.verified_bad}  位置单调=${r.monotonic}  判定=${r.verdict}`)
if (r.low_similarity?.length) {
  console.log(`低相似度（需 LLM 复核）: ${r.low_similarity.map((x) => `第${x.set}套Q${x.no}=${x.similarity}`).join('  ')}`)
}
console.log('')

for (const x of r.results.slice(0, limit)) {
  const mark = x.located ? 'OK ' : 'BAD'
  const sim = x.similarity === undefined || x.similarity === null ? '-' : x.similarity
  console.log(`[${mark}] #${x.index}  第${x.set}套 第${x.question_no}题(题本p${x.question_page})  解析位置=${x.located_at ?? '-'}  相似度=${sim}  方式=${x.method ?? '-'}`)
  console.log(`      题干: ${String(x.stem_head).replace(/\n/g, ' ').slice(0, 44)}`)
  if (!x.located) console.log(`      ✗ ${x.reason}  探针=${JSON.stringify(x.probe)}`)
  if (x.options?.length) {
    console.log(`      选项: ${x.options.map((o) => o.label + '.' + o.text.slice(0, 14)).join('  ')}`)
  }
}
