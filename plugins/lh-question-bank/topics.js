/**
 * `topics` 字段的词表 —— **两轴封闭词表**。
 *
 * ═══ 为什么需要这个文件（它是数据的产物，不是设计偏好）═══
 * LLM 预处理试点里，模型对 30 道题产出了 86 个自由标签（`data/pilot-llm-preprocess.json`）。
 * 按"它到底是什么"分，那 86 个混了三类东西：
 *
 *   1. **题型**：中心理解、语句填入、削弱论证……      ← 这题要你干什么
 *   2. **领域**：片段阅读、逻辑判断……                ← 这题属于哪门
 *   3. **内容词**：纳米金属、相声、老年群体……        ← 这题在讲什么
 *
 * 第三类混进来是**最贵的一种错**（见 `docs/archive/decisions/021` 结论七）：
 * 把 `纳米金属` 当成知识点，等于声称"你对纳米金属掌握得不好"，
 * 而那道题考的是**中心理解**。于是"系统觉得你弱在哪"就永远说不清——
 * 而那正是学习者最需要看到、也最有权反驳的那句话（契约 §4.1）。
 *
 * 所以：**给模型一份封闭词表让它挑，而不是让它自己造**；
 * 挑不中的**不丢弃、不报错**，而是如实回报为"未映射"——那是词表该扩的证据。
 * 这与 ADR-026 决定 5（`ignored` 是模型的纠错回路）是同一条纪律。
 *
 * ═══ 为什么两轴记在同一个数组里 ═══
 * 断言层要按"题型 × 领域"两轴**分别结算**（契约 §4.2：按域建模，不混成一个总分），
 * 所以两者必须能一眼分开。判据是**两个集合不相交**——
 * 题型来自 `QUESTION_TYPES`，领域来自 `DOMAINS`，一个词不可能同时属于两者。
 * 于是 `topics: ['中心理解', '片段阅读']` 里哪个是哪个是确定的，不需要额外字段。
 *
 * ═══ 词表的内容从哪来 ═══
 * **全部来自试点产出的 86 个标签**（加上它们的同义写法当别名），不是凭空发明的。
 * 这是刻意的：凭空发明的词表配不上真实题目的分布，
 * 而"配不上对象的词汇表"正是作者在 ADR-017/018 里提醒过的那个错误。
 *
 * ═══ 加词表的纪律 ═══
 * 1. 新词只在**真实数据里出现过**才加（`unmapped_topics` 就是它的来源清单）；
 * 2. 同一个意思**只留一个规范名**，其余全部进 `aliases`——
 *    两个规范名指同一件事，会让统计在没人察觉的情况下对半分；
 * 3. **内容词不加**。判据：这个词能不能回答"学习者的哪种能力"？
 *    答不上来的（`相声`、`老年群体`）是题干信息，不进词表。
 */

/**
 * 题型轴（这题要你干什么）。值形如 `{ name, aliases }`。
 *
 * 量级刻意控制在二十项上下：它是**可机械枚举**的，模型照着挑不会挑错；
 * 一旦长到上百项，模型会开始挑相近的邻居，那就退化回自由产出了。
 */
export const QUESTION_TYPES = [
  { name: '中心理解', aliases: ['主旨概括', '主旨对策', '主旨', '中心思想', '意图判断', '意图', '总结', '总结conclusion', 'conclusion', '文段主旨', '概括'] },
  { name: '细节判断', aliases: ['细节理解', '细节查找', '细节比对', '细节', '理解正确', '符合文意'] },
  { name: '标题填入', aliases: ['标题', '拟标题'] },
  { name: '下文推断', aliases: ['下文', '接续'] },
  { name: '语句填入', aliases: ['语句填空', '选句填空', '填空', '横线处填入', '填入画横线'] },
  { name: '语句排序', aliases: ['语句衔接', '话题衔接', '上下文逻辑', '衔接', '语境分析', '行文逻辑', '排序'] },
  { name: '削弱论证', aliases: ['削弱', '论证削弱', '削弱质疑', '削弱论点', '削弱结论', '削弱建议可行性', '质疑', '反驳'] },
  { name: '加强论证', aliases: ['加强支持', '加强', '论证支持', '论证支持项', '支持'] },
  { name: '前提假设', aliases: ['前提条件', '前提', '假设', '必要条件', '排除非前提项'] },
  { name: '原因解释', aliases: ['解释', '原因'] },
  { name: '结论推出', aliases: ['推出', '推论', '必然性结论'] },
  { name: '真假推理', aliases: ['真假', '真话假话'] },
  { name: '翻译推理', aliases: ['翻译', '假言命题', '逆否命题', '否前不能否后'] },
  { name: '分析推理', aliases: ['组合排列', '排列', '方位关系', '方位推理', '空间推理'] },
  { name: '概念关系', aliases: ['概念外延', '集合关系', '矛盾关系', '偷换概念', '直言命题', '选言命题'] },
  { name: '论证结构', aliases: ['论证逻辑', '因果论证', '实验类论证', '可能性推理', '中介因果', '因果倒置', '另有他因', '搭桥', '反例削弱', '对照实验', '混淆变量', '样本代表性', '抽样代表性'] },
  { name: '数据推断', aliases: ['比例计算', '统计图表', '容斥问题', '平均数', '增长量'] },
]

/**
 * 领域轴（这题属于哪门）。对应契约 §4.2 的"域"。
 *
 * 刻意保持很短：域是**断言结算的分母**，域一多，"你哪门弱"就会碎成一堆单题域，
 * 于是什么都没有统计意义。加域的判据是"它下面能攒到足够多的题"，
 * 而不是"资料里出现了这个名词"。
 */
export const DOMAINS = [
  { name: '片段阅读', aliases: ['言语理解', '片段', '阅读理解'] },
  { name: '逻辑判断', aliases: ['判断推理', '逻辑', '逻辑推理'] },
  { name: '资料分析', aliases: [] },
  { name: '数量关系', aliases: ['数学运算', '数量'] },
  { name: '常识判断', aliases: ['常识'] },
]

/**
 * 一个标签常见的"带后缀"写法。
 *
 * ═══ 为什么需要它 ═══
 * 实测模型爱写括号补充：`削弱论证题（除哪项外）`、`翻译推理题（逻辑判断）`、
 * `加强支持题（最不能支持）`。括号里的内容是**那一道题的修饰**，不是另一个知识点。
 * 不剥掉的话，同一个知识点会以"带括号的变体"无限增殖——而两个名字会让统计对半分，
 * 且**不会报错**（同一条纪律：静默的错误比响亮的问题更贵）。
 *
 * 剥法是保守的：只剥掉**结尾**的括号补充与领头的"题"字，不动中间的内容。
 */
const DECORATIONS = [
  /\s*[（(【\[][^）)】\]]*[）)】\]]\s*$/u, // 结尾的括号补充
  /类$/u,
  /题$/u,
  /型$/u,
]

/** 归一化一个标签的**字面**（用于查表）：去空白、统一全角、剥装饰。 */
export function canonicalizeLabel(text) {
  let s = String(text ?? '').trim()
  if (s === '') return ''
  // 全角括号/顿号统一（同一个意思的两种写法不该是两个词）
  s = s.replace(/[（]/gu, '(').replace(/[）]/gu, ')').replace(/[、]/gu, '/')
  for (let i = 0; i < 3; i += 1) {
    let changed = false
    for (const re of DECORATIONS) {
      const next = s.replace(re, '')
      if (next !== s) {
        s = next
        changed = true
      }
    }
    if (!changed) break
  }
  return s.replace(/\s+/gu, '').toLowerCase()
}

/** 建立「别名（已归一化）→ 规范名」的索引。轴内部合并，两轴之间**不合并**。 */
function buildIndex(axis) {
  const index = new Map()
  for (const entry of axis) {
    index.set(canonicalizeLabel(entry.name), entry.name)
    for (const alias of entry.aliases) index.set(canonicalizeLabel(alias), entry.name)
  }
  return index
}

const TYPE_INDEX = buildIndex(QUESTION_TYPES)
const DOMAIN_INDEX = buildIndex(DOMAINS)

/** 所有规范名（两轴），供提示词渲染与校验用。 */
export const ALL_CANONICAL_TOPICS = [
  ...QUESTION_TYPES.map((e) => e.name),
  ...DOMAINS.map((e) => e.name),
]

/**
 * 把一个标签归一到规范名。
 *
 * @param text - 模型给的原文（可能是别名、可能带括号、可能是内容词）。
 * @returns `{ topic, axis }` —— 认不出时 `topic` 为 null、`axis` 为 null。
 */
export function canonicalTopic(text) {
  const key = canonicalizeLabel(text)
  if (key === '') return { topic: null, axis: null }
  const asType = TYPE_INDEX.get(key)
  if (asType !== undefined) return { topic: asType, axis: 'type' }
  const asDomain = DOMAIN_INDEX.get(key)
  if (asDomain !== undefined) return { topic: asDomain, axis: 'domain' }
  return { topic: null, axis: null }
}

/**
 * 把模型给的"一组标签"拆成单个标签。
 *
 * ═══ 为什么需要拆（实测：不拆就整条丢掉）═══
 * 同一份试点产物里，模型有时返回数组 `["主旨概括","言语理解"]`，
 * 有时返回**一个字符串** `"片段阅读 主旨概括"`（两次运行、两种写法）。
 * 不拆的话整个字符串会作为一个标签去查表，查不到 → 进 `unmapped` →
 * **这道题的知识点全空，而且不报错**。
 *
 * 拆法是保守的：只在**明确的分隔符**处拆（空白、逗号、顿号、斜杠、分号、竖线、加号），
 * 不猜词边界。代价是"一个知识点恰好含空格"这种写法拆不开——
 * 而那种写法本来也不该出现在封闭词表里（词表名都是连续的中文）。
 *
 * @param value - 数组或字符串。
 * @returns 字符串数组。
 */
export function splitTopicLabels(value) {
  if (Array.isArray(value)) return value.flatMap((v) => splitTopicLabels(v))
  if (value === undefined || value === null) return []
  // 只对**字符串**做分隔符拆分。
  // 非字符串（数字、对象）在调用方那里就是坏输入，任何形态都不该被拆——
  // 实测 `{}` 会被 String() 成 `[object Object]`，按空格一拆就成了
  // `[object` 与 `Object]` 两个垃圾标签，于是"报一次"变成"报两次"，
  // 而且报出来的东西与输入长得完全不一样（更难查）。
  if (typeof value !== 'string') return [String(value)]
  const text = value.trim()
  if (text === '') return []
  return text
    .split(/[\s,，、/;；|+]+/u)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * 归一化一组标签。
 *
 * ═══ 三条刻意的行为 ═══
 * 1. **认不出的不丢**，进 `unmapped`——那是词表该扩的证据（静默丢弃等于让词表永远不成长）；
 * 2. **顺序固定为"题型在前、领域在后"**，于是数组本身可读，且同一组标签的总顺序稳定；
 * 3. **不用 JSON Schema 的 enum 去硬拦**。模型挑不中时抛错会让整批题失败，
 *    而它挑不中恰恰是**我们**该知道的信号——拦掉就看不见了。
 *    （这与 ADR-019 决定 4 的精神一致：未知的 `order` 退回默认并留痕，不抛错。）
 *
 * @param list - 标签数组或字符串（见 splitTopicLabels）。
 * @returns `{ topics, unmapped, byAxis }`。
 */
export function normalizeTopics(list) {
  const types = []
  const domains = []
  const unmapped = []
  const seen = new Set()

  for (const text of splitTopicLabels(list)) {
    const { topic, axis } = canonicalTopic(text)
    if (topic === null) {
      // 同一个认不出的词出现两次，只报一次（它是词表问题，不是每题问题）
      if (!unmapped.includes(text)) unmapped.push(text)
      continue
    }
    if (seen.has(topic)) continue
    seen.add(topic)
    if (axis === 'type') types.push(topic)
    else domains.push(topic)
  }

  return { topics: [...types, ...domains], unmapped, byAxis: { type: types, domain: domains } }
}

/**
 * 渲染词表（给提示词用）。
 *
 * ═══ 为什么从数据生成而不是手写一份 ═══
 * 与 ADR-026 决定 6 同一条理由：手写一份的话，改了词表却忘了改提示词，
 * 模型就会按过时的词表调用，而它收到的回报又说"这个词不在允许值里"——
 * **两边互相矛盾，模型开始瞎猜**。
 *
 * @returns 形如 `中心理解 / 细节判断 / …` 的文本（两轴分行）。
 */
export function describeTopicVocabulary() {
  return {
    types: QUESTION_TYPES.map((e) => e.name).join(' / '),
    domains: DOMAINS.map((e) => e.name).join(' / '),
  }
}

/**
 * 校验词表自身（自测与闸门用）。
 *
 * @returns `{ ok, errors }`。
 */
export function validateVocabulary() {
  const errors = []
  const typeNames = new Set()
  for (const entry of QUESTION_TYPES) {
    if (typeNames.has(entry.name)) errors.push(`题型词表有重复规范名：${entry.name}`)
    typeNames.add(entry.name)
  }
  const domainNames = new Set()
  for (const entry of DOMAINS) {
    if (domainNames.has(entry.name)) errors.push(`领域词表有重复规范名：${entry.name}`)
    domainNames.add(entry.name)
  }
  // 两轴必须不相交 —— 否则 `topics` 里一个词属于哪一轴就不确定了
  for (const name of typeNames) {
    if (domainNames.has(name)) errors.push(`同一个词同时是题型与领域：${name}`)
  }
  // 别名不能跨轴撞车
  for (const entry of QUESTION_TYPES) {
    for (const alias of entry.aliases) {
      const { topic, axis } = canonicalTopic(alias)
      if (axis !== 'type' || topic !== entry.name) {
        errors.push(`别名「${alias}」没有归到 ${entry.name}（实际：${topic ?? '认不出'}）`)
      }
    }
  }
  for (const entry of DOMAINS) {
    for (const alias of entry.aliases) {
      const { topic, axis } = canonicalTopic(alias)
      if (axis !== 'domain' || topic !== entry.name) {
        errors.push(`别名「${alias}」没有归到 ${entry.name}（实际：${topic ?? '认不出'}）`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}
