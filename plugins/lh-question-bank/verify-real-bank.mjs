/**
 * 端到端验证：用**真实抽取出来的题库**跑一遍刷题循环。
 *
 * ═══ 它验证什么 ═══
 * 前面每一段都是分开验的：OCR 验过、对齐验过、答案提取验过、题库存盘验过。
 * 但它们**串起来**能不能用，还没验过。这个脚本就是那条串起来的链：
 *
 *   真实题库文件 → 插件装载 → list_question_banks → get_questions
 *                → submit_answer（真答案 / 假答案 / 空答案）→ get_practice_stats
 *
 * 尤其要验三件容易在"串起来"时才暴露的事：
 *   ① 抽取的答案**判分判得对**（答对判 true、答错判 false）——
 *      这检验的是"提取的答案"与"判分逻辑"是否真的相容；
 *   ② 取题**不带答案**（离线单测过，但真实题库里字段更多，要再验一次）；
 *   ③ 错题本、覆盖率在真实数据上的表现。
 *
 * 用法: node plugins/lh-question-bank/verify-real-bank.mjs <题库文件路径>
 */

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, copyFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as plugin from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
const bankFile = process.argv[2]
if (!bankFile) {
  console.error('用法: node plugins/lh-question-bank/verify-real-bank.mjs <题库文件路径>')
  process.exit(2)
}
if (!existsSync(bankFile)) {
  console.error(`题库文件不存在: ${bankFile}`)
  process.exit(2)
}

// 造一个隔离的工作区：把题库复制进去，并让事件日志也落在里面
const sandbox = join(here, '..', '..', 'data', 'real-bank-verify')
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(join(sandbox, 'lh-questions'), { recursive: true })
const bankName = '片段阅读600题'
copyFileSync(bankFile, join(sandbox, 'lh-questions', `${bankName}.json`))
process.env.LH_EVENT_LOG = join(sandbox, 'events.jsonl')

const bank = JSON.parse(readFileSync(join(sandbox, 'lh-questions', `${bankName}.json`), 'utf8'))

let passed = 0
let failed = 0
const failures = []

/**
 * 跑一个用例。
 * @param name - 用例名。
 * @param fn - 用例体。
 */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, message: error?.message ?? String(error) })
    console.log(`  FAIL ${name}\n       ${error?.message ?? String(error)}`)
  }
}

const tools = new Map()
plugin.apply({
  tools: {
    register(def) {
      tools.set(def.name, def)
    },
  },
  on() {},
})

const exec = { agent: { session: { id: 'session-real-bank', header: { cwd: sandbox } } } }
const listBanks = tools.get('list_question_banks')
const getQuestions = tools.get('get_questions')
const submit = tools.get('submit_answer')
const stats = tools.get('get_practice_stats')

console.log(`\n题库文件: ${bankFile}`)
console.log(`题数: ${bank.question_count}\n`)

console.log('══ 1. 插件能看见这个题库 ══')

let listed
await check('list_question_banks 列出它，题数一致', async () => {
  listed = await listBanks.execute({}, exec)
  const mine = listed.banks.find((b) => b.name === bankName)
  assert.ok(mine, `列表里没有 ${bankName}`)
  assert.equal(mine.ok, true, `题库被判定为不合格: ${JSON.stringify(mine.errors)}`)
  assert.equal(mine.question_count, bank.question_count)
})

console.log('\n══ 2. 取题（真实题库里的题）══')

let taken
await check('取到题，且数量正确', async () => {
  taken = await getQuestions.execute({ bank_name: bankName, count: 5 }, exec)
  assert.equal(taken.question_count, 5)
  assert.equal(taken.total_in_bank, bank.question_count)
})

await check('★ 取题结果里没有答案（真实题库字段更多，再验一次）', () => {
  for (const q of taken.questions) {
    assert.ok(!('answer' in q), `${q.id} 带了 answer`)
    assert.ok(!('analysis' in q), `${q.id} 带了 analysis`)
    assert.ok(!('accept' in q), `${q.id} 带了 accept`)
  }
  const text = getQuestions.output.render({}, taken).map((x) => x.text).join('\n')
  // 用题库里的真实答案做反向检查：渲染文本里不该出现答案字母的显式标注
  assert.ok(!/【参考答案】/.test(text), '渲染文本里出现了【参考答案】标记')
})

await check('每道题都有选项、题干非空、选项数≥2', () => {
  for (const q of taken.questions) {
    assert.ok(q.stem.length > 10, `${q.id} 题干太短: ${q.stem}`)
    assert.ok(q.options.length >= 2, `${q.id} 选项太少: ${q.options.length}`)
    for (const o of q.options) {
      assert.ok(o.label && o.text, `${q.id} 有空的选项标签或内容`)
    }
  }
})

console.log('\n══ 3. 判分：用真实答案 ══')

await check('★ 提交正确选项 → 判对，且能拿到讲解', async () => {
  const q = taken.questions[0]
  const real = bank.questions.find((x) => x.id === q.id)
  const r = await submit.execute(
    { bank_name: bankName, question_id: q.id, response: real.answer.join('、') },
    exec,
  )
  assert.equal(r.correct, true, `应判对，实际 ${r.correct}（题库答案 ${JSON.stringify(real.answer)}）`)
  assert.ok(r.analysis !== undefined, '没有返回 analysis 字段')
})

await check('★ 提交错误选项 → 判错，且标准答案正确回显', async () => {
  const q = taken.questions[1]
  const real = bank.questions.find((x) => x.id === q.id)
  const labels = real.options.map((_t, i) => 'ABCD'[i])
  const wrong = labels.find((l) => !real.answer.includes(l))
  const r = await submit.execute({ bank_name: bankName, question_id: q.id, response: wrong }, exec)
  assert.equal(r.correct, false)
  assert.deepEqual(r.answer, real.answer, '回显的标准答案与题库不一致')
})

await check('空作答 → null，不默认算错', async () => {
  const q = taken.questions[2]
  const r = await submit.execute({ bank_name: bankName, question_id: q.id, response: '', source: 'human' }, exec)
  assert.equal(r.correct, null)
})

await check('★ 全部 20 题：对答案判对、错答案判错（判分与抽取答案相容）', async () => {
  let okCount = 0
  for (const real of bank.questions) {
    const labels = real.options.map((_t, i) => 'ABCD'[i])
    const right = real.answer.join('、')
    const wrong = labels.find((l) => !real.answer.includes(l)) ?? 'A'
    const a = await submit.execute({ bank_name: bankName, question_id: real.id, response: right, source: 'human' }, exec)
    assert.equal(a.correct, true, `${real.id} 正确答案被判错（题库答案 ${JSON.stringify(real.answer)}，提交 ${right}）`)
    const b = await submit.execute({ bank_name: bankName, question_id: real.id, response: wrong, source: 'human' }, exec)
    assert.equal(b.correct, false, `${real.id} 错误答案被判对（提交 ${wrong}，题库答案 ${JSON.stringify(real.answer)}）`)
    okCount += 1
  }
  console.log(`       ${okCount} 题全部通过双向判分`)
})

console.log('\n══ 4. 进度与错题本（真实数据）══')

await check('进度统计的形状与数值合理', async () => {
  const s = await stats.execute({ bank_name: bankName }, exec)
  assert.equal(s.total_questions, bank.question_count)
  assert.equal(s.attempted_questions, bank.question_count, '每道题都做过了')
  assert.equal(s.coverage, 1, '覆盖率应为 1')
  assert.ok(s.human_correct > 0 && s.human_wrong > 0)
  assert.equal(s.human_unjudged, 1, '只有一次空作答')
  // 分母只算判得了的
  const judged = s.human_correct + s.human_wrong
  assert.equal(s.accuracy, Number((s.human_correct / judged).toFixed(4)))
  console.log(`       对=${s.human_correct} 错=${s.human_wrong} 判不了=${s.human_unjudged} 正确率=${s.accuracy}`)
})

await check('★ 错题本：受展示上限约束，且最新答错的排在最前', async () => {
  // ⚠ 这条我改过两次，值得说清"错题本"到底有几个口径：
  //   · `missed_recent` 是**给人看的列表**，默认上限 20（summarizeProgress 的 missedLimit）——
  //     所以题库 49 题时它**不可能**等于 49；
  //   · `order=missed` 是**取题池**，不设上限。
  //   第一版写的是"错题本包含全部 20 题"（当时题库恰好 20 题，撞上了上限）；
  //   扩到 49 题后这个断言在语义上就不可能成立。
  //   现在按列表的真实口径断言：长度不超过上限，且**最新答错的那一道在最前**。
  const s = await stats.execute({ bank_name: bankName }, exec)
  assert.ok(s.missed_recent.length > 0, '错题本是空的')
  assert.ok(s.missed_recent.length <= 20, `错题本超过展示上限 20：${s.missed_recent.length}`)

  // 刚刚在"全部题双向判分"那一段里，最后提交的是**错答案**（先对后错），
  // 所以最后那题应当出现在错题本最前（按 last_at 倒序）。
  const lastQuestion = bank.questions[bank.questions.length - 1]
  assert.equal(s.missed_recent[0].id, lastQuestion.id, '最新答错的题没有排在最前')
})

await check('答对后从错题本消失', async () => {
  const s1 = await stats.execute({ bank_name: bankName }, exec)
  const target = s1.missed_recent[0].id
  const real = bank.questions.find((x) => x.id === target)
  await submit.execute({ bank_name: bankName, question_id: target, response: real.answer.join('、'), source: 'human' }, exec)
  const s2 = await stats.execute({ bank_name: bankName }, exec)
  assert.ok(!s2.missed_recent.map((m) => m.id).includes(target))
})

await check('order=missed 取题：全在错题本里，且取题池不设上限', async () => {
  // ⚠ 这条原来断言 `r.question_count === s.missed_recent.length`，**那个等式从来不成立**：
  //   · `missed_recent` 是给人看的**列表**，默认上限 20（`summarizeProgress` 的 missedLimit）；
  //   · `order=missed` 是**取题池**，取的是全部"最近一次答错"的题，不设上限。
  //   题库 20 题时两个数字**巧合相等**（20 ≤ 20），扩到 49 题就露出来了。
  //
  //   现在按各自的口径断言：
  //     ① 取到的题必须都真的在题库里（id 对得上）；
  //     ② 取题池**不小于**展示列表（列表有上限，池子没有）——
  //        这条能抓住"口径被改反了"这种回归。
  const bankIds = new Set(bank.questions.map((q) => q.id))
  const r = await getQuestions.execute({ bank_name: bankName, order: 'missed', count: 999 }, exec)
  assert.ok(r.question_count > 0, 'order=missed 一道都没取到')
  assert.ok(r.question_count <= bank.question_count, '取到的题数多于题库总数')
  for (const q of r.questions) assert.ok(bankIds.has(q.id), `${q.id} 不在题库里`)

  const s = await stats.execute({ bank_name: bankName }, exec)
  assert.ok(
    r.question_count >= s.missed_recent.length,
    `取题池(${r.question_count}) 小于展示列表(${s.missed_recent.length}) —— 口径反了`,
  )
})

console.log('\n══ 5. 讲解质量（这是给 agent 讲错因用的）══')

await check('★ 讲解要么有、要么被显式标注为"没有"（不假装完整）', () => {
  // ⚠ 这条断言我改过一次。原来写的是"每题都必须有非空讲解"，
  //   但数据推翻了那个假设：这份资料是双栏/页边批注排版，
  //   真正的讲解在批注里，而 OCR 按行输出导致批注与正文交错，
  //   逐行解析无法可靠地把批注挂到正确的题上（实测 20 题只捞回 3 题且会串题）。
  //
  //   所以正确的断言不是"必须有讲解"，而是**诚实性**：
  //   有就有，没有就必须在 provenance 里显式标出来，且说明是哪一种。
  //   一段读不通的"讲解"比没有讲解更糟——agent 会以为那是原文。
  const withAnalysis = bank.questions.filter((q) => q.analysis && q.analysis.trim() !== '')
  const withoutAnalysis = bank.questions.filter((q) => !q.analysis || q.analysis.trim() === '')
  const kinds = new Set(['原文', '选项标注拼成', '无'])
  for (const q of bank.questions) {
    assert.ok(
      typeof q.provenance?.analysis_available === 'boolean',
      `${q.id} 缺 provenance.analysis_available —— 无法区分"本来没讲解"与"抽取失败"`,
    )
    assert.equal(
      q.provenance.analysis_available,
      Boolean(q.analysis && q.analysis.trim() !== ''),
      `${q.id} 的 analysis_available 与实际内容不一致`,
    )
    assert.ok(kinds.has(q.provenance.analysis_kind), `${q.id} 的 analysis_kind 非法: ${q.provenance.analysis_kind}`)
  }
  console.log(`       有讲解 ${withAnalysis.length} 题（其中拼成的 ${bank.questions.filter((q) => q.provenance.analysis_kind === '选项标注拼成').length} 题）`)
  console.log(`       无讲解 ${withoutAnalysis.length} 题（已显式标注 analysis_available=false，agent 会自己去讲）`)
})

await check('★ 讲解为空时不得留下"读不通的批注"充数', () => {
  // 空讲解可以接受；但"把错序的批注塞进 analysis"不可接受。
  // 判据：讲解里不该出现明显的批注碎片特征（单字行、无标点的短片段混排）。
  const suspicious = bank.questions.filter((q) => {
    const a = (q.analysis || '').trim()
    if (!a) return false
    // 若讲解里出现"花生批注"等批注标记，说明有人把批注当讲解塞了进来
    return /花生批注|行文结构：|批注：/.test(a)
  })
  assert.equal(suspicious.length, 0, `${suspicious.length} 题的讲解里混进了批注碎片: ${suspicious.slice(0, 3).map((q) => q.id)}`)
})

await check('讲解里没有推广文字（微信/资料群）', () => {
  const bad = bank.questions.filter((q) => /微信|SKA\d|公考最新资料|更新进度|公众号/.test(q.analysis || ''))
  assert.equal(bad.length, 0, `${bad.length} 题的讲解里残留推广文字: ${bad.slice(0, 3).map((q) => q.id)}`)
})

await check('题干里没有页眉页脚污染', () => {
  const bad = bank.questions.filter((q) => /四海公考|SIHAIGONGKAO|练习题\d+套$/.test(q.stem))
  assert.equal(bad.length, 0, `${bad.length} 题的题干里有页眉页脚: ${bad.slice(0, 3).map((q) => q.id)}`)
})

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
  process.exit(1)
}
console.log('全部通过。\n')
