/**
 * lh-question-bank-ui 的【视图组装层】—— **唯一的视图实现**。
 *
 * ═══ 为什么单独一层，而不是写在路由里 ═══
 * 与 `@lh/course-tree/directory.js`、`@lh/schedule/calendar.js` 同一条分工：
 * 路由只负责"读盘 + 转成 HTTP"，**形状怎么组装只在这里**。于是：
 *   · 这一层是纯函数（输入是已经读好的 `banks` / `events` / `archived`，不碰文件系统），
 *     可以不起宿主、不建临时目录就测——`selftest.mjs` 覆盖的就是它；
 *   · 界面永远不会"自己再推一遍"：题库/来源/题目/记录四段的形状只有这一处定义。
 *
 * ═══ 它不重复实现什么（这是本文件最要紧的一条纪律）═══
 *   · **题库读取与判据**：`@lh/question-bank/bank`（loadBank / listQuestionBanks / isBankFile）；
 *   · **作答的解析与统计**：`@lh/question-bank/attempt`（`extractAttempts` / `summarizeAttempts`）；
 *   · **题型枚举**：`@lh/question-bank/question`。
 * 一个字段名、一条判据都不在这里重写——本项目吃过"两份判据各自漂移、而失败是静默的"的亏
 * （`requireBank` 那段 20 行注释记的就是同类事故）。视图层只做**呈现所需的取舍**
 * （截断、分页、排序、把指针翻成标题），不做判定。
 *
 * ═══ 「只列能对上号的」（作者 2026-10-13 定的口径）═══
 * 作答记录按 `question_id` 跨库 join。对不上任何题库的那些**不进列表**，
 * 但**必须有一行计数**（`unmatched_attempt_count`）——静默丢弃是本项目反复记的形状，
 * 而"我明明做过 21 次，面板只说 20 次"正是那种没人能查的错。
 */

import { extractAttempts, summarizeAttempts, verdictOf, ATTEMPT_SOURCES } from '@lh/question-bank/attempt'
import { extractNotes, activeNotesByTarget } from '@lh/question-bank/note'
import { QUESTION_KINDS } from '@lh/question-bank/question'

/** 分页默认与上限。上限是硬的：一个 600 题的库不该被一次请求整包塞进浏览器。 */
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

/** 四段读法（与四条读路由一一对应）。 */
export const VIEW_KINDS = ['banks', 'source', 'questions', 'attempts']

/** 记录段的对错过滤值。`null` 是**判不了**的独立一态，不能与 false 合并（ADR-018 决定 5）。 */
export const CORRECT_FILTERS = ['all', 'true', 'false', 'null']

/**
 * 判决的过滤值（**四态**，含"部分正确"）。
 *
 * 与 `CORRECT_FILTERS` 并存而不是替换它：
 *   · `correct` 问的是"三态原值"（布尔语义，旧口径）；
 *   · `verdict` 问的是"人话判决"（正确 / 部分正确 / 错误 / 判不了），**派生**自三态 + 分数。
 * 两个问题都正当，而判决是界面该用的那个。
 */
export const VERDICT_FILTERS = ['all', 'correct', 'partial', 'wrong', 'unjudged']

/** 多个答案项拼成**字符型**答案时的分隔符（作者 2026-10-13：正确答案列用字符型）。 */
export const ANSWER_SEP = '、'

/**
 * 把题目的官方答案折成**字符型**（做题记录里那一列）。
 *
 * 为什么一律折成字符串：选择题的 `['A','C']`、填空题的 `['42']`、将来简答题的整段文字，
 * 在这一列里是**同一件事**（"官方答案是什么"）。分两种类型渲染会让列宽与比对逻辑分叉，
 * 而收益是零。
 *
 * @param question - 题目对象。
 * @returns 答案字符串；没有答案时是空串（而不是 'undefined' 之类）。
 */
export function answerText(question) {
  const list = Array.isArray(question?.answer) ? question.answer : []
  return list.map((a) => String(a)).join(ANSWER_SEP)
}

/** 题目段的作答状态过滤值。 */
export const QUESTION_STATE_FILTERS = ['all', 'unseen', 'done', 'wrong']

/**
 * 作答的**口径**：`human` 只看人的作答，`all` 含模型 / 导入的。
 *
 * ═══ 为什么默认必须是 `human`（这不是偏好，是纪律）═══
 * ADR-018 决定 6 / ADR-019 决定 6：**模型答对了不是"我会了"**。
 * 一旦模型作答混进"这个人答得怎么样"，学习者模型上的每个数字都会失真——
 * 而失真是**看不出来**的（题目看起来都正常、数字看起来也正常）。
 *
 * 所以：统计类口径（题库正确率、每库统计、题目的"最近对错"、错题筛选）
 * **默认只算人的**；非人作答的数量**如实单列**（`non_human_attempt_count`），
 * 既不计入、也不隐藏——隐藏事实是另一种错。
 *
 * 这条口径是 2026-10-13 用模型模拟作答时**当场暴露**出来的：
 * 在那之前面板只按 `question_id` join，根本没看 `source`。
 */
export const ATTEMPT_SCOPES = ['human', 'all']

/**
 * 按口径筛作答。
 *
 * @param attempts - `extractAttempts` 的 attempts。
 * @param scope - `human`（默认）或 `all`。
 * @returns 筛后的数组。
 */
export function scopeAttempts(attempts, scope) {
  const list = Array.isArray(attempts) ? attempts : []
  return scope === 'all' ? list : list.filter((a) => a.source === 'human')
}

/**
 * 口径的规范化：认不出的值一律退回 `human`。
 * 保守方向是**宁少算不混算**——把模型作答算进人的成绩，比漏算严重得多。
 *
 * @param value - 原始值。
 * @returns `human` 或 `all`。
 */
export function normalizeScope(value) {
  return ATTEMPT_SCOPES.includes(value) ? value : 'human'
}

/** 人作答在「作答者」里的键（界面显示为「用户」）。 */
export const HUMAN_ANSWERER = 'human'

/** 模型作答但**没记型号**时的键（不假装知道是哪个模型）。 */
export const UNKNOWN_MODEL_ANSWERER = 'model:unknown'

/**
 * 一条作答的**作答者键**。
 *
 * ═══ 为什么不是直接用 `source` ═══
 * `source` 只有三类（human / llm / imported），而"让不同型号的模型都来试"要求能按
 * **型号**分别看。所以键在 llm 里再分一层；没记型号的归 `model:unknown`——
 * **如实标注"不知道是哪个模型"**，而不是塞进一个笼统的"模型"里。
 *
 * @param attempt - 一条作答。
 * @returns 作答者键。
 */
export function answererOf(attempt) {
  const src = attempt?.source
  if (src === 'human') return HUMAN_ANSWERER
  if (src === 'llm') return text(attempt.model) ?? UNKNOWN_MODEL_ANSWERER
  return String(src ?? 'unknown')
}

/**
 * 按「作答者」多选筛。
 *
 * ⚠ **空选 = 什么都不显示**，而不是"全选"：这一处的意图是"我只想看某几个模型的答案"，
 *   把空选解释成全选会在最坏的时刻（什么都没勾）给出最多的数据，与意图相反。
 *
 * @param attempts - 全部作答。
 * @param answerers - 选中的作答者键数组。
 * @returns 筛后的数组。
 */
export function selectByAnswerers(attempts, answerers) {
  const list = Array.isArray(attempts) ? attempts : []
  if (!Array.isArray(answerers) || answerers.length === 0) return []
  const want = new Set(answerers.map((a) => String(a)))
  return list.filter((a) => want.has(answererOf(a)))
}

/**
 * 这批作答里**出现过**哪些作答者（含条数）——界面据此渲染复选框。
 *
 * 顺序：「用户」在最前，其余按条数降序。**只列出现过的**：没出现过的模型不该占一格。
 *
 * @param attempts - 全部作答。
 * @returns `[{ key, label, count }]`。
 */
export function availableAnswerers(attempts) {
  const counts = new Map()
  for (const a of Array.isArray(attempts) ? attempts : []) {
    const key = answererOf(a)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const rows = [...counts.entries()].map(([key, count]) => ({
    key,
    count,
    label: key === HUMAN_ANSWERER ? '用户' : key === UNKNOWN_MODEL_ANSWERER ? '模型（未记录型号）' : key,
  }))
  rows.sort((a, b) => {
    if (a.key === HUMAN_ANSWERER) return -1
    if (b.key === HUMAN_ANSWERER) return 1
    return b.count - a.count
  })
  return rows
}

/**
 * 解析 `answerers` 查询参数（逗号分隔）。
 *
 * ⚠ **"没给"与"给了但为空"是两个意思**（2026-10-14 审查修的缺陷）：
 *   · 没给（null）→ 返回 null，调用方退回 `scope` 粗口径；
 *   · `answerers=`（空串）→ 返回 []，即**明确的"一个都不选"**（显示为空，不是全选）。
 * 旧实现把两者都折成 null，于是界面承诺的"一个都没勾 = 不显示任何记录"被静默打翻。
 *
 * @param raw - 原始字符串。
 * @returns 键数组；**没给**时返回 null。
 */
export function parseAnswerers(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'string') return null
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 作答行里题干预览的长度（列表要一眼能扫，完整题干在题目段看）。 */
export const STEM_PREVIEW_CHARS = 120

/**
 * 把 limit 收进合法区间。
 *
 * 为什么不接受"不传就全给"：那会让一次误点把 600 题的整库正文拉进浏览器，
 * 而症状是"面板卡住"——比报错更难归因。
 *
 * @param value - 原始值。
 * @returns 1..MAX_LIMIT 之间的整数。
 */
export function clampLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

/**
 * 把 offset 收成非负整数。
 * @param value - 原始值。
 * @returns 非负整数。
 */
export function clampOffset(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/** 取非空字符串（空/空白一律当"没有"）。 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 题干预览：压掉换行、截断到 `n` 字。
 *
 * 为什么必须压换行：列表行是单行省略号（`nowrap + ellipsis`），
 * 不压的话一道题的换行会把整列撑高，其它行就挤没了（ADR-037 §11.7 的同一课）。
 *
 * @param stem - 题干全文。
 * @param n - 最多多少字。
 * @returns 预览文本。
 */
export function previewStem(stem, n = STEM_PREVIEW_CHARS) {
  const s = String(stem ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

/**
 * 建"题目 id → 它属于哪个题库"的索引。
 *
 * ═══ 为什么这是 join 的唯一依据 ═══
 * 作答事件里只有 `question_id`（ADR-017 决定 6），没有题库名。而题目 id 是
 * "出处 + 源编号 + 题干指纹"派生的全局唯一值（ADR-028），所以**跨库遍历一遍就能建出索引**，
 * 不需要任何新的字段、也不需要改事件。
 *
 * ⚠ 同一个 id 出现在两个库里时**如实标注**（`duplicate_in`），不静默取第一个——
 * 那正说明 id 唯一性被破坏了，而它会让"这条作答算哪个库"变成猜。
 *
 * @param banks - `[{ name, bank }]`（`bank` 可为 null = 读不出来）。
 * @returns `{ byId: Map, duplicates: [{ id, banks: [] }], questionCount }`。
 */
export function indexQuestions(banks) {
  const byId = new Map()
  const duplicates = []
  let questionCount = 0
  for (const entry of Array.isArray(banks) ? banks : []) {
    const questions = Array.isArray(entry?.bank?.questions) ? entry.bank.questions : []
    for (const q of questions) {
      questionCount += 1
      if (typeof q?.id !== 'string' || q.id === '') continue
      const hit = byId.get(q.id)
      if (hit === undefined) {
        byId.set(q.id, { bankName: entry.name, question: q })
      } else if (hit.bankName !== entry.name) {
        const existing = duplicates.find((d) => d.id === q.id)
        if (existing === undefined) duplicates.push({ id: q.id, banks: [hit.bankName, entry.name] })
        else if (!existing.banks.includes(entry.name)) existing.banks.push(entry.name)
      }
    }
  }
  return { byId, duplicates, questionCount }
}

/**
 * 一个库的作答统计（按该库的题目 id 集合去算）。
 *
 * 为什么不用 `summarizeAttempts({ source })` 那套：那个维度是"谁答的"（human/llm），
 * 这里要的是"哪个库"。同一个三态统计，换一个分组维度——所以**复用它算出来的
 * `per_question`**，不自己再写一遍三态判断。
 *
 * @param params.questions - 该库的题目数组。
 * @param params.perQuestion - `summarizeAttempts(...).per_question`。
 * @returns `{ attempted, attempts, correct, wrong, unjudged, accuracy, last_at }`。
 */
export function summarizeBankAttempts({ questions, perQuestion }) {
  let attempted = 0
  let attempts = 0
  let correct = 0
  let wrong = 0
  let partial = 0
  let unjudged = 0
  let lastAt = null
  for (const q of Array.isArray(questions) ? questions : []) {
    const h = perQuestion?.[q?.id]
    if (h === undefined) continue
    attempted += 1
    attempts += h.attempts
    correct += h.correct
    wrong += h.wrong
    partial += h.partial ?? 0
    unjudged += h.unjudged
    if (h.last_at !== null && (lastAt === null || String(h.last_at) > String(lastAt))) lastAt = h.last_at
  }
  const judged = correct + wrong
  return {
    attempted,
    attempts,
    correct,
    wrong,
    partial,
    unjudged,
    // 分母只算判得了的；judged=0 时是 null 而不是 0——"没数据"不等于"全错"
    accuracy: judged === 0 ? null : Number((correct / judged).toFixed(4)),
    last_at: lastAt,
  }
}

/**
 * 题库段：每个库一行摘要 + 全局合计。
 *
 * @param params.banks - `[{ name, path, ok, errors, bank }]`。
 * @param params.archived - `[{ name, path, ok, question_count, title }]`（来自 `lh-questions/.archived/`）。
 * @param params.events - LH 全量事件。
 * @returns 题库段视图。
 */
export function buildBankList({ banks, archived = [], events, scope = 'human', answerers = null }) {
  const { attempts: allAttempts, malformed } = extractAttempts(events)
  // answerers 是更细的切口（按人/型号多选）；没给时退回 scope 粗切口（人 / 全部）
  const attempts = Array.isArray(answerers) ? selectByAnswerers(allAttempts, answerers) : scopeAttempts(allAttempts, scope)
  const nonHuman = allAttempts.length - attempts.length
  const summary = summarizeAttempts({ attempts })
  const { byId, duplicates, questionCount } = indexQuestions(banks)

  // 对上号的作答按库分组；对不上号的数量如实记账（不进列表，但绝不丢）
  const matchedByBank = new Map()
  let matched = 0
  for (const a of attempts) {
    const hit = byId.get(a.question_id)
    if (hit === undefined) continue
    matched += 1
    matchedByBank.set(hit.bankName, (matchedByBank.get(hit.bankName) ?? 0) + 1)
  }

  const rows = (Array.isArray(banks) ? banks : []).map((entry) => {
    const questions = Array.isArray(entry.bank?.questions) ? entry.bank.questions : []
    const stats = summarizeBankAttempts({ questions, perQuestion: summary.per_question })
    const withTopics = questions.filter((q) => Array.isArray(q.topics) && q.topics.length > 0).length
    const noAnalysis = questions.filter((q) => typeof q.analysis !== 'string' || q.analysis === '').length
    return {
      name: entry.name,
      path: entry.path ?? null,
      // 坏库照样列出来并标注它坏了：隐藏它会让"我的题库去哪了"变成谜（bank.js 立下的同一条）
      ok: entry.ok !== false,
      errors: Array.isArray(entry.errors) ? entry.errors : [],
      title: entry.bank?.title ?? entry.name,
      question_count: questions.length,
      source_root: entry.bank?.source_root ?? null,
      generated_at: entry.bank?.generated_at ?? null,
      provenance: entry.bank?.provenance ?? null,
      with_topics_count: withTopics,
      no_analysis_count: noAnalysis,
      duplicate_ids: Array.isArray(entry.bank?.duplicate_ids) ? entry.bank.duplicate_ids : [],
      attempts: stats,
    }
  })

  return {
    kind: 'banks',
    banks: rows,
    archived: (Array.isArray(archived) ? archived : []).map((a) => ({
      name: a.name,
      question_count: a.question_count ?? 0,
      title: a.title ?? a.name,
      ok: a.ok !== false,
    })),
    totals: {
      bank_count: rows.length,
      ok_bank_count: rows.filter((r) => r.ok).length,
      broken_bank_count: rows.filter((r) => !r.ok).length,
      archived_count: (Array.isArray(archived) ? archived : []).length,
      question_count: questionCount,
      attempt_count: summary.total,
      matched_attempt_count: matched,
      unmatched_attempt_count: summary.total - matched,
      correct: summary.correct,
      wrong: summary.wrong,
      /** 部分正确：**既不进分子也不进分母**，单列（把"答对一半"算成错会无故拉低正确率）。 */
      partial: summary.partial,
      unjudged: summary.unjudged,
      accuracy: summary.accuracy,
      by_source: summary.by_source,
      malformed_attempt_count: malformed.length,
      /** 被口径排除掉的作答（按作答者多选时，可能是别的模型；按 scope 时是全部非人）。**不计入但不隐藏**。 */
      non_human_attempt_count: nonHuman,
      scope: normalizeScope(scope),
      /** 出现过的作答者（含条数）——界面据此渲染复选框。 */
      answerers: availableAnswerers(allAttempts),
      selected_answerers: Array.isArray(answerers) ? answerers : scope === 'all' ? availableAnswerers(allAttempts).map((a) => a.key) : [HUMAN_ANSWERER],
      last_attempt_at: attempts.reduce((acc, a) => (acc === null || String(a.timestamp ?? '') > acc ? String(a.timestamp ?? '') : acc), null),
      duplicate_question_ids: duplicates,
    },
    notes: buildBankNotes({ rows, summary, matched, malformed, duplicates, archived, nonHuman, scope }),
  }
}

/**
 * 题库段要如实说出口的几件事（每一件都是"不说就会被误读"的那类）。
 *
 * @returns 字符串数组（可为空）。
 */
function buildBankNotes({ rows, summary, matched, malformed, duplicates, archived, nonHuman = 0, scope = 'human' }) {
  const notes = []
  if (rows.length === 0) notes.push('当前工作区的 lh-questions/ 里还没有题库。')
  for (const r of rows) {
    if (!r.ok) notes.push(`题库「${r.name}」读出来不合格（${r.errors.length} 条问题），内容可能不完整。`)
  }
  if (nonHuman > 0 && normalizeScope(scope) === 'human') {
    notes.push(
      `另有 ${nonHuman} 条作答**因作答者未选中而未计入**上面的数字——模型答对了不是"我会了"（ADR-018 决定 6）。要看得在做题记录的「作答者」里勾上对应项。`,
    )
  }
  if (summary.total > 0 && summary.total !== matched) {
    notes.push(
      `有 ${summary.total - matched} 条作答的题目不在当前工作区的任何题库里——**未列入记录**（题目 id 变更或题库来自别处时会这样）。`,
    )
  }
  if (summary.unjudged > 0) notes.push(`有 ${summary.unjudged} 次作答**无法判别**（无法判别不算错，不计入正确率）。`)
  if (malformed.length > 0) notes.push(`有 ${malformed.length} 条作答事件形状不合法（缺 question_id / source 非法），未计入。`)
  if (duplicates.length > 0) notes.push(`有 ${duplicates.length} 个题目 id 同时出现在多个题库里：${duplicates.map((d) => d.id).join('、')}——id 唯一性被破坏了，作答归属需要人判断。`)
  if ((archived ?? []).length > 0) notes.push(`另有 ${archived.length} 个题库已归档（不在上面的清单里，可恢复）。`)
  return notes
}

/**
 * 来源段：这个库**从哪来**（库级，不做逐题质量审计）。
 *
 * ═══ 为什么来源主要来自题库文件本身，而不是导入事件 ═══
 * 实测：工作区这两个库是脚本直接落盘的，**从来没有经过 `import_questions`**；
 * 日志里那 5 条 `lh/resource/questions-imported` 全部指向另一个工作区。所以
 * "来源"必须以题库文件自带的 `source_root` / 每题 `source.path` / `provenance` 为主，
 * 导入事件只作**佐证**，并如实标出它是否属于当前工作区。
 *
 * ═══ 刻意不做深的那些（作者 2026-10-13：工具开发阶段，具体提取内容不考虑）═══
 * 不做逐题的答案置信度分布、不做"模型自答 vs 官方答案不一致"清单。
 * **失效信号**：一旦要评估"这份提取质量如何"，那就是该加回来的地方——
 * 数据都在题目的 `provenance` 里（`answer_confidence` / `model_self_answer`），不需要迁移。
 *
 * @param params.bank - 完整题库对象。
 * @param params.importEvents - 与该库相关的 `questions-imported` 事件（已由调用方筛好）。
 * @param params.workspaceRoot - 当前工作区（用来判断事件的路径属不属于这里）。
 * @returns 来源段视图。
 */
export function buildSource({ bank, importEvents = [], workspaceRoot = null }) {
  const questions = Array.isArray(bank?.questions) ? bank.questions : []

  // 来源文件：按 `source.path` 归组，并给出题号范围与页码（页码是 0 或多个——OCR 链未跑时为空）
  const groups = new Map()
  for (const q of questions) {
    const p = text(q?.source?.path) ?? '(未记来源文件)'
    const g = groups.get(p) ?? { path: p, question_count: 0, numbers: [], pages: [] }
    g.question_count += 1
    if (q?.source?.number !== undefined && q.source.number !== null && q.source.number !== '') g.numbers.push(String(q.source.number))
    if (q?.source?.page !== undefined && q.source.page !== null && q.source.page !== '' && !g.pages.includes(q.source.page)) g.pages.push(q.source.page)
    groups.set(p, g)
  }
  const sourceFiles = [...groups.values()].map((g) => ({
    path: g.path,
    question_count: g.question_count,
    first_number: g.numbers.length > 0 ? g.numbers[0] : null,
    last_number: g.numbers.length > 0 ? g.numbers[g.numbers.length - 1] : null,
    numbers_sample: g.numbers.slice(0, 5),
    pages: g.pages.slice(0, 20),
  }))

  const unmapped = []
  for (const q of questions) {
    for (const t of Array.isArray(q?.unmapped_topics) ? q.unmapped_topics : []) {
      if (!unmapped.includes(t)) unmapped.push(t)
    }
  }

  const kinds = {}
  for (const q of questions) kinds[q?.kind ?? '(缺)'] = (kinds[q?.kind ?? '(缺)'] ?? 0) + 1

  const provenance = bank?.provenance ?? null

  return {
    kind: 'source',
    bank: { name: bank?.title ?? null, title: bank?.title ?? null, question_count: questions.length },
    source_root: bank?.source_root ?? null,
    generated_at: bank?.generated_at ?? null,
    provenance,
    // 抽取链的两侧分工（ADR-029）：题本侧决定题干/选项，解析侧决定答案。
    // 这两行把"答案是从哪份文件里来的"显式说出来——它决定下游对答案的信任度。
    method: text(provenance?.method) ?? text(provenance?.extraction) ?? null,
    model: text(provenance?.model) ?? null,
    answer_source_file: text(provenance?.source_answer_file) ?? null,
    source_files: sourceFiles,
    coverage: {
      with_topics: questions.filter((q) => Array.isArray(q.topics) && q.topics.length > 0).length,
      without_analysis: questions.filter((q) => typeof q.analysis !== 'string' || q.analysis === '').length,
      unmapped_topics: unmapped,
      duplicate_ids: Array.isArray(bank?.duplicate_ids) ? bank.duplicate_ids : [],
      kinds,
    },
    import_events: (Array.isArray(importEvents) ? importEvents : []).map((e) => ({
      event_id: e.id ?? null,
      timestamp: e.timestamp ?? null,
      bank_path: e.data?.bank_path ?? null,
      in_workspace: isInside(workspaceRoot, e.data?.bank_path),
      content_ref: e.content_ref ?? null,
      source_root: e.data?.source_root ?? null,
      source_file: e.data?.source_file ?? null,
      added_count: e.data?.added_count ?? null,
      replaced_count: e.data?.replaced_count ?? null,
      rejected_count: e.data?.rejected_count ?? null,
      with_topics_count: e.data?.with_topics_count ?? null,
      unmapped_topics: e.data?.unmapped_topics ?? [],
      model: e.provenance?.model ?? null,
      supersedes_count: Array.isArray(e.data?.supersedes) ? e.data.supersedes.length : 0,
    })),
    notes: buildSourceNotes({ questions, sourceFiles, importEvents, workspaceRoot, provenance }),
  }
}

/**
 * 来源段要说出口的话。
 * @returns 字符串数组。
 */
function buildSourceNotes({ questions, sourceFiles, importEvents, workspaceRoot, provenance }) {
  const notes = []
  if (questions.length === 0) notes.push('这个题库里没有题目。')
  if (sourceFiles.length === 1 && sourceFiles[0].path === '(未记来源文件)') {
    notes.push('题库里**一道题都没记来源文件**——出处跟着题目走是纪律（ADR-021），这份题库缺了它。')
  }
  if ((importEvents ?? []).length === 0) {
    notes.push('日志里没有这个库的导入事件（它是脚本直接落盘的，或导入发生在别处）——所以「来源」全部取自题库文件本身。')
  }
  if (provenance === null || typeof provenance !== 'object') notes.push('题库文件里没有 provenance（抽取方式与模型无从考证）。')
  const outside = (importEvents ?? []).filter((e) => !isInside(workspaceRoot, e.data?.bank_path)).length
  if (outside > 0) notes.push(`有 ${outside} 条导入事件的落点**不在当前工作区**（是别处的安装），只作佐证。`)
  return notes
}

/**
 * 路径是否落在某个目录之内（用来判断事件里的路径属不属于当前工作区）。
 *
 * 为什么不做 realpath / 大小写归一：两端都是我们自己的路径字符串，而 Windows 上
 * 大小写不敏感——这里只用来**标注**"是不是这里的"，标错不会造成数据损坏，
 * 所以不做重活；判不出来的（任一端为空）返回 false 并如实降级。
 *
 * @param root - 目录（绝对路径）。
 * @param target - 目标路径。
 * @returns 落在之内返回 true。
 */
export function isInside(root, target) {
  const r = text(root)
  const t = text(target)
  if (r === null || t === null) return false
  const a = r.replace(/[\\/]+$/, '').toLowerCase()
  const b = t.toLowerCase()
  return b === a || b.startsWith(`${a}\\`) || b.startsWith(`${a}/`)
}

/**
 * 题目段：一个库的题目清单（分页 + 过滤），每题带上它的作答史摘要。
 *
 * ═══ 为什么这一层**给看答案** ═══
 * 这是**管理/校对**视角，不是作答过程：学习者就是本人，来看"我的题库里这道题答案对不对"
 * 是正当用途。ADR-019 那条"答案只在作答之后给"约束的是**刷题**那条路
 * （`submit_answer` = 记录与揭示合一），不是审计面。两条路各自成立，不互相削。
 *
 * @param params.bank - 完整题库对象。
 * @param params.events - LH 全量事件。
 * @param params.filters - `{ q, topic, kind, state }`。
 * @param params.offset - 起点。
 * @param params.limit - 条数。
 * @returns 题目段视图。
 */
export function buildQuestions({ bank, events, filters = {}, offset = 0, limit = DEFAULT_LIMIT, scope = 'human', answerers = null }) {
  const questions = Array.isArray(bank?.questions) ? bank.questions : []
  const { attempts: allAttempts } = extractAttempts(events)
  const attempts = Array.isArray(answerers) ? selectByAnswerers(allAttempts, answerers) : scopeAttempts(allAttempts, scope)
  const per = summarizeAttempts({ attempts }).per_question

  const q = text(filters.q)
  const topic = text(filters.topic)
  const kind = text(filters.kind)
  const state = QUESTION_STATE_FILTERS.includes(filters.state) ? filters.state : 'all'

  const rows = []
  for (const item of questions) {
    const history = per[item?.id]
    if (topic !== null && !(Array.isArray(item.topics) && item.topics.includes(topic))) continue
    if (kind !== null && item.kind !== kind) continue
    if (q !== null && !String(item.stem ?? '').toLowerCase().includes(q.toLowerCase())) continue
    if (state === 'unseen' && history !== undefined) continue
    if (state === 'done' && history === undefined) continue
    // "最近答错"= 最近一次判决是**错误**。部分正确**不算错题**——
    // 把"答对一半"塞进错题本，会让错题本里混进一堆"其实会了"的题。
    if (state === 'wrong' && history?.last_verdict !== 'wrong') continue
    rows.push(item)
  }

  const start = clampOffset(offset)
  const size = clampLimit(limit)
  const slice = rows.slice(start, start + size)

  const topics = [...new Set(questions.flatMap((item) => (Array.isArray(item.topics) ? item.topics : [])))].sort()

  return {
    kind: 'questions',
    bank: { name: bank?.title ?? null, question_count: questions.length },
    total: rows.length,
    bank_total: questions.length,
    offset: start,
    limit: size,
    has_more: start + size < rows.length,
    topics,
    scope: normalizeScope(scope),
    /** 按口径被排除的非人作答条数（默认为人时才有值）——如实报出，不隐藏。 */
    non_human_attempt_count: allAttempts.length - attempts.length,
    filters: { q, topic, kind, state },
    items: slice.map((item) => {
      const history = per[item?.id]
      return {
        id: item.id,
        kind: item.kind,
        stem: item.stem,
        options: Array.isArray(item.options) ? item.options : [],
        answer: Array.isArray(item.answer) ? item.answer : [],
        accept: Array.isArray(item.accept) ? item.accept : [],
        analysis: typeof item.analysis === 'string' ? item.analysis : '',
        topics: Array.isArray(item.topics) ? item.topics : [],
        source: {
          path: item?.source?.path ?? null,
          number: item?.source?.number ?? null,
          page: item?.source?.page ?? null,
        },
        attempts: history === undefined
          ? null
          : {
              total: history.attempts,
              correct: history.correct,
              wrong: history.wrong,
              partial: history.partial ?? 0,
              unjudged: history.unjudged,
              last_at: history.last_at,
              last_correct: history.last_correct,
              last_verdict: history.last_verdict,
              last_response: history.last_response,
            },
      }
    }),
  }
}

/**
 * 记录段：做题记录（时间 / 作答 / 对错 / 来源 / 用时 / 关联会话 / 属于哪个库哪道题）。
 *
 * ═══ 会话坐标为什么有的空 ═══
 * 界面来的作答没有会话上下文（HTTP 路由拿不到当前会话，`ARCHITECTURE.md` 开放问题 3），
 * 所以那些记录的 `session_ref` 是 `null`。**如实显示"无会话坐标"**，
 * 不由时间或题库去猜一个会话——猜出来的关联比没有更糟（它看起来像真的）。
 *
 * @param params.banks - `[{ name, bank }]`。
 * @param params.events - LH 全量事件。
 * @param params.filters - `{ bank, question, session, correct, source }`。
 * @param params.offset - 起点。
 * @param params.limit - 条数。
 * @returns 记录段视图。
 */
export function buildAttempts({ banks, events, filters = {}, offset = 0, limit = DEFAULT_LIMIT, scope = 'human', answerers = null, withNotes = true }) {
  const { attempts: allAttempts, malformed } = extractAttempts(events)
  const attempts = Array.isArray(answerers) ? selectByAnswerers(allAttempts, answerers) : scopeAttempts(allAttempts, scope)
  const nonHuman = allAttempts.length - attempts.length
  const { byId } = indexQuestions(banks)
  // 备注（注解）按目标分组一次，行上直接挂——**只挂当前有效的**（被 supersedes 的仍在日志里）
  const noteMap = withNotes ? activeNotesByTarget(extractNotes(events).notes) : new Map()

  const bankFilter = text(filters.bank)
  const questionFilter = text(filters.question)
  const sessionFilter = text(filters.session)
  const correctFilter = CORRECT_FILTERS.includes(filters.correct) ? filters.correct : 'all'
  const verdictFilter = VERDICT_FILTERS.includes(filters.verdict) ? filters.verdict : 'all'
  const sourceFilter = ATTEMPT_SOURCES.includes(filters.source) ? filters.source : null

  const matched = []
  let unmatched = 0
  const verdictCounts = { correct: 0, partial: 0, wrong: 0, unjudged: 0 }
  const bankCounts = {}
  const sessionCounts = {}
  for (const a of attempts) {
    const hit = byId.get(a.question_id)
    if (hit === undefined) {
      unmatched += 1
      continue
    }
    if (bankFilter !== null && bankFilter !== 'all' && hit.bankName !== bankFilter) continue
    if (questionFilter !== null && a.question_id !== questionFilter) continue
    if (sessionFilter !== null && String(a.session_ref ?? '') !== sessionFilter) continue
    if (correctFilter !== 'all' && String(a.correct) !== correctFilter) continue
    // 四态判决在**进入匹配集之前**算一次：它既用于过滤，也用于统计与渲染
    const verdict = verdictOf(a)
    if (verdictFilter !== 'all' && verdict !== verdictFilter) continue
    if (sourceFilter !== null && a.source !== sourceFilter) continue
    verdictCounts[verdict] += 1
    matched.push({ ...a, verdict, bankName: hit.bankName, question: hit.question })
    bankCounts[hit.bankName] = (bankCounts[hit.bankName] ?? 0) + 1
    const s = a.session_ref ?? null
    if (s !== null) sessionCounts[s] = (sessionCounts[s] ?? 0) + 1
  }

  // 最近的排前面：记录段回答的是"我刚做了什么"
  matched.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))

  const start = clampOffset(offset)
  const size = clampLimit(limit)
  const slice = matched.slice(start, start + size)

  return {
    kind: 'attempts',
    total: matched.length,
    offset: start,
    limit: size,
    has_more: start + size < matched.length,
    unmatched_attempt_count: unmatched,
    malformed_attempt_count: malformed.length,
    scope: normalizeScope(scope),
    /** 按口径被排除的非人作答条数（默认"只看人的"时才有值）。 */
    non_human_attempt_count: nonHuman,
    /** 出现过的作答者（含条数）——界面据此渲染「作答者」复选框。 */
    answerers: availableAnswerers(allAttempts),
    selected_answerers: Array.isArray(answerers)
      ? answerers
      : normalizeScope(scope) === 'all'
        ? availableAnswerers(allAttempts).map((a) => a.key)
        : [HUMAN_ANSWERER],
    filters: { bank: bankFilter, question: questionFilter, session: sessionFilter, correct: correctFilter, verdict: verdictFilter, source: sourceFilter },
    /** 四态判决的计数（**当前筛选集**内的分布）。 */
    verdict_counts: verdictCounts,
    banks: Object.entries(bankCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    sessions: Object.entries(sessionCounts).map(([id, count]) => ({ session_id: id, count })).sort((a, b) => b.count - a.count),
    sources: [...new Set(matched.map((a) => a.source))].sort(),
    /** 出现过的型号清单（给"作答者"筛选/分组用；人作答为 null，不进这个列表）。 */
    models: [...new Set(matched.map((a) => text(a.model)).filter((m) => m !== null))].sort(),
    items: slice.map((a) => ({
      event_id: a.event_id ?? null,
      timestamp: a.timestamp ?? null,
      question_id: a.question_id,
      response: Array.isArray(a.response) ? a.response.join(ANSWER_SEP) : String(a.response ?? ''),
      correct: a.correct === true ? true : a.correct === false ? false : null,
      /** 四态判决：correct / partial / wrong / unjudged（派生量）。 */
      verdict: a.verdict,
      /** 部分正确的分数（如 6/12）；非部分正确时为 null。 */
      score_got: typeof a.score_got === 'number' ? a.score_got : null,
      score_total: typeof a.score_total === 'number' ? a.score_total : null,
      source: a.source,
      /** 谁作的答：人作答为 null；模型作答为型号（如 DeepSeek-v4.1）。 */
      model: text(a.model),
      duration_ms: a.duration_ms ?? null,
      session_ref: a.session_ref ?? null,
      bank: a.bankName,
      /** 这次作答的备注（当前有效的那几条，时间正序）。 */
      notes: (noteMap.get(`attempt:${a.event_id}`) ?? []).map((n) => ({
        event_id: n.event_id,
        text: n.text,
        note_kind: n.note_kind,
        author: n.author,
        model: n.model,
        created_at: n.created_at,
      })),
      question: {
        stem_preview: previewStem(a.question?.stem),
        number: a.question?.source?.number ?? null,
        page: a.question?.source?.page ?? null,
        /** 官方答案的**字符型**形态（简答题将来也是这一列）。 */
        answer_text: answerText(a.question),
      },
    })),
    notes: buildAttemptNotes({ attempts, unmatched, malformed, matched, nonHuman, scope, verdictCounts }),
  }
}

/**
 * 记录段要说出口的话。
 * @returns 字符串数组。
 */
function buildAttemptNotes({ attempts, unmatched, malformed, matched, nonHuman = 0, scope = 'human', verdictCounts = null }) {
  const notes = []
  if (attempts.length === 0) notes.push('日志里还没有任何作答记录。')
  if (unmatched > 0) {
    notes.push(`有 ${unmatched} 条作答的题目不在当前工作区的题库里，**未列入**（按 2026-10-13 定的口径：只列能对上号的）。`)
  }
  if (nonHuman > 0 && normalizeScope(scope) === 'human') {
    notes.push(`另有 ${nonHuman} 条作答**因作答者未选中而未列入**——在做题记录的「作答者」里勾上对应项即可看到。`)
  }
  if ((verdictCounts?.partial ?? 0) > 0) {
    notes.push(`有 ${verdictCounts.partial} 条**部分正确**：它们不计入正确率的分母（把"答对一半"算成错会无故拉低正确率），单列在此。`)
  }
  if (malformed.length > 0) notes.push(`有 ${malformed.length} 条作答事件形状不合法，未列入。`)
  const noSession = matched.filter((a) => a.session_ref === null).length
  if (noSession > 0) notes.push(`其中 ${noSession} 条没有会话坐标（界面来的作答拿不到当前会话，如实留空、不猜）。`)
  const llm = matched.filter((a) => a.source === 'llm').length
  if (llm > 0) notes.push(`其中 ${llm} 条是模型作答（source: llm），**不是学习证据**，不要与人的作答混看正确率。`)
  return notes
}

/** 供路由层与自测复用的枚举（避免两处各写一份）。 */
export const ATTEMPT_SOURCE_VALUES = ATTEMPT_SOURCES
export const QUESTION_KIND_VALUES = QUESTION_KINDS
