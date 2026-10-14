/**
 * 核对题目 id 的派生参数 —— **为什么新题库的 id 和旧题库不一样**。
 *
 * ═══ 为什么必须查清 ═══
 * 作者已经在片段阅读的题上刷过题，作答事件（`lh/user/attempt`）记的是**题目 id**。
 * id 一变，那些记录就指向不存在的题——那是不可恢复的损失
 * （`question.js` 的 `deriveQuestionId` 注释专门写了这条）。
 *
 * 而 `deriveQuestionId` 的输入是 `(sourceRoot, sourceFile, number, 题干前 40 字)`。
 * 我这套新链用了 `number = '练习题01-q1'`（为了跨资料唯一），
 * 所以 id 必然不同。本脚本把"差在哪"算清楚，而不是凭印象说"参数不同"。
 *
 * 用法: node scripts/diff-question-ids.mjs
 */

import { readFileSync } from 'node:fs'

import { deriveQuestionId } from '../plugins/lh-question-bank/question.js'

const OLD_BANK = 'D:/learning Harness test/lh-questions/考公刷题-片段阅读与逻辑判断.json'
const NEW_BANK = 'D:/learning Harness test/lh-questions/考公刷题-片段阅读-第1册.json'

const oldBank = JSON.parse(readFileSync(OLD_BANK, 'utf8'))
const newBank = JSON.parse(readFileSync(NEW_BANK, 'utf8'))

// 取两道**同一道真题**（片段阅读第 1 套第 1 题）在两个题库里的记录
const oldQ = oldBank.questions.find((q) => q.source.number === 'set1-q1')
const newQ = newBank.questions.find((q) => q.source.number === '练习题01-q1')

if (oldQ === undefined || newQ === undefined) {
  console.error('两个题库里没同时找到这道题，无法比对')
  process.exit(2)
}

console.log('同一道真题（片段阅读 第1套 第1题）在两个题库里的 id：')
console.log(`  旧：${oldQ.id}   number=${oldQ.source.number}  path=${oldQ.source.path}`)
console.log(`  新：${newQ.id}   number=${newQ.source.number}  path=${newQ.source.path}`)
console.log(`  题干是否同一道：${oldQ.stem.slice(0, 30) === newQ.stem.slice(0, 30) ? '是' : '**不是**'}`)

console.log('\n逐个参数试，看哪个组合能复现旧 id（旧题库的 source_root = ' + oldBank.source_root + '）：')
const candidates = [
  ['旧 root + 旧 number', { sourceRoot: oldBank.source_root, sourceFile: oldQ.source.path, number: oldQ.source.number, stem: oldQ.stem }],
  ['旧 root + 旧 number + 旧题干', { sourceRoot: oldBank.source_root, sourceFile: oldQ.source.path, number: oldQ.source.number, stem: oldQ.stem }],
  ['拼接 path 作 root', { sourceRoot: oldBank.source_root + '\\' + oldQ.source.path, sourceFile: oldQ.source.path, number: oldQ.source.number, stem: oldQ.stem }],
  ['路径用反斜杠', { sourceRoot: oldBank.source_root, sourceFile: oldQ.source.path.replace(/\//g, '\\'), number: oldQ.source.number, stem: oldQ.stem }],
  ['空 root', { sourceRoot: '', sourceFile: oldQ.source.path, number: oldQ.source.number, stem: oldQ.stem }],
]
for (const [label, params] of candidates) {
  const id = deriveQuestionId(params)
  console.log(`  ${label.padEnd(28)} -> ${id}${id === oldQ.id ? '   ★ 复现成功' : ''}`)
}
console.log(`  ${'期望（旧 id）'.padEnd(28)} -> ${oldQ.id}`)

console.log('\n新链的参数（为了让 id 跨资料唯一，number 换成了 `练习题01-q1`）：')
const newParams = { sourceRoot: 'D:\\考公资料', sourceFile: '片段阅读600题/2025年花生片段阅读600题-题本【上】.pdf', number: newQ.source.number, stem: newQ.stem }
console.log(`  ${deriveQuestionId(newParams)}  （= 新题库里的 ${newQ.id}：${deriveQuestionId(newParams) === newQ.id ? '一致' : '**不一致**'}）`)
