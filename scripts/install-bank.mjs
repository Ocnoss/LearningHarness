/**
 * 把题库装进工作区，并在装之前用**插件自己的代码路径**验证一遍。
 *
 * ═══ 为什么要有这一步，而不是 cp 一下就完 ═══
 * 作者要手动刷题。如果装进去的题库有问题，他会在对话里撞上——
 * 而那时看到的是 agent 报的错，不是"题库有问题"这个事实。
 * 所以装载前先跑一遍 `listQuestionBanks` 与 `getQuestions`（插件真实导出的函数），
 * 确认：能被列出、题数对、取题不泄答案、第一题能被判分。
 *
 * 用法: node scripts/install-bank.mjs <题库文件> <工作区路径>
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { listQuestionBanks, getQuestions, getPracticeStats } from '../plugins/lh-question-bank/index.js'
import { loadBank } from '../plugins/lh-question-bank/bank.js'

const src = process.argv[2]
const workspace = process.argv[3]

if (!src || !workspace) {
  console.error('用法: node scripts/install-bank.mjs <题库文件> <工作区路径>')
  process.exit(2)
}
if (!existsSync(src)) {
  console.error(`题库文件不存在: ${src}`)
  process.exit(2)
}
if (!existsSync(workspace)) {
  console.error(`工作区不存在: ${workspace}`)
  process.exit(2)
}

const bankName = basename(src, '.json')
const targetDir = join(workspace, 'lh-questions')
mkdirSync(targetDir, { recursive: true })

// 连带把配套文件一起带过去（选项评注 + 抽取报告）——它们是题库的伴生信息
const companions = ['.option-notes.json', '.extract-report.json']
const copied = []
for (const suffix of companions) {
  const from = join(src.replace(/\.json$/, '') + suffix)
  if (existsSync(from)) {
    copyFileSync(from, join(targetDir, bankName + suffix))
    copied.push(bankName + suffix)
  }
}

const target = join(targetDir, `${bankName}.json`)
copyFileSync(src, target)
copied.unshift(`${bankName}.json`)

console.log(`已装入: ${target}`)
for (const c of copied) console.log(`  ${c}`)

// ── 装完立刻用插件自己的代码验证 ──
console.log('\n用插件自己的代码路径验证：')

const { bank, errors } = loadBank(target)
if (errors.length > 0) {
  console.error(`  ✗ 题库不合格: ${errors.join('; ')}`)
  process.exit(1)
}
console.log(`  ✓ loadBank 通过，${bank.question_count} 道题`)

const listed = listQuestionBanks({ workspaceRoot: workspace })
const mine = listed.banks.find((b) => b.name === bankName)
if (!mine) {
  console.error('  ✗ listQuestionBanks 看不到它')
  process.exit(1)
}
console.log(`  ✓ listQuestionBanks 能看到：${mine.name}（${mine.question_count} 道，ok=${mine.ok}）`)

const taken = getQuestions({ workspaceRoot: workspace, bankName, count: 3 })
if (taken.questions.length !== 3) {
  console.error(`  ✗ 取题失败，只拿到 ${taken.questions.length} 道`)
  process.exit(1)
}
const leaked = taken.questions.filter((q) => 'answer' in q || 'analysis' in q)
if (leaked.length > 0) {
  console.error(`  ✗ 取题泄漏了答案: ${leaked.map((q) => q.id)}`)
  process.exit(1)
}
console.log('  ✓ getQuestions 取到 3 道，且不含答案/解析')

const stats = getPracticeStats({ workspaceRoot: workspace, bankName })
console.log(`  ✓ getPracticeStats 可用：${stats.total_questions} 道，做过 ${stats.attempted_questions} 道，正确率 ${stats.accuracy}`)

// ── 给人看的一份预览（可打印、可核对）──
const previewPath = join(targetDir, `${bankName}.预览.md`)
const lines = [
  `# ${bank.title}（预览）`,
  '',
  `- 题数：**${bank.question_count}**`,
  `- 来源题本：${bank.questions[0]?.source?.path ?? '(未记录)'}`,
  `- 抽取方式：规则抽取（\`【参考答案】\` + 双信号校验），非 LLM`,
  `- 有可靠讲解：${bank.questions.filter((q) => q.provenance?.analysis_available).length} 题`,
  '',
  '> 这份文件是给人核对的，不参与刷题。题库存的是同目录下的 JSON。',
  '',
]
for (const q of bank.questions) {
  const n = String(q.source.number ?? '').replace('set', '第').replace('-q', '套 第') + ' 题'
  lines.push(`## ${n}　答案 ${q.answer.join('')}　_(${q.provenance?.confidence} 置信度)_`, '')
  lines.push(q.stem, '')
  for (let i = 0; i < q.options.length; i += 1) {
    lines.push(`- ${'ABCD'[i]}. ${q.options[i]}`)
  }
  if (q.analysis) lines.push('', `**讲解**（${q.provenance?.analysis_kind}）：${q.analysis}`)
  else lines.push('', '**讲解**：无（源资料的讲解在页边批注里，OCR 无法可靠取出）')
  lines.push('', '---', '')
}
writeFileSync(previewPath, lines.join('\n'), 'utf8')
console.log(`\n预览文件（给人核对用）: ${previewPath}`)

console.log('\n可以开始刷了。在 LH 会话里说一句"刷片段阅读600题"即可。')
