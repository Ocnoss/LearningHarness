/**
 * 题库的接口层 —— 作答事件与判分。
 *
 * ═══ 为什么作答是事件、题目是资源（docs/archive/decisions/017）═══
 * 题目可以被反复取用、可以重排版、可以换一份来源重导——它是**产物**。
 * 作答是"某人在某时刻答了这道题"，不可重来、不可取代——它是**行为**。
 * 契约把这两类东西分开（ADR-009），本文件遵守同一条界线：
 * 题目走 `lh/resource/*` + 文件，作答走 `lh/user/attempt` + 事件日志。
 *
 * ═══ 本文件的立场：判分与记录分开 ═══
 * `judgeAttempt` 是纯函数（算对错），`buildAttempt` 只组装语义，
 * **写日志交给事件存储**。这样"判分逻辑对不对"能独立测，
 * 不需要一个跑着的 dsh——与 `question.js` 同一分层。
 */

import { normalizeAnswer } from './question.js'

/** 作答事件的 schema 版本。 */
export const ATTEMPT_SCHEMA_VERSION = 1

/** 作答事件的类型名。`lh/user/*` 表示"学习者本人的行为"（契约 §3.1 四类生成行为的输入侧）。 */
export const ATTEMPT_EVENT_TYPE = 'lh/user/attempt'

/** 作答来源。人与模型的作答**必须可区分**——否则学习者模型会把"模型答对了"算成"我会了"。 */
export const ATTEMPT_SOURCES = ['human', 'llm', 'imported']

/**
 * 判断一次作答对不对。
 *
 * ═══ 为什么可能返回 null ═══
 * `true`/`false` 是"知道对错"，`null` 是"**无法判定**"。
 * 判不了就说判不了，不能默认算错——把"判不了"混进 `false`，
 * 会让学习者的正确率统计凭空变低，而那种错误在数据里看不出来。
 * 典型情形：题干残缺、题库里没有这道题、填空答案无法机械化比对（需要人判）。
 *
 * ═══ 选择题与填空题的判法不同 ═══
 * - 选择题：答案项**集合相等**即对（多选顺序无关）。`['A','C']` 与 `['C','A']` 同对。
 * - 填空题：接受 `answer` 或 `accept` 里任意一项；比对前压掉空白并忽略大小写，
 *   但**不做同义替换**（"四十二" 与 "42" 是两回事，要靠 `accept` 显式声明）。
 *
 * @param params.question - 题目对象。
 * @param params.response - 作答内容：选择题传标签数组或字符串，填空题传文本。
 * @returns `true` / `false` / `null`（无法判定）。
 */
export function judgeAttempt({ question, response }) {
  if (question === null || typeof question !== 'object') return null
  const expected = Array.isArray(question.answer) ? question.answer : []
  if (expected.length === 0) return null

  const kind = question.kind
  const isChoice = kind === 'single_choice' || kind === 'multiple_choice'

  if (isChoice) {
    const given = normalizeAnswer(response, kind).map((v) => v.toUpperCase())
    if (given.length === 0) return null
    // 集合相等
    const a = [...new Set(given)].sort()
    const b = [...new Set(expected.map((v) => String(v).toUpperCase()))].sort()
    return a.length === b.length && a.every((v, i) => v === b[i])
  }

  // 填空 / 其他：接受标准答案或任一可接受答案
  const text = Array.isArray(response) ? response.join('') : String(response ?? '')
  const fold = (s) => String(s).replace(/\s+/g, '').toLowerCase()
  const givenText = fold(text)
  if (givenText === '') return null

  const accepted = [expected, ...(Array.isArray(question.accept) ? question.accept.map((a) => [a]) : [])]
  for (const group of accepted) {
    // 一个答案项内部的多个片段视为并列可接受（如 answer: ['42','四十二'] 是两解而非两空）
    if (group.map(fold).includes(givenText)) return true
  }
  return false
}

/**
 * 组装一次作答的语义负载（不含信封）。
 *
 * ═══ 为什么记 `context`（当时的会话与事件序号）═══
 * 契约 §1.3 写细读粗：写入时多记一点，读取时可以粗。
 * 当场会话与序号让后来的分析能回答"这次作答是在什么上下文里发生的"——
 * 那道题之前刚看过讲解？还是在一次小测里？这个区别对策略评估是决定性的，
 * 而事后**无法重建**。这是"现在不记，以后就没有"的那类字段。
 *
 * @param params.question - 题目对象。
 * @param params.response - 作答内容。
 * @param params.source - 作答来源：human / llm / imported。
 * @param params.correct - 已知对错时直接给定；省略则自动判分。
 * @param params.durationMs - 作答耗时（毫秒）；未知则 null。
 * @param params.sessionRef - 当时的会话 id。
 * @param params.seq - 当时会话日志的序号。
 * @returns 可直接交给 `lhEvents.append` 的 `data`。
 * @throws 当 `source` 非法或题目缺 id 时。
 */
export function buildAttempt({ question, response, source = 'human', correct, durationMs, sessionRef, seq, model, scoreGot, scoreTotal }) {
  if (question === null || typeof question !== 'object' || typeof question.id !== 'string' || question.id === '') {
    throw new Error('buildAttempt: 题目必须有 id')
  }
  if (!ATTEMPT_SOURCES.includes(source)) {
    throw new Error(`buildAttempt: source 非法（${source}），只接受 ${ATTEMPT_SOURCES.join(' / ')}`)
  }

  const judged = correct === undefined ? judgeAttempt({ question, response }) : correct
  if (judged !== null && typeof judged !== 'boolean') {
    throw new Error(`buildAttempt: correct 只能是 true / false / null，收到 ${JSON.stringify(correct)}`)
  }

  // ═══ 部分正确：**不扩三态，另记分数**（2026-10-13，作者要求）═══
  //
  // 为什么不是把 correct 改成数字：三态是 ADR-018 决定 5 冻结的语义
  // （`true|false|null`，"判不了"是独立一态）。让它"有时布尔、有时数字"，
  // 每一个消费方都得先判类型——那是最容易写错、且看起来正常的形状。
  //
  // 所以：**分数是原始事实，判决是派生量**（ADR-014：可派生的不进日志）。
  //   · 全对 → correct: true
  //   · 部分 → correct: false + score_got/score_total（如 6/12）
  //   · 全错 → correct: false
  //   · 判不了 → correct: null
  // 于是"部分正确"可由 `correct === false && score_got > 0` **派生**（见 isPartial），
  // 而旧记录（没有分数字段，例如当前日志里那 21 条）语义完全不变。
  const got = typeof scoreGot === 'number' && Number.isFinite(scoreGot) ? scoreGot : null
  const total = typeof scoreTotal === 'number' && Number.isFinite(scoreTotal) ? scoreTotal : null
  if ((got === null) !== (total === null)) {
    throw new Error('buildAttempt: score_got 与 score_total 必须同时给或同时不给')
  }
  if (got !== null && (got < 0 || total <= 0 || got > total)) {
    throw new Error(`buildAttempt: 分数不合法（${got}/${total}）——要求 score_total > 0 且 0 ≤ score_got ≤ score_total`)
  }

  return {
    question_id: question.id,
    // 原始作答原样保留（读细）；归一化留给判分与统计
    response: Array.isArray(response) ? response.map((v) => String(v)) : String(response ?? ''),
    correct: judged,
    source,
    // ═══ 谁作的答 ═══
    // ⚠ 放 `data.model` 而不是信封的 `provenance.model`：两者问的不是同一件事——
    //   `provenance` 是"**谁写了这条事件**"（题库插件），而型号是"**谁作的答**"。
    //   导入事件（questions-imported）把 model 放 provenance，是因为那里"抽题的模型"
    //   与"写事件的插件"是同一件事的两个侧面；作答这里不是。
    //   **失效信号**：若哪天有工具按 `provenance.model` 找作答型号而找不到，
    //   那不是数据错，是它找错了字段——**不要**把 model 挪进 provenance 去迁就它。
    //   人作答时为 null（显式写 null 不省略：读取端要能区分"没有"与"没记"）。
    model: typeof model === 'string' && model.trim() !== '' ? model.trim() : null,
    // 部分正确的分数；非部分正确时两者都是 null
    score_got: got,
    score_total: total,
    duration_ms: typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : null,
    context: {
      session_ref: sessionRef ?? null,
      // seq 用 null 而不是省略：读取端要能区分"没有会话"与"没记序号"
      seq: typeof seq === 'number' ? seq : null,
    },
  }
}

/**
 * 这次作答是不是"部分正确"（**派生量**，不进日志）。
 *
 * @param attempt - 一条作答（`data` 或 `extractAttempts` 的输出都行）。
 * @returns 部分正确返回 true。
 */
export function isPartial(attempt) {
  return attempt?.correct === false && typeof attempt?.score_got === 'number' && attempt.score_got > 0
}

/**
 * 把三态 + 分数折成**四态判决**（派生，不进日志）。
 *
 * ⚠ 这是界面与统计用的**读取端词汇**：`correct | partial | wrong | unjudged`。
 *   它比 `correct` 多一个 `partial`——但那不是新的事实，是 `correct + score` 的另一种说法。
 *
 * @param attempt - 一条作答。
 * @returns 判决字符串。
 */
export function verdictOf(attempt) {
  if (attempt?.correct === true) return 'correct'
  if (isPartial(attempt)) return 'partial'
  if (attempt?.correct === false) return 'wrong'
  return 'unjudged'
}

/**
 * 读取作答记录并做基本校验（从事件数组里筛出来）。
 *
 * @param events - 事件数组（`lhEvents.all()` 或 `readEvents()` 的结果）。
 * @returns `{ attempts, malformed }`；malformed 是形状不对的记录，如实报告不丢弃。
 */
export function extractAttempts(events) {
  const attempts = []
  const malformed = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== ATTEMPT_EVENT_TYPE) continue
    const d = event.data
    if (typeof d?.question_id !== 'string' || d.question_id === '') {
      malformed.push({ event_id: event.id ?? null, reason: '缺 question_id' })
      continue
    }
    if (typeof d?.correct !== 'boolean' && d?.correct !== null) {
      malformed.push({ event_id: event.id ?? null, reason: `correct 非法：${JSON.stringify(d?.correct)}` })
      continue
    }
    if (!ATTEMPT_SOURCES.includes(d?.source)) {
      malformed.push({ event_id: event.id ?? null, reason: `source 非法：${JSON.stringify(d?.source)}` })
      continue
    }
    // 分数字段是**可选**的（旧记录没有）。给了就必须是合法的一对——
    // 只给一半、或 got > total，都是形状不合法：如实报出，而不是当成答错。
    const hasGot = d?.score_got !== undefined && d?.score_got !== null
    const hasTotal = d?.score_total !== undefined && d?.score_total !== null
    if (hasGot !== hasTotal || (hasGot && !(typeof d.score_got === 'number' && typeof d.score_total === 'number' && d.score_total > 0 && d.score_got >= 0 && d.score_got <= d.score_total))) {
      malformed.push({ event_id: event.id ?? null, reason: `分数字段不合法：${JSON.stringify({ score_got: d?.score_got, score_total: d?.score_total })}` })
      continue
    }
    attempts.push({ ...d, event_id: event.id, timestamp: event.timestamp, session_ref: event.session_ref ?? null })
  }
  return { attempts, malformed }
}

/**
 * 汇总某个学习者在一批题上的表现。
 *
 * ═══ 刻意把 `unjudged` 单列 ═══
 * 正确率的分母**只算判得了的题**。把 `null` 算进分母会让正确率无端变低，
 * 算进分子则会让它虚高——两种都是失真。单列出"判不了"的数量，
 * 让人看见"这份数据里有多少是靠不住的"，而不是给一个看起来很确定的百分比。
 * （契约 §5.3：工具质量是策略评估的天花板。）
 *
 * @param params.attempts - `extractAttempts` 的 attempts。
 * @param params.source - 只统计某个来源；省略则全部（但会按来源分组报告）。
 * @returns 统计结果。
 */
export function summarizeAttempts({ attempts, source }) {
  const list = (Array.isArray(attempts) ? attempts : []).filter((a) => (source === undefined ? true : a.source === source))

  const byQuestion = new Map()
  let correct = 0
  let wrong = 0
  let partial = 0
  let unjudged = 0
  const bySource = {}

  for (const a of list) {
    // ⚠ 「部分正确」必须**先于** wrong 判定：它是 `correct === false` 的一个子集，
    //   顺序反了就会把"答对一半"静默算成"答错"（ADR-018 决定 5 的同一课：
    //   判不了不能默认算错；答对一半同理）。
    const v = verdictOf(a)
    if (v === 'correct') correct += 1
    else if (v === 'partial') partial += 1
    else if (v === 'wrong') wrong += 1
    else unjudged += 1

    const s = (bySource[a.source] ??= { total: 0, correct: 0, wrong: 0, partial: 0, unjudged: 0 })
    s.total += 1
    if (v === 'correct') s.correct += 1
    else if (v === 'partial') s.partial += 1
    else if (v === 'wrong') s.wrong += 1
    else s.unjudged += 1

    const prev = byQuestion.get(a.question_id) ?? {
      attempts: 0,
      correct: 0,
      wrong: 0,
      partial: 0,
      unjudged: 0,
      last_at: null,
      /** 上一次**答了什么**（已归一化成可直接显示的字符串）。 */
      last_response: null,
      /** 上一次判成什么（true / false / null）。 */
      last_correct: null,
      /** 上一次的四态判决（含 partial）。 */
      last_verdict: null,
    }
    prev.attempts += 1
    if (v === 'correct') prev.correct += 1
    else if (v === 'partial') prev.partial += 1
    else if (v === 'wrong') prev.wrong += 1
    else prev.unjudged += 1

    // "上一次"= 时间戳最大的那一次。**所有字段必须在同一处更新**——
    // 分成几个独立的 if 迟早会漂移（`last_at` 来自这条、`last_response` 来自那条），
    // 于是界面会显示"上次答了 X"却配着另一个时间，而且**没人会发现**。
    if (prev.last_at === null || String(a.timestamp ?? '') > String(prev.last_at)) {
      prev.last_at = a.timestamp ?? null
      prev.last_response = Array.isArray(a.response) ? a.response.join('、') : String(a.response ?? '')
      prev.last_correct = a.correct === true ? true : a.correct === false ? false : null
      prev.last_verdict = v
    }
    byQuestion.set(a.question_id, prev)
  }

  const judged = correct + wrong
  return {
    total: list.length,
    correct,
    wrong,
    // 部分正确**单列**：它既不进分子也不进分母（与 unjudged 同样的克制），
    // 于是"答对一半"不会把一个学习者的正确率无故拉低。
    // **失效信号**：一旦要按分数算掌握度（把 6/12 折成半分），那就是该改
    // 正确率**口径**的时候了——改口径要动 ADR-018 决定 5，不要在这里偷偷加权。
    partial,
    unjudged,
    // 分母只算判得了的（全对 + 全错）；judged 为 0 时正确率是 null 而不是 0——"没数据"不等于"全错"
    accuracy: judged === 0 ? null : Number((correct / judged).toFixed(4)),
    by_source: bySource,
    per_question: Object.fromEntries(byQuestion),
  }
}
