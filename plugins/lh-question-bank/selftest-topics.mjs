/**
 * `topics.js` 词表的自测 —— **拿试点真实标签当输入**。
 *
 * ═══ 为什么输入必须是真的 ═══
 * 词表的用途是接住模型**实际会产出的东西**，所以我不能自己编几个漂亮例子来测它——
 * 那样测的是"我的想象"，而真实分布（`docs/archive/decisions/021` 结论六：86 个标签、
 * 一半是同义词、四分之一是内容词）才是被测对象。
 *
 * 因此本自测的输入取自 `data/pilot-llm-preprocess.json` 里**真实出现过的标签**
 * （那份文件在 `.gitignore` 里，所以这里把它们**内联**进来，
 * 而不是运行时去读——否则自测会在干净仓库上跑不起来）。
 *
 * ═══ 判据的先验值（不是"跑了看结果"）═══
 * 三条都是**动手前就写下的期望**，跑出来不一致就是词表错了：
 *   1. 同义词必须合流：`主旨概括`/`中心理解`/`意图判断` → 同一个规范名；
 *   2. 内容词必须**认不出**（进 unmapped），不许被硬塞进某个题型；
 *   3. 带括号的变体（`削弱论证题（除哪项外）`）必须归到干净的规范名。
 *
 * 用法: node plugins/lh-question-bank/selftest-topics.mjs
 */

import {
  normalizeTopics,
  canonicalTopic,
  canonicalizeLabel,
  validateVocabulary,
  describeTopicVocabulary,
  QUESTION_TYPES,
  DOMAINS,
  ALL_CANONICAL_TOPICS,
} from './topics.js'

let pass = 0
let fail = 0

/**
 * 断言一个条件。
 *
 * @param label - 用例描述。
 * @param ok - 是否成立。
 * @param detail - 失败时的补充信息。
 */
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

console.log('=== 1. 词表自身合法（两轴不相交、别名都能查到）===')
{
  const { ok, errors } = validateVocabulary()
  check('validateVocabulary() 全过', ok, errors.join('\n      '))
  check(`题型轴 ${QUESTION_TYPES.length} 项 / 领域轴 ${DOMAINS.length} 项`, QUESTION_TYPES.length >= 10 && DOMAINS.length >= 3)
}

console.log('\n=== 2. 试点里的同义词必须合流（先验判据 1）===')
{
  // 全部取自试点真实产出
  const groups = [
    [['主旨概括', '中心理解', '意图判断', '主旨对策', '总结 conclusion'], '中心理解'],
    [['言语理解', '片段阅读'], '片段阅读'],
    [['语句填空', '语句填入', '填入画横线'], '语句填入'],
    [['削弱质疑', '削弱论点', '削弱论证'], '削弱论证'],
    [['加强支持', '论证支持'], '加强论证'],
    [['前提条件', '必要条件'], '前提假设'],
    [['真假推理', '真假'], '真假推理'],
    [['翻译推理', '假言命题', '逆否命题', '否前不能否后'], '翻译推理'],
  ]
  for (const [aliases, expected] of groups) {
    const { topics, unmapped } = normalizeTopics(aliases)
    check(
      `${JSON.stringify(aliases)} → [${topics.join(', ')}]`,
      topics.length === 1 && topics[0] === expected && unmapped.length === 0,
      `期望只有 ${expected}；实际 topics=${JSON.stringify(topics)} unmapped=${JSON.stringify(unmapped)}`,
    )
  }
}

console.log('\n=== 3. 内容词必须认不出（先验判据 2）——这是本词表存在的主要理由 ===')
{
  // 试点里真实出现过的"题目在讲什么"，一个都不许被当成知识点
  const mustBeUnmapped = [
    '纳米金属',
    '相声',
    '老年群体',
    '人脸识别',
    '隐私权',
    '消费者剩余',
    '经济学',
    '外部性',
    '细晶强化',
    '高压形变',
    '遗传与环境',
    '公共服务',
    '回归群众',
    '教育规律',
    '人生价值',
    '兴趣',
  ]
  const { topics, unmapped } = normalizeTopics(mustBeUnmapped)
  check(
    `内容词全部进 unmapped（${mustBeUnmapped.length} 个）`,
    unmapped.length === mustBeUnmapped.length && mustBeUnmapped.every((w) => unmapped.includes(w)),
    `实际 topics=${JSON.stringify(topics)} unmapped=${JSON.stringify(unmapped)}`,
  )
  check('内容词没有被塞进 topics', topics.length === 0, `实际 topics=${JSON.stringify(topics)}`)

  // 反例保护：明确在词表里的词**必须**认出来，否则上一条会"因为全都不认识"而假绿
  check('反例保护：中介因果 → 论证结构', canonicalTopic('中介因果').topic === '论证结构')
  check('反例保护：另有他因 → 论证结构', canonicalTopic('另有他因').topic === '论证结构')
}

console.log('\n=== 4. 带括号的变体必须剥掉（先验判据 3）===')
{
  const cases = [
    ['削弱论证题（除哪项外）', '削弱论证'],
    ['翻译推理题（逻辑判断）', '翻译推理'],
    ['加强支持题（最不能支持）', '加强论证'],
    ['论证削弱题（削弱结论）', '削弱论证'],
    ['削弱质疑题（不能质疑）', '削弱论证'],
    ['中心理解题', '中心理解'],
    ['语句填入类', '语句填入'],
  ]
  for (const [raw, expected] of cases) {
    const { topic } = canonicalTopic(raw)
    check(`「${raw}」→ ${expected}`, topic === expected, `实际 ${topic ?? '(认不出)'}`)
  }
}

console.log('\n=== 5. 两轴可分：同一个数组里哪个词属于哪一轴是确定的 ===')
{
  const { topics, byAxis } = normalizeTopics(['主旨概括', '片段阅读', '削弱质疑', '逻辑判断'])
  check(
    `topics = ${JSON.stringify(topics)}（题型在前、领域在后）`,
    JSON.stringify(topics) === JSON.stringify(['中心理解', '削弱论证', '片段阅读', '逻辑判断']),
    `实际 ${JSON.stringify(topics)}`,
  )
  check('byAxis.type 只含题型', byAxis.type.every((t) => QUESTION_TYPES.some((e) => e.name === t)))
  check('byAxis.domain 只含领域', byAxis.domain.every((t) => DOMAINS.some((e) => e.name === t)))

  // 不相交断言：一个词不可能同时落在两轴
  const both = ALL_CANONICAL_TOPICS.filter(
    (n) => QUESTION_TYPES.some((e) => e.name === n) && DOMAINS.some((e) => e.name === n),
  )
  check('两轴规范名不相交', both.length === 0, `交集：${both.join(', ')}`)
}

console.log('\n=== 6. 边界（空、重复、非字符串、混着认不出的）===')
{
  const a = normalizeTopics([])
  check('空数组 → 空结果', a.topics.length === 0 && a.unmapped.length === 0)
  const b = normalizeTopics(undefined)
  check('undefined → 空结果（不抛错）', b.topics.length === 0)
  const c = normalizeTopics(null)
  check('null → 空结果（不抛错）', c.topics.length === 0)
  const d = normalizeTopics(['片段阅读', '言语理解', '片段'])
  check('三个同义写法只留一个', JSON.stringify(d.topics) === JSON.stringify(['片段阅读']), JSON.stringify(d.topics))
  const e = normalizeTopics(['片段阅读', '片段阅读'])
  check('重复词只留一个', e.topics.length === 1)
  const f = normalizeTopics(['', '   '])
  check('空串与空白被忽略', f.topics.length === 0 && f.unmapped.length === 0)
  const g = normalizeTopics(['火星文abc', '火星文abc'])
  check('同一个认不出的词只报一次', g.unmapped.length === 1 && g.unmapped[0] === '火星文abc')
  const h = normalizeTopics('片段阅读')
  check('传入单个字符串（不是数组）也不炸', JSON.stringify(h.topics) === JSON.stringify(['片段阅读']))
  const i = normalizeTopics([123, {}])
  check('非字符串项不炸', i.topics.length === 0 && i.unmapped.length === 2)

  // ⚠ 这一条是实测抓出来的：同一份试点产物里，模型有时给数组、有时给
  //   **一个用空格分隔的字符串**（`"片段阅读 主旨概括"`）。
  //   不拆的话整条字符串查不到表 → 进 unmapped → 该题知识点全空**且不报错**。
  const j = normalizeTopics('片段阅读 主旨概括')
  check(
    '★ 空格分隔的字符串会被拆开（实测：两次运行的写法不同）',
    JSON.stringify(j.topics) === JSON.stringify(['中心理解', '片段阅读']) && j.unmapped.length === 0,
    `实际 topics=${JSON.stringify(j.topics)} unmapped=${JSON.stringify(j.unmapped)}`,
  )
  const k = normalizeTopics('中心理解、片段阅读')
  check('顿号分隔也拆', JSON.stringify(k.topics) === JSON.stringify(['中心理解', '片段阅读']), JSON.stringify(k.topics))
  const l = normalizeTopics('削弱论证/逻辑判断')
  check('斜杠分隔也拆', JSON.stringify(l.topics) === JSON.stringify(['削弱论证', '逻辑判断']), JSON.stringify(l.topics))
}

console.log('\n=== 7. canonicalizeLabel 的边界（它是最底层，脆了上面全脆）===')
{
  check('去空白', canonicalizeLabel(' 中心 理解 ') === '中心理解')
  check('全角括号统一', canonicalizeLabel('削弱（除哪项外）') === canonicalizeLabel('削弱(除哪项外)'))
  check('剥结尾括号', canonicalizeLabel('削弱论证题（除哪项外）') === '削弱论证')
  check('不动中间的括号', canonicalizeLabel('A（B）C') === canonicalizeLabel('A（B）C'))
  check('空串安全', canonicalizeLabel('') === '' && canonicalizeLabel(null) === '')
  // 中英混写：试点里真实出现过 `总结 conclusion`，空格被去掉后要能查到
  check('中英混写去空格后能查到', canonicalTopic('总结 conclusion').topic === '中心理解')
}

console.log('\n=== 8. 提示词渲染与词表一致（防"手写第二份"）===')
{
  const { types, domains } = describeTopicVocabulary()
  check('渲染出的题型数 = 词表条目数', types.split(' / ').length === QUESTION_TYPES.length, types)
  check('渲染出的领域数 = 词表条目数', domains.split(' / ').length === DOMAINS.length, domains)
  const missing = [...QUESTION_TYPES, ...DOMAINS]
    .map((e) => e.name)
    .filter((name) => !types.includes(name) && !domains.includes(name))
  check('每个词表项都出现在渲染结果里', missing.length === 0, `缺：${missing.join(', ')}`)
}

console.log('')
if (fail > 0) {
  console.log(`══ 结果：${pass} 通过 / ${fail} 失败 ══`)
  process.exit(1)
}
console.log(`══ 结果：${pass} 通过 / 0 失败 ══`)
