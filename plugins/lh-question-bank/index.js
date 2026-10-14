/**
 * lh-question-bank —— LH 的题库。
 *
 * ═══ 它做什么 ═══
 *   1. `import_questions`：把**已结构化**的题目写进工作区的题库文件，并记一条 LH 资源事件；
 *   2. `record_attempt`：记录一次作答（判分 + 记一条 LH 事件）。
 *
 * ═══ 它刻意不做什么 ═══
 * **不做题目抽取**（OCR / 版式解析 / 图表题）。见 `docs/archive/decisions/017` 决定 7 与 `018` 决定 7：
 * 抽取是**判断**，不是接口；而且它是独立工程（170 个扫描版 PDF）。
 * 先把"题目进来以后怎么用"打通，再解决"题目怎么进来"——
 * 否则会得到一个词汇表配不上对象的分类器（作者本次任务的顺序判断正是这个）。
 *
 * ═══ 为什么两个工具都"薄" ═══
 * 它们只做机械的事：校验、派生 id、落盘、记事件。
 * **一切判断留在调用方**（LH 的 agent 与将来的策略层），
 * 于是这些工具可以被替换、被并置、被比较——契约 §1.1：内核拥有语法，插件拥有判断。
 *
 * ═══ 作答为什么不写进 `data/` ═══
 * 作答是事件，事件进 `events.jsonl`（ADR-018 决定 1 —— 那是 LH 的唯一事实源）。
 * 题库是资源，资源进工作区文件 + 事件里的指针。
 * 两者寿命不同：事件是历史（只追加），题库是可更新的产物。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ═══ 这里曾让 dsh 完全起不来，值得写清楚 ═══
//
// 原来是相对导入 `../lh-event-store/store.js`，**只在源码目录成立**
// （`plugins/` 下都是兄弟目录，我离线测试也在那里跑）。
// 而 pnpm 把本包装进 `profiles/web/node_modules/@lh/question-bank` 时
// 用的是**复制而非软链**，于是：
//   · 目录名由包名派生：`@lh/question-bank` → 目录 `@lh/question-bank/`
//   · 相对路径 `../lh-event-store/store.js` 要找的是 `@lh/lh-event-store/store.js`
//   · **永远找不到** → ERR_MODULE_NOT_FOUND
//
// 而插件的导入失败会让**整棵插件树加载失败、dsh 完全无法启动**
// （这是 profile 层的失败，比 preset 行失败更严重）。
//
// 修法：改成**包名导入** + 在 package.json 里声明成 `file:` 依赖。
// 这样 pnpm 把依赖放在**同级 node_modules** 下，包名解析在源码与安装后都成立。
import { LhEventStore, eventLogPath, readEvents } from '@lh/event-store/store'
import { assertWhitelistedModel } from '@lh/model-tier/model'
import { normalizeQuestionList, pickQuestions } from './question.js'
import { recordNote } from './note.js'
import { buildAttempt, ATTEMPT_EVENT_TYPE, extractAttempts, summarizeAttempts } from './attempt.js'
// ⚠ `requireBank` 必须**同时**局部导入：ESM 的 `export { … } from './bank.js'` 只做转发，
//   **不会**在本模块建立本地绑定，而下面的 getQuestions / getPracticeStats / recordAttempt
//   都在调它。少了这个 import，症状是运行期 `requireBank is not defined`——
//   而那条路径要真跑到取题/作答才会触发（自测恰好覆盖到了它）。
import { loadBank, saveBank, mergeIntoBank, resolveBankPath, extractRawQuestions, requireBank, listQuestionBanks } from './bank.js'
import { selectQuestions, buildAttemptIndex, toPresentableQuestion, toRevealedQuestion, summarizeProgress, sanitizeSelection, describeSelection, ORDER_KINDS, ORDER_HINTS } from './practice.js'
import { requestPracticePanel, readPracticeSignal } from './signal.js'
import {
  sanitizeCardStyle,
  describeCardStyle,
  describeStyleVocabulary,
  STYLE_TOKENS,
  STYLE_NUMBERS,
  SHOW_ITEMS,
} from './style.js'
import { describeTopicVocabulary, canonicalTopic } from './topics.js'
import { renderPracticeRoutingContext } from './context.js'

/** 插件名。 */
export const name = 'lh-question-bank'

/**
 * 声明依赖：`tools` 注册工具；`subagents`（host 面注册表）用于录题时 spawn 子 agent。
 * 两者都在 preset 作用域可得：`subagents` 服务名与官方 dsh-tool-subagent 的 inject 一致；
 * dsh-base 的 cordis.patch.yml 无 isolate 地挂了 `id: subagent` 注册表 + spawn/fork 后端，
 * 故 root realm 进程全局可 inject（已核 dsh-base/dsh-tool-subagent 源码）。
 *
 * ⚠ `systemPrompt` **刻意不放进硬 inject**（2026-10-13，与 course-tree / schedule 对齐）：
 *   硬 inject 的语义是"任一项拿不到，整行就不激活"——那会让 10 个题库工具一起静默消失；
 *   而"这一层没有 systemPrompt"不该让题库不可用。上下文改用
 *   `ctx.inject(['systemPrompt'], …)` 等它（拿不到只是不注入，插件仍在）。
 */
export const inject = ['tools', 'subagents']

const PROVENANCE = Object.freeze({ plugin: '@lh/question-bank', version: '0.0.1' })

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 记一条调试痕迹（与 LH 事件严格分开）。
 *
 * 为什么要分开：契约把"调试信息"与"事件"分成两类（ADR-014）。
 * 把调试写进事件流会污染学习者史；把事件写进 trace.log 则会丢掉事实源。
 *
 * @param line - 文本。
 */
function trace(line) {
  try {
    appendFileSync(join(HERE, 'trace.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

/**
 * 扫描从 s[i] 起的平衡括号片段（字符串内的括号不算数）。
 * 到结尾都没闭合就返回 null（说明 JSON 疑似被 token 截断）。
 */
function scanBalanced(s, i) {
  const stack = []
  let inStr = false
  let esc = false
  for (let j = i; j < s.length; j++) {
    const ch = s[j]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      stack.pop()
      if (stack.length === 0) return s.slice(i, j + 1)
    }
  }
  return null
}

/**
 * 从子 agent 的混合输出（推理文字 + 末尾 JSON）里抠出 JSON。
 *
 * 为什么不用"首括号→末括号一截"：子 agent 爱先写推理，推理文字里常出现
 * 花括号片段（引述字段形状之类），一截就把非 JSON 文本包进来，JSON.parse 必挂
 * （2026-09 verify_pairing 真跑踩过："I need to parse..." 推理在前）。
 * 现在：先试所有 ```json 围栏块（从最后一个往回——最终答案一般在末尾），
 * 再从后往前对每个起始括号做平衡扫描，第一个形状对上的就是结果。
 *
 * @param txt - 子 agent 回传全文。
 * @param want - 'array' 要数组 / 'object' 要对象。
 * @returns 解析出的 JSON，失败 null。
 */
function extractJsonValue(txt, want) {
  const s = String(txt ?? '').replace(/^\uFEFF/, '')
  const ok = (v) => (want === 'array' ? (Array.isArray(v) ? v : null) : (v && typeof v === 'object' && !Array.isArray(v) ? v : null))
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1])
  for (let i = fences.length - 1; i >= 0; i--) {
    try { const r = ok(JSON.parse(fences[i].trim())); if (r) return r } catch { /* 试下一块 */ }
  }
  const open = want === 'array' ? '[' : '{'
  const starts = []
  for (let i = s.length - 1; i >= 0; i--) if (s[i] === open) starts.push(i)
  for (const i of starts.slice(0, 400)) {
    const seg = scanBalanced(s, i)
    if (seg === null) continue
    try { const r = ok(JSON.parse(seg)); if (r) return r } catch { /* 试下一个起点 */ }
  }
  return null
}

/**
 * 解析失败时把子 agent 回传全文落盘（工作区 data/subagent-out/），便于诊断
 * 到底是推理跑偏、还是 JSON 被截断——错误消息里只给前 200 字是判不出来的。
 *
 * @returns 文件绝对路径（落盘失败返回 ''）。
 */
function dumpChildOut(tag, root, text) {
  try {
    const dir = join(root, 'data', 'subagent-out')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, `${tag}-${Date.now()}.txt`)
    writeFileSync(f, String(text ?? ''), 'utf8')
    return f
  } catch {
    return ''
  }
}

/**
 * 读取一批题目（从文件路径或内联数组）。
 *
 * @param args - 工具入参。
 * @returns `{ rawList, title, readFrom }`。
 * @throws 当既没给 file_path 也没给 questions，或文件读不出时。
 */
function readQuestionSource(args) {
  const filePath = typeof args?.file_path === 'string' && args.file_path.trim() !== '' ? args.file_path.trim() : null
  if (filePath !== null) {
    if (!existsSync(filePath)) throw new Error(`题目文件不存在：${filePath}`)
    // 去 BOM：题目文件很可能是 PowerShell 或别的工具写的（踩过这个坑）
    const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`题目文件不是合法 JSON：${filePath}（${error?.message ?? String(error)}）`)
    }
    const { rawList, title } = extractRawQuestions(parsed)
    if (rawList.length === 0) throw new Error(`题目文件里没有识别出题目：${filePath}（支持题目数组 / {questions:[...]} / 单题对象）`)
    return { rawList, title, readFrom: filePath }
  }

  if (Array.isArray(args?.questions)) {
    const { rawList, title } = extractRawQuestions(args.questions)
    if (rawList.length === 0) throw new Error('questions 是空数组')
    return { rawList, title, readFrom: '(内联)' }
  }

  throw new Error('必须提供 file_path（题目 JSON 文件）或 questions（题目数组）之一')
}

/**
 * 导入题目。
 *
 * 抽成独立函数而不是写在工具里：**能被独立调用才谈得上验证**
 * （与 `indexResources` 同一个理由）。
 *
 * @param params.store - LH 事件存储。
 * @param params.workspaceRoot - 工作区绝对路径。
 * @param params.bankName - 题库名。
 * @param params.rawList - 原始题目数组。
 * @param params.title - 题库标题（可空，取 bankName）。
 * @param params.sourceRoot - 资料根路径（id 派生的组成部分）。
 * @param params.sourceFile - 资料内文件（id 派生的组成部分）。
 * @param params.provenanceModel - 抽取所用模型（若是 LLM 抽的；决定下游可信度）。
 * @param params.sessionRef - 当时的会话 id。
 * @returns 导入结果摘要。
 */
export function importQuestions({
  store,
  workspaceRoot,
  bankName,
  rawList,
  title,
  sourceRoot,
  sourceFile,
  provenanceModel,
  sessionRef,
}) {
  const bankPath = resolveBankPath({ workspaceRoot, bankName })
  const existing = loadBank(bankPath)
  if (existing.errors.length > 0) {
    // 已有题库不合格时**不覆盖**：先让人看见坏在哪，再决定怎么办。
    // 直接覆盖会静默销毁一份可能有价值的题库——那是最不该发生的失败方式。
    throw new Error(`目标题库文件已存在但不合格，拒绝覆盖：${bankPath}\n  ${existing.errors.join('\n  ')}`)
  }

  const provenance = { ...PROVENANCE }
  if (typeof provenanceModel === 'string' && provenanceModel !== '') provenance.model = provenanceModel

  const { questions, errors, unmappedTopics } = normalizeQuestionList({
    rawList,
    origin: { sourceRoot, sourceFile },
    provenance,
  })

  if (questions.length === 0) {
    throw new Error(`没有一道题通过校验，已全部拒绝（共 ${rawList.length} 道）\n  ${errors.map((e) => `[${e.index}] ${e.message}`).join('\n  ')}`)
  }

  const merged = mergeIntoBank({
    existing: existing.bank,
    questions,
    meta: { title: title ?? bankName, sourceRoot, provenance },
  })

  saveBank({ path: bankPath, bank: merged.bank })

  // 事件只留指针：题库正文在文件里（ADR-018 决定 2）。
  // supersedes 指向同一题库的上一条记录 —— 更新 = 新资源 + 指针（ADR-009 决定 3）。
  const supersedes = store
    .all()
    .filter((e) => e.type === 'lh/resource/questions-imported' && e.data?.bank_path === bankPath)
    .map((e) => e.id)

  const event = store.appendResource({
    actor: 'agent',
    type: 'lh/resource/questions-imported',
    provenance,
    scope: 'root',
    sessionRef,
    contentRef: bankPath,
    supersedes,
    data: {
      bank_path: bankPath,
      bank_title: merged.bank.title,
      question_count: merged.bank.question_count,
      // 本次新增与替换分别记：只有总数的话，"重导是否真的生效"无法从事件流判断
      added_count: merged.added.length,
      replaced_count: merged.replaced.length,
      rejected_count: errors.length,
      source_root: sourceRoot ?? null,
      source_file: sourceFile ?? null,
      // 本题库现有多少题**带知识点**（0 是合法但重要的数字：
      // 它意味着"按知识点出题/断言"这条链现在没有原料，见契约 §4.3）
      with_topics_count: merged.bank.questions.filter((q) => Array.isArray(q.topics) && q.topics.length > 0).length,
      // 认不出的知识点标签：**词表该扩的证据**，不是错误。
      // 记进事件而不是只回给调用方，因为"词表缺什么"是跨会话的事实，
      // 而调用方那一轮对话结束就没了（`docs/archive/decisions/021` 结论七）。
      unmapped_topics: unmappedTopics,
    },
  })

  return {
    bankPath,
    bank: merged.bank,
    added: merged.added,
    replaced: merged.replaced,
    errors,
    unmappedTopics,
    eventId: event.id,
  }
}

/**
 * 列出工作区里有哪些题库。
 *
 * ⚠ 2026-10-13：`listQuestionBanks` / `isBankFile` / `BANK_COMPANION_SUFFIXES` / `requireBank`
 *   已**下沉到 `bank.js`**（纯文件/目录层），本文件只 re-export（见下方 import 之后的 export 行）。
 *   理由：`@lh/question-bank-ui`（profile 行的界面插件）要用同一份判据，而本文件会拖进
 *   `@lh/model-tier`；从本文件取会把那条依赖也拖进界面包，而"界面插件导入不到包"会让
 *   **整棵插件树加载失败、dsh 起不来**。同一份实现留在能解析到的那一层，是本项目的老规矩
 *   （ADR-037 §6）。
 */
export { BANK_COMPANION_SUFFIXES, isBankFile, listQuestionBanks, requireBank } from './bank.js'

/**
 * 按名字找一个题库 —— 已下沉到 `bank.js`（见本文件上方那段说明）。
 * 这里只留一行指针，免得读者在 index.js 里找它。
 */

/**
 * 取题（给学习者看的那一份，**不含答案**）。
 *
 * @param params.workspaceRoot - 工作区绝对路径。
 * @param params.bankName - 题库名。
 * @param params.count - 取几道。
 * @param params.order - 顺序策略。
 * @param params.topic - 知识点过滤。
 * @param params.ids - 直接指定 id。
 * @param params.excludeIds - 排除已出过的题。
 * @param params.includeAnswer - 是否带答案（默认 false）。
 * @returns `{ bankPath, questions, order, considered, note, progressHint, topic }`。
 */
export function getQuestions({
  workspaceRoot,
  bankName,
  count = 1,
  order = 'sequential',
  topic,
  ids,
  excludeIds = [],
  includeAnswer = false,
}) {
  const { path: bankPath, bank } = requireBank({ workspaceRoot, bankName })

  // ═══ 知识点过滤前先过词表 —— 但归一化**只在 `sanitizeSelection` 一处做** ═══
  //
  // 题库里的 `topics` 是词表里的规范名（`topics.js` 与 decisions/021 结论七），
  // 所以调用方给的原始写法必须归一化，否则会**静默取不到题**——
  // 而"取不到题"与"题库里真没有这样的题"从外面看一模一样。
  //
  // 这里刻意**不自己再写一遍**归一化：卡片那条路（`start_practice`）走的是
  // `sanitizeSelection`，两条路各写一次 = 两套规则，迟早不一致。
  const { selection } = sanitizeSelection({ topic }, { ignoreKeys: [] })
  const asked = typeof selection.topic_asked === 'string' ? selection.topic_asked : undefined
  const topicFilter = selection.topic

  const attemptIndex = buildAttemptIndex(readEvents())
  const picked = selectQuestions({ bank, attemptIndex, count, order, topic: topicFilter, ids, excludeIds })

  const questions = includeAnswer
    ? picked.questions.map(toRevealedQuestion)
    : picked.questions.map(toPresentableQuestion)

  // 认不出的知识点如实说，并**顺带说明这题的知识点标签情况**——
  // 否则调用方只能瞎猜，而它会反复试同一类错写法（同 ADR-026 决定 5）。
  //
  // ⚠ 这一段的措辞很重要：认不出的词会让过滤**生效但取不到题**（0 道），
  // 而那正是"取错题库"或"题库里没这题"的样子。所以必须点名说
  // "这个词不在词表里"，否则模型会把"词写错了"读成"题库里没有这样的题"。
  const tagged = bank.questions.filter((q) => Array.isArray(q.topics) && q.topics.length > 0).length
  const recognized = canonicalTopic(topicFilter)
  const topicNote =
    topicFilter === undefined
      ? null
      : recognized.topic === null
        ? `知识点「${topicFilter}」**不在词表里**（所以按它筛是筛不到任何题的）。可用值见 import_questions 的描述；全库有 ${tagged} 道题带知识点标签。`
        : asked !== undefined
          ? `知识点原写法「${asked}」已归一到词表名「${topicFilter}」；本批按它筛选`
          : `已按知识点「${topicFilter}」筛选（全库 ${bank.questions.length} 道里只有 ${tagged} 道打了知识点标签）`

  return {
    bankPath,
    bankTitle: bank.title,
    totalInBank: Array.isArray(bank.questions) ? bank.questions.length : 0,
    questions,
    order: picked.order,
    considered: picked.considered,
    note: [picked.note, topicNote].filter((x) => x !== null && x !== '').join('；'),
  }
}

/**
 * 取刷题进度（覆盖了多少、对了多少、最近错哪些）。
 *
 * @param params.workspaceRoot - 工作区绝对路径。
 * @param params.bankName - 题库名。
 * @returns 进度摘要。
 */
export function getPracticeStats({ workspaceRoot, bankName }) {
  const { path: bankPath, bank } = requireBank({ workspaceRoot, bankName })
  return { bankPath, bankTitle: bank.title, ...summarizeProgress({ bank, events: readEvents() }) }
}

/**
 * 记录一次作答**并立刻取回解析**。
 *
 * ═══ 为什么是"一个工具"而不是"记录 + 揭示"两个 ═══
 * 拆成两个工具会打开一个破坏循环的缺口：agent 可以先调"揭示答案"、再装作学习者作答，
 * 或者把答案念给学习者之后才记录。**合成一个动作，这个缺口就不存在**——
 * 取回解析的前提是作答已经被记录（`event` 已经写进日志）。
 * 这是"用接口形状防止误用"而不是"在提示词里请求模型别那样做"（契约 §1.1）。
 *
 * @param params 见 `recordAttempt`，另加 `includeAnalysis`。
 * @returns `{ event, question, data, revealed }`。
 */
export function submitAnswer({ includeAnalysis = true, ...rest }) {
  const result = recordAttempt(rest)
  return {
    ...result,
    revealed: includeAnalysis ? toRevealedQuestion(result.question) : null,
  }
}

/**
 * 这道题**在这之前**做过几次、上次答了什么。
 *
 * ═══ 为什么必须在 `store.append` **之前**算（这是这段代码唯一容易写错的地方）═══
 * 作者要的形态是"**在本次作答之后**告诉学习者：这题你做过，上次你选了什么"。
 * 如果先写事件再统计，那么"上一次"统计到的就是**刚刚写进去的这一次**——
 * 于是界面会显示"上次你选了 C"，而 C 正是他刚刚选的那个。
 * 那不但没信息量，还会让人以为系统记错了。
 *
 * 所以调用点必须在写入之前（见 `recordAttempt`）。这是一个**顺序**约束，
 * 而顺序错误不会报错、只会给出一个看起来合理的错答案——所以它有专门的测试。
 *
 * @param params.events - 当前事件日志（**写入本次作答之前**读到的）。
 * @param params.questionId - 题目 id。
 * @returns `{attempts, correct, wrong, unjudged, last_at, last_response, last_correct}`；没做过则 null。
 */
export function priorHistoryOf({ events, questionId }) {
  const { attempts } = extractAttempts(events)
  const per = summarizeAttempts({ attempts }).per_question
  const h = per[questionId]
  if (h === undefined || h.attempts === 0) return null
  return h
}

/**
 * 记录一次作答。
 *
 * @param params.store - LH 事件存储。
 * @param params.workspaceRoot - 工作区绝对路径。
 * @param params.bankName - 题库名。
 * @param params.questionId - 题目 id。
 * @param params.response - 作答内容。
 * @param params.source - 作答来源。
 * @param params.durationMs - 用时（毫秒）。
 * @param params.sessionRef - 当时的会话 id。
 * @returns 记录结果。
 */
export function recordAttempt({ store, workspaceRoot, bankName, questionId, response, source, durationMs, sessionRef, model, scoreGot, scoreTotal, note, noteKind, author }) {
  const { path: bankPath, bank } = requireBank({ workspaceRoot, bankName })

  const [question] = pickQuestions({ bank, ids: [questionId] })
  if (question === undefined) {
    // 不静默记一条"答错"：题目找不到时判分无意义，
    // 而记成 false 会让学习者的正确率凭空变低（ADR-018 决定 5）。
    throw new Error(`题库「${bankName}」里没有 id 为 ${questionId} 的题（共 ${bank.question_count} 道）`)
  }

  const data = buildAttempt({
    question,
    response,
    source,
    // ⚠ 这两个必须**显式透传**：漏了它们的症状是"字段静默为空"——
    //   底层 buildAttempt 已经把 model 写成 null、把分数写成 null，
    //   于是模型作答会显示成"模型（未记录型号）"，而**没有任何报错**。
    //   （2026-10-13 实测踩到：我改了 buildAttempt 却忘了这一层，39 条记录的型号全丢了。）
    model,
    scoreGot,
    scoreTotal,
    durationMs,
    sessionRef,
    // seq 暂缺：会话事件序号在工具执行期拿不到（宿主没在 exec 上暴露）。
    // 显式留 null 而不是编一个 —— 坐标错比坐标缺更糟（见 lh-recorder-trace 的同一条判断）。
    seq: undefined,
  })

  // ⚠ 必须在 append **之前**读：否则"上一次"统计到的是刚写进去的这一条，
  // 界面就会显示"上次你选了 C"而 C 正是他刚选的。见 priorHistoryOf 的注释。
  const history = priorHistoryOf({ events: readEvents(), questionId })

  const event = store.append({
    // actor 取 source 的值：作答是**谁**做的，这是这条事件最重要的语义
    // （ADR-018 决定 6：模型答对了不是"我会了"）
    actor: source,
    type: ATTEMPT_EVENT_TYPE,
    provenance: PROVENANCE,
    scope: 'root',
    sessionRef,
    data,
  })

  // ═══ 答题时顺手写下的备注 ═══
  //
  // 作者 2026-10-13 要求"支持模型在答题的时候写入备注"。为什么这比"事后再调一次 add_note"
  // 强得多：**事后再问，模型给的是重构过的理由**，而不是当时那条推理——
  // 与 `cancel_schedule` 的 reason、以及"撤销原因只在撤销那一刻知道"是同一条纪律。
  //
  // 一次调用写两条事件（先作答、后注解）**顺序有意义**：备注的 target 是刚写的那条作答。
  // 项目已有先例（"标记完成 + 绑到当前对话" = linked + done 两条）。
  //
  // 谁写的：模型答的 → 这条思路是**模型的**（author: agent + model）；
  //        人答的 → 是学习者的（agent 只是代记，author: user）。
  //         这条区分不做的话，将来会把"模型编的思路"当成"我当时的想法"。
  let noteEvent = null
  if (typeof note === 'string' && note.trim() !== '') {
    noteEvent = recordNote({
      store,
      provenance: PROVENANCE,
      sessionRef,
      targetKind: 'attempt',
      targetId: event.id,
      text: note,
      questionId: question.id,
      author: author ?? (source === 'llm' ? 'agent' : 'user'),
      model,
      // 与作答同一次写下的，默认就是"答题时的思路"（而不是事后的反思）
      noteKind: noteKind ?? 'reasoning',
    }).event
  }

  return { event, question, data, history, noteEvent }
}

/**
 * 插件体。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  trace('APPLY_CALLED')
  ctx.on('dispose', () => trace('DISPOSED（插件被卸载，通常意味着重载）'))

  const store = new LhEventStore()

  // ── 把"刷题走哪条路"写进运行时上下文 ──
  //
  // 为什么不能只靠工具描述：实测一段写在 `get_questions` 描述里的
  // "什么时候不要用它"**没有被遵守**（2026-09-19，agent 仍用 `get_questions`
  // 回应"按知识点出题"，卡片一次都没放）。工具描述是"用到它时才读到"，
  // 而计划阶段看到的上下文才管得住工具选择（同 ADR-016 决定 2）。
  //
  // order 取 117：与宿主的政策类上下文（sandbox 110、approval 115）同带，
  // 排在 `lh:model-tiers`（116）之后——先讲环境（有哪些模型），再讲这次该怎么做。
  //
  // ⚠ `text` 是每次组装时求值的函数，与 lh-model-tier 的写法一致；
  //   没有 agent 时不注入（诊断性组装不带 agent，宿主的两个范例也是这样）。
  //
  // 这里刻意**不做"systemPrompt 可用吗"的防御判断**：软 `ctx.inject` 的回调只在
  // 服务就绪时执行（`systemPrompt` 刻意不进硬 inject，见头注释 2026-10-13）；
  // 再包一层 if 只会多一条永远不触发的分支，还会让人以为"这里的服务可能没有"
  // （`lh-model-tier` 的 apply 就是这么写的，生产已验证）。
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'lh:practice-routing',
      order: 117,
      text: (context) => (context.agent === undefined ? '' : renderPracticeRoutingContext()),
    })
    trace('CONTEXT_REGISTERED  name=lh:practice-routing  order=117')
  })

  // ── 工具 1：导入题目 ──
  ctx.tools.register({
    name: 'import_questions',
    description:
      '把**已经结构化**的题目导入题库（写入当前工作区的 lh-questions/ 目录），并记为一条 LH 资源。' +
      '会自动校验每道题、派生稳定 id、合并进已有题库。' +
      '注意：本工具**不从 PDF 或图片里抽题**——题目必须已经是 JSON 结构（题干、选项、答案）。' +
      '部分题目不合格时，合格的照样入库，不合格的原样报出原因。' +
      // 词表从实现生成，不手写第二份（ADR-026 决定 6）：
      // 手写的那份会和 topics.js 漂移，而模型会按过时的词表调用，
      // 再收到"这个词不在允许值里"的回报 —— 两边矛盾，模型开始瞎猜。
      `知识点的写法必须取自封闭词表（题型：${describeTopicVocabulary().types}；` +
      `领域：${describeTopicVocabulary().domains}）。词表外的词会被记为 unmapped_topics 并在返回值里报出，而不是被悄悄丢掉——` +
      '**题干里出现的内容词（如"纳米金属""相声"）不是知识点，不要填**。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['bank_name'],
      properties: {
        bank_name: {
          type: 'string',
          description: '题库名（会成为文件名，如「行测-常识判断」）。同名即同一个题库，重复导入会合并而不是新建。',
        },
        file_path: {
          type: 'string',
          description:
            '题目 JSON 文件的绝对路径。文件可以是题目数组、{"questions":[...]}、或单个题目对象。' +
            '与 questions 二选一。',
        },
        questions: {
          type: 'array',
          description: '直接内联给的题目数组。与 file_path 二选一。每项形如 {stem, options, answer, kind?, analysis?, topics?}。',
          items: { type: 'object', additionalProperties: true },
        },
        title: { type: 'string', description: '题库标题（给人看的）。省略则用 bank_name。' },
        source_root: { type: 'string', description: '这些题来自哪个资料根目录。参与题目 id 的派生，建议填。' },
        source_file: { type: 'string', description: '资料内的具体文件（相对 source_root），如「行测/常识判断.pdf」。' },
        provenance_model: {
          type: 'string',
          description:
            '抽取这些题所用的模型（若是 LLM 抽的，如 deepseek-flash）。这决定下游对题目质量的信任度，建议填。' +
            '只接受 data/model-tiers.json 白名单里的模型，白名单外会被拒绝（须由使用者改配置，agent 不得自选计费模型）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bank_path', 'question_count', 'added_count', 'replaced_count', 'rejected_count', 'resource_event_id'],
        properties: {
          bank_path: { type: 'string', description: '题库文件的绝对路径' },
          question_count: { type: 'integer', description: '导入后题库里的总题数' },
          added_count: { type: 'integer', description: '本次新增的题数' },
          replaced_count: { type: 'integer', description: '本次替换掉的同 id 题数（通常意味着同一题被修正）' },
          rejected_count: { type: 'integer', description: '未通过校验被拒的题数' },
          resource_event_id: { type: 'string', description: 'LH 资源事件的 id' },
          errors: {
            type: 'array',
            description: '被拒题目的原因（每条含 index 与 message）',
            items: { type: 'object', additionalProperties: true },
          },
          sample_ids: {
            type: 'array',
            description: '本次新增题目的前几个 id（便于后续按 id 引用）',
            items: { type: 'string' },
          },
          with_topics_count: {
            type: 'integer',
            description: '题库里有多少题带上了知识点（0 是合法数字，但意味着按知识点出题目前没有原料）',
          },
          unmapped_topics: {
            type: 'array',
            description:
              '本次没被词表认出的知识点标签（**不是错误**，是词表该扩的证据）。它们没有被写进题目，也没被丢弃。',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `题库：${value.bank_path}`,
          `现有 ${value.question_count} 道题（本次新增 ${value.added_count}，替换 ${value.replaced_count}，拒绝 ${value.rejected_count}）`,
        ]
        if (value.sample_ids?.length) lines.push(`新增题 id 示例：${value.sample_ids.join('、')}`)
        if (typeof value.with_topics_count === 'number') {
          lines.push(`其中 ${value.with_topics_count} 道带知识点`)
        }
        // 未映射如实报出，并说清"它没有被写进去"——否则模型会以为填了就生效了
        // （与 ADR-026 决定 5 的 `ignored` 同一条纪律：声明了却不生效比没有更糟）
        if (value.unmapped_topics?.length) {
          lines.push(
            '',
            `有 ${value.unmapped_topics.length} 个知识点写法不在词表里，**未写入题目**：${value.unmapped_topics.join('、')}`,
            '如果其中确实有该保留的知识点，请改用词表里的说法重导；若词表确实缺这一类，请告知（词表会按真实数据扩）。',
          )
        }
        if (value.rejected_count > 0) {
          lines.push('', `被拒的 ${value.rejected_count} 道：`)
          for (const e of value.errors ?? []) lines.push(`  [${e.index}] ${e.message}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
        throw new Error('拿不到工作区路径（session.header.cwd），无法决定题库落点')
      }
      const bankName = args?.bank_name
      if (typeof bankName !== 'string' || bankName.trim() === '') throw new Error('bank_name 必填')

      // ── 模型白名单硬闸（T4.1 堵漏）──
      // provenance_model 只是"记账用"入参，但它同样是 agent 自选计费模型的入口，
      // 所以在读题/入库之前先过闸（按 model 名校验，见 assertWhitelistedModel）。
      const provenanceModel =
        typeof args?.provenance_model === 'string' && args.provenance_model.trim() !== ''
          ? args.provenance_model.trim()
          : undefined
      if (provenanceModel !== undefined) {
        assertWhitelistedModel({
          model: provenanceModel,
          tool: 'import_questions',
          provenance: PROVENANCE,
          sessionRef: exec?.agent?.session?.id === undefined ? undefined : String(exec.agent.session.id),
          store,
        })
      }

      const { rawList, title, readFrom } = readQuestionSource(args)

      const result = importQuestions({
        store,
        workspaceRoot,
        bankName,
        rawList,
        title: typeof args?.title === 'string' ? args.title : title,
        sourceRoot: typeof args?.source_root === 'string' ? args.source_root : undefined,
        sourceFile: typeof args?.source_file === 'string' ? args.source_file : undefined,
        provenanceModel,
        sessionRef: exec?.agent?.session?.id === undefined ? undefined : String(exec.agent.session.id),
      })
      trace(`IMPORTED  bank=${result.bankPath}  from=${readFrom}  total=${result.bank.question_count}  added=${result.added.length}  replaced=${result.replaced.length}  rejected=${result.errors.length}`)

      return Promise.resolve({
        bank_path: result.bankPath,
        question_count: result.bank.question_count,
        added_count: result.added.length,
        replaced_count: result.replaced.length,
        rejected_count: result.errors.length,
        resource_event_id: result.eventId,
        errors: result.errors,
        sample_ids: result.added.slice(0, 5),
        with_topics_count: result.bank.questions.filter((q) => Array.isArray(q.topics) && q.topics.length > 0).length,
        unmapped_topics: result.unmappedTopics,
      })
    },
  })

  // ══ 工具：从源资料抽题入库（把最脆的"抽取/配对"甩给 subagent，入库仍复用 importQuestions）══
  // 分工依据：本插件刻意不做抽取（见头注释 / ADR-017·018）；既有 rule 抽取（scripts/align_by_question.py
  //   → build_bank.py）在双栏批注、占位解析上很脆。这里让阅读/视觉子 agent 读题本页(取题干选项)+
  //   解析页(取答案讲解)配对成套，产 build_bank 约定形状的题，再走 importQuestions 校验/派 id/入库。
  // ⚠ 与所有真工具一样：必须带 output{schema,render}，否则 register 抛错拖垮整个 preset 挂载（t4 的教训）。
  ctx.tools.register({
    name: 'import_questions_from_source',
    description:
      '从**题本/解析的已 OCR 页文本**里抽题并入库。内部派一个子 agent（默认 mimo-v2.5）读题本页(取题干/选项)' +
      '与解析页(取答案/讲解)、配对成套，产出题目后走同一套校验/派 id/入库。' +
      '**只回计数与样例 id，题干与答案不进主会话**（把录题的重活与答案都关在子 agent 里）。' +
      'page 参数是 data/ocr/**/page-XXXX.json 的绝对路径（工具读其中的 text 字段喂给子 agent）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['bank_name', 'question_pages'],
      properties: {
        bank_name: { type: 'string', description: '目标题库名（工作区 lh-questions 下的文件名，不含 .json）' },
        question_pages: { type: 'array', description: '题本页 OCR json 的绝对路径数组（取题干与选项）。', items: { type: 'string' } },
        answer_pages: { type: 'array', description: '解析页 OCR json 的绝对路径数组（取答案与讲解）。省略则让子 agent 从题本文本里判断答案。', items: { type: 'string' } },
        count: { type: 'integer', description: '从前往后最多入库几题（过盈测试用；省略或 0 表示不限）。' },
        set_number: { type: 'integer', description: '套号兜底值（子 agent 识别不到套/章节时用）；题号 setN-qM（默认 1）。' },
        source_file: { type: 'string', description: '参与 id 派生的稳定来源标签（默认取第一个题本页路径）。重导幂等靠它。' },
        source_root: { type: 'string', description: '资料根路径（可选，参与 id 派生）。' },
        title: { type: 'string', description: '题库标题（可选，默认取 bank_name）。' },
        model: {
          type: 'string',
          description:
            '子 agent 模型 id（默认 mimo-v2.5）。只接受 data/model-tiers.json 白名单里的 {provider, model} 组合，' +
            '白名单外会被拒绝（须由使用者改配置，agent 不得自选计费模型）。',
        },
        provider: {
          type: 'string',
          description:
            '子 agent provider（默认 xiaomi-token-plan-ams）。只接受 data/model-tiers.json 白名单里的 {provider, model} 组合，' +
            '白名单外会被拒绝（须由使用者改配置，agent 不得自选计费模型）。',
        },
        min_confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '低于此置信度的题不入库（默认 medium）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bank_path', 'extracted_count', 'added_count', 'rejected_count', 'skipped_low_confidence_count', 'child_stop_reason'],
        properties: {
          bank_path: { type: 'string', description: '题库落点路径' },
          question_count: { type: 'integer', description: '题库现有总题数' },
          extracted_count: { type: 'integer', description: '子 agent 抽出的题目数（含被拒/跳过的）' },
          added_count: { type: 'integer', description: '本次新增入库题数' },
          replaced_count: { type: 'integer', description: '本次替换（同 id 重导）题数' },
          rejected_count: { type: 'integer', description: '未过校验被拒的题数' },
          skipped_low_confidence_count: { type: 'integer', description: '因置信度低于阈值被跳过、未入库的题数' },
          child_stop_reason: { type: 'string', description: '子 agent 的结束原因（completed/error/...）' },
          sample_ids: { type: 'array', description: '本次新增题的前几个 id', items: { type: 'string' } },
          errors: { type: 'array', description: '被拒题目的原因（index/message）', items: { type: 'object', additionalProperties: true } },
          unmapped_topics: { type: 'array', description: '未被词表认出的知识点（未写入）', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [
          `子 agent 抽出 ${value.extracted_count} 题（${value.child_stop_reason}），` +
          `本次新增 ${value.added_count}、替换 ${value.replaced_count}、拒绝 ${value.rejected_count}、低置信跳过 ${value.skipped_low_confidence_count}。`,
          `题库：${value.bank_path}（现有 ${value.question_count} 道）`,
        ]
        if (value.sample_ids?.length) lines.push(`新增题 id 示例：${value.sample_ids.join('、')}`)
        if (value.rejected_count > 0) {
          lines.push('', `被拒的 ${value.rejected_count} 道（多为缺答案/选项标签越界，可据此回看子 agent 抽取质量）：`)
          for (const e of value.errors ?? []) lines.push(`  [${e.index}] ${e.message}`)
        }
        if (value.unmapped_topics?.length) lines.push('', `未识别知识点（未写入，非错误）：${value.unmapped_topics.join('、')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') throw new Error('拿不到工作区路径（session.header.cwd）')
      const bankName = typeof args?.bank_name === 'string' ? args.bank_name.trim() : ''
      if (bankName === '') throw new Error('bank_name 必填')
      if (!Array.isArray(args?.question_pages) || args.question_pages.length === 0) throw new Error('question_pages 至少要一个页 json 绝对路径')

      // ── 模型白名单硬闸（T4.1 堵漏）──
      // provider/model 是子 agent 的计费出口——事故 B 就是 agent 自传
      // deepseek-official/deepseek-flash 从这里跑掉按量计费的。
      // 必须在读页/派子 agent **之前**按 {provider, model} 严格组合过闸。
      const model = typeof args?.model === 'string' && args.model !== '' ? args.model : 'mimo-v2.5'
      const provider = typeof args?.provider === 'string' && args.provider !== '' ? args.provider : 'xiaomi-token-plan-ams'
      assertWhitelistedModel({
        provider,
        model,
        tool: 'import_questions_from_source',
        provenance: PROVENANCE,
        sessionRef: exec?.agent?.session?.id === undefined ? undefined : String(exec.agent.session.id),
        store,
      })

      // 读页 OCR json 的 text（题本=题干/选项，解析=答案/讲解）
      const pageTag = (p) => { const m = String(p).match(/(\d{3,})/); return m ? String(Number(m[1])) : '?' }
      const readPageText = (paths) => (paths ?? []).map((p) => {
        if (typeof p !== 'string' || !existsSync(p)) throw new Error(`页文件不存在：${p}`)
        let obj
        try { obj = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { throw new Error(`页文件不是合法 JSON：${p}（${e?.message ?? String(e)}）`) }
        if (typeof obj?.text !== 'string' || obj.text.trim() === '') throw new Error(`页文件没有非空 text 字段：${p}`)
        return `〔页 ${pageTag(p)}〕\n${obj.text}`
      }).join('\n\n')
      const qText = readPageText(args.question_pages)
      const aText = Array.isArray(args.answer_pages) && args.answer_pages.length ? readPageText(args.answer_pages) : ''

      const setNumber = Number.isInteger(args?.set_number) ? args.set_number : 1
      const sourceFile = typeof args?.source_file === 'string' && args.source_file !== '' ? args.source_file : String(args.question_pages[0])
      const floor = args?.min_confidence === 'high' ? 3 : args?.min_confidence === 'low' ? 1 : 2
      const confOrder = { high: 3, medium: 2, low: 1, none: 0 }
      const cap = Number.isInteger(args?.count) && args.count > 0 ? args.count : 0

      // 子 agent 提示词：字段分工（题本→stem/options，解析→answer/analysis）+ 套/页识别 + count + 只出 JSON
      const childPrompt = [
        '你是录题抽取器。每段文本前都有〔页 NNNN〕标记（该段来自第几页）。下面给你【题本页文本】（题干与选项，题号形如 1. 2. 3.）和【解析页文本】（每题含【参考答案】X、【题型与文段类型】、讲解）。',
        `把题本里能配到解析的题抽成一个 JSON 数组。可以先写几句分析，但最终结果必须是回复末尾**单独一个 \`\`\`json 代码块**包裹的 JSON 数组，代码块之外不要出现别的 JSON。${cap > 0 ? `从前往后最多取 ${cap} 道**可完整配到【参考答案】的题**。` : '取全部能完整配对的题。'}`,
        '配对纪律（关键，别按页码对应）：**题本与解析是两本书、分页各不相同**（某题题干可能在题本第 3 页，它的【参考答案】却在解析第 7 页）。必须按**题号 + 题干文字**在整段【解析页文本】里定位该题，再读它的【参考答案】；**绝不允许“题本第几页↔解析第几页”的位置对应**。',
        '套/章节识别（决定 set）：优先读页眉或"第X套""X组""X章"等标记填 set（整数套号）；若无明显标记但题号从大回绕到 1，判定进入下一套、套号 +1；都识别不到就用 ' + setNumber + '。',
        '每题对象字段：',
        '  set: 套号（整数，按套/章节规则判定）, no: 题本里印的题号（整数）, page: 该题前最近的〔页 …〕里的数字,',
        '  stem: 题干全文（含"这段文字旨在说明："这类提问句；只从题本取）,',
        '  options: [{label:"A",text:"选项文字"}]（只从题本取，label 用 A/B/C/D）,',
        '  answer: ["C"]（**照抄该题【参考答案】后的字母**，数组形式；若按题号/题干在整段解析里定位不到该题的【参考答案】，answer 必须填 []——**绝不可自己凭理解推断答案，宁可空也不编**）,',
        '  analysis: 该题讲解（取解析里该题那段，可含选项评注；若只是"文段分析见批注"这类占位或读不通就填 ""）,',
        '  question_type: 题型标签（取该题【题型与文段类型】；没有就 ""）,',
        '  confidence: high|medium|low|none（**只有真的照抄到【参考答案】才可 high/medium**；定位不到参考答案一律 none，此时 answer 必须是 []）。',
        '输出示例（只含一条，示意形状）：',
        `[{"set":${setNumber},"no":1,"page":"0003","stem":"……？这段文字旨在说明：","options":[{"label":"A","text":"……"},{"label":"B","text":"……"}],"answer":["C"],"analysis":"……对应C选项，当选……","question_type":"中心理解题","confidence":"high"}]`,
        '',
        '【题本页文本】',
        qText,
        '',
        '【解析页文本】\n' + (aText !== '' ? aText : '（未提供解析页：所有题都无从照抄【参考答案】→ 每题 answer 必须是 []、confidence 必须是 none，一题都不要作答）'),
        '',
        '记住：最终 JSON 数组放在回复最末尾的 ```json 代码块里，别处不要放 JSON。',
      ].join('\n')

      const sa = ctx.subagents ?? (typeof ctx.get === 'function' ? ctx.get('subagents') : undefined)
      const parent = exec?.agent
      if (typeof sa?.start !== 'function' || !parent) {
        return { bank_path: '', question_count: 0, extracted_count: 0, added_count: 0, replaced_count: 0, rejected_count: 0, skipped_low_confidence_count: 0, child_stop_reason: 'subagents_or_parent_unavailable', sample_ids: [], errors: [], unmapped_topics: [] }
      }

      // 子 agent 回传是"推理文字 + 末尾 JSON"的混合体：解析失败先带硬格式提示重试一次，再失败落盘全文供诊断
      const spawnOnce = async (promptText) => {
        const run = await sa.start('spawn', {
          label: '录题抽取',
          prompt: [{ type: 'text', text: promptText }],
          parent,
          agentOptions: { provider, model },
          maxDepth: 3,
          signal: exec.signal ?? new AbortController().signal,
        })
        const result = await run.result
        try { run.dispose?.() } catch { /* 忽略 */ }
        return { stop: String(result?.stopReason ?? 'unknown'), text: (Array.isArray(result?.output) ? result.output : []).filter((b) => b?.type === 'text').map((b) => b.text).join('') }
      }
      const retryNote = '\n\n（重试：上一次回复里没有可解析的最终 JSON 数组。这次把结果放在回复末尾的 ```json 代码块里，其余文字最多两三句。）'
      let childStop = 'unknown'
      let outText = ''
      let items = null
      for (let attemptNo = 1; attemptNo <= 2 && items === null; attemptNo++) {
        try {
          const r = await spawnOnce(attemptNo === 1 ? childPrompt : childPrompt + retryNote)
          childStop = r.stop
          outText = r.text
        } catch (e) {
          trace(`IMPORT_FROM_SOURCE CHILD_THROW  ${String(e?.message ?? e)}`)
          throw new Error(`子 agent 抽取失败：${String(e?.message ?? e)}`)
        }
        items = extractJsonValue(outText, 'array')
      }
      if (items === null) {
        const dump = dumpChildOut('import-from-source', workspaceRoot, outText)
        trace(`IMPORT_FROM_SOURCE PARSE_FAIL  stop=${childStop}  dump=${dump}`)
        throw new Error(`子 agent 输出两次都无法解析为 JSON 数组（stop=${childStop}，全文已存：${dump || '（落盘失败）'}；前 200 字：${outText.slice(0, 200)}；末 200 字：${outText.slice(-200)}）`)
      }

      // 低置信跳过 → 转 importQuestions 的 rawList（number=setN-qM、options 只留文字、显式 kind）
      let skippedLow = 0
      const rawList = []
      for (const it of items) {
        if ((confOrder[String(it?.confidence ?? 'none')] ?? 0) < floor) { skippedLow += 1; continue }
        const opts = Array.isArray(it?.options) ? it.options.map((o) => (typeof o === 'string' ? o : String(o?.text ?? ''))).filter((s) => s !== '') : []
        const answerArr = Array.isArray(it?.answer) ? it.answer.map((a) => String(a)) : (it?.answer ? [String(it.answer)] : [])
        // 兜底纪律：没有【参考答案】可照抄的题（answer 为空）一律不入库，杜绝“子 agent 自己推出一个错答案”混进库污染学习者模型
        if (answerArr.length === 0) { skippedLow += 1; continue }
        rawList.push({
          number: `set${it?.set ?? setNumber}-q${it?.no ?? (rawList.length + 1)}`,
          kind: opts.length >= 2 ? (answerArr.length > 1 ? 'multiple_choice' : 'single_choice') : 'fill_blank',
          stem: typeof it?.stem === 'string' ? it.stem.trim() : '',
          options: opts,
          answer: answerArr,
          analysis: typeof it?.analysis === 'string' ? it.analysis.trim() : '',
          topics: [],
        })
      }
      // 过盈测试：只取前 cap 道可入库的题（cap=0 表示不限）
      if (cap > 0 && rawList.length > cap) rawList.length = cap

      if (rawList.length === 0) {
        trace(`IMPORT_FROM_SOURCE  extracted=${items.length}  lowSkip=${skippedLow}  importable=0  (无题可入库)`)
        return { bank_path: '', question_count: 0, extracted_count: items.length, added_count: 0, replaced_count: 0, rejected_count: 0, skipped_low_confidence_count: skippedLow, child_stop_reason: childStop, sample_ids: [], errors: [], unmapped_topics: [] }
      }

      const result = importQuestions({
        store,
        workspaceRoot,
        bankName,
        rawList,
        title: typeof args?.title === 'string' ? args.title : undefined,
        sourceRoot: typeof args?.source_root === 'string' ? args.source_root : undefined,
        sourceFile,
        provenanceModel: model,
        sessionRef: exec?.agent?.session?.id === undefined ? undefined : String(exec.agent.session.id),
      })
      trace(`IMPORT_FROM_SOURCE  bank=${result.bankPath}  extracted=${items.length}  lowSkip=${skippedLow}  total=${result.bank.question_count}  added=${result.added.length}  replaced=${result.replaced.length}  rejected=${result.errors.length}`)

      return {
        bank_path: result.bankPath,
        question_count: result.bank.question_count,
        extracted_count: items.length,
        added_count: result.added.length,
        replaced_count: result.replaced.length,
        rejected_count: result.errors.length,
        skipped_low_confidence_count: skippedLow,
        child_stop_reason: childStop,
        sample_ids: result.added.slice(0, 5),
        errors: result.errors,
        unmapped_topics: result.unmappedTopics,
      }
    },
  })

  // ── 工具：verify_pairing（入库前“按题对应”体检，防串题）──
  ctx.tools.register({
    name: 'verify_pairing',
    description:
      '过盈式配对体检 + 索引：把【题本】与【解析】各自交给抽取 LLM 按"题号 + 套/章节 + 页"分别切成题目清单（两侧同一套分题逻辑），从前往后取满 count 题（喂多几页即可、不必凑页数），核对两侧数量、抽几对判"是不是同一道题"，并吐一张"套+题号 → 参考答案/页码"的索引表。批量入库前用它确认没串题。只回索引与抽样判定，不回题干/答案正文。page 参数是 data/ocr/**/page-XXXX.json 的绝对路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question_pages', 'answer_pages'],
      properties: {
        question_pages: { type: 'array', items: { type: 'string' }, description: '题本 OCR 页（page-XXXX.json）绝对路径；按顺序，宁多勿少（过盈），取满 count 题即可' },
        answer_pages: { type: 'array', items: { type: 'string' }, description: '解析 OCR 页绝对路径；题本与解析分页不同，各自喂足覆盖同一段题号' },
        count: { type: 'integer', description: '每侧从前往后最多取几题，默认 30' },
        sample_size: { type: 'integer', description: '抽几对做“同一题”判定，默认 5' },
        set_number: { type: 'integer', description: '套号识别不到时的兜底套号，默认 1' },
        model: { type: 'string', description: '抽取子 agent 模型，默认 mimo-v2.5' },
        provider: { type: 'string', description: '子 agent provider，默认 xiaomi-token-plan-ams' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['question_count', 'answer_count', 'counts_match', 'answer_letters_in_order', 'index', 'sampled', 'child_stop_reason'],
        properties: {
          question_count: { type: 'integer', description: '题本侧取到的题数' },
          answer_count: { type: 'integer', description: '解析侧取到的【参考答案】条数' },
          counts_match: { type: 'boolean', description: '两侧取到数量是否一致' },
          total_extracted: { type: 'integer', description: '题本侧实际能取到的题数（未受 count 截断前）' },
          note: { type: 'string', description: '子 agent 的补充说明（如不足 count、套识别情况）' },
          question_numbers: { type: 'array', items: { type: 'integer' }, description: '题本侧题号（按顺序）' },
          answer_letters_in_order: { type: 'array', items: { type: 'string' }, description: '解析侧按出现顺序的【参考答案】字母（机械抓取，权威）' },
          index: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '索引：[{key,q_set,q_no,q_page,a_ref,matched}]，key=套+题号' },
          sampled: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '抽样对：{index,q_head,a_ref,a_head,same,reason}' },
          child_stop_reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = []
        lines.push(`题本侧 ${value.question_count} 题 ｜ 解析侧 ${value.answer_count} 条【参考答案】 ｜ ${value.counts_match ? '数量一致 ✓' : '数量不一致 ✗'}`)
        if (value.note) lines.push(`说明：${value.note}`)
        if (value.answer_letters_in_order?.length) lines.push(`参考答案顺序（机械抓取）：${value.answer_letters_in_order.join(' ')}`)
        lines.push(`索引（套+题号 → 答案 ｜ 题本第几页）：`)
        for (const e of value.index ?? []) lines.push(`  ${e.key} → ${e.a_ref ?? '?'} ｜ 第${e.q_page ?? '?'}页${e.matched ? '' : '  ⚠未配到解析'}`)
        lines.push(`抽样判定：`)
        for (const s of value.sampled ?? []) {
          lines.push(`  #${s.index}：题本「${s.q_head ?? ''}」↔ 解析${s.a_ref ?? '?'}「${s.a_head ?? ''}」→ ${s.same ? '同一题 ✓' : '存疑 ✗'}${s.reason ? `（${s.reason}）` : ''}`)
        }
        lines.push(`（子 agent：${value.child_stop_reason}）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const pageTag = (p) => { const m = String(p).match(/(\d{3,})/); return m ? String(Number(m[1])) : '?' }
      const readPageText = (paths) => (paths ?? []).map((p) => {
        if (typeof p !== 'string' || !existsSync(p)) throw new Error(`页文件不存在：${p}`)
        let obj
        try { obj = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { throw new Error(`页文件不是合法 JSON：${p}`) }
        if (typeof obj?.text !== 'string' || obj.text.trim() === '') throw new Error(`页文件没有非空 text 字段：${p}`)
        return `〔页 ${pageTag(p)}〕\n${obj.text}`
      }).join('\n\n')

      if (!Array.isArray(args?.question_pages) || args.question_pages.length === 0) throw new Error('question_pages 不能为空')
      if (!Array.isArray(args?.answer_pages) || args.answer_pages.length === 0) throw new Error('answer_pages 不能为空')
      const qText = readPageText(args.question_pages)
      const aText = readPageText(args.answer_pages)

      // 机械侧（不依赖 LLM）：按顺序抓解析里的【参考答案】，作为权威答案序列
      const answerLetters = [...aText.matchAll(/【参考答案】\s*([A-D]{1,4})/g)].map((m) => m[1])
      const cap = Number.isInteger(args?.count) && args.count > 0 ? args.count : 30
      const sample = Number.isInteger(args?.sample_size) && args.sample_size > 0 ? args.sample_size : 5
      const setFallback = Number.isInteger(args?.set_number) ? args.set_number : 1
      const model = typeof args?.model === 'string' && args.model !== '' ? args.model : 'mimo-v2.5'
      const provider = typeof args?.provider === 'string' && args.provider !== '' ? args.provider : 'xiaomi-token-plan-ams'

      const childPrompt = [
        '你在做题库"按题对应"过盈体检。每段文本前都有〔页 NNNN〕标记（该段来自第几页）。【题本】含题干与选项，【解析】含每题的【参考答案】与讲解。',
        '关键：题本与解析是两本书、分页各不相同。必须按"题号 + 题干内容"把两边对应起来，绝不可按页码/位置对应。',
        `两侧都用同一套分题逻辑，各自从前往后取满 ${cap} 题（不足则取实际能取到的，并在 note 说明）。`,
        '套/章节识别：优先读页眉或"第X套""X组""X章"等标记填 set（整数套号）；若无明显标记但题号从大回绕到 1，判定进入下一套、套号 +1；都识别不到就用 ' + setFallback + '。',
        '最终结果必须是回复末尾**单独一个 ```json 代码块**包裹的 JSON 对象（可以先写几句分析，但代码块之外不要出现别的 JSON）。形状：',
        '{"questions":[{"no":1,"set":1,"page":"0003","head":"题干前约18字"}],"answers":[{"no":1,"set":1,"page":"0003","ref":"C","head":"解析段前约18字"}],"checks":[{"index":0,"same":true,"reason":"题干关键词出现在该解析段"}],"note":""}',
        'questions：题本侧每题 {no=题本印的题号, set=套号, page=该题前最近的〔页 …〕里的数字, head=题干前约18字}，按出现顺序取前 ' + cap + ' 题。',
        'answers：解析侧每条【参考答案】 {no=该题题号, set=套号, page=所在页数字, ref=答案字母, head=解析段前约18字}，按出现顺序取前 ' + cap + ' 条。',
        `checks：对前 ${sample} 对（index 从 0 起，指 questions 与 answers 同下标）逐对判断"题本这一题与解析这一条是否同一道题"，给 same(true/false) 与简短 reason。`,
        'note：一句话补充（如实际题数不足、套如何判定）。',
        '',
        '【题本】',
        qText,
        '',
        '【解析】',
        aText,
        '',
        '记住：最终 JSON 对象放在回复最末尾的 ```json 代码块里，别处不要放 JSON。',
      ].join('\n')

      const sa = ctx.subagents ?? (typeof ctx.get === 'function' ? ctx.get('subagents') : undefined)
      const parent = exec?.agent
      if (typeof sa?.start !== 'function' || !parent) {
        return { question_count: 0, answer_count: answerLetters.length, counts_match: false, total_extracted: 0, note: '', question_numbers: [], answer_letters_in_order: answerLetters, index: [], sampled: [], child_stop_reason: 'subagents_or_parent_unavailable' }
      }

      // 同 import 侧：推理混排回传 → 硬格式提示重试一次 → 再失败落盘全文
      const workspaceRoot = exec?.agent?.session?.header?.cwd ?? ''
      const spawnOnce = async (promptText) => {
        const run = await sa.start('spawn', {
          label: '录题体检',
          prompt: [{ type: 'text', text: promptText }],
          parent,
          agentOptions: { provider, model },
          maxDepth: 3,
          signal: exec.signal ?? new AbortController().signal,
        })
        const result = await run.result
        try { run.dispose?.() } catch { /* 忽略 */ }
        return { stop: String(result?.stopReason ?? 'unknown'), text: (Array.isArray(result?.output) ? result.output : []).filter((b) => b?.type === 'text').map((b) => b.text).join('') }
      }
      const retryNote = '\n\n（重试：上一次回复里没有可解析的最终 JSON 对象。这次把结果放在回复末尾的 ```json 代码块里，其余文字最多两三句。）'
      let childStop = 'unknown'
      let outText = ''
      let obj = null
      for (let attemptNo = 1; attemptNo <= 2 && obj === null; attemptNo++) {
        try {
          const r = await spawnOnce(attemptNo === 1 ? childPrompt : childPrompt + retryNote)
          childStop = r.stop
          outText = r.text
        } catch (e) {
          trace(`VERIFY_PAIRING CHILD_THROW  ${String(e?.message ?? e)}`)
          throw new Error(`子 agent 体检失败：${String(e?.message ?? e)}`)
        }
        obj = extractJsonValue(outText, 'object')
      }
      if (obj === null) {
        const dump = dumpChildOut('verify-pairing', workspaceRoot, outText)
        trace(`VERIFY_PAIRING PARSE_FAIL  stop=${childStop}  dump=${dump}`)
        throw new Error(`子 agent 输出两次都无法解析为 JSON 对象（stop=${childStop}，全文已存：${dump || '（落盘失败）'}；前 200 字：${outText.slice(0, 200)}；末 200 字：${outText.slice(-200)}）`)
      }

      const allQ = Array.isArray(obj.questions) ? obj.questions : []
      const allA = Array.isArray(obj.answers) ? obj.answers : []
      const questions = allQ.slice(0, cap)
      const answers = allA.slice(0, cap)
      const checks = Array.isArray(obj.checks) ? obj.checks : []
      const keyOf = (o, i) => `s${Number.isInteger(+o?.set) ? +o.set : setFallback}-q${Number.isInteger(+o?.no) ? +o.no : i + 1}`
      const aByKey = new Map()
      answers.forEach((a, i) => aByKey.set(keyOf(a, i), a))
      const qNums = questions.map((q, i) => (Number.isInteger(+q?.no) ? +q.no : i + 1))
      const index = questions.map((q, i) => {
        const k = keyOf(q, i)
        const a = aByKey.get(k) ?? answers[i]
        return { key: k, q_set: Number.isInteger(+q?.set) ? +q.set : setFallback, q_no: qNums[i], q_page: String(q?.page ?? ''), a_ref: String(a?.ref ?? ''), matched: a != null }
      })
      const sampled = checks.map((c) => {
        const i = Number(c?.index)
        const q = questions[i]
        const a = q ? (aByKey.get(keyOf(q, i)) ?? answers[i]) : answers[i]
        return { index: Number.isInteger(i) ? i : -1, q_head: String(questions[i]?.head ?? '').slice(0, 24), a_ref: String(a?.ref ?? ''), a_head: String(a?.head ?? '').slice(0, 24), same: c?.same === true, reason: String(c?.reason ?? '').slice(0, 60) }
      })

      trace(`VERIFY_PAIRING  q=${questions.length}  a=${answers.length}  mechAnswers=${answerLetters.length}  countsMatch=${questions.length === answers.length}  stop=${childStop}`)
      return {
        question_count: questions.length,
        answer_count: answers.length,
        counts_match: questions.length === answers.length,
        total_extracted: allQ.length,
        note: String(obj.note ?? ''),
        question_numbers: qNums,
        answer_letters_in_order: answerLetters,
        index,
        sampled,
        child_stop_reason: childStop,
      }
    },
  })

  // ── 工具 2：记录作答 ──
  ctx.tools.register({
    name: 'record_attempt',
    description:
      '记录学习者（或模型）对某道题的**一次作答**，写入 LH 事件日志。' +
      '会自动判分：选择题按选项集合比对，填空题接受标准答案或题目声明的其他可接受答案。' +
      '判不了时 `correct` 记 null，**不会默认算错**。' +
      '请如实填写 source：人答的填 human，模型答的填 llm——模型答对不是学习证据。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['bank_name', 'question_id', 'response', 'source'],
      properties: {
        bank_name: { type: 'string', description: '题目所在题库名' },
        question_id: { type: 'string', description: '题目 id（形如 q-1a2b3c4d5e6f）' },
        response: {
          type: 'string',
          description: '作答内容。选择题填选项标签（如 "A" 或 "A、C"）；填空题填答案文本。',
        },
        source: {
          type: 'string',
          enum: ['human', 'llm', 'imported'],
          description: '谁在作答。human=学习者本人，llm=模型代答，imported=从别处导入的历史作答。',
        },
        duration_ms: { type: 'integer', description: '作答用时（毫秒）。未知则省略。' },
        model: {
          type: 'string',
          description:
            '**谁作的答**——`source: llm` 时填模型的型号（如 deepseek-v4.1-flash）。' +
            '会显示在题库管理面板的「作答者」列，用于区分不同型号模型的作答；人作答不要填。',
        },
        score_got: { type: 'integer', description: '部分正确的得分（如多选答对一半填 6）。与 score_total 必须成对出现。' },
        score_total: { type: 'integer', description: '部分正确的满分（如 12）。与 score_got 必须成对出现。' },
        note: {
          type: 'string',
          description:
            '**答题时**的思路/反思（可选）。**当场写**才值钱：事后补的是重构过的理由。' +
            '会写成一条独立注解（lh/resource/note-made）挂在这次作答上；不写就不写，不要硬编。',
        },
        note_kind: { type: 'string', enum: ['reasoning', 'reflection'], description: 'note 的种类：reasoning=答题时的思路（默认）/ reflection=做后的反思。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['correct', 'attempt_event_id', 'question_id', 'source'],
        properties: {
          correct: {
            description: 'true=答对，false=答错，null=无法判定',
            oneOf: [{ type: 'boolean' }, { type: 'null' }],
          },
          attempt_event_id: { type: 'string', description: '所记事件的 id' },
          question_id: { type: 'string' },
          source: { type: 'string' },
          expected: {
            type: 'array',
            description: '标准答案（便于确认判分对不对）',
            items: { type: 'string' },
          },
          stem: { type: 'string', description: '题干（截断）' },
        },
      },
      render: (_args, value) => {
        const verdict = value.correct === true ? '答对' : value.correct === false ? '答错' : '无法判定'
        const lines = [`${verdict}（${value.question_id}）`]
        if (value.correct !== true) lines.push(`标准答案：${(value.expected ?? []).join('、')}`)
        if (value.correct === null) lines.push('（判不了，已如实记 null——没有被算成答错）')
        lines.push(`事件 id：${value.attempt_event_id}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
        throw new Error('拿不到工作区路径（session.header.cwd）')
      }
      if (typeof args?.bank_name !== 'string' || args.bank_name.trim() === '') throw new Error('bank_name 必填')
      if (typeof args?.question_id !== 'string' || args.question_id.trim() === '') throw new Error('question_id 必填')
      if (args?.response === undefined) throw new Error('response 必填（可以是空字符串，但不能缺）')

      const result = recordAttempt({
        store,
        workspaceRoot,
        bankName: args.bank_name,
        questionId: args.question_id.trim(),
        response: args.response,
        source: args?.source,
        durationMs: typeof args?.duration_ms === 'number' ? args.duration_ms : undefined,
        // 型号与分数必须显式透传（漏了它们只是静默为空，不报错）
        model: args?.model,
        scoreGot: typeof args?.score_got === 'number' ? args.score_got : undefined,
        scoreTotal: typeof args?.score_total === 'number' ? args.score_total : undefined,
        sessionRef: exec?.agent?.session?.id === undefined ? undefined : String(exec.agent.session.id),
        // note / note_kind 同样必须显式透传：schema 收了不透传 = 备注静默消失
        //（与 model/分数同一条——2026-10-14 审查发现 submit_answer 透传了而这里漏了）
        note: args?.note,
        noteKind: args?.note_kind,
      })
      trace(`ATTEMPT  bank=${args.bank_name}  q=${args.question_id}  source=${args.source}  correct=${result.data.correct}  note=${result.noteEvent ? 'yes' : 'no'}`)

      return Promise.resolve({
        correct: result.data.correct,
        attempt_event_id: result.event.id,
        question_id: result.question.id,
        source: result.data.source,
        expected: result.question.answer,
        stem: result.question.stem.slice(0, 60),
      })
    },
  })

  trace('TOOLS_REGISTERED  import_questions, record_attempt')

  // ═══════════════════════════════════════════════════════════
  //  刷题循环的四个工具
  // ═══════════════════════════════════════════════════════════
  //
  //  ═══ 为什么题的线格式是结构化的，而不是一段念出来的文本 ═══
  //  作者的要求是"至少要有打字以外的输入方式"（选择题的点击），
  //  同时又要"比对话更不容易误触、更流畅、更沉浸"。
  //  那意味着同一道题未来要被**两种界面**使用：文本（念）与可点击（按钮）。
  //  如果工具返回的是一段拼好的文本，点击界面就得回头去解析那串文本——
  //  那是脆弱的耦合，而且一旦措辞变了就静默失灵。
  //  所以这里返回 `options: [{ label, text }]`：
  //  **文本界面把它念成 "A. 1954年"，点击界面把同一个 label 渲染成按钮。**
  //  契约不需要改，界面可以后加。这是"两条路不独立"在接口层的落地。
  //
  //  ═══ 为什么提交是"记录 + 揭示"合一个动作 ═══
  //  见 `submitAnswer` 的注释：拆成两个工具会打开"先看答案再作答"的缺口。

  /** 题的线格式：与 `toPresentableQuestion` 的返回严格同构。 */
  const questionShape = {
    type: 'object',
    additionalProperties: true,
    description: '一道题。options 带 label，文本界面念 "A. 选项内容"，图形界面把 label 渲染成按钮。',
    properties: {
      id: { type: 'string', description: '题目 id，提交作答时要用它' },
      kind: {
        type: 'string',
        enum: ['single_choice', 'multiple_choice', 'fill_blank', 'other'],
        description: '题型。single_choice/multiple_choice 让学习者点选项；fill_blank 让他打字。',
      },
      stem: { type: 'string', description: '题干' },
      options: {
        type: 'array',
        description: '选项。选择题有，填空题为空数组。',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'text'],
          properties: {
            label: { type: 'string', description: '选项标签，如 A / B / C / D' },
            text: { type: 'string', description: '选项内容' },
          },
        },
      },
      topics: { type: 'array', description: '知识点（可能为空——知识点体系尚未定案）', items: { type: 'string' } },
    },
  }

  // ── 刷题工具 1：看有哪些题库 ──
  ctx.tools.register({
    name: 'list_question_banks',
    description:
      '列出当前工作区里有哪些题库（名字、题数、来自哪份资料）。' +
      '学习者说"我想刷题"但没说刷哪个时，先用它看看有什么可刷。',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bank_count', 'banks'],
        properties: {
          bank_count: { type: 'integer' },
          banks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string', description: '题库名（后续工具都用它引用）' },
                ok: { type: 'boolean', description: 'false 表示这个题库文件坏了，需要修' },
                title: { type: 'string' },
                question_count: { type: 'integer' },
                // ⚠ 必须允许 null。真实题库里这两个字段常常是 null（手写题库没记来源、
                // 或生成时间缺失）。第一版写成 `type: 'string'`，于是宿主拒绝整个工具输出：
                //   tool "list_question_banks" returned invalid output:
                //   "value.banks[1].source_root" must be a string
                // 这个错**离线测试查不出来**——假 ctx 的 register 不做输出校验。
                // 现在测试里接上了宿主的 validateJsonSchemaValue（见 selftest-plugin.mjs）。
                source_root: {
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                  description: '题目来自哪份资料；未记录时为 null',
                },
                generated_at: {
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                  description: '题库生成时间；未记录时为 null',
                },
                errors: { type: 'array', items: { type: 'string' }, description: '坏在哪里' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.bank_count === 0) {
          return [{ type: 'text', text: '工作区里还没有题库。需要先用 import_questions 建一个。' }]
        }
        const lines = [`共 ${value.bank_count} 个题库：`]
        for (const b of value.banks) {
          lines.push(`  ${b.name} —— ${b.question_count} 道${b.ok ? '' : '（⚠ 文件有问题，需要修）'}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(_args, exec) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') throw new Error('拿不到工作区路径（session.header.cwd）')
      const { banks } = listQuestionBanks({ workspaceRoot })
      trace(`LIST_BANKS  count=${banks.length}`)
      return Promise.resolve({ bank_count: banks.length, banks })
    },
  })

  // ── 刷题工具 2：取题（不含答案）──
  ctx.tools.register({
    name: 'get_questions',
    description:
      '从题库里取题**给学习者做**。返回的题**不含答案**（答案只在提交作答后才给）。' +
      '取到后把题干与选项念给学习者，选择题让他选，填空题让他填——不要替他作答。' +
      // ⚠⚠ 这段分工说明是**出了事故之后补上的**（2026-09-19 反馈）⚠⚠
      // 原来的描述只写"取到后把题干与选项念给学习者"——**那等于在教模型把题念在对话里**。
      // 于是学习者说"继续刷题"时，模型就顺着它一道道念出来，
      // 而不是去调 `start_practice` 放一张卡片：两条路都合法、而这条路更顺手。
      // 现在把分工写死：**刷题走卡片，这个工具只用于"在对话里问一道题"。**
      '\n\n【什么时候**不要**用它】' +
      '学习者说"刷题""继续刷题""给我 10 题""重刷做过的/错题""再练几道"这类**要进入刷题**的话时，' +
      '**一律调 `start_practice` 放一张卡片**——题会出现在卡片与面板里（有判分、有记录、有进度），' +
      '而**不要**把题目念在对话里：那样做完留不下作答记录，也就没有统计可看。' +
      '\n\n【什么时候用它】只在这两种情形：① 学习者**明确要求**"就在对话里问我一道题"；' +
      '② 你想就某个知识点现问一道、随即继续别的话题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['bank_name'],
      properties: {
        bank_name: { type: 'string', description: '题库名（用 list_question_banks 可以看有哪些）' },
        count: { type: 'integer', description: '取几道，默认 1。' },
        order: {
          type: 'string',
          enum: ['sequential', 'random', 'unseen', 'attempted', 'missed'],
          description:
            '出题顺序。sequential=按题库里的原始顺序；random=随机；unseen=只取没做过的；' +
            'attempted=只取**做过的**（"重刷做过的题"用这一档）；missed=只取**最近一次答错**的（"只练错题"）。' +
            'unseen/attempted/missed 在没有相应记录时会退化为 sequential，不会返回空。',
        },
        topic: {
          type: 'string',
          description:
            '只看某个知识点。⚠ 与 `start_practice` 的 topic **不是同一件事的两种写法**：' +
            '这个工具的 topic 只用于"我现在问你一道这个知识点的题"，' +
            '而进入刷题要把它传给 `start_practice`（否则卡片代表不了你要的选择）。' +
            '写法与词表见 `start_practice` 的 topic 参数说明。',
        },
        ids: { type: 'array', items: { type: 'string' }, description: '直接指定题目 id（给了就忽略 order）。' },
        exclude_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '排除这些题。本次已经出过的题放这里，避免连着出同一道。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bank_name', 'total_in_bank', 'question_count', 'questions', 'order'],
        properties: {
          bank_name: { type: 'string' },
          total_in_bank: { type: 'integer', description: '题库总题数' },
          question_count: { type: 'integer', description: '本次取到几道' },
          order: { type: 'string', description: '实际生效的顺序（可能因退化而与请求不同）' },
          note: { type: 'string', description: '策略被如何调整过；空串表示完全按请求执行' },
          questions: { type: 'array', items: questionShape },
        },
      },
      render: (_args, value) => {
        const parts = [`来自题库「${value.bank_name}」（共 ${value.total_in_bank} 道），本次 ${value.question_count} 道：`, '']
        for (const q of value.questions) {
          parts.push(`【${q.id}】${q.stem}`)
          for (const o of q.options) parts.push(`  ${o.label}. ${o.text}`)
          if (q.options.length === 0) parts.push('  （填空题，请学习者直接填写答案）')
          parts.push('')
        }
        if (value.note) parts.push(`注：${value.note}`)
        // ⚠ 这段提醒是**唯一在"用错工具"那一刻出现在模型眼前的东西**。
        // 描述是调用前读的，这段话是调用后读的——而"刚才那次是不是该走卡片"
        // 只有在拿到结果时才最容易判断（2026-09-19 实测：agent 在"按知识点出题"
        // 的意图下调了本工具两次，卡片一次都没放）。
        parts.push(
          '',
          '⚠ 本工具**不写作答记录**——这里出的题在对话里作答，事后没有进度、没有错题本。' +
            '如果学习者要的是"进入刷题"（刷题 / 给我 N 题 / 重刷做过的 / 只练错题 / 按知识点出题），' +
            '现在改调 `start_practice` 把选择传进去，卡片才是留下记录的入口。',
        )
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    execute(args, exec) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') throw new Error('拿不到工作区路径（session.header.cwd）')
      if (typeof args?.bank_name !== 'string' || args.bank_name.trim() === '') throw new Error('bank_name 必填')

      const result = getQuestions({
        workspaceRoot,
        bankName: args.bank_name.trim(),
        count: typeof args?.count === 'number' ? args.count : 1,
        order: typeof args?.order === 'string' ? args.order : 'sequential',
        topic: typeof args?.topic === 'string' ? args.topic : undefined,
        ids: Array.isArray(args?.ids) ? args.ids : undefined,
        excludeIds: Array.isArray(args?.exclude_ids) ? args.exclude_ids : [],
      })
      trace(`GET_QUESTIONS  bank=${args.bank_name}  order=${result.order}  got=${result.questions.length}/${result.totalInBank}`)

      return Promise.resolve({
        bank_name: args.bank_name.trim(),
        total_in_bank: result.totalInBank,
        question_count: result.questions.length,
        order: result.order,
        note: result.note ?? '',
        questions: result.questions,
      })
    },
  })

  // ── 刷题工具 3：提交作答（记录 + 立刻给解析）──
  ctx.tools.register({
    name: 'submit_answer',
    description:
      '提交学习者对某道题的作答。**记录与判分与解析在同一步完成**——' +
      '所以不存在"先看答案再作答"的可能，也不要试图绕过它去别处找答案。' +
      '返回里会有对错、标准答案与解析；答错时用解析讲清为什么。' +
      'source 一定填 human（这是学习者的作答）；只有学习者明确要求"你示范一遍"时才用 llm——' +
      '模型答对不算学习者会了。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['bank_name', 'question_id', 'response'],
      properties: {
        bank_name: { type: 'string', description: '题库名' },
        question_id: { type: 'string', description: '题目 id（get_questions 返回的那个）' },
        response: {
          type: 'string',
          description: '学习者给的答案。选择题填选项标签（如 "A" 或 "A、C"）；填空题填他写的文本。',
        },
        source: {
          type: 'string',
          enum: ['human', 'llm', 'imported'],
          description: '谁在作答。默认 human。llm 只用于"学习者要求你示范"。',
        },
        duration_ms: { type: 'integer', description: '学习者思考用时（毫秒）。能估出来就填，估不出省略。' },
        model: {
          type: 'string',
          description:
            '**谁作的答**——`source: llm` 时填模型的型号（如 deepseek-v4.1-flash），' +
            '题库管理面板的「作答者」列会显示它，便于区分不同型号模型的作答；人作答不要填。',
        },
        score_got: { type: 'integer', description: '部分正确的得分（如多选答对一半填 6）。与 score_total 必须成对出现。' },
        score_total: { type: 'integer', description: '部分正确的满分（如 12）。与 score_got 必须成对出现。' },
        note: {
          type: 'string',
          description:
            '**答题时**写下的思路/反思（可选，但很值钱）：学习者答题时说的话、或你作为模型的推理。' +
            '会写成一条独立注解挂在这次作答上——**当场写**才值钱，事后补的是重构过的理由。' +
            '不要为了填满而编：没有思路就省略。',
        },
        note_kind: { type: 'string', enum: ['reasoning', 'reflection'], description: 'note 的种类：reasoning=答题时的思路（默认）/ reflection=做后的反思。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['correct', 'question_id', 'response', 'source', 'attempt_event_id', 'stem', 'options', 'answer', 'analysis', 'history_attempts'],
        properties: {
          correct: {
            description: 'true=答对，false=答错，null=判不了（不要去猜，如实告诉学习者判不了）',
            oneOf: [{ type: 'boolean' }, { type: 'null' }],
          },
          question_id: { type: 'string' },
          response: { type: 'string', description: '回显学习者给的原答案，便于确认没记错' },
          source: { type: 'string' },
          attempt_event_id: { type: 'string', description: '这次作答的事件 id' },
          stem: { type: 'string' },
          options: { type: 'array', items: { type: 'object', additionalProperties: true } },
          answer: { type: 'array', items: { type: 'string' }, description: '标准答案' },
          accept: { type: 'array', items: { type: 'string' }, description: '其他也算对的写法（填空题常见）' },
          analysis: { type: 'string', description: '解析。答错时用它讲清为什么；可能为空。' },
          analysis_kind: {
            type: 'string',
            description: '解析的来路与质量：原文 / 原文（OCR 可能串行）/ 选项标注拼成 / 无。' +
              '串行的那类**不要当权威原文用**（读起来会跳）。',
          },
          // ── 这道题**在这之前**做过几次、上次答了什么 ──
          //
          // ⚠ 这几个字段**只在这里出现**：`get_questions`（取题）的返回里**绝不带**。
          // 这是"结构上不可能先看历史再作答"——不靠提醒模型别说，而是数据不在那条路上。
          // 作者的要求也正是"在本次作答之后才让学习者知道"。
          history_attempts: {
            type: 'integer',
            description: '**本次之前**这道题做过几次（0 = 第一次做）。每次都如实报给学习者。',
          },
          history_last_response: {
            description: '上一次答的是什么；第一次做时为 null',
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
          history_last_correct: {
            description: '上一次判成对还是错；第一次做或判不了时为 null',
            oneOf: [{ type: 'boolean' }, { type: 'null' }],
          },
          history_last_at: {
            description: '上一次作答的时间（ISO 字符串）；第一次做时为 null',
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
        },
      },
      render: (_args, value) => {
        const verdict = value.correct === true ? '✓ 答对' : value.correct === false ? '✗ 答错' : '? 判不了'
        const lines = [`${verdict}（${value.stem}）`, `学习者答的是：${value.response}`]
        if (value.correct !== true) {
          lines.push(`标准答案：${(value.answer ?? []).join('、')}`)
          if (value.accept?.length) lines.push(`（这些写法也算对：${value.accept.join('、')}）`)
        }
        if (value.analysis) lines.push('', `解析：${value.analysis}`)
        else if (value.correct === false) lines.push('', '（题库里没有解析，需要你自己讲——别编造标准答案之外的依据。）')
        if (value.correct === null) lines.push('', '（判不了，已如实记 null——没有被算成答错。）')

        // ── 作答历史：**在本次作答之后**才给（这是刻意的）──
        if (value.history_attempts > 0) {
          const when = typeof value.history_last_at === 'string' ? value.history_last_at.slice(0, 10) : null
          const judge = value.history_last_correct === true ? '答对' : value.history_last_correct === false ? '答错' : '判不了'
          lines.push(
            '',
            `📌 这道题**之前做过 ${value.history_attempts} 次**：上次（${when ?? '时间未记'}）答的是「${value.history_last_response ?? '?'}」，${judge}。`,
            '（把这条一起告诉学习者——他要的是"这题我做过、上次错了"这种连续感。' +
              '但**只在这一次作答之后**说，作答之前不要提。）',
          )
        } else {
          lines.push('', '📌 这是这道题的**第一次**作答。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') throw new Error('拿不到工作区路径（session.header.cwd）')
      if (typeof args?.bank_name !== 'string' || args.bank_name.trim() === '') throw new Error('bank_name 必填')
      if (typeof args?.question_id !== 'string' || args.question_id.trim() === '') throw new Error('question_id 必填')
      if (args?.response === undefined) throw new Error('response 必填（可以是空字符串，但不能缺）')

      const result = submitAnswer({
        store,
        workspaceRoot,
        bankName: args.bank_name.trim(),
        questionId: args.question_id.trim(),
        response: args.response,
        source: typeof args?.source === 'string' ? args.source : 'human',
        durationMs: typeof args?.duration_ms === 'number' ? args.duration_ms : undefined,
        // 型号与分数必须显式透传（漏了它们只是静默为空，不报错）
        model: args?.model,
        scoreGot: typeof args?.score_got === 'number' ? args.score_got : undefined,
        scoreTotal: typeof args?.score_total === 'number' ? args.score_total : undefined,
        // 答题时顺手写的备注：**当场写**才值钱（事后补的是重构过的理由）
        note: args?.note,
        noteKind: args?.note_kind,
        sessionRef: exec?.agent?.session?.id === undefined ? undefined : String(exec.agent.session.id),
      })
      trace(`SUBMIT  bank=${args.bank_name}  q=${args.question_id}  source=${result.data.source}  correct=${result.data.correct}  note=${result.noteEvent ? 'yes' : 'no'}`)

      const r = result.revealed
      // 作答历史：`recordAttempt` 在**写入之前**算好的那一条（见 priorHistoryOf 的注释）。
      const h = result.history
      return Promise.resolve({
        correct: result.data.correct,
        question_id: r.id,
        response: Array.isArray(result.data.response) ? result.data.response.join('、') : String(result.data.response ?? ''),
        source: result.data.source,
        attempt_event_id: result.event.id,
        stem: r.stem,
        options: r.options,
        answer: r.answer,
        accept: r.accept,
        analysis: r.analysis,
        analysis_kind: r.analysis_kind,
        history_attempts: h === null ? 0 : h.attempts,
        history_last_response: h === null ? null : h.last_response,
        history_last_correct: h === null ? null : h.last_correct,
        history_last_at: h === null ? null : h.last_at,
      })
    },
  })

  // ── 刷题工具 4.5：**只读**取题解（给「AI深解」那条链用）──
  //
  // ═══ 为什么必须单独有这么一个工具（2026-09-19 实测出来的缺口）═══
  // 「AI深解」那条消息要求模型：① 先自己独立解一遍 →② **再检索题库里这道题的参考解析**
  // →③ 分析错因。但第 ② 步**当时根本做不到**：
  //   · `get_questions` 明确「返回的题不含答案」（那是刻意的，见它的说明）；
  //   · 唯一能看到解析的是 `submit_answer`，而它**会写一条作答事件**。
  // 于是模型只有两条路：**撒谎说"没有"**，或者用 `submit_answer` 往学习史里
  // **写一条它自己编的作答**——后者更糟，它污染的正是"统计与将来的选题能力"所依赖的数据。
  //
  // ⚠ 这个工具是**只读**的：**不写任何事件**。
  // 这不是"尽量不写"，而是它的定义——一个"查资料"的动作不该在事实源里留下痕迹。
  // 有测试专门断言它不写事件（`selftest-plugin.mjs`）。
  //
  // ═══ 它为什么现在放在题库插件里，而不是等 lh-deep-dive ═══
  // 短期：它修掉一个"会说错话、还会污染数据"的路径，成本很小。
  // 长期：`lh-deep-dive` 要扩到别的资料类型时，"证据组装"（题解 + 本人作答史 +
  // 该用什么姿势分析）会挪到那个插件去。**那时这个工具仍然该留在题库里**——
  // 因为"题库里的题解是什么"是题库的知识，不是深解的知识。
  ctx.tools.register({
    name: 'get_solution',
    description:
      '**只读**读取某几道题的参考答案与题库解析（**不记录任何东西**，不写作答、不改进度）。' +
      '用途：学习者要求深讲一道题时——**你先自己独立解一遍**，再用这个工具核对题库的参考解析，' +
      '最后对比分析。**顺序不能颠倒**：先看解析再"自己解"是假的独立解，' +
      '而且你会把自己的推理对齐到解析上（看起来更可信，其实更糟）。' +
      '⚠ 解析可能为空、可能只是选项标注的拼凑、也可能是 OCR 自动抽取的**两栏串行**文本' +
      '（读起来会跳）、结尾可能带页脚噪声——`analysis_kind` 会如实标注它的来路与质量。' +
      '**不要把串行的句子当成权威依据去解释**；解析不可靠时，以你自己的推理为准并说明这一点。' +
      '注意：这个工具只给"讲题"用；学习者**作答**仍必须走 submit_answer（那里判分与解析在同一步完成）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['bank_name', 'ids'],
      properties: {
        bank_name: { type: 'string', description: '题库名' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: '题目 id（get_questions / start_practice 那条链里拿到的那个）',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bank_name', 'solutions', 'missing'],
        properties: {
          bank_name: { type: 'string' },
          solutions: {
            type: 'array',
            description: '查到题解的题（顺序与请求的 ids 无关，缺失的会进 missing）',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'stem', 'answer', 'analysis', 'analysis_kind'],
              properties: {
                id: { type: 'string' },
                number: {
                  description: '题号（如 set1-q7）——学习者在纸质资料上能找到的那个编号；无则为 null',
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                },
                stem: { type: 'string' },
                options: { type: 'array', items: { type: 'object', additionalProperties: true } },
                answer: { type: 'array', items: { type: 'string' }, description: '标准答案' },
                accept: { type: 'array', items: { type: 'string' }, description: '其他也算对的写法（填空题常见）' },
                analysis: { type: 'string', description: '题库解析；空串表示这道题没有可用的解析' },
                analysis_kind: {
                  type: 'string',
                  description: '解析的来路与质量：原文 / 原文（OCR 可能串行）/ 选项标注拼成 / 无',
                },
              },
            },
          },
          missing: {
            type: 'array',
            items: { type: 'string' },
            description: '没查到的 id（不在这个题库里）。**如实告诉学习者，不要编。**',
          },
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.solutions.length === 0) {
          lines.push('这个题库里没有查到这些题的题解。**如实告诉学习者这里没有，不要用记忆里的"标准解析"替代。**')
        }
        for (const s of value.solutions) {
          lines.push(`【${s.number ?? s.id}】${s.stem}`)
          lines.push(`标准答案：${(s.answer ?? []).join('、')}`)
          if (s.accept?.length) lines.push(`（这些写法也算对：${s.accept.join('、')}）`)
          if (s.analysis) {
            lines.push(`题库解析（${s.analysis_kind}）：`)
            lines.push(s.analysis)
          } else {
            lines.push('题库解析：**没有**（这道题没有可用的解析——请用自己的推理讲解，并说明依据来自你自己的分析。）')
          }
          lines.push('')
        }
        if (value.missing.length > 0) lines.push(`没查到的 id：${value.missing.join('、')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') throw new Error('拿不到工作区路径（session.header.cwd）')
      if (typeof args?.bank_name !== 'string' || args.bank_name.trim() === '') throw new Error('bank_name 必填')
      const ids = Array.isArray(args?.ids) ? args.ids.filter((x) => typeof x === 'string' && x.trim() !== '') : []
      if (ids.length === 0) throw new Error('ids 必填（至少一个题目 id）')

      const bankName = args.bank_name.trim()
      // 用 ids 直接指定题目：**不要**用 order（那会按策略挑题，可能挑到别的）。
      //
      // ⚠ `includeAnswer: true` 是**必须的**，而且这里踩过一次值得记：
      // `getQuestions` 默认返回 `toPresentableQuestion` 的结果，
      // 也就是**答案与解析已经被剥掉了**（那是给它取题用的默认，见 practice.js）。
      // 第一版这里忘了传，于是 `toRevealedQuestion(q)` 拿到的是一个"已经没答案的题"，
      // 返回的 `answer` 与 `analysis` **全是空**——而且**不报错**。
      // 一个"查题解"的工具静默返回空题解，模型只会据实说"题库里没有解析"，
      // 于是整条深解链条看起来"正常工作"，实际永远拿不到证据。
      // （这正是本项目反复出现的"静默取错数据"，所以测试里专门断言解析非空。）
      const got = getQuestions({ workspaceRoot, bankName, ids, count: ids.length, includeAnswer: true })
      const wanted = new Set(ids)
      const found = (got.questions ?? []).filter((q) => wanted.has(q.id))
      const foundIds = new Set(found.map((q) => q.id))
      const missing = ids.filter((id) => !foundIds.has(id))

      trace(`GET_SOLUTION  bank=${bankName}  请求=${ids.length}  查到=${found.length}  缺=${missing.length}（只读，不写事件）`)

      return Promise.resolve({
        bank_name: bankName,
        // `got.questions` 已经是 revealed 形状（含 answer/accept/analysis/analysis_kind），
        // **不要再 toRevealedQuestion 一次**：那是在"已经揭开的题"上再揭一次，
        // 多一层无谓的转换，也让"它到底经过了哪几个映射"更难追。
        solutions: found.map((q) => ({
          id: q.id,
          number: q.source?.number ?? null,
          stem: q.stem,
          options: q.options,
          answer: q.answer,
          accept: q.accept,
          analysis: q.analysis,
          analysis_kind: q.analysis_kind,
        })),
        missing,
      })
    },
  })

  // ── 刷题工具 5：进度 ──
  ctx.tools.register({
    name: 'get_practice_stats',
    description:
      '看某个题库的刷题进度：做了多少道、覆盖多少、正确率、最近答错的是哪些题。' +
      '用于回答"我练得怎么样""哪些地方不行"。' +
      '正确率**只算人答的、且只算判得了的**——模型代答不会被算进学习成果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['bank_name'],
      properties: {
        bank_name: { type: 'string', description: '题库名' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bank_name', 'total_questions', 'attempted_questions', 'accuracy', 'missed_recent'],
        properties: {
          bank_name: { type: 'string' },
          total_questions: { type: 'integer' },
          attempted_questions: { type: 'integer', description: '做过（至少一次）的题目数' },
          coverage: {
            description: '覆盖率 = 做过的题 / 总题数。null 表示题库是空的（"没题"不等于"没练"）',
            oneOf: [{ type: 'number' }, { type: 'null' }],
          },
          accuracy: {
            description: '正确率，只算人答的且判得了的。null 表示还没有可判的人工作答。',
            oneOf: [{ type: 'number' }, { type: 'null' }],
          },
          human_correct: { type: 'integer' },
          human_wrong: { type: 'integer' },
          human_unjudged: { type: 'integer', description: '判不了的次数，单列——它不进正确率的分母' },
          llm_attempts: { type: 'integer', description: '模型代答的次数，不算学习成果' },
          missed_recent: {
            type: 'array',
            description: '最近一次答错的题（按时间倒序）。这就是错题本的数据。',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                stem: { type: 'string' },
                wrong_count: { type: 'integer' },
                // 允许 null：作作答事件缺时间戳时 last_at 会是 null
                last_at: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const pct = (x) => (x === null ? '（还没有数据）' : `${(x * 100).toFixed(1)}%`)
        const lines = [
          `题库「${value.bank_name}」：${value.total_questions} 道题`,
          `做过 ${value.attempted_questions} 道，覆盖 ${pct(value.coverage)}`,
          `正确率 ${pct(value.accuracy)}（对 ${value.human_correct} / 错 ${value.human_wrong}${value.human_unjudged > 0 ? ` / 判不了 ${value.human_unjudged}` : ''}）`,
        ]
        if (value.llm_attempts > 0) lines.push(`（另有 ${value.llm_attempts} 次模型代答，未计入正确率）`)
        if (value.missed_recent.length > 0) {
          lines.push('', `最近答错的 ${value.missed_recent.length} 道：`)
          for (const m of value.missed_recent) lines.push(`  【${m.id}】${m.stem}（错过 ${m.wrong_count} 次）`)
        } else {
          lines.push('', '还没有答错的题。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') throw new Error('拿不到工作区路径（session.header.cwd）')
      if (typeof args?.bank_name !== 'string' || args.bank_name.trim() === '') throw new Error('bank_name 必填')

      const s = getPracticeStats({ workspaceRoot, bankName: args.bank_name.trim() })
      trace(`STATS  bank=${args.bank_name}  total=${s.total_questions}  attempted=${s.attempted_questions}  accuracy=${s.accuracy}`)

      return Promise.resolve({
        bank_name: args.bank_name.trim(),
        total_questions: s.total_questions,
        attempted_questions: s.attempted_questions,
        coverage: s.coverage,
        accuracy: s.accuracy,
        human_correct: s.human.correct,
        human_wrong: s.human.wrong,
        human_unjudged: s.human.unjudged,
        llm_attempts: s.other.attempts,
        missed_recent: s.missed_recent,
      })
    },
  })

  trace('TOOLS_REGISTERED  list_question_banks, get_questions, submit_answer, get_practice_stats')

  // ── 刷题工具 5：在对话里放一张「开始刷题」卡片 ──
  //
  // ═══ 为什么这个工具存在 ═══
  // 作者反馈：常驻的侧栏"刷题"按钮很突兀，刷题应当**由对话触发**
  // （原话：*"我更希望的是能通过对话里 agent 的调用来启动，就像对话时你给我一个链接，
  // 我点进去就开始刷题……一个出现在 dsh 界面内的刷题按钮很突兀"*）。
  //
  // 所以入口从"界面上的按钮"移到"对话里的**卡片**"：
  // 学习者说"刷题" → agent 调这个工具 → 宿主用 `lh-practice` 注册的渲染器
  // 把这次工具调用画成一张可点的卡片 → **学习者点它**，面板才打开。
  //
  // ⚠ 调这个工具**不会自动弹出面板**（那是被否掉的第二版设计）。
  // 它做的是"把入口递到学习者手边"，打开与否由学习者决定。
  //
  // ═══ 它只写一个信号，不取题、不判分 ═══
  // 因为它与面板**不在同一棵树里**（本工具在 agent preset 作用域，
  // 面板在 profile/host 作用域），内存信号传不过去——
  // 所以用文件做会合点（见 `signal.js` 的注释）。
  // 面板的卡片**点的时候**会读这个信号，好知道"agent 请了几道题、哪个题库"。
  // 真正的取题与判分仍由面板走 HTTP 路由完成，判分口径依旧只有一处实现。
  ctx.tools.register({
    name: 'start_practice',
    description:
      '在学习者的对话里放一张**「开始刷题」卡片**（学习者点它才打开刷题面板）。' +
      '学习者说"我想刷题""开始刷题""练几道"这类意思时调用它。' +
      '这个工具不取题、不判分，**也不会自动弹出面板**——它只是把入口放进对话里。' +
      '如果你只想取一两道题在对话里问，用 get_questions 而不是这个。' +
      '\n\n【调用之后必须做的两件事】' +
      '1. 告诉学习者"**点上面的卡片开始**"。' +
      '2. **主动说明你能改卡片的样子**，并举例说出你能调什么，' +
      '例如"如果这张卡片看着别扭，告诉我，我能改：配色（强调色/底色）、字号大小、' +
      '圆角与边框、文字与按钮的排布、卡片上预览几道题、面板宽度，也能只保留标题和按钮"。' +
      '可以让他先用着，再按需要调。' +
      '\n\n【学习者提出样式偏好时怎么改】' +
      '**再调一次这个工具**，把偏好写进 style —— 那会在对话里**多出一张应用了新样式的新卡片**，' +
      '旧卡片保持原样（方便对比）。**不需要重启任何东西**，改完立刻生效：' +
      '学习者刷新页面后新卡片还是新样式（样式随那次调用一起留在会话里）。' +
      '如果他说不出具体想要什么，就用你判断合适的语义档先给一版，再问他要不要调。' +
      '写错的值不会让调用失败——返回值里的 style_ignored 会说明哪一项没被接受，据此纠正后可以再调一次。' +
      '\n\n可用的键：' + describeStyleVocabulary() + '。' +
      '推荐优先用**语义档**（如 accent:"focus"、font_scale:"large"），它们跟随主题，' +
      '深浅色模式下都正确；想精确指定颜色也可以用 "#rrggbb"（文字色会按背景自动配，不会看不见）。' +
      '示例：{"accent":"focus","font_scale":"large","preview_questions":3}',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        bank_name: { type: 'string', description: '要刷的题库名。省略则面板用工作区里的第一个题库。' },
        count: { type: 'integer', description: '一次出几道（1 或 5 之类）。省略则由学习者在面板里选。' },
        // ── 选择：这次要刷**哪些题** ──
        //
        // ⚠ 这一组是 2026-09-19 补上的。在此之前 `start_practice` **没有表达"选择"的词汇**，
        // 于是"只练错题""重刷做过的"无处可传，卡片只能表示"某个题库"=整个题库。
        // 作者的反馈："我说'给我 10 题'或'我想重刷做过的题目'，弹出的卡片依然是
        // 49 题的全题库……而不能呈现出 10 道题或是仅有错题的卡片。"
        order: {
          type: 'string',
          enum: ORDER_KINDS,
          description:
            '出哪些题（**把学习者的说法映射到这里**）：' +
            ORDER_KINDS.map((k) => `${k}=${ORDER_HINTS[k]}`).join('；') +
            '。省略=按题库原顺序（面板里仍可再选）。',
        },
        topic: {
          type: 'string',
          description:
            '只出某个知识点的题（**把学习者的说法映射到这里**）。写法取自封闭词表——' +
            `题型：${describeTopicVocabulary().types}；领域：${describeTopicVocabulary().domains}。` +
            '词表外的写法会被归一化（如"主旨概括"→"中心理解"）；完全认不出的会如实回报为"没有匹配的题"。' +
            '⚠ 目前题库里**只有一部分题**打了知识点标签，所以按知识点出题会比整库出得少——这是正常的，不是出错。',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            '只出**这些题**（题目 id）。学习者指定"就做刚才那几道"时用；给了 ids 就忽略 order。' +
            '省略 count 时会自动按 ids 的道数取。',
        },
        style: {
          type: 'object',
          description:
            '卡片与面板的外观意图。省略则全部用默认。' +
            '可用键：' + describeStyleVocabulary() + '。' +
            '示例：{"accent":"focus","font_scale":"large","preview_questions":3}',
          additionalProperties: true,
          properties: {
            accent: {
              type: 'string',
              description: '强调色（左边条与主按钮）：' + STYLE_TOKENS.accent.join('/') + '，或 "#rrggbb"',
            },
            background: { type: 'string', description: '底色：' + STYLE_TOKENS.background.join('/') },
            font_scale: { type: 'string', description: '字号与留白：' + STYLE_TOKENS.font_scale.join('/') },
            radius: { type: 'string', description: '框体圆角：' + STYLE_TOKENS.radius.join('/') },
            border: { type: 'string', description: '框体边框：' + STYLE_TOKENS.border.join('/') },
            layout: { type: 'string', description: '卡片内文字与按钮的排布：' + STYLE_TOKENS.layout.join('/') },
            preview_questions: {
              type: 'integer',
              description: `卡片上预览几道题（${STYLE_NUMBERS.preview_questions.min}-${STYLE_NUMBERS.preview_questions.max}，0 = 不预览）`,
            },
            panel_width: {
              type: 'integer',
              description: `面板宽度像素（${STYLE_NUMBERS.panel_width.min}-${STYLE_NUMBERS.panel_width.max}）`,
            },
            accent_color: { type: 'string', description: '自定义强调色 "#rrggbb"（会覆盖 accent）' },
            background_color: { type: 'string', description: '自定义底色 "#rrggbb"' },
            text_color: { type: 'string', description: '自定义文字色 "#rrggbb"（一般不用给）' },
            show: {
              type: 'array',
              description: '卡片上显示哪些信息：' + SHOW_ITEMS.join('/'),
              items: { type: 'string' },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['opened', 'signal_seq', 'bank_count', 'banks'],
        properties: {
          opened: { type: 'boolean', description: '是否已请求打开面板' },
          signal_seq: { type: 'integer', description: '启动信号的序号（面板据此判断是否是新请求）' },
          bank_count: { type: 'integer', description: '工作区里可用的题库数' },
          banks: {
            type: 'array',
            description: '可用题库名，便于告诉学习者有哪些可刷',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'question_count'],
              properties: {
                name: { type: 'string' },
                question_count: { type: 'integer' },
              },
            },
          },
          chosen_bank: {
            description: '实际会用的题库名；找不到匹配项时为 null（面板会用第一个）',
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
          style_applied: {
            description: '实际生效的外观（人话描述）；没给 style 时是"全部用默认外观"',
            type: 'string',
          },
          style_ignored: {
            description: '被忽略的外观项及原因（空数组表示全部接受）。据此纠正后可以再调一次。',
            type: 'array',
            items: { type: 'string' },
          },
          selection_applied: {
            description: '本次卡片代表的选择（人话，如"只出**做过的** · 10 道"）；务必照它向学习者复述一遍',
            type: 'string',
          },
          selection_ignored: {
            description: '被忽略的选择项及原因（空数组表示全部接受）。据此纠正后可以再调一次。',
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          value.opened
            ? '已把「开始刷题」卡片放进对话。**请学习者点那张卡片**，面板才会打开。'
            : '卡片没能放到对话里（界面可能没在运行）。',
        ]
        if (value.chosen_bank) lines.push(`题库：${value.chosen_bank}`)
        // 选择：**先说这一条**，因为它是学习者最在意的一句
        // （"我说了只练错题，卡片上写的是什么"）。
        if (value.selection_applied) lines.push(`这次刷：${value.selection_applied}`)
        if (Array.isArray(value.selection_ignored) && value.selection_ignored.length > 0) {
          lines.push(`选择里这几项没被接受（已忽略）：${value.selection_ignored.join('；')}`)
        }
        if (value.bank_count === 0) {
          lines.push('（注意：工作区里还没有题库，打开后会是空的。）')
        } else if (value.bank_count > 1) {
          lines.push(`可选题库：${value.banks.map((b) => `${b.name}(${b.question_count})`).join('、')}`)
        }
        // 外观：**如实回报**。生效的与没被接受的都要说——
        // 模型写错字段名时，静默忽略会让它一直重复同一个错写法。
        if (value.style_applied) lines.push(`卡片外观：${value.style_applied}`)
        if (Array.isArray(value.style_ignored) && value.style_ignored.length > 0) {
          lines.push(`外观里这几项没被接受（已忽略）：${value.style_ignored.join('；')}`)
        }
        lines.push('', '面板打开后浮在界面右侧（**可以拖动**），学习者可以随时关掉它。')
        // 卡片路径**不保证一定渲染**：key 写错时宿主只静默不渲染（`tool.call.toolview` 的既有语义）。
        // 所以这里也把"卡没出现时怎么办"写清楚，让 agent 有话可说——
        // 否则学习者看到的就是"它说放了卡片，可是什么都没有"。
        lines.push(
          '⚠ 若学习者说**没看到卡片**：先让他看界面右下角（卡片没注册成功时那里会出现一个刷题入口按钮）；' +
            '两条都没有，就用 `get_questions` 在对话里带他做，同时如实告诉他"这次不会留下作答记录"。',
        )
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
        throw new Error('拿不到工作区路径（session.header.cwd）')
      }

      const { banks } = listQuestionBanks({ workspaceRoot })
      const wanted = typeof args?.bank_name === 'string' ? args.bank_name.trim() : ''

      // 只做**精确匹配**，不做模糊匹配（理由是"选错题库不可恢复"，见 requireBank 的注释）。
      // 名字给不对时不报错——面板会用第一个题库，而返回值里列出了全部可选项，
      // agent 因而能自己纠正并告诉学习者。
      const chosen = wanted === '' ? null : (banks.find((b) => b.name === wanted)?.name ?? null)

      // 外观：**先归一化再写信号**（见 style.js）。
      // 归一化放在这个工具里、而不是放在客户端，理由是纠错回路：
      // 这里是唯一能把"哪一项没被接受"回给 agent 的地方。
      // 客户端只负责把已经合法的值画出来，不做校验——两处各管一件事。
      const { style, ignored } = sanitizeCardStyle(args?.style)

      // 选择：同一套做法（先归一化再写信号），见 practice.js 的 sanitizeSelection。
      //
      // ⚠ 传的是**整个 args**，不是挑出来的三个键：只有这样才能把模型发明的字段名
      // （`only_wrong`）报给它。`ignoreKeys` 里是本工具自己合法的参数名，
      // 免得它们被误报成"不认识的选择字段"。
      const { selection, ignored: selectionIgnored } = sanitizeSelection(args, {
        ignoreKeys: ['bank_name', 'count', 'style'],
      })

      // 指定了 ids 却没给 count 时，**按 ids 的道数取**。
      // 为什么这是对的默认：学习者说"就做这几道"，那"几道"就是他要的数量；
      // 若默认成 1，卡片会写"指定 10 道 · 1 道"这种自相矛盾的话。
      let count = typeof args?.count === 'number' && args.count > 0 ? Math.floor(args.count) : undefined
      if (count === undefined && Array.isArray(selection.ids) && selection.ids.length > 0) {
        count = selection.ids.length
      }

      const signal = requestPracticePanel({
        bank: chosen ?? wanted ?? undefined,
        count,
        by: 'agent',
        style,
        selection,
      })
      trace(
        `START_PRACTICE  seq=${signal.seq} bank=${chosen ?? wanted ?? '-'} banks=${banks.length}` +
          ` style=[${describeCardStyle(style)}] ignored=${ignored.length}` +
          ` sel=[${describeSelection(selection, count)}] sel_ignored=${selectionIgnored.length}`,
      )

      return Promise.resolve({
        opened: true,
        signal_seq: signal.seq,
        bank_count: banks.length,
        banks: banks.map((b) => ({ name: b.name, question_count: b.question_count })),
        chosen_bank: chosen,
        style_applied: describeCardStyle(style),
        style_ignored: ignored,
        selection_applied: describeSelection(selection, count),
        selection_ignored: selectionIgnored,
      })
    },
  })

  // ── 工具：写一条作答备注（**注解**，不是作答的一部分）──
  //
  // 为什么它是独立工具而不是 `submit_answer` 的一个参数：
  //   作答是"某人在某时刻答了这道题"（事件），备注是"**对那次作答的注解**"（资源，ADR-009）。
  //   两者寿命不同：作答写下去就定了；备注可以事后补、可以修正（编辑 = 新备注 + supersedes）。
  //   而且一次作答可以有多条备注（先记思路、事后补反思）。
  //
  // 为什么正文进 `data` 而不进 content_ref：备注是**一句到一段**（≤2000 字），
  //   而"能被记事本打开、能被 grep"是这份日志的本意（ADR-012）。超长才该走资源文件。
  ctx.tools.register({
    name: 'add_note',
    description:
      '给**某一次作答**（或某道题）记一条备注：答题时的思路、或事后反思。' +
      '它是**注解**（lh/resource/note-made），不是作答的一部分——只追加；要改就再记一条并在 supersedes 里指向旧的。' +
      '什么时候该记：学习者自己说出"我为什么选这个 / 我错在哪"，或你要把"他这次是把主旨读成了细节"这类观察落下来时。' +
      '**不要替他编反思**：备注是证据，空着完全正常。' +
      '锚点：优先给 attempt_event_id（submit_answer 的返回值里有，精确到某一次作答）；' +
      '只给 question_id 时挂到题上（跨多次作答累积）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '备注正文（≤2000 字）。' },
        attempt_event_id: { type: 'string', description: '锚到哪一次作答（submit_answer 返回的 attempt_event_id）。给了它就用它做锚点。' },
        question_id: { type: 'string', description: '题目 id。没给 attempt_event_id 时用它做锚点；给了也顺带记下来。' },
        note_kind: {
          type: 'string',
          enum: ['reasoning', 'reflection'],
          description: 'reasoning=答题时的思路；reflection=做后的反思（默认）。两者在教学上不同，别混。',
        },
        author: {
          type: 'string',
          enum: ['user', 'agent'],
          description: '谁写的。学习者说的话填 user（默认）；你自己写的观察填 agent。',
        },
        model: { type: 'string', description: 'author=agent 时填模型型号（如 deepseek-v4.1-flash），便于事后区分是谁的推理。' },
        supersedes: { type: 'string', description: '要取代的旧备注事件 id（编辑时给）。旧的那条仍在日志里，只是不再生效。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['note_event_id', 'target_kind', 'target_id', 'note_kind', 'author'],
        properties: {
          note_event_id: { type: 'string', description: '新建的备注事件 id' },
          target_kind: { type: 'string', description: 'attempt / question' },
          target_id: { type: 'string' },
          note_kind: { type: 'string' },
          author: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `已记一条备注（${value.note_kind}，${value.author}）→ ${value.target_kind}:${value.target_id}\n备注是注解，不进正确率；要改就再记一条并指向它。`,
        },
      ],
    },
    async execute(args, exec) {
      const attemptEventId =
        typeof args?.attempt_event_id === 'string' && args.attempt_event_id.trim() !== '' ? args.attempt_event_id.trim() : null
      const questionId = typeof args?.question_id === 'string' && args.question_id.trim() !== '' ? args.question_id.trim() : null
      if (attemptEventId === null && questionId === null) {
        throw new Error('add_note: 至少要给 attempt_event_id 或 question_id 之一——备注必须锚在某次作答或某道题上')
      }
      const result = recordNote({
        store,
        sessionRef: exec?.agent?.session?.id === undefined ? undefined : String(exec.agent.session.id),
        provenance: PROVENANCE,
        targetKind: attemptEventId === null ? 'question' : 'attempt',
        targetId: attemptEventId ?? questionId,
        text: args?.text,
        author: args?.author === 'agent' ? 'agent' : 'user',
        model: args?.model,
        noteKind: typeof args?.note_kind === 'string' ? args.note_kind : 'reflection',
        questionId,
        supersedes: args?.supersedes,
      })
      trace(`NOTE  kind=${result.data.note_kind}  author=${result.data.author}  target=${result.data.target_kind}:${result.data.target_id}`)
      return {
        note_event_id: result.event.id,
        target_kind: result.data.target_kind,
        target_id: result.data.target_id,
        note_kind: result.data.note_kind,
        author: result.data.author,
      }
    },
  })

  trace('TOOLS_REGISTERED  list_question_banks, get_questions, submit_answer, get_practice_stats, start_practice, add_note')
}
