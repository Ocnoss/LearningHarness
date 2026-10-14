/**
 * 刷题循环的取题与统计 —— 纯函数层。
 *
 * ═══ 它解决什么问题 ═══
 * 题库有了对象与接口（ADR-017/018），但**循环是断的**：
 *   - agent 手上没有"取题"这个动作，只能去读 `lh-questions/*.json` 全文
 *     （那正是资源索引器踩过的坑：8,400 tokens 塞进对话、每轮重发）；
 *   - 作答记下来之后，也取不回解析，讲不出为什么错。
 * 本文件补前半截：**从题库里挑出"现在该给哪几道题"**。
 *
 * ═══ 为什么顺序是纯函数、不是提示词 ═══
 * 契约 §1.1：内核拥有语法，插件拥有判断。但"下一题给哪道"是**可以机械化表达的策略**——
 * 它属于语法一侧，不属于"跟模型说一句希望它照做"。写成函数的好处很直接：
 * 可复现（同一个题库 + 同一批作答 → 同样的顺序）、可测试、可替换（换策略不改调用方）。
 *
 * ═══ 现在刻意不做间隔重复 ═══
 * 契约 §8.4-A 说 FSRS 直接采用 `ts-fsrs`，但**那要等作答数据够**。
 * 现在做等于在没有数据时发明参数，而且会把"顺序"这个概念的调试难度抬高一个量级。
 * 所以本版只有机械顺序与随机：确定性、可复现、出事能查。
 */

// 知识点词表：`topics` 的 schema 由 topics.js 拥有，选择层必须用它归一化，
// 否则"主旨概括"筛不到"中心理解"那批题——而那种失败看起来像"题库里没有这样的题"。
import { canonicalTopic } from './topics.js'

/**
 * 出题顺序。
 *
 * `unseen` / `attempted` / `missed` 都需要作答记录，所以它们在**没有相应记录时
 * 退化为 `sequential`**，而不是报错或返回空——那样会让"刚开始刷题的人"拿到一个坏掉的工具。
 *
 * ⚠ `attempted`（做过的）与 `missed`（上次答错的）**是两件不同的事，不能合并**：
 * 学习者说"我想重刷做过的题"时，他指的是**做过的那些**，不是"做错的那几个"。
 * 之前只有 `missed`，于是"重刷做过的"无处可映射，只能退化成整个题库——
 * 学习者看到的现象就是"我说了要重刷，弹出的还是全题库"（2026-09-19 反馈）。
 */
export const ORDER_KINDS = ['sequential', 'random', 'unseen', 'attempted', 'missed']

/**
 * 学习者会怎么描述这些档位（给工具描述用，也给人看）。
 *
 * 为什么把它写成数据而不是散在文案里：它的用途是**让模型把学习者的说法映射到档位**——
 * "重刷做过的" → `attempted`、"只练错题" → `missed`、"没做过的" → `unseen`。
 * 这个映射是这张卡片能不能"听懂人话"的关键，所以放在档位旁边，改档位时一定看得见。
 */
export const ORDER_HINTS = {
  sequential: '按题库原顺序（题库顺序通常按章节，有意义）',
  random: '随机',
  unseen: '只出**没做过的**（学习者说"没做过的/新的/往下刷"）',
  attempted: '只出**做过的**（学习者说"重刷做过的/复习我做过的"）',
  missed: '只出**最近一次答错的**（学习者说"只练错题/看看我错在哪"）',
}

/** `ids` 一次最多接受多少个。给上限是因为它会被写进信号文件与 URL，不是因为它"重"。 */
const MAX_IDS = 200

/**
 * 校验并归一化"这次要刷哪些题"。
 *
 * ═══ 它为什么存在（2026-09-19 反馈）═══
 * 作者说："当我和模型说'给我 10 题'或者说'我想重刷做过的题目'，
 * 弹出的卡片依然是 49 题的全题库……而不能呈现出 10 道题或是仅有错题的卡片。"
 *
 * 根因有两层，这一层是**词汇**：`start_practice` 当时只有 `bank_name`/`count`/`style`，
 * **根本没有表达"选择"的词汇**。所以"只错题""只做过的"无处可传，
 * 卡片只能表示"某个题库"——也就是整个题库。
 *
 * ═══ 校验只在**这一处**（与 `style.js` 同一套做法）═══
 * 客户端不认识这些值就退回默认，绝不重复校验。
 * 两处校验 = 两套规则，迟早不一致，而那时"哪个才对"无法回答。
 *
 * ⚠ **不抛错，只忽略**：外观参数写错不该让刷题失败，**选择参数同理**——
 * 认不出的档位退回顺序、认不出的 topic 交给下游如实报告。
 * 但被忽略的项要**如实回报**，否则模型会以为自己说的"只错题"生效了。
 *
 * @param raw - `{order, topic, ids}`（都可能缺）。
 * @param opts.ignoreKeys - 调用方**自己的**参数名（如工具层的 `bank_name`/`count`/`style`），
 *   这些不该被报成"不认识的选择字段"。
 *   ⚠ 为什么要有这个参数：第一版工具层只把 `order/topic/ids` 三个键**挑出来**传进来，
 *   于是模型发明的字段名（`only_wrong`）**根本到不了这里**，
 *   "不认识的字段"那条报告**永远不会触发**——而它正是给模型纠错用的。
 *   **挑出已知键再校验 = 把未知键静默丢掉。**
 * @returns `{selection, ignored}`：归一化后的选择，与被忽略项的说明。
 */
export function sanitizeSelection(raw, { ignoreKeys = [] } = {}) {
  const ignored = []
  const selection = {}
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    ignored.push(`选择必须是对象，收到 ${Array.isArray(raw) ? 'array' : typeof raw}`)
  }

  // order：认不出就**不放进 selection**（下游会按默认顺序走），并如实报告
  if (src.order !== undefined && src.order !== null) {
    if (typeof src.order === 'string' && ORDER_KINDS.includes(src.order)) {
      selection.order = src.order
    } else {
      ignored.push(`order=${JSON.stringify(src.order)} 不是合法档位（可选：${ORDER_KINDS.join(' / ')}）`)
    }
  }

  // topic：非空字符串；**是否存在这个知识点交给下游**（它会如实报告"没有匹配的题"）。
  //
  // ⚠ 这里会**过词表归一化**（`docs/archive/decisions/021` 结论七）：题库里的 `topics` 是规范名，
  // 所以 `主旨概括` 与 `中心理解` 必须指向同一批题。
  // 归一化放在**这一处**（卡片与工具共用的唯一校验点），而不是两个工具里各做一次——
  // 两处归一化 = 两套规则，迟早不一致（与 style.js 那条"校验只在一处"同一理由）。
  if (src.topic !== undefined && src.topic !== null) {
    if (typeof src.topic === 'string' && src.topic.trim() !== '') {
      const asked = src.topic.trim()
      const { topic } = canonicalTopic(asked)
      // 认不出的**保留原样**：下游会如实报告"没有匹配的题"，
      // 而在这里丢掉会让"知识点写错了"表现成"题库里没有这样的题"——两件事不同。
      selection.topic = topic ?? asked
      if (topic !== null && topic !== asked) selection.topic_asked = asked
    } else {
      ignored.push(`topic=${JSON.stringify(src.topic)} 必须是非空字符串`)
    }
  }

  // ids：逐项校验，去重，限长
  if (src.ids !== undefined && src.ids !== null) {
    if (!Array.isArray(src.ids)) {
      ignored.push(`ids 必须是数组，收到 ${typeof src.ids}`)
    } else {
      const kept = []
      for (const id of src.ids) {
        if (typeof id === 'string' && id.trim() !== '') kept.push(id.trim())
        else ignored.push(`ids 里的 ${JSON.stringify(id)} 不是合法题目 id`)
      }
      const unique = [...new Set(kept)]
      if (unique.length > MAX_IDS) {
        ignored.push(`ids 给了 ${unique.length} 个，超过上限 ${MAX_IDS}，只取前 ${MAX_IDS} 个`)
      }
      if (unique.length > 0) selection.ids = unique.slice(0, MAX_IDS)
    }
  }

  // 不认识的键也报告出来：模型很容易发明字段名（`only_wrong`、`filter`），
  // 静默忽略会让它反复试同一个错名字。
  //
  // ⚠ 要看**原始 args**（而不是挑出来的三个键），否则这条永远不触发；
  // 同时跳过调用方自己的合法参数名（见 opts.ignoreKeys）。
  const known = new Set(['order', 'topic', 'ids', ...ignoreKeys])
  for (const key of Object.keys(src)) {
    if (!known.has(key)) ignored.push(`不认识的选择字段 ${key}`)
  }

  return { selection, ignored }
}

/**
 * 把选择说成一句人话（给卡片与工具返回值用，让学习者与 agent 都确认"这次刷的是哪些"）。
 *
 * @param selection - `sanitizeSelection` 的 selection。
 * @param count - 这次要几道（可选）。
 * @returns 描述文本；空选择时给"题库里按顺序出"。
 */
export function describeSelection(selection, count) {
  const s = selection ?? {}
  const parts = []

  if (Array.isArray(s.ids) && s.ids.length > 0) {
    parts.push(`指定 ${s.ids.length} 道`)
  } else {
    parts.push(ORDER_HINTS[s.order] ?? ORDER_HINTS.sequential)
  }
  if (typeof s.topic === 'string' && s.topic !== '') {
    // 写过词表外的说法时把原话也带上：学习者/agent 才知道"我说的那个词被理解成了这个"
    parts.push(
      typeof s.topic_asked === 'string' && s.topic_asked !== ''
        ? `知识点「${s.topic}」（原说法「${s.topic_asked}」）`
        : `知识点「${s.topic}」`,
    )
  }
  if (typeof count === 'number' && count > 0) parts.push(`${count} 道`)
  return parts.join(' · ')
}

/**
 * 从事件数组里建立"作答索引"。
 *
 * @param events - LH 事件数组。
 * @returns `{ byQuestion, attemptedIds }`；byQuestion 的每项是
 *   `{ attempts, correct, wrong, unjudged, last_at, last_correct }`。
 */
export function buildAttemptIndex(events) {
  const byQuestion = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'lh/user/attempt') continue
    const d = event?.data
    if (typeof d?.question_id !== 'string' || d.question_id === '') continue

    const prev = byQuestion.get(d.question_id) ?? {
      attempts: 0,
      correct: 0,
      wrong: 0,
      unjudged: 0,
      last_at: null,
      last_correct: null,
    }
    prev.attempts += 1
    if (d.correct === true) prev.correct += 1
    else if (d.correct === false) prev.wrong += 1
    else prev.unjudged += 1

    const at = String(event.timestamp ?? '')
    if (prev.last_at === null || at >= prev.last_at) {
      prev.last_at = at
      // last_correct 是"最近一次"的结果——错题本要的是这个，不是"曾经错过"
      prev.last_correct = d.correct === true ? true : d.correct === false ? false : null
    }
    byQuestion.set(d.question_id, prev)
  }
  return { byQuestion, attemptedIds: new Set(byQuestion.keys()) }
}

/**
 * 挑出要刷的题。
 *
 * ═══ 一个刻意的取舍：题库文件的顺序就是"资料里的顺序" ═══
 * `sequential` 不改动任何次序。理由：题库是**人的材料**，它的顺序通常有意义
 * （按章节、由易到难）。按 id、按字母重排会把那个意义丢掉，而丢掉之后
 * 学习者会觉得"题是乱的"——那是产品问题，不只是排序问题。
 *
 * @param params.bank - 题库对象。
 * @param params.attemptIndex - `buildAttemptIndex` 的结果；省略则视为全未作答。
 * @param params.count - 取几道（默认 1）。
 * @param params.order - 顺序策略，见 ORDER_KINDS。
 * @param params.topic - 只看某个知识点（题库里 topics 允许空，所以这会把没打标的题排除掉）。
 * @param params.ids - 直接指定题目 id（给了就忽略 order）。
 * @param params.excludeIds - 排除这些题（通常是"本次已经出过的"）。
 * @returns `{ questions, order, considered, note }`；note 说明策略被如何调整过。
 */
export function selectQuestions({
  bank,
  attemptIndex,
  count = 1,
  order = 'sequential',
  topic,
  ids,
  excludeIds = [],
}) {
  const all = Array.isArray(bank?.questions) ? bank.questions : []
  const idx = attemptIndex ?? { byQuestion: new Map(), attemptedIds: new Set() }
  const excluded = new Set(excludeIds)
  const notes = []

  // ① 指定 id 优先：调用方明确要哪几道时，任何策略都不该插手
  if (Array.isArray(ids) && ids.length > 0) {
    const wanted = new Set(ids)
    const found = all.filter((q) => wanted.has(q.id))
    const missing = ids.filter((id) => !found.some((q) => q.id === id))
    if (missing.length > 0) notes.push(`有 ${missing.length} 个 id 不在题库里：${missing.slice(0, 5).join('、')}`)
    return { questions: found, order: 'ids', considered: found.length, note: notes.join('；') }
  }

  if (!ORDER_KINDS.includes(order)) {
    notes.push(`顺序策略 "${order}" 不认识，按 sequential 处理`)
    order = 'sequential'
  }

  // ② 过滤
  let pool = all.filter((q) => !excluded.has(q.id))
  if (typeof topic === 'string' && topic !== '') {
    const before = pool.length
    pool = pool.filter((q) => Array.isArray(q.topics) && q.topics.includes(topic))
    if (pool.length === 0 && before > 0) {
      notes.push(`知识点 "${topic}" 没有匹配的题（题库里 ${all.filter((q) => (q.topics ?? []).length > 0).length} 道题打了知识点标签）`)
    }
  }

  const considered = pool.length

  // ③ 排序
  if (order === 'unseen') {
    const unseen = pool.filter((q) => !idx.attemptedIds.has(q.id))
    // 全刷过了就退化为顺序重刷，而不是返回空——
    // 返回空会让"想继续练"变成"工具说没题了"，而实际上题都在。
    if (unseen.length > 0) pool = unseen
    else notes.push('所有题都做过了，退化为按顺序重刷')
  } else if (order === 'attempted') {
    // "重刷做过的题"：**做过至少一次**的都算（不管上次对错）。
    //
    // 为什么必须单独有这一档：这正是"我说要重刷，弹出的还是整个题库"的根因——
    // 之前只有 `missed`（上次答错的），"做过的"无处可映射。
    const done = pool.filter((q) => idx.attemptedIds.has(q.id))
    if (done.length > 0) pool = done
    else notes.push('还没有做过的题，退化为按顺序')
  } else if (order === 'missed') {
    const missed = pool.filter((q) => idx.byQuestion.get(q.id)?.last_correct === false)
    if (missed.length > 0) pool = missed
    else notes.push('没有"最近一次答错"的题，退化为按顺序')
  } else if (order === 'random') {
    // Fisher–Yates，不改原数组
    const shuffled = [...pool]
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    pool = shuffled
  }

  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
  const picked = pool.slice(0, n)
  if (picked.length < n) {
    notes.push(`只取到 ${picked.length} 道（要 ${n} 道）`)
  }

  return { questions: picked, order, considered, note: notes.join('；') }
}

/**
 * 把一道题变成**给学习者看的样子**：去掉答案与解析。
 *
 * ═══ 为什么这必须是一个显式的函数，而不是"记得别传" ═══
 * 如果把整道题（含 `answer`）交给模型去念，答案就进了上下文——
 * 它可能顺口说出来，也可能在后续推理里被"看见"。
 * 更实际的风险是：**出题的工具一旦返回答案，任何一次调用都会污染整个循环**，
 * 而这种事在日志里看不出来（工具调用是成功的）。
 *
 * 所以"去掉答案"是这一层的职责，不是调用方的自觉。
 *
 * @param question - 题目对象。
 * @returns 可安全展示的题目（含 id，便于随后提交作答）。
 */
export function toPresentableQuestion(question) {
  return {
    id: question.id,
    kind: question.kind,
    stem: question.stem,
    // 选项带标签，与"点击式选项"是同一份数据：
    // 文本界面念 "A. 1954年"，将来的界面直接渲染成按钮——**不需要改契约**。
    options: (Array.isArray(question.options) ? question.options : []).map((text, i) => ({
      label: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] ?? String(i + 1),
      text,
    })),
    topics: Array.isArray(question.topics) ? question.topics : [],
    source: question.source,
  }
}

/**
 * 把一道题变成**讲解用的样子**：带答案与解析。
 *
 * @param question - 题目对象。
 * @returns 含答案、可接受答案、解析的题目。
 */
export function toRevealedQuestion(question) {
  const analysis = question.analysis ?? ''
  return {
    ...toPresentableQuestion(question),
    answer: question.answer,
    accept: Array.isArray(question.accept) ? question.accept : [],
    analysis,
    // 解析的**来路与质量**，随解析一起给出去。
    //
    // 为什么必须带上：题库里的解析很多是 OCR 自动抽取的**两栏串行**文本
    // （读起来会跳，见 scripts/audit-bank-analysis.mjs），还有一些只是选项标注的拼凑。
    // 不标注，模型会把串行的句子当权威原文去解释——**编出连贯但错的道理**，
    // 那比"没有解析"更糟。所以"有解析"这件事必须连"它可不可靠"一起说。
    analysis_kind: question.provenance?.analysis_kind ?? (analysis === '' ? '无' : '未标注'),
  }
}

/**
 * 汇总刷题进度（供"我练了多少、哪块不行"用）。
 *
 * ═══ 与 `attempt.js` 的 `summarizeAttempts` 的区别 ═══
 * 那个是**通用**统计（按来源分组、按题聚合）；
 * 这个是**面向刷题**的：以题库为分母算覆盖率，并给出"最近答错"的题列表。
 * 分开而不是加参数，是因为两者的默认口径不同——
 * 刷题视角关心"这个题库我刷了多少"，通用视角不关心题库。
 *
 * @param params.bank - 题库对象。
 * @param params.events - LH 事件数组。
 * @param params.missedLimit - 返回多少道最近答错的题。
 * @returns 进度摘要。
 */
export function summarizeProgress({ bank, events, missedLimit = 20 }) {
  const { byQuestion, attemptedIds } = buildAttemptIndex(events)
  const all = Array.isArray(bank?.questions) ? bank.questions : []

  // ═══ 人的作答与模型的作答必须分开计数 ═══
  // 混在一起会让"模型答对了"抬高学习者的正确率（ADR-018 决定 6）。
  // 第一版把两者混算又自称"分母只算人的"，那是自相矛盾的——
  // 所以这里对每条作答都先判来源，再分别计数。
  const tally = (src) => ({ attempts: 0, correct: 0, wrong: 0, unjudged: 0 })
  const human = tally()
  const other = tally()
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'lh/user/attempt') continue
    const bucket = event?.data?.source === 'human' ? human : other
    bucket.attempts += 1
    if (event?.data?.correct === true) bucket.correct += 1
    else if (event?.data?.correct === false) bucket.wrong += 1
    else bucket.unjudged += 1
  }

  // 只统计题库里还存在的题：题库可能被重导，历史作答会指向已不存在的 id
  const inBank = all.filter((q) => attemptedIds.has(q.id))
  const judged = human.correct + human.wrong

  const missed = all
    .filter((q) => byQuestion.get(q.id)?.last_correct === false)
    .sort((a, b) => String(byQuestion.get(b.id).last_at ?? '').localeCompare(String(byQuestion.get(a.id).last_at ?? '')))
    .slice(0, missedLimit)
    .map((q) => ({
      id: q.id,
      stem: q.stem.slice(0, 40),
      wrong_count: byQuestion.get(q.id).wrong,
      last_at: byQuestion.get(q.id).last_at,
    }))

  return {
    total_questions: all.length,
    attempted_questions: inBank.length,
    // 覆盖率的分母是题库总量；没有题时是 null 而不是 0（"没题"不等于"没练"）
    coverage: all.length === 0 ? null : Number((inBank.length / all.length).toFixed(4)),
    human,
    other,
    // 正确率：**只算人答的、且只算判得了的**
    accuracy: judged === 0 ? null : Number((human.correct / judged).toFixed(4)),
    missed_recent: missed,
  }
}
