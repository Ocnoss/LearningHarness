/**
 * @lh/question-bank-ui 的**离线自测** —— 只测 `view.js`（纯函数层）。
 *
 * ═══ 为什么这一层能离线测 ═══
 * `view.js` 的入参是**已经读好的** `banks` / `events` / `archived`，它不碰文件系统、
 * 不碰宿主服务。所以"计数对不对、join 对不对、分页边界对不对"这些**判断性**的东西
 * 可以在这里精确地测——不用起 dsh，也不用往真实学习史里写数据。
 * （接缝那一层——路由、字段白名单、归档真的落了盘——由 `selftest-routes.mjs` 用假 req/res 真跑。）
 *
 * 跑法：node plugins/lh-question-bank-ui/selftest.mjs
 */

import assert from 'node:assert/strict'

// 统计口径**走生产实现**（不在测试里另抄一份三态判断——抄的那份会和本体漂移，
// 于是测的是副本而不是本体。这是本项目的老纪律）
import { extractAttempts, summarizeAttempts } from '@lh/question-bank/attempt'

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  VIEW_KINDS,
  CORRECT_FILTERS,
  QUESTION_STATE_FILTERS,
  clampLimit,
  clampOffset,
  previewStem,
  isInside,
  indexQuestions,
  summarizeBankAttempts,
  buildBankList,
  buildSource,
  buildQuestions,
  buildAttempts,
  normalizeScope,
  scopeAttempts,
  answerText,
  VERDICT_FILTERS,
  answererOf,
  availableAnswerers,
  selectByAnswerers,
  parseAnswerers,
} from './view.js'

// 判决与部分正确的**唯一实现**在 @lh/question-bank/attempt（视图层只是转发），
// 所以这里也直接引它来测——不在测试里另抄一份判定。
import { isPartial, verdictOf } from '@lh/question-bank/attempt'

// ══════════════════════════════════════════════════════════════════════════
// 夹具路径（集中在这里，理由写一行）
//
// 它们都是**字符串标签**，不需要真实存在：题库的 `source_root` / 文件路径只参与
// "显示与归属判断"（`isInside` / 来源分组），测试不会真去读这些路径。
// 闸门 `check-hardcoded-paths` 要求写死盘符的行必须带理由，所以在这一处集中声明，
// 而不是把标记撒到二十行上——那样标记会退化成"看到红就加一句"。
// ══════════════════════════════════════════════════════════════════════════
const FIXTURE_SOURCE_ROOT = 'D:\\资料' // lh-path-ok: 测试夹具；只是题库 source_root 的字符串标签
const FIXTURE_BANK_DIR = 'X:\\ws\\lh-questions' // lh-path-ok: 测试夹具；给"题库文件路径"一个形状，不读它
const FIXTURE_OTHER_WS = 'D:\\LHtest' // lh-path-ok: 测试夹具；用来断言"导入事件的落点在别的工作区"

let passed = 0
let failed = 0
const failures = []

/** 跑一个用例。 */
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

// ══════════════════════════════════════════════════════════════════════════
// 夹具：两个题库 + 一批事件（含判不了、孤儿、形状不合法三种真实会出现的形状）
// ══════════════════════════════════════════════════════════════════════════

const T = {
  a1: '2026-09-17T15:10:51.557Z',
  a2: '2026-09-17T15:11:00.000Z',
  a3: '2026-09-18T09:00:00.000Z',
  b1: '2026-09-19T08:06:01.065Z',
  orphan: '2026-09-21T09:56:34.338Z',
}
const S1 = 'session-1111-aaaa'
const S2 = 'session-2222-bbbb'

const bankA = {
  schema_version: 1,
  title: 'A库',
  source_root: FIXTURE_SOURCE_ROOT,
  generated_at: '2026-09-17T15:00:00.000Z',
  provenance: { plugin: '@lh/extractor', version: '0.0.1', extraction: 'rule', merged: true },
  question_count: 3,
  duplicate_ids: [],
  questions: [
    { id: 'q-a1', kind: 'single_choice', stem: '甲题：这段文字旨在说明？', options: ['选项一', '选项二'], answer: ['A'], accept: [], analysis: '甲解析', topics: ['片段阅读'], unmapped_topics: [], source: { path: 'f1.pdf', number: '1', page: 3 }, provenance: {} },
    { id: 'q-a2', kind: 'single_choice', stem: '乙题：接下来最可能讲的是？', options: ['甲', '乙'], answer: ['B'], accept: [], analysis: '', topics: [], unmapped_topics: ['新词'], source: { path: 'f1.pdf', number: '2', page: 3 }, provenance: {} },
    { id: 'q-a3', kind: 'fill_blank', stem: '丙题：填入横线处最恰当的是？', options: [], answer: ['42'], accept: [], analysis: '丙解析', topics: [], unmapped_topics: [], source: { path: 'f2.pdf', number: '1' }, provenance: {} },
  ],
}

const bankB = {
  schema_version: 1,
  title: 'B库',
  source_root: null,
  generated_at: '2026-09-17T15:00:00.000Z',
  provenance: { plugin: '@lh/extractor', version: '0.1.0', model: 'mimo-v2.5' },
  question_count: 1,
  duplicate_ids: [],
  questions: [
    { id: 'q-b1', kind: 'single_choice', stem: '丁题？', options: ['A', 'B'], answer: ['A'], accept: [], analysis: '丁解析', topics: [], unmapped_topics: [], source: { path: 'g1.pdf', number: '7' }, provenance: {} },
  ],
}

const banks = [
  { name: 'A库', path: FIXTURE_BANK_DIR + '\\A库.json', ok: true, errors: [], bank: bankA },
  { name: 'B库', path: FIXTURE_BANK_DIR + '\\B库.json', ok: true, errors: [], bank: bankB },
]

/** 造一条作答事件（`extras` 用来加 2026-10-13 新增的 model / 分数字段）。 */
const attempt = (questionId, response, correct, source, timestamp, sessionRef, extras = {}) => ({
  id: `e-${questionId}-${timestamp}`,
  timestamp,
  actor: source,
  type: 'lh/user/attempt',
  provenance: { plugin: '@lh/question-bank', version: '0.0.1' },
  scope: 'root',
  session_ref: sessionRef ?? null,
  content_ref: null,
  data: {
    question_id: questionId,
    response,
    correct,
    source,
    model: extras.model ?? null,
    score_got: extras.scoreGot ?? null,
    score_total: extras.scoreTotal ?? null,
    duration_ms: null,
    context: { session_ref: sessionRef ?? null, seq: null },
  },
})

const events = [
  { id: 'e-other', timestamp: T.a1, type: 'lh/course/created', data: {} },
  attempt('q-a1', 'A', true, 'human', T.a1, S1),
  attempt('q-a1', 'B', false, 'human', T.a2, S1),
  attempt('q-a3', '42', true, 'llm', T.a3, S2, { model: 'mimo-v2.5' }),
  // 一条**部分正确**的模型作答（6/12）：判决由 correct + 分数**派生**，三态本身没被改
  attempt('q-a2', '四十二', false, 'llm', T.a3, S2, { model: 'DeepSeek-v4.1', scoreGot: 6, scoreTotal: 12 }),
  attempt('q-b1', 'A', null, 'human', T.b1, null),
  attempt('q-orphan999', 'C', true, 'human', T.orphan, null),
  // 形状不合法：correct 不是三态 → extractAttempts 会如实报为 malformed，而不是当成答错
  { id: 'e-bad', timestamp: T.b1, type: 'lh/user/attempt', data: { question_id: 'q-x', correct: 'yes', source: 'human' } },
]

const archived = [{ name: '旧库', path: FIXTURE_BANK_DIR + '\\.archived\\旧库.json', ok: true, question_count: 5, title: '旧库' }]

// ══════════════════════════════════════════════════════════════════════════

console.log('\n══ 1. 小工具：分页与文本 ══')

check('clampLimit：不给 → 默认；0/负数 → 默认', () => {
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT)
  assert.equal(clampLimit(0), DEFAULT_LIMIT)
  assert.equal(clampLimit(-3), DEFAULT_LIMIT)
})
check(`clampLimit：超上限收到 ${MAX_LIMIT}（防一次误点把整库拉进浏览器）`, () => {
  assert.equal(clampLimit(9999), MAX_LIMIT)
})
check('clampLimit：合法值向下取整', () => {
  assert.equal(clampLimit(3.7), 3)
})
check('clampOffset：负数/NaN → 0', () => {
  assert.equal(clampOffset(-5), 0)
  assert.equal(clampOffset('abc'), 0)
  assert.equal(clampOffset('7'), 7)
})
check('previewStem：压掉换行（列表行是单行省略号，换行会把整列撑高）', () => {
  assert.equal(previewStem('甲\n乙   丙'), '甲 乙 丙')
})
check('previewStem：超长截断并带省略号', () => {
  const long = '字'.repeat(200)
  const out = previewStem(long)
  assert.equal(out.length, 121)
  assert.ok(out.endsWith('…'))
})
check('isInside：真子路径算在内', () => {
  assert.equal(isInside('/ws', '/ws/lh-questions/a.json'), true)
  assert.equal(isInside('/ws/', '/ws'), true)
})
check('isInside：**前缀相同但不是子目录**不算在内（D:\\ws vs D:\\wsx）', () => {
  assert.equal(isInside('/ws', '/wsx/a.json'), false)
})
check('isInside：任一端为空 → 如实返回 false（不猜）', () => {
  assert.equal(isInside(null, '/a'), false)
  assert.equal(isInside('/a', null), false)
})

console.log('\n══ 2. indexQuestions：作答 join 的唯一依据 ══')

check('索引到全部 4 道题', () => {
  const { byId, questionCount, duplicates } = indexQuestions(banks)
  assert.equal(questionCount, 4)
  assert.equal(byId.size, 4)
  assert.equal(byId.get('q-a1').bankName, 'A库')
  assert.equal(byId.get('q-b1').bankName, 'B库')
  assert.equal(duplicates.length, 0)
})
check('读不出来的库（bank=null）不炸，也不贡献索引', () => {
  const { byId } = indexQuestions([{ name: '坏库', bank: null }, ...banks])
  assert.equal(byId.size, 4)
})
check('同一个 id 出现在两个库里 → 如实报出，不静默取第一个', () => {
  const dup = { ...bankB, questions: [{ ...bankB.questions[0], id: 'q-a1' }] }
  const { duplicates } = indexQuestions([banks[0], { name: 'B库', bank: dup }])
  assert.equal(duplicates.length, 1)
  assert.deepEqual(duplicates[0].banks, ['A库', 'B库'])
})

console.log('\n══ 3. summarizeBankAttempts：按库的三态统计 ══')

const perQuestion = summarizeAttempts({ attempts: extractAttempts(events).attempts }).per_question

check('A库：做过的题数 / 次数 / 对错 / 正确率', () => {
  const stats = summarizeBankAttempts({ questions: bankA.questions, perQuestion })
  assert.equal(stats.attempted, 3)
  assert.equal(stats.attempts, 4)
  assert.equal(stats.correct, 2)
  assert.equal(stats.wrong, 1)
  assert.equal(stats.partial, 1)
  assert.equal(stats.unjudged, 0)
  assert.equal(stats.accuracy, 0.6667)
  assert.equal(stats.last_at, T.a3)
})
check('B库：只有判不了的一次 → accuracy 是 null，不是 0', () => {
  const stats = summarizeBankAttempts({ questions: bankB.questions, perQuestion })
  assert.equal(stats.attempted, 1)
  assert.equal(stats.unjudged, 1)
  assert.equal(stats.accuracy, null)
})

console.log('\n══ 4. buildBankList：题库段 ══')

const list = buildBankList({ banks, archived, events })
const listAll = buildBankList({ banks, archived, events, scope: 'all' })

check('默认口径是「只看人的」——模型答对了不是我会了（ADR-018 决定 6）', () => {
  assert.equal(list.totals.scope, 'human')
  assert.equal(list.totals.non_human_attempt_count, 2)
  assert.ok(list.notes.some((n) => n.includes('因作答者未选中')), JSON.stringify(list.notes))
})
check('口径 all 时那条 llm 作答才进来（5 条），人的口径只有 4 条', () => {
  assert.equal(listAll.totals.attempt_count, 6)
  assert.equal(list.totals.attempt_count, 4)
  assert.equal(listAll.totals.non_human_attempt_count, 0)
})
check('认不出的口径值退回 human（宁少算不混算）', () => {
  assert.equal(normalizeScope('乱写'), 'human')
  assert.equal(normalizeScope(undefined), 'human')
  assert.equal(normalizeScope('all'), 'all')
})

check('两库四题，全部合格', () => {
  assert.equal(list.kind, 'banks')
  assert.equal(list.totals.bank_count, 2)
  assert.equal(list.totals.ok_bank_count, 2)
  assert.equal(list.totals.question_count, 4)
})
check('作答总数 / 对上号 / 孤儿三者的账要对得上（人的口径：4 / 3 / 1）', () => {
  assert.equal(list.totals.attempt_count, 4)
  assert.equal(list.totals.matched_attempt_count, 3)
  assert.equal(list.totals.unmatched_attempt_count, 1)
})
check('三态分开计：correct/wrong/unjudged 各自如实（人的口径：4 条里对2错1判不了1）', () => {
  assert.equal(list.totals.correct, 2)
  assert.equal(list.totals.wrong, 1)
  assert.equal(list.totals.unjudged, 1)
  assert.equal(list.totals.accuracy, 0.6667)
})
check('三态分开计：含模型作答时的口径（all：5 条里对3错1判不了1）', () => {
  assert.equal(listAll.totals.correct, 3)
  assert.equal(listAll.totals.wrong, 1)
  assert.equal(listAll.totals.unjudged, 1)
  assert.equal(listAll.totals.accuracy, 0.75)
})
check('按来源分组：人的口径里**不出现** llm（这就叫不混算）', () => {
  assert.deepEqual(list.totals.by_source.human, { total: 4, correct: 2, wrong: 1, partial: 0, unjudged: 1 })
  assert.equal(list.totals.by_source.llm, undefined)
  // 放到 all 口径下才看得到 llm 那一档
  assert.deepEqual(listAll.totals.by_source.llm, { total: 2, correct: 1, wrong: 0, partial: 1, unjudged: 0 })
})
check('形状不合法的事件被报出来，且不计入作答', () => {
  assert.equal(list.totals.malformed_attempt_count, 1)
})
check('每库的覆盖率计数（带知识点 / 缺解析）', () => {
  const a = list.banks.find((b) => b.name === 'A库')
  assert.equal(a.with_topics_count, 1)
  assert.equal(a.no_analysis_count, 1)
})
check('坏库照样列出并标注（隐藏它会让"我的题库去哪了"变成谜）', () => {
  const broken = buildBankList({
    banks: [{ name: '坏库', ok: false, errors: ['缺 questions 数组'], bank: null }],
    archived: [],
    events: [],
  })
  assert.equal(broken.banks[0].ok, false)
  assert.equal(broken.totals.broken_bank_count, 1)
  assert.ok(broken.notes.some((n) => n.includes('不合格')))
})
check('notes：孤儿作答、无法判别、malformed、归档、作答者未选中各有一条', () => {
  const joined = list.notes.join('\n')
  assert.ok(joined.includes('1 条作答的题目不在当前工作区的任何题库里'), joined)
  assert.ok(joined.includes('1 次作答**无法判别**'), joined)
  assert.ok(joined.includes('1 条作答事件形状不合法'), joined)
  assert.ok(joined.includes('1 个题库已归档'), joined)
  assert.ok(joined.includes('因作答者未选中'), joined)
})
check('archived 单独成区，不进题库清单', () => {
  assert.equal(list.totals.archived_count, 1)
  assert.equal(list.banks.length, 2)
  assert.equal(list.archived[0].name, '旧库')
})

console.log('\n══ 5. buildSource：来源段（库级） ══')

const importEvents = [
  {
    id: 'imp-1',
    timestamp: T.a1,
    provenance: { plugin: '@lh/question-bank', version: '0.0.1', model: 'mimo-v2.5' },
    content_ref: FIXTURE_SOURCE_ROOT + '\\A库.json',
    data: { bank_path: FIXTURE_SOURCE_ROOT + '\\A库.json', added_count: 3, replaced_count: 0, rejected_count: 1, source_root: FIXTURE_SOURCE_ROOT, source_file: 'f1.pdf', with_topics_count: 1, unmapped_topics: ['新词'], supersedes: [] },
  },
  {
    id: 'imp-2',
    timestamp: T.a2,
    provenance: { plugin: '@lh/question-bank', version: '0.0.1', model: 'deepseek-flash' },
    content_ref: FIXTURE_OTHER_WS + '\\lh-questions\\A库.json',
    data: { bank_path: FIXTURE_OTHER_WS + '\\lh-questions\\A库.json', added_count: 1, supersedes: ['imp-1'] },
  },
]
const source = buildSource({ bank: bankA, importEvents, workspaceRoot: FIXTURE_SOURCE_ROOT })

check('来源文件按 path 归组，并给出题号范围', () => {
  assert.equal(source.source_files.length, 2)
  const f1 = source.source_files.find((f) => f.path === 'f1.pdf')
  assert.equal(f1.question_count, 2)
  assert.equal(f1.first_number, '1')
  assert.equal(f1.last_number, '2')
  assert.deepEqual(f1.pages, [3])
})
check('库级覆盖面：带知识点的题数 / 缺解析的题数 / 词表外标签', () => {
  assert.equal(source.coverage.with_topics, 1)
  assert.equal(source.coverage.without_analysis, 1)
  assert.deepEqual(source.coverage.unmapped_topics, ['新词'])
})
check('题型直方图', () => {
  assert.deepEqual(source.coverage.kinds, { single_choice: 2, fill_blank: 1 })
})
check('抽取方式与答案来源文件显式说出来（它决定下游对答案的信任度）', () => {
  assert.equal(source.method, 'rule')
  assert.equal(source.answer_source_file, null)
  assert.equal(source.model, null)
})
check('导入事件标注"属不属于当前工作区"（别的工作区只作佐证）', () => {
  assert.equal(source.import_events.length, 2)
  assert.equal(source.import_events[0].in_workspace, true)
  assert.equal(source.import_events[1].in_workspace, false)
  assert.equal(source.import_events[0].model, 'mimo-v2.5')
  assert.equal(source.import_events[1].supersedes_count, 1)
  assert.ok(source.notes.some((n) => n.includes('不在当前工作区')))
})
check('没有导入事件时如实说"来源全部取自题库文件本身"', () => {
  const s = buildSource({ bank: bankA, importEvents: [], workspaceRoot: FIXTURE_SOURCE_ROOT })
  assert.ok(s.notes.some((n) => n.includes('没有这个库的导入事件')))
})
check('一道题都没记来源文件时如实说出来（ADR-021 的纪律）', () => {
  const bare = { ...bankA, questions: [{ ...bankA.questions[0], source: {} }] }
  const s = buildSource({ bank: bare, importEvents: [], workspaceRoot: null })
  assert.ok(s.notes.some((n) => n.includes('一道题都没记来源文件')))
})

console.log('\n══ 6. buildQuestions：题目段 ══')

check('全量 3 题，按题库文件顺序（那是资料里的顺序）', () => {
  const v = buildQuestions({ bank: bankA, events })
  assert.equal(v.total, 3)
  assert.equal(v.bank_total, 3)
  assert.deepEqual(v.items.map((i) => i.id), ['q-a1', 'q-a2', 'q-a3'])
})
check('管理视角**看得到答案与解析**（与刷题那条路的约束不是同一件事）', () => {
  const v = buildQuestions({ bank: bankA, events })
  assert.deepEqual(v.items[0].answer, ['A'])
  assert.equal(v.items[0].analysis, '甲解析')
})
check('每题挂上它的作答史（次数 / 最近一次对错与作答）', () => {
  const v = buildQuestions({ bank: bankA, events })
  const a1 = v.items.find((i) => i.id === 'q-a1')
  assert.equal(a1.attempts.total, 2)
  assert.equal(a1.attempts.last_correct, false)
  assert.equal(a1.attempts.last_response, 'B')
  assert.equal(a1.attempts.last_at, T.a2)
  assert.equal(v.items.find((i) => i.id === 'q-a2').attempts, null)
})
check('筛题干（忽略大小写、子串）', () => {
  assert.equal(buildQuestions({ bank: bankA, events, filters: { q: '乙题' } }).total, 1)
})
check('筛知识点', () => {
  assert.equal(buildQuestions({ bank: bankA, events, filters: { topic: '片段阅读' } }).total, 1)
  assert.equal(buildQuestions({ bank: bankA, events, filters: { topic: '不存在的词' } }).total, 0)
})
check('筛题型', () => {
  assert.equal(buildQuestions({ bank: bankA, events, filters: { kind: 'fill_blank' } }).total, 1)
})
check('筛作答状态：unseen / done / wrong（人的口径：llm 那条不算做过）', () => {
  assert.deepEqual(buildQuestions({ bank: bankA, events, filters: { state: 'unseen' } }).items.map((i) => i.id), ['q-a2', 'q-a3'])
  assert.equal(buildQuestions({ bank: bankA, events, filters: { state: 'done' } }).total, 1)
  assert.deepEqual(buildQuestions({ bank: bankA, events, filters: { state: 'wrong' } }).items.map((i) => i.id), ['q-a1'])
  // 口径切到 all：llm 做过的 q-a3 就从 unseen 里出去
  assert.deepEqual(
    buildQuestions({ bank: bankA, events, filters: { state: 'unseen' }, scope: 'all' }).items.map((i) => i.id),
    [],
  )
})
check('非法 state 值退回 all 而不是报错或返回空', () => {
  assert.equal(buildQuestions({ bank: bankA, events, filters: { state: '乱写' } }).total, 3)
})
check('分页：has_more 与 offset 边界', () => {
  const p1 = buildQuestions({ bank: bankA, events, limit: 2 })
  assert.equal(p1.items.length, 2)
  assert.equal(p1.has_more, true)
  const p2 = buildQuestions({ bank: bankA, events, limit: 2, offset: 2 })
  assert.equal(p2.items.length, 1)
  assert.equal(p2.has_more, false)
  const p3 = buildQuestions({ bank: bankA, events, limit: 2, offset: 99 })
  assert.equal(p3.items.length, 0)
  assert.equal(p3.has_more, false)
})
check('词表外的标签不会变成可筛的知识点（筛它是 0 题，而注释里说明了为什么）', () => {
  const v = buildQuestions({ bank: bankA, events })
  assert.deepEqual(v.topics, ['片段阅读'])
})

console.log('\n══ 7. buildAttempts：记录段 ══')

const rec = buildAttempts({ banks, events })
const recAll = buildAttempts({ banks, events, scope: 'all' })

check('只列对得上号的：人的口径 3 条进列表，1 条孤儿只计count', () => {
  assert.equal(rec.total, 3)
  assert.equal(rec.unmatched_attempt_count, 1)
  assert.equal(rec.items.length, 3)
  assert.ok(rec.notes.some((n) => n.includes('未列入')))
})
check('非默认作答者不列入，但**如实计数**并给出一句说明', () => {
  assert.equal(rec.scope, 'human')
  assert.equal(rec.non_human_attempt_count, 2)
  assert.ok(rec.notes.some((n) => n.includes('因作答者未选中')), JSON.stringify(rec.notes))
  assert.equal(recAll.total, 5)
  assert.equal(recAll.non_human_attempt_count, 0)
})
check('最近的排前面', () => {
  assert.equal(rec.items[0].timestamp, T.b1)
  assert.equal(rec.items[2].timestamp, T.a1)
})
check('每条都带上时间、作答、三态对错、来源、用时、题库与题干预览', () => {
  const row = rec.items.find((i) => i.timestamp === T.a2)
  assert.equal(row.question_id, 'q-a1')
  assert.equal(row.response, 'B')
  assert.equal(row.correct, false)
  assert.equal(row.source, 'human')
  assert.equal(row.bank, 'A库')
  assert.ok(row.question.stem_preview.startsWith('甲题'))
  assert.equal(row.question.number, '1')
})
check('判不了是独立一态（null），不并进 false', () => {
  const row = rec.items.find((i) => i.timestamp === T.b1)
  assert.equal(row.correct, null)
})
check('关联会话原样带出（界面再翻成标题）', () => {
  assert.equal(rec.items.find((i) => i.timestamp === T.a1).session_ref, S1)
  assert.equal(rec.items.find((i) => i.timestamp === T.b1).session_ref, null)
})
check('过滤：按库（人的口径）', () => {
  assert.equal(buildAttempts({ banks, events, filters: { bank: 'A库' } }).total, 2)
  assert.equal(buildAttempts({ banks, events, filters: { bank: 'all' } }).total, 3)
})
check('过滤：按对错（含 null 那一档）', () => {
  assert.equal(buildAttempts({ banks, events, filters: { correct: 'true' } }).total, 1)
  assert.equal(buildAttempts({ banks, events, filters: { correct: 'false' } }).total, 1)
  assert.equal(buildAttempts({ banks, events, filters: { correct: 'null' } }).total, 1)
})
check('过滤：按会话 / 按来源 / 按题目 id', () => {
  assert.equal(buildAttempts({ banks, events, filters: { session: S1 } }).total, 2)
  // S2 只有那条 llm 作答 → 人的口径下是 0；切 all 才是 1
  assert.equal(buildAttempts({ banks, events, filters: { session: S2 } }).total, 0)
  assert.equal(buildAttempts({ banks, events, filters: { session: S2 }, scope: 'all' }).total, 2)
  assert.equal(buildAttempts({ banks, events, filters: { source: 'llm' } }).total, 0)
  assert.equal(buildAttempts({ banks, events, filters: { source: 'llm' }, scope: 'all' }).total, 2)
  assert.equal(buildAttempts({ banks, events, filters: { question: 'q-a1' } }).total, 2)
})
check('下拉选项：库与会话都带计数（人的口径）', () => {
  assert.deepEqual(rec.banks, [{ name: 'A库', count: 2 }, { name: 'B库', count: 1 }])
  assert.deepEqual(rec.sessions, [{ session_id: S1, count: 2 }])
})
check('notes：无会话坐标如实说、未选中的作答单列', () => {
  const joined = rec.notes.join('\n')
  assert.ok(joined.includes('1 条没有会话坐标'), joined)
  assert.ok(joined.includes('因作答者未选中'), joined)
  // llm 那一档要切到 all 才在列表里，那时才出"模型作答不是学习证据"这句
  assert.ok(recAll.notes.join('\n').includes('模型作答'), JSON.stringify(recAll.notes))
})
check('分页与 has_more', () => {
  const p = buildAttempts({ banks, events, limit: 2 })
  assert.equal(p.items.length, 2)
  assert.equal(p.has_more, true)
  assert.equal(buildAttempts({ banks, events, limit: 2, offset: 4 }).has_more, false)
})
check('没有作答时如实说，不返回一个"看起来正常"的空表', () => {
  const empty = buildAttempts({ banks, events: [] })
  assert.equal(empty.total, 0)
  assert.ok(empty.notes.some((n) => n.includes('还没有任何作答记录')))
})

console.log('\n══ 8. 部分正确 / 型号 / 正确答案（2026-10-13 新增） ══')

check('answerText：官方答案一律折成**字符型**（选择 A、填空 42、将来简答整段文字都是同一件事）', () => {
  assert.equal(answerText({ answer: ['A'] }), 'A')
  assert.equal(answerText({ answer: ['A', 'C'] }), 'A、C')
  assert.equal(answerText({ answer: ['42'] }), '42')
  assert.equal(answerText({ answer: [] }), '')
  assert.equal(answerText(null), '')
})
check('部分正确是**派生**的：correct=false + score_got>0（三态本身没被改）', () => {
  assert.equal(verdictOf({ correct: true }), 'correct')
  assert.equal(verdictOf({ correct: false }), 'wrong')
  assert.equal(verdictOf({ correct: null }), 'unjudged')
  assert.equal(verdictOf({ correct: false, score_got: 6, score_total: 12 }), 'partial')
  // 0/12 不算部分正确：一分没得就是错
  assert.equal(verdictOf({ correct: false, score_got: 0, score_total: 12 }), 'wrong')
  assert.equal(isPartial({ correct: false, score_got: 6, score_total: 12 }), true)
})
check('部分正确**不进正确率的分母**（把"答对一半"算成错会无故拉低正确率）', () => {
  const recAll2 = buildAttempts({ banks, events, scope: 'all' })
  assert.equal(recAll2.verdict_counts.partial, 1)
  assert.equal(recAll2.verdict_counts.correct, 2)
  assert.equal(recAll2.verdict_counts.wrong, 1)
  assert.equal(recAll2.verdict_counts.unjudged, 1)
  // accuracy = 3/(3+1)，部分那一条既不在分子也不在分母
  assert.equal(listAll.totals.accuracy, 0.75)
  assert.equal(listAll.totals.partial, 1)
  assert.ok(recAll2.notes.some((n) => n.includes('部分正确')), JSON.stringify(recAll2.notes))
})
check('部分正确**不算错题**（错题本里不该混进"其实会了一半"的题）', () => {
  const wrongOnly = buildQuestions({ bank: bankA, events, filters: { state: 'wrong' }, scope: 'all' })
  assert.deepEqual(wrongOnly.items.map((i) => i.id), ['q-a1'])
})
check('判决过滤：correct / partial / wrong / unjudged 四档各自筛得出', () => {
  const f = (verdict) => buildAttempts({ banks, events, filters: { verdict }, scope: 'all' }).total
  assert.equal(f('correct'), 2)
  assert.equal(f('partial'), 1)
  assert.equal(f('wrong'), 1)
  assert.equal(f('unjudged'), 1)
  assert.equal(f('all'), 5)
})
check('记录行带出型号（谁作的答）；人作答的型号是 null', () => {
  const rows = buildAttempts({ banks, events, scope: 'all' }).items
  assert.deepEqual([...new Set(rows.map((r) => r.model).filter(Boolean))].sort(), ['DeepSeek-v4.1', 'mimo-v2.5'])
  assert.equal(rows.find((r) => r.source === 'human').model, null)
  assert.deepEqual(buildAttempts({ banks, events, scope: 'all' }).models, ['DeepSeek-v4.1', 'mimo-v2.5'])
})
check('记录行带出**决策所需**的字段：四态判决、分数、正确答案（字符型）', () => {
  const rows = buildAttempts({ banks, events, scope: 'all' }).items
  const partial = rows.find((r) => r.verdict === 'partial')
  assert.equal(partial.score_got, 6)
  assert.equal(partial.score_total, 12)
  assert.equal(partial.model, 'DeepSeek-v4.1')
  // 夹具里 q-a2 是单选（答案 B）；填空题的 ['42'] → '42' 由 answerText 单测覆盖
  assert.equal(partial.question.answer_text, 'B')
  const someRow = rows.find((r) => r.bank === 'B库')
  assert.equal(someRow.question.answer_text, 'A')
})
check('题目段也带出四态判决（部分正确单独一档）', () => {
  const v = buildQuestions({ bank: bankA, events, scope: 'all' })
  const a2 = v.items.find((i) => i.id === 'q-a2')
  assert.equal(a2.attempts.partial, 1)
  assert.equal(a2.attempts.last_verdict, 'partial')
})
check('分数形状不合法的事件被报为 malformed，而不是当成答错', () => {
  const bad = [
    ...events,
    {
      id: 'e-bad-score',
      timestamp: T.b1,
      type: 'lh/user/attempt',
      data: { question_id: 'q-a1', response: 'A', correct: false, source: 'human', score_got: 9, score_total: 4 },
    },
  ]
  const v = buildAttempts({ banks, events: bad })
  assert.equal(v.malformed_attempt_count, 2) // 原有的 correct:'yes' + 新的 got>total
})

console.log('\n══ 9. 作答者多选（2026-10-13：按人 / 型号分别看） ══')

check('answererOf：人 → human；模型 → 型号；没记型号 → model:unknown（不假装知道）', () => {
  assert.equal(answererOf({ source: 'human' }), 'human')
  assert.equal(answererOf({ source: 'llm', model: 'DeepSeek-v4.1' }), 'DeepSeek-v4.1')
  assert.equal(answererOf({ source: 'llm', model: null }), 'model:unknown')
})
check('availableAnswerers：用户排最前，其余按条数降序，只列出现过的', () => {
  const list = availableAnswerers(extractAttempts(events).attempts)
  assert.deepEqual(list.map((a) => a.key), ['human', 'mimo-v2.5', 'DeepSeek-v4.1'])
  assert.equal(list[0].label, '用户')
  assert.equal(list[0].count, 4)
})
check('selectByAnswerers：只勾模型 → 只有模型的作答；**空选 = 什么都不显示**（不是全选）', () => {
  const all = extractAttempts(events).attempts
  assert.equal(selectByAnswerers(all, ['DeepSeek-v4.1']).length, 1)
  assert.equal(selectByAnswerers(all, ['human']).length, 4)
  assert.equal(selectByAnswerers(all, ['human', 'DeepSeek-v4.1', 'mimo-v2.5']).length, 6)
  assert.equal(selectByAnswerers(all, []).length, 0)
})
check('parseAnswerers：逗号分隔；**空串 = 明确的"一个都不选"**；没给才退回 scope', () => {
  assert.deepEqual(parseAnswerers('human,DeepSeek-v4.1'), ['human', 'DeepSeek-v4.1'])
  assert.deepEqual(parseAnswerers(''), [], '给了但为空 → []（不是全选、也不是退回 scope）')
  assert.equal(parseAnswerers(undefined), null)
  assert.equal(parseAnswerers(null), null)
})
check('answerers=[]（明确空选）→ 记录为空，但作答者清单仍如实给出（不然没法再勾回去）', () => {
  const v = buildAttempts({ banks, events, answerers: parseAnswerers('') })
  assert.equal(v.total, 0)
  assert.deepEqual(v.selected_answerers, [])
  assert.ok(v.answerers.length > 0, '出现过的作答者仍要列出来')
})
check('路由层用 answerers 时，返回体带出清单与当前选择', () => {
  const v = buildAttempts({ banks, events, answerers: ['DeepSeek-v4.1'] })
  assert.equal(v.total, 1)
  assert.deepEqual(v.selected_answerers, ['DeepSeek-v4.1'])
  assert.deepEqual(v.answerers.map((a) => a.key), ['human', 'mimo-v2.5', 'DeepSeek-v4.1'])
  assert.ok(v.notes.some((n) => n.includes('因作答者未选中')), JSON.stringify(v.notes))
})
check('不传 answerers 时退回 scope 口径（老行为不变）', () => {
  assert.equal(buildAttempts({ banks, events }).total, 3)
  assert.equal(buildAttempts({ banks, events, scope: 'all' }).total, 5)
})

console.log('\n══ 10. 枚举导出（供路由层复用，避免两处各写一份） ══')

check('四段读法与过滤枚举齐全', () => {
  assert.deepEqual(VIEW_KINDS, ['banks', 'source', 'questions', 'attempts'])
  assert.deepEqual(CORRECT_FILTERS, ['all', 'true', 'false', 'null'])
  assert.deepEqual(VERDICT_FILTERS, ['all', 'correct', 'partial', 'wrong', 'unjudged'])
  assert.deepEqual(QUESTION_STATE_FILTERS, ['all', 'unseen', 'done', 'wrong'])
})

// ══════════════════════════════════════════════════════════════════════════

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}
