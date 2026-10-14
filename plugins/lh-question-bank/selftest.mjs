/**
 * 题库对象层的离线自测。
 *
 * ═══ 它测什么、不测什么 ═══
 * 不测"能不能跑"（那只证明语法对）。它测**我写 schema 时做的判断对不对**：
 * 尤其是 id 对 OCR 噪声的容忍度——那是整个题库里最贵的一条约定，
 * 一旦错了，已经落盘的所有题目都要重新编号，下游断言与作答记录全部失联。
 *
 * 运行：node plugins/lh-question-bank/selftest.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  deriveQuestionId,
  normalizeAnswer,
  normalizeQuestion,
  normalizeQuestionList,
  buildBank,
  validateBank,
  pickQuestions,
  fingerprintStem,
  BANK_SCHEMA_VERSION,
} from './question.js'
import { judgeAttempt, buildAttempt, extractAttempts, summarizeAttempts, ATTEMPT_SOURCES } from './attempt.js'
import {
  loadModelWhitelist,
  isWhitelistedModel,
  assertWhitelistedModel,
  FALLBACK_WHITELIST_COMBOS,
} from '@lh/model-tier/model'

/**
 * 测试夹具用的**假资料根**。
 *
 * ⚠ 它不是要真的存在的目录——它只是参与题目 id 派生的一个**字符串标签**
 * （见 `deriveQuestionId`）。所以这里可以写一个固定的盘符路径，
 * 而**运行时代码里不行**（那会让插件在别人机器上读错目录）。
 */
const FIXTURE_SOURCE_ROOT = 'D:\\考公资料' // lh-path-ok: 测试夹具；只是 id 派生用的字符串标签，不需要真实存在

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '..', 'data', 'question-bank-test')

let passed = 0
let failed = 0
const failures = []

/**
 * 跑一个用例。
 *
 * @param name - 用例名。
 * @param fn - 用例体。
 */
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, message: error?.message ?? String(error) })
    console.log(`  FAIL ${name}\n       ${error?.message ?? String(error)}`)
  }
}

console.log('\n══ 1. 答案归一化 ══')

check("单个字母 'A' → ['A']", () => {
  assert.deepEqual(normalizeAnswer('A', 'single_choice'), ['A'])
})

check("顿号分隔 'A、C' → ['A','C']（多选）", () => {
  assert.deepEqual(normalizeAnswer('A、C', 'multiple_choice'), ['A', 'C'])
})

check("连写 'AC' + 多选 → 拆成 ['A','C']", () => {
  assert.deepEqual(normalizeAnswer('AC', 'multiple_choice'), ['A', 'C'])
})

// ★ 这条是本次修正的核心：同一个输入 'AB'，填空题型下不能被拆
check("连写 'AB' + 填空 → 保留 ['AB']（不拆！）", () => {
  assert.deepEqual(normalizeAnswer('AB', 'fill_blank'), ['AB'])
})

check("数字答案 '42' → ['42']", () => {
  assert.deepEqual(normalizeAnswer(42, 'fill_blank'), ['42'])
})

check("数组输入原样归一 ['a','','b'] → ['a','b']", () => {
  assert.deepEqual(normalizeAnswer(['a', ' ', 'b'], 'multiple_choice'), ['a', 'b'])
})

check('undefined → []（不是抛错，由校验层报）', () => {
  assert.deepEqual(normalizeAnswer(undefined, 'single_choice'), [])
})

console.log('\n══ 2. id 稳定性（schema 里最贵的约定）══')

const ocr = { sourceRoot: FIXTURE_SOURCE_ROOT, sourceFile: '行测/常识判断.pdf', number: 17, stem: '下列关于我国宪法的说法，正确的是：' }

check('同输入 → 同 id（幂等重导）', () => {
  assert.equal(deriveQuestionId(ocr), deriveQuestionId({ ...ocr }))
})

check('空白差异不影响 id（OCR 最常见的噪声）', () => {
  const noisy = { ...ocr, stem: '下列关于我国宪法的说法， 正确的是： ' }
  assert.equal(deriveQuestionId(ocr), deriveQuestionId(noisy))
})

check('全角/半角标点差异不影响 id', () => {
  const half = { ...ocr, stem: '下列关于我国宪法的说法,正确的是:' }
  assert.equal(deriveQuestionId(ocr), deriveQuestionId(half))
})

// 注意：指纹取的是**压缩后**文本的前 40 字，所以造数据时必须先算清压缩后的长度。
// 下面 base 压缩后是 19 字，补 '甲' 到 45 字，分叉点才落在 40 字之外。
const longBase = '下列关于我国宪法的说法，正确的是：' // 压缩后 19 字（去空白/标点映射后）
// 标点被映射成半角但**不删除**，所以 '，' 和 '：' 仍各占 1 字 → 实际压缩后 19 字
const paddedStem = (tail) => longBase + '甲'.repeat(30) + tail

check('★ 分叉点落在前 40 字**之内** → id 不同（前 40 字是身份的一部分）', () => {
  const a = { ...ocr, stem: '甲'.repeat(35) + '尾巴A' }
  const b = { ...ocr, stem: '甲'.repeat(35) + '尾巴B' }
  assert.notEqual(deriveQuestionId(a), deriveQuestionId(b))
})

check('★ 分叉点落在前 40 字**之外** → id 相同（长题干尾部噪声被容忍）', () => {
  const a = { ...ocr, stem: paddedStem('结尾A') }
  const b = { ...ocr, stem: paddedStem('结尾B') }
  // 先确认造的数据确实越过了边界，否则这条用例是假通过
  const compressedLen = fingerprintStem(paddedStem('结尾A')).length
  assert.ok(compressedLen > 40, `造的数据压缩后只有 ${compressedLen} 字，没越过 40 字边界，用例无效`)
  assert.equal(deriveQuestionId(a), deriveQuestionId(b))
})

check('不同题号 → 不同 id（防重排版错位）', () => {
  assert.notEqual(deriveQuestionId(ocr), deriveQuestionId({ ...ocr, number: 18 }))
})

check('不同文件 → 不同 id', () => {
  assert.notEqual(deriveQuestionId(ocr), deriveQuestionId({ ...ocr, sourceFile: '行测/言语理解.pdf' }))
})

check('id 形状：q- + 12 位 hex', () => {
  assert.match(deriveQuestionId(ocr), /^q-[0-9a-f]{12}$/)
})

console.log('\n══ 3. 题目校验：该报错的必须报错 ══')

const origin = { sourceRoot: FIXTURE_SOURCE_ROOT, sourceFile: '行测/常识.pdf', number: 1 }

check('缺题干 → 抛错（不静默补默认值）', () => {
  assert.throws(() => normalizeQuestion({ raw: { stem: '  ', options: ['a'] }, origin }), /缺题干/)
})

check('缺答案 → 抛错', () => {
  assert.throws(() => normalizeQuestion({ raw: { stem: '题干', options: ['a'] }, origin }), /答案无法解析/)
})

check('★ 答案标签超出选项数 → 抛错（能机械查出的错就不放过）', () => {
  assert.throws(
    () => normalizeQuestion({ raw: { stem: '题干', options: ['a', 'b', 'c', 'd'], answer: 'E', kind: 'single_choice' }, origin }),
    /不是有效选项标签/,
  )
})

check('单选题给了两个答案 → 抛错', () => {
  assert.throws(
    () => normalizeQuestion({ raw: { stem: '题干', options: ['a', 'b'], answer: 'A、B', kind: 'single_choice' }, origin }),
    /单选题有 2 个答案/,
  )
})

check('多选题两个答案 → 通过，且大写归一', () => {
  const q = normalizeQuestion({ raw: { stem: '题干', options: ['a', 'b', 'c'], answer: 'a,c', kind: 'multiple_choice' }, origin })
  assert.deepEqual(q.answer, ['A', 'C'])
})

check('题型缺失时按选项机械推断', () => {
  const single = normalizeQuestion({ raw: { stem: '题干', options: ['a', 'b'], answer: 'A' }, origin })
  assert.equal(single.kind, 'single_choice')
  const fill = normalizeQuestion({ raw: { stem: '填空', answer: 'AB' }, origin })
  assert.equal(fill.kind, 'fill_blank')
  assert.deepEqual(fill.answer, ['AB'], '填空题推断后答案不能被拆')
})

check('topics 缺省为空数组（合法状态，不是"未填写"）', () => {
  const q = normalizeQuestion({ raw: { stem: '题干', answer: 'x' }, origin })
  assert.deepEqual(q.topics, [])
})

// ── topics 过词表（docs/archive/decisions/021 结论七）──────────────────────────────
//
// 这一节测的是**本次改动**：`topics` 从"原样存下字符串"改成"过封闭词表"。
// 判据在动手前就写好了，不是跑出来才补的。

check('★ topics 归一化：别名收成规范名，且题型在前、领域在后', () => {
  const q = normalizeQuestion({
    raw: { stem: '题干', options: ['甲', '乙'], answer: 'A', topics: ['片段阅读', '主旨概括'] },
    origin,
  })
  // 输入顺序是"领域在前"，输出必须是"题型在前"——数组本身要能看出两轴
  assert.deepEqual(q.topics, ['中心理解', '片段阅读'])
})

check('★ 内容词被拦在 topics 之外，且如实进 unmapped_topics（不丢弃、不报错）', () => {
  const q = normalizeQuestion({
    raw: { stem: '题干', options: ['甲', '乙'], answer: 'A', topics: ['纳米金属', '削弱论证', '相声'] },
    origin,
  })
  assert.deepEqual(q.topics, ['削弱论证'], '只有词表里的那个能进 topics')
  assert.deepEqual(q.unmapped_topics, ['纳米金属', '相声'], '认不出的必须如实带着走')
})

check('★ 带括号的变体能归到干净规范名（模型真实会这么写）', () => {
  const q = normalizeQuestion({
    raw: { stem: '题干', options: ['甲', '乙'], answer: 'A', topics: ['削弱论证题（除哪项外）'] },
    origin,
  })
  assert.deepEqual(q.topics, ['削弱论证'])
  assert.deepEqual(q.unmapped_topics, [])
})

check('★ 批处理汇总 unmapped_topics —— 否则"词表缺什么"永远是静默的', () => {
  const b = normalizeQuestionList({
    rawList: [
      { number: 1, stem: '一', options: ['甲', '乙'], answer: 'A', topics: ['火星词A', '中心理解'] },
      { number: 2, stem: '二', options: ['甲', '乙'], answer: 'A', topics: ['火星词A', '火星词B'] },
    ],
    origin,
    provenance: { plugin: 'lh-test', version: '0.1.0' },
  })
  assert.deepEqual(b.unmappedTopics, ['火星词A', '火星词B'], '去重且保持出现顺序')
  assert.deepEqual(b.questions[0].topics, ['中心理解'])
  assert.deepEqual(b.questions[1].topics, [], '一个都认不出时是空数组，不是原样留下')
})

check('出处完整落到 source 字段', () => {
  const q = normalizeQuestion({ raw: { stem: '题干', answer: 'x' }, origin, provenance: { plugin: 'lh-x', version: '0.1.0' } })
  assert.equal(q.source.path, '行测/常识.pdf')
  assert.equal(q.source.number, 1)
  assert.equal(q.provenance.plugin, 'lh-x')
})

console.log('\n══ 4. 批量导入：收集错误而不是遇错即停 ══')

const batchRaw = [
  { number: 1, stem: '第一题', options: ['甲', '乙'], answer: 'A' },
  { number: 2, stem: '', options: ['甲'], answer: 'A' }, // 坏题：缺题干
  { number: 3, stem: '第三题', answer: '对' },
]
const batch = normalizeQuestionList({ rawList: batchRaw, origin, provenance: { plugin: 'lh-test', version: '0.1.0' } })

check('2 题通过、1 题报错，且报错带 index', () => {
  assert.equal(batch.questions.length, 2)
  assert.equal(batch.errors.length, 1)
  assert.equal(batch.errors[0].index, 1)
})

check('坏题不影响好题的题号（第 3 题仍是 3）', () => {
  assert.equal(batch.questions[1].source.number, 3)
})

console.log('\n══ 5. 题库组装与读回 ══')

const bank = buildBank({ questions: batch.questions, meta: { title: '测试题库', sourceRoot: origin.sourceRoot, provenance: { plugin: 'lh-test', version: '0.1.0' } } })

check('question_count 与实际题数一致', () => {
  assert.equal(bank.question_count, 2)
})

check('validateBank 通过', () => {
  const v = validateBank(bank)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
})

check('★ 同一批里的重复 id 如实报告，不静默吞掉', () => {
  const dup = buildBank({ questions: [batch.questions[0], batch.questions[0]], meta: {} })
  assert.equal(dup.question_count, 1)
  assert.deepEqual(dup.duplicate_ids, [batch.questions[0].id])
})

check('validateBank 能查出被篡改的 question_count', () => {
  const broken = { ...bank, question_count: 99 }
  assert.equal(validateBank(broken).ok, false)
})

check('validateBank 能查出非法题型', () => {
  const broken = { ...bank, questions: [{ ...bank.questions[0], kind: 'essay' }] }
  assert.equal(validateBank(broken).ok, false)
})

check('pickQuestions 按 id 取题', () => {
  const picked = pickQuestions({ bank, ids: [bank.questions[0].id, 'q-不存在'] })
  assert.equal(picked.length, 1)
})

check('落盘 → 读回 → 校验，全链路无损', () => {
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, '测试题库.json')
  writeFileSync(file, JSON.stringify(bank, null, 2), 'utf8')
  const readBack = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(readBack.schema_version, BANK_SCHEMA_VERSION)
  const v = validateBank(readBack)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.deepEqual(readBack.questions.map((q) => q.id), bank.questions.map((q) => q.id))
  console.log(`       落盘于 ${file}`)
})

console.log('\n══ 6. 判分：判不了就说判不了 ══')

const single = normalizeQuestion({ raw: { stem: '单选题', options: ['甲', '乙', '丙', '丁'], answer: 'B', kind: 'single_choice' }, origin })
const multi = normalizeQuestion({ raw: { stem: '多选题', options: ['甲', '乙', '丙', '丁'], answer: 'A、C', kind: 'multiple_choice' }, origin })
const fill = normalizeQuestion({ raw: { stem: '我国法定结婚年龄是____周岁。', answer: '22', accept: ['二十二'], kind: 'fill_blank' }, origin })

check('单选：答对', () => {
  assert.equal(judgeAttempt({ question: single, response: 'B' }), true)
})

check('单选：小写标签也算对（人不该因为大小写被判错）', () => {
  assert.equal(judgeAttempt({ question: single, response: 'b' }), true)
})

check('单选：答错', () => {
  assert.equal(judgeAttempt({ question: single, response: 'C' }), false)
})

check('多选：顺序无关，集合相等即对', () => {
  assert.equal(judgeAttempt({ question: multi, response: ['C', 'A'] }), true)
  assert.equal(judgeAttempt({ question: multi, response: 'AC' }), true)
})

check('多选：漏选算错（不是部分分）', () => {
  assert.equal(judgeAttempt({ question: multi, response: 'A' }), false)
})

check('多选：多选算错', () => {
  assert.equal(judgeAttempt({ question: multi, response: 'A、B、C' }), false)
})

check('填空：标准答案对', () => {
  assert.equal(judgeAttempt({ question: fill, response: '22' }), true)
})

check('★ 填空：accept 里的替代写法也算对（否则答对的人被判错）', () => {
  assert.equal(judgeAttempt({ question: fill, response: '二十二' }), true)
})

check('填空：忽略空白与大小写', () => {
  assert.equal(judgeAttempt({ question: fill, response: ' 22 ' }), true)
})

check('填空：真答错', () => {
  assert.equal(judgeAttempt({ question: fill, response: '20' }), false)
})

check('★ 判不了 → null（不能默认算错）', () => {
  assert.equal(judgeAttempt({ question: single, response: '' }), null)
  assert.equal(judgeAttempt({ question: null, response: 'A' }), null)
  assert.equal(judgeAttempt({ question: { kind: 'single_choice', answer: [] }, response: 'A' }), null)
})

console.log('\n══ 7. 作答事件 ══')

check('来源必须是 human / llm / imported', () => {
  assert.throws(() => buildAttempt({ question: single, response: 'B', source: 'robot' }), /source 非法/)
})

check('correct 只能是 true/false/null', () => {
  assert.throws(() => buildAttempt({ question: single, response: 'B', correct: 'yes' }), /correct 只能是/)
})

check('省略 correct 时自动判分', () => {
  const a = buildAttempt({ question: single, response: 'B' })
  assert.equal(a.correct, true)
})

check('★ 原始作答原样保留（读细）', () => {
  const a = buildAttempt({ question: multi, response: ['c', 'a'] })
  assert.deepEqual(a.response, ['c', 'a'], '不能被归一化掉——归一化是判分时的事')
})

check('无会话时 context 显式写 null（区分"没有"与"没记"）', () => {
  const a = buildAttempt({ question: single, response: 'B' })
  assert.equal(a.context.session_ref, null)
  assert.equal(a.context.seq, null)
})

check('带上下文时记录会话与序号', () => {
  const a = buildAttempt({ question: single, response: 'B', sessionRef: 'session-abc', seq: 42 })
  assert.equal(a.context.session_ref, 'session-abc')
  assert.equal(a.context.seq, 42)
})

console.log('\n══ 8. 作答记录读取与统计 ══')

const fakeEvents = [
  { id: 'e1', type: 'lh/user/attempt', timestamp: '2026-09-18T01:00:00.000Z', data: buildAttempt({ question: single, response: 'B' }) },
  { id: 'e2', type: 'lh/user/attempt', timestamp: '2026-09-18T01:01:00.000Z', data: buildAttempt({ question: single, response: 'C' }) },
  { id: 'e3', type: 'lh/user/attempt', timestamp: '2026-09-18T01:02:00.000Z', data: buildAttempt({ question: multi, response: 'AC', source: 'llm' }) },
  { id: 'e4', type: 'lh/user/attempt', timestamp: '2026-09-18T01:03:00.000Z', data: buildAttempt({ question: fill, response: '' }) },
  { id: 'e5', type: 'lh/resource/questions-imported', data: { whatever: true } }, // 不是作答事件，应被忽略
  { id: 'e6', type: 'lh/user/attempt', data: { question_id: '', correct: true, source: 'human' } }, // 坏记录
]

const extracted = extractAttempts(fakeEvents)

check('筛出 4 条作答，忽略无关事件', () => {
  assert.equal(extracted.attempts.length, 4)
})

check('★ 坏记录如实报告，不静默丢弃', () => {
  assert.equal(extracted.malformed.length, 1)
  assert.match(extracted.malformed[0].reason, /缺 question_id/)
})

const summary = summarizeAttempts({ attempts: extracted.attempts })

check('total / correct / wrong / unjudged 分别统计', () => {
  assert.equal(summary.total, 4)
  assert.equal(summary.correct, 2) // single 对 + llm 多选对
  assert.equal(summary.wrong, 1)
  assert.equal(summary.unjudged, 1) // 空作答
})

check('★ 正确率分母只算判得了的（1+2 之外的那条不算进去）', () => {
  assert.equal(summary.accuracy, Number((2 / 3).toFixed(4)))
})

check('★ 按来源分组：模型答对不会被算成"我会了"', () => {
  assert.equal(summary.by_source.human.total, 3)
  assert.equal(summary.by_source.human.correct, 1)
  assert.equal(summary.by_source.human.unjudged, 1)
  assert.equal(summary.by_source.llm.total, 1)
  assert.equal(summary.by_source.llm.correct, 1)
})

check('按题聚合，记录最后作答时间', () => {
  const s = summary.per_question[single.id]
  assert.equal(s.attempts, 2)
  assert.equal(s.correct, 1)
  assert.equal(s.wrong, 1)
  assert.equal(s.last_at, '2026-09-18T01:01:00.000Z')
})

check('★ 按题聚合时也记下"上一次答了什么"（作答历史反馈的数据来源）', () => {
  // 这一条是"这题你做过、上次你选了什么"的来源。
  //
  // ⚠ 断言的是**不变量**，不是手算出来的值：
  // last_at / last_response / last_correct **必须来自同一次作答**。
  // 若分几处更新（一个按时间、一个按遍历顺序），字段会互相错位，
  // 界面就会显示"上次答了 X"却配着另一个时间——而且**没人会发现**。
  // 手写期望值（第一版写的 `true`）只是把夹具的顺序抄了一遍，抄错就变成假红。
  const s = summary.per_question[single.id]
  const mine = extracted.attempts.filter((a) => a.question_id === single.id)
  const latest = mine.reduce((a, b) => (String(a.timestamp ?? '') > String(b.timestamp ?? '') ? a : b))

  assert.ok('last_response' in s, '缺 last_response')
  assert.ok('last_correct' in s, '缺 last_correct')
  assert.equal(typeof s.last_response, 'string', 'last_response 应当是字符串（可直接显示）')
  assert.equal(s.last_at, latest.timestamp, 'last_at 与"最后一次作答"不一致')
  assert.equal(
    s.last_response,
    Array.isArray(latest.response) ? latest.response.join('、') : String(latest.response ?? ''),
    'last_response 不是**最后那一次**的作答 —— 三个字段错位了',
  )
  assert.equal(
    s.last_correct,
    latest.correct === true ? true : latest.correct === false ? false : null,
    'last_correct 不是**最后那一次**的判定 —— 三个字段错位了',
  )
})

check('★ 没有任何可判数据时正确率是 null，不是 0', () => {
  const empty = summarizeAttempts({ attempts: [] })
  assert.equal(empty.accuracy, null)
  assert.equal(empty.total, 0)
})

console.log('\n══ 9. 模型白名单（T4.1 堵漏：agent 不得自选计费模型）══')

// 这一节测的是**授权集语义**，不是语法：白名单的判断错一处，
// 后果要么是计费模型被放进来（真金白银损失），要么是默认路径被自己的闸拒掉
// （插件全废）。所以每条断言都对着一个具体的事故形状写。

mkdirSync(outDir, { recursive: true })

// 一个“合法”配置：故意带 BOM 写盘——真实配置是手工编辑的，BOM 必须容忍
const wlGoodPath = join(outDir, 'wl-good.json')
const wlGoodText = JSON.stringify(
  {
    flash: [{ provider: 'xiaomi-token-plan-ams', model: 'mimo-v2.5-pro' }],
    extract: [{ provider: 'xiaomi-token-plan-ams', model: 'mimo-v2.5' }],
    balance: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
  },
  null,
  2,
)
writeFileSync(wlGoodPath, String.fromCharCode(0xfeff) + wlGoodText, 'utf8')

// 一个“被改坏”的配置：坏条目 + 非数组档位 + 一条好的
const wlMixedPath = join(outDir, 'wl-mixed.json')
writeFileSync(
  wlMixedPath,
  JSON.stringify(
    {
      flash: 'oops', // 档位不是数组
      balance: [{ provider: '', model: 'x' }, { model: 'only-model' }, { provider: 'deepseek-official', model: 'deepseek-flash' }],
    },
    null,
    2,
  ),
  'utf8',
)

const wlBrokenPath = join(outDir, 'wl-broken.json')
writeFileSync(wlBrokenPath, '{ 这不是合法 JSON', 'utf8')

const wlMissingPath = join(outDir, 'wl-missing.json')

const good = loadModelWhitelist(wlGoodPath)
const captured = []
const fakeStore = { append: (e) => { captured.push(e); return e } }

check('合法配置读出全部组合（含 extract 档，BOM 容忍）', () => {
  assert.equal(good.notes.length, 0, `不该有 note：${good.notes.join('；')}`)
  assert.equal(good.combos.length, 3)
  assert.ok(good.combos.some((c) => c.provider === 'xiaomi-token-plan-ams' && c.model === 'mimo-v2.5'), 'extract 档必须读出来（from_source 的默认模型靠它）')
})

check('provider+model 都给 → 严格按组合命中才放行', () => {
  assert.equal(isWhitelistedModel(good, { provider: 'xiaomi-token-plan-ams', model: 'mimo-v2.5-pro' }), true)
  assert.equal(isWhitelistedModel(good, { provider: 'xiaomi-token-plan-ams', model: 'mimo-v2.5' }), true)
})

check('只给 model（记账入参）→ 按 model 名单校验', () => {
  assert.equal(isWhitelistedModel(good, { model: 'deepseek-flash' }), true)
  assert.equal(isWhitelistedModel(good, { model: 'gpt-4o' }), false)
})

check('★ 跨档混搭被拒（事故 B 的组合形状）：deepseek-official + mimo-v2.5', () => {
  // 两个 id 各自都在白名单里，但**组合**不在——严格组合就是防这种自选拼装
  assert.equal(isWhitelistedModel(good, { provider: 'deepseek-official', model: 'mimo-v2.5' }), false)
})

check('空 model 一律不放行（未给 model 不等于随便用）', () => {
  assert.equal(isWhitelistedModel(good, {}), false)
  assert.equal(isWhitelistedModel(good, { model: '  ' }), false)
})

check('合法组合过闸：不抛错、不记账', () => {
  const before = captured.length
  assert.doesNotThrow(() => assertWhitelistedModel({ provider: 'xiaomi-token-plan-ams', model: 'mimo-v2.5-pro', whitelist: good, store: fakeStore }))
  assert.equal(captured.length, before, '放行时不该写拒绝事件')
})

check('★ 非法 model 被拒，错误指明「须由使用者改配置，agent 不得自选计费模型」', () => {
  assert.throws(
    () => assertWhitelistedModel({ model: 'gpt-4o', whitelist: good, tool: 'import_questions', store: fakeStore }),
    (e) => {
      assert.match(e.message, /模型不在白名单/)
      assert.match(e.message, /gpt-4o/)
      assert.match(e.message, /须由使用者改配置，agent 不得自选计费模型/)
      return true
    },
  )
})

check('★ 拒绝前先记账：lh/security/rejected-model 事件带 requested_provider/model 与 tool', () => {
  const evs = captured.filter((e) => e.type === 'lh/security/rejected-model')
  assert.equal(evs.length, 1)
  assert.equal(evs[0].data.tool, 'import_questions')
  assert.equal(evs[0].data.requested_model, 'gpt-4o')
  assert.equal(evs[0].data.requested_provider, null)
  assert.equal(evs[0].data.reason, 'not-in-model-whitelist')
})

check('★ 记账失败不掩盖拒绝（审计线索丢了要在错误里说出来）', () => {
  const brokenStore = { append: () => { throw new Error('磁盘满了') } }
  assert.throws(
    () => assertWhitelistedModel({ model: 'gpt-4o', whitelist: good, store: brokenStore }),
    (e) => {
      assert.match(e.message, /须由使用者改配置/, '拒绝本身必须照常发生')
      assert.match(e.message, /记账失败/, `记账失败要带进错误信息：${e.message}`)
      return true
    },
  )
})

const mixed = loadModelWhitelist(wlMixedPath)

check('★ 有效文件里的坏条目只排除、留痕，**不补默认**（补默认=放松拒绝面）', () => {
  assert.equal(mixed.combos.length, 1, `只该剩 1 条好的，实际 ${JSON.stringify(mixed.combos)}`)
  assert.deepEqual(mixed.combos[0], { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.ok(mixed.notes.length >= 3, `坏档位+坏条目都该留 note，实际：${mixed.notes.join('；')}`)
  // 关键判据：DEFAULT_TIERS 里有但文件里没有的组合，必须**不在**白名单里
  assert.equal(isWhitelistedModel(mixed, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }), false)
})

check('整个文件不可读/不是 JSON → 退兜底组合（并留 note）', () => {
  for (const p of [wlMissingPath, wlBrokenPath]) {
    const wl = loadModelWhitelist(p)
    assert.equal(wl.notes.length, 1, `${p} 该留 1 条 note`)
    assert.deepEqual(
      wl.combos.map((c) => `${c.provider}/${c.model}`).sort(),
      [...FALLBACK_WHITELIST_COMBOS].map((c) => `${c.provider}/${c.model}`).sort(),
    )
  }
})

check('★ 兜底组合必须含 extract 默认（否则配置一坏，from_source 默认路径被自己的闸拒）', () => {
  assert.ok(
    [...FALLBACK_WHITELIST_COMBOS].some((c) => c.provider === 'xiaomi-token-plan-ams' && c.model === 'mimo-v2.5'),
    '兜底组合缺 xiaomi-token-plan-ams/mimo-v2.5',
  )
})

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
  process.exit(1)
}
console.log('全部通过。\n')
