/**
 * 分题器 —— 以一个"窗口"（若干连续页）为单位，让模型**像人一样整体读**，
 * 输出每一道题的**完整可读文本 + 语义信息 + 分组出处**，再由程序与 OCR 原文对账。
 *
 * ═══ 它服务的设计（作者 2026-09-19 定的三条，逐条对应）═══
 *
 * 1. **模型必须把题目文本重新输出一遍，这是"校验"的解法。**
 *    OCR 没有"接收修改意见"的接口，也没法回头改像素；所以"模型读出来的文本"
 *    就是唯一可用的反馈通道。它和 OCR 原文一比，差异即证据：
 *    · 逐字差异（错字/丢字/多字）→ OCR 识别问题；
 *    · 结构差异（一句话被栏边界切断/行序错乱）→ 阅读顺序问题。
 *    因此**题目文本以模型输出为准，OCR 原文降为校验基准**（同 ADR-018 决定 4 的分工）。
 *
 * 2. **分组（套 / 章节 / 专题）是语义，归模型；它同时是题目要记的出处。**
 *    程序不认识"第几套""哪一专题"，所以这类标签只能由模型给，
 *    并作为 `group` 落进题库，供刷完之后溯源（"这是练习题03的第7题"）。
 *
 * 3. **页码是程序级语义，不需要模型识别。**
 *    喂进去时页码就是**锚**（`───── 第 3 页 ─────`），模型只需在输出里引用它。
 *
 * ═══ 重叠窗口不是浪费，是**独立复核** ═══
 * 同一道题出现在两个窗口里 → 两次独立的读法，可以互相印证：
 * 一致 = 共识；不一致 = 标为"没读准"，进人工复核清单。
 * （作者担心过重复输入的 token 成本；在这个用途下它买到的是一次免费复核。）
 *
 * ═══ 纯函数与网络调用分开 ═══
 * 校验逻辑（`verifyExtraction`）是**纯函数**，可离线测、可复现；
 * 调模型的部分只负责"发窗口、收 JSON"。
 *
 * 用法:
 *   # 1) 只切窗、不调模型（看窗口表对不对）
 *   node scripts/extract-questions.mjs plan --ocr data/ocr/align解析上 --pages-per-set 14
 *
 *   # 2) 真跑（先小规模）
 *   $env:XIAOMI_TOKEN_PLAN_AMS_API_KEY = (…)
 *   node scripts/extract-questions.mjs run --ocr data/ocr/align解析上 --sets 1 --concurrency 2
 *
 *   # 3) 只看校验器（用已有产物，不花钱）
 *   node scripts/extract-questions.mjs verify --ocr … --result data/extract/set01.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 知识点词表从**插件**里取，而不是在这里手写第二份：
// 手写的那份会和 `topics.js` 漂移，而漂移的表现是"模型按旧词表挑、归一化又认不出"——
// 两边互相矛盾，模型开始瞎猜（同 ADR-026 决定 6）。
import { describeTopicVocabulary, normalizeTopics } from '../plugins/lh-question-bank/topics.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const mode = argv[0] ?? 'plan'

/**
 * 取 `--名字=值` 形式的参数。
 *
 * @param name - 参数名。
 * @param fallback - 缺省值。
 * @returns 值。
 */
function arg(name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

// ══════════════════════════════════════════════════════════════════════════
// 第一部分：确定性锚 —— 从 OCR 页里认出"套头"与"题号"
// ══════════════════════════════════════════════════════════════════════════

/**
 * 套头（分组标签）的正则。
 *
 * ⚠ "套"字**必须可选**——这是 `align_by_question.py` 踩过的坑，照抄过来：
 *   片段阅读的套头是 `练习题01套`（带"套"字）；
 *   逻辑判断的套头是 `练习题01`（**不带**，页眉只有编号）。
 * 只认带"套"字的，逻辑判断的套号就识别不出来，而每套题号都从 1 重启 ——
 * 去重会把后面的套整批删掉，且"第 1 套恰好 20 题"会让结果**看起来完全正常**。
 */
export const RE_GROUP = /练\s*习\s*题\s*(\d{1,3})\s*套?/g

/** 题号的正则：行首的 `12.` / `12、` / `12 ．`。 */
export const RE_QUESTION_NO = /^\s*(\d{1,3})\s*[.、．]\s*/gm

/**
 * 从一页文本里抽出**分组标签出现**与**题号出现**。
 *
 * 这两样都是**程序能确定性拿到**的东西，用途是给模型一个约束与一个对账基准：
 *   · 分组标签 → 告诉模型"这一窗属于哪一套"，并要求它复述（复述错就说明它读错了）；
 *   · 题号计数 → 与模型报出来的题数对账（数量对不上就说明它漏题或幻觉了）。
 *
 * ═══ 为什么必须对账（实测的教训）═══
 * 目录页上**一道题都没有**，而模型在那页上"抽出"了 15 道不存在的题。
 * 只信模型自己的话，目录会变成 15 道幽灵题；而它们**不会报错**，只会污染题库。
 *
 * @param text - 该页的 OCR 文本。
 * @returns `{ groups, questionNumbers }`。
 */
export function scanPageAnchors(text) {
  const groups = [...String(text ?? '').matchAll(RE_GROUP)].map((m) => `练习题${m[1]}`)
  const questionNumbers = [...String(text ?? '').matchAll(RE_QUESTION_NO)].map((m) => Number(m[1]))
  return {
    // 同一页上重复出现的页眉只算一次
    groups: [...new Set(groups)],
    questionNumbers: [...new Set(questionNumbers)],
  }
}

/**
 * 把 OCR 页切成窗口。
 *
 * ═══ 切法的三层（按优先级）═══
 * 1. **分组锚**（套/章节/专题，印在页面上）：它是语义边界，**不落在题目中间**；
 * 2. **题数预算**：一窗最多装几道题（程序用题号正则数得出来，不需要模型参与）。
 *    这一层是实测逼出来的：逻辑判断每套 16 页，而它的题干是多段材料，
 *    一窗 20 题的输出会顶到 16k 上限被截断 —— 截断的表现是"最后一题少半截"，
 *    而它**不报错**，只会静默丢内容。
 * 3. **跨页保护**：题不会超过 `maxQuestionPages` 页（作者给的先验），
 *    所以下一窗要**回退 `maxQuestionPages - 1` 页**再开始，否则跨页的题会被切碎。
 *    回退那一页不是浪费：它同时是下一窗的上文。
 *
 * ═══ 为什么不"按套一刀切" ═══
 * 组页数实测差得很远（题本 6 页/套、逻辑判断解析 16 页/套），一刀切必然要么
 * 在密的那份上截断、要么在疏的那份上浪费。所以**组边界是优先切割点，题数是硬上限**。
 *
 * @param params.pages - `[{ page, text }]`。
 * @param params.maxQuestionsPerWindow - 一窗最多几题（按程序数出来的题号）。
 * @param params.maxQuestionPages - 先验：一道题最多占几页（跨页保护用）。
 * @returns `[{ from, to, pages, group, groupSource, questionCount }]`。
 */
export function planWindows({ pages, maxQuestionsPerWindow = 14, maxQuestionPages = 1 }) {
  const info = pages.map((p) => {
    const a = scanPageAnchors(p.text)
    return { page: p.page, text: p.text, groups: a.groups, questions: a.questionNumbers.length }
  })

  const windows = []
  let i = 0
  const back = Math.max(0, maxQuestionPages - 1)

  while (i < info.length) {
    // 这一窗从哪一页开始：当前页（**不跳过任何页**）
    const startIdx = i
    let endIdx = startIdx
    let count = info[startIdx].questions
    const groupAt = (idx) => {
      const g = info[idx].groups
      return g.length > 0 ? g[g.length - 1] : null
    }
    let group = groupAt(startIdx)

    // 往后吃页，直到"再加一页就会超过题数预算"或"跨进了下一个分组"
    while (endIdx + 1 < info.length) {
      const next = info[endIdx + 1]
      const nextGroup = groupAt(endIdx + 1)
      const wouldBe = count + next.questions
      // ① 跨分组：组边界是更好的切割点，先切在这里
      if (nextGroup !== null && group !== null && nextGroup !== group) break
      // ② 题数预算
      if (count > 0 && wouldBe > maxQuestionsPerWindow) break
      endIdx += 1
      count = wouldBe
      if (group === null) group = nextGroup
    }

    const slice = info.slice(startIdx, endIdx + 1)
    windows.push({
      from: slice[0].page,
      to: slice[slice.length - 1].page,
      group,
      groupSource: group === null ? 'none' : 'page-anchor',
      questionCount: count,
      pages: slice.map((p) => ({ page: p.page, text: p.text })),
    })

    // ③ 下一窗的起点：回退 `maxQuestionPages - 1` 页做跨页保护
    const next = endIdx + 1 - back
    i = next > startIdx ? next : endIdx + 1
  }

  return windows
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：校验器 —— 模型输出 vs OCR 原文（纯函数）
// ══════════════════════════════════════════════════════════════════════════

/** 归一化：去掉空白与常见标点差异，只留实义字符（比对用）。 */
export function normalizeForCompare(text) {
  return String(text ?? '')
    .replace(/\s+/gu, '')
    .replace(/[，。、；：？！“”‘’（）《》【】…—·,.;:?!'"()[\]<>_]/gu, '')
    .toLowerCase()
}

/**
 * 最长公共子序列的长度（用于算"编辑相似度"）。
 *
 * 为什么不用简单的"包含判断"：模型输出与 OCR 的差异往往是**局部**的
 * （一个错字、一处丢字、一段被栏切断），包含判断只会给出"不包含"这一个比特，
 * 而我们需要的是"**差了多少**"——好逐题设阈值、并把最像的那几题挑出来给人看。
 *
 * @param a - 字符串 A。
 * @param b - 字符串 B。
 * @returns LCS 长度。
 */
export function lcsLength(a, b) {
  const s = String(a ?? '')
  const t = String(b ?? '')
  if (s === '' || t === '') return 0
  // 只保留两行，避免 O(n*m) 的内存；题目文本量级（几百字）下够用
  let prev = new Uint32Array(t.length + 1)
  let cur = new Uint32Array(t.length + 1)
  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = s[i - 1] === t[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const tmp = prev
    prev = cur
    cur = tmp
    cur.fill(0)
  }
  return prev[t.length]
}

/**
 * 逐题校验：模型读出来的题，与 OCR 原文对得上吗？
 *
 * ═══ 它回答三个不同的问题（不要混成一个分数）═══
 * 1. **文本保真**：模型输出的题干在 OCR 原文里能找到多少（相似度）。
 *    低 = 它改写/概括了（那是错的：我们要的是它**读**出来的，不是它**总结**的）。
 * 2. **边界可信**：题号在模型输出里有没有、与程序扫到的题号对得上吗。
 * 3. **数量对账**：模型报出的题数 vs 程序在该窗口扫到的题号数。
 *    对不上就是漏题或幻觉（目录页那次实测就是这一条抓出来的）。
 *
 * ⚠ 刻意**不**给一个"总分"：三个问题要采取的行动完全不同
 * （相似度低要去查 OCR；数量不对要去查提示词或窗口切法）。
 * 合成一个分数会让它们在同一个数字里互相掩盖。
 *
 * @param params.window - `{ from, to, group, pages }`。
 * @param params.questions - 模型输出的题数组。
 * @returns `{ ok, report, items }`。
 */
export function verifyExtraction({ window, questions }) {
  const rawText = window.pages.map((p) => p.text).join('\n')
  const normalizedRaw = normalizeForCompare(rawText)
  const anchors = window.pages.map((p) => scanPageAnchors(p.text))
  // 程序扫到的题号集合（窗口内所有页的并集）
  const programNumbers = new Set(anchors.flatMap((a) => a.questionNumbers))

  const items = []
  for (const q of Array.isArray(questions) ? questions : []) {
    const stem = normalizeForCompare(q.stem ?? q.source_text ?? '')
    const opts = normalizeForCompare((q.options ?? []).map((o) => (typeof o === 'string' ? o : o?.text ?? '')).join(''))
    const text = stem + opts
    // 相似度：LCS / 模型输出长度（问的是"它输出里有几成来自原文"）
    const sim = text.length === 0 ? 0 : lcsLength(text, normalizedRaw) / text.length
    const hasNumber = q.number !== null && q.number !== undefined && String(q.number).trim() !== ''
    const numberSeenByProgram = hasNumber && programNumbers.has(Number(q.number))
    items.push({
      number: q.number ?? null,
      group: q.group ?? null,
      page: q.page ?? null,
      // 答案与文本要留在 items 里：跨窗口复核（`crossCheck`）靠它比"两次读法一不一致"，
      // 而复核往往在**产物落盘之后**才做（`verify` 子命令只读产物）。
      // 第一版没留，于是 `verify` 拿不到答案，只能报"未给"——等于复核失效。
      answer: q.my_answer ?? null,
      stemLength: String(q.stem ?? '').length,
      contentSimilarity: Number(sim.toFixed(3)),
      hasNumber,
      numberSeenByProgram,
      // 模型自己说"这段我读不准"时，一定要带上——那是最有价值的信号
      unsure: q.unsure === true ? String(q.unsure_reason ?? '模型标了不确定') : null,
    })
  }

  const countMismatch = items.length - programNumbers.size
  const lowSim = items.filter((x) => x.contentSimilarity < 0.9)
  const unknownNumbers = items.filter((x) => x.hasNumber && !x.numberSeenByProgram)
  const unsure = items.filter((x) => x.unsure !== null)

  // 知识点过词表：**认不出的如实回报**（那是词表该扩的证据，不是错误）。
  // 这里只报，不改写——改写发生在入库那一步（`normalizeTopics` 会给出规范名）。
  const unmappedTopics = []
  for (const q of Array.isArray(questions) ? questions : []) {
    const { unmapped } = normalizeTopics(q.topics)
    for (const t of unmapped) if (!unmappedTopics.includes(t)) unmappedTopics.push(t)
  }

  const report = {
    window: `${window.from}-${window.to}`,
    group: window.group,
    groupSource: window.groupSource,
    modelQuestions: items.length,
    programNumbers: programNumbers.size,
    programNumberList: [...programNumbers].sort((a, b) => a - b),
    countMismatch,
    lowSimilarity: lowSim.map((x) => ({ number: x.number, similarity: x.contentSimilarity })),
    // 题号带上页码：只报题号时不看不出"它把这题放到了哪一页"，
    // 而页码正是我们要落库的出处锚（见文件头第 3 条）。
    numbersNotSeenByProgram: unknownNumbers.map((x) => ({ number: x.number, page: x.page })),
    // 模型自报的"这题我读不准"也要带页码 + 理由，否则人工复核时得回去翻整窗
    unsureItems: unsure.map((x) => ({ number: x.number, page: x.page, reason: x.unsure })),
    unsureCount: unsure.length,
    /** 词表认不出的知识点（**不是错误**，是词表该扩的证据） */
    unmappedTopics,
    /** 三道关全过才算"这一窗可信"。 */
    ok: countMismatch === 0 && lowSim.length === 0 && unknownNumbers.length === 0 && unsure.length === 0,
  }
  return { ok: report.ok, report, items }
}

/**
 * 跨窗口复核：同一道题在多个窗口里各读了一次，两次一致吗？
 *
 * ═══ 这是重叠窗口买到的唯一东西 ═══
 * 所以它必须真的被算出来并报出来，否则重叠就只是白花的 token。
 * 判据用 `(group, number)` 作键（**不是页码**：跨页的题在不同窗口里页码不同）。
 *
 * @param allItems - 各窗口 items 的扁平数组，每项需带 `window`。
 * @returns `{ total, agreed, disagreed, details }`。
 */
export function crossCheck(allItems) {
  const byKey = new Map()
  for (const it of allItems) {
    const key = `${it.group ?? '?'}|${it.number ?? '?'}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(it)
  }
  const details = []
  let agreed = 0
  let disagreed = 0
  for (const [key, list] of byKey) {
    if (list.length < 2) continue
    const answers = new Set(list.map((x) => x.answer ?? '(未给)'))
    const sims = list.map((x) => x.contentSimilarity)
    const sameAnswer = answers.size === 1
    const simSpread = Math.max(...sims) - Math.min(...sims)
    if (sameAnswer && simSpread < 0.1) agreed += 1
    else {
      disagreed += 1
      details.push({ key, answers: [...answers], sims, windows: list.map((x) => x.window) })
    }
  }
  return { total: agreed + disagreed, agreed, disagreed, details }
}

// ══════════════════════════════════════════════════════════════════════════
// 第三部分：调模型（只负责"发窗口、收 JSON"）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 渲染一个窗口的提示词。
 *
 * ═══ 只输出一遍（作者 2026-09-19 明确）═══
 * 模型读题、顺手把 OCR 的错字与断行修正掉、**直接输出成品结构化题目**。
 * 不再要求它"先照抄一遍供对账"——那是多余的：它的读法本身就是产物。
 *
 * ═══ 提示词的其余纪律（每条都有来历）═══
 * - **页码由我们给（锚），它只引用**：页码是程序级语义，不需要模型识别；
 * - **分组标签要求它给出并复述**：套/章节/专题是语义（程序不认识），
 *   且它与程序扫到的锚互为校验；
 * - **允许它说"我读不准"**：比硬猜有用得多（同 ADR-021 决定 1 的空位处置）；
 * - **不许把题干缩写成摘要**：修正错字可以，改写/概括不行——那会让题库里
 *   的题干不再是"原题"。
 *
 * @param window - `{ from, to, group, pages }`。
 * @returns 提示词文本。
 */
export function buildWindowPrompt(window) {
  const body = window.pages.map((p) => `───── 第 ${p.page} 页 ─────\n${p.text}`).join('\n\n')
  const programGroups = [...new Set(window.pages.flatMap((p) => scanPageAnchors(p.text).groups))]
  return `下面是一份公考行测题集**连续若干页的 OCR 文本**。它是扫描件的识别结果：可能有错字、可能丢字，也可能因为双栏排版而**行序错乱**。页码是我标好的锚，你不必判断页码。

${body}

请你**像人一样整体阅读**这些页，把里面出现的**每一道题**抽成结构化的题目。

【怎么处理 OCR 的错误】
- 你读出来的就是成品：**遇到明显的识别错误（错字、多字、断行、栏边界把句子切断），按你的理解修正后输出**。
- 但**只做修正，不要改写或概括**：题干要是原题的文字，不能变成摘要。
- 修不了的地方（整段乱到读不出意思）**不要猜**：照原样输出，设「unsure」为 true，
  并在「unsure_reason」里说清是哪一段、为什么。**宁可标出来，也不要编。**

【另外三件事】
1. **分组**：题集按"套/章节/专题"分组（页面上印的形如「练习题03套」）。给每道题填上它属于哪一组——
   这是要跟着题目一起入库的出处信息。这几页里我扫到的分组标签是：${programGroups.length > 0 ? programGroups.join('、') : '(这一窗没扫到)'}
   请以你读到的为准；不一致时在「group_note」里说明。
2. **题号与页码**：题号用页面上印的（形如「12.」）；页码填这道题**开始**的那一页。
3. **知识点只能从下面的词表里挑**（它是给下游统计用的，自己造词会污染判断）：
   题型：${describeTopicVocabulary().types}
   领域：${describeTopicVocabulary().domains}
   ⚠ **题干里出现的内容词不算知识点**（"纳米金属""相声""教育"这类是题目**在讲什么**），
   知识点回答的是"这题考你**哪种能力**"。词表里没有合适的就填空数组，**不要自己造词**。
4. **你自己做一遍**：每题给出你的答案与一句理由。

【输出】只输出 JSON，不要解释文字：
{"questions":[{
  "group":"练习题03",
  "number":"12",
  "page":3,
  "stem":"…修正后的题干…",
  "options":[{"label":"A","text":"…"},{"label":"B","text":"…"},{"label":"C","text":"…"},{"label":"D","text":"…"}],
  "my_answer":"A|B|C|D",
  "my_reasoning":"…",
  "question_type":"…",
  "topics":["…"],
  "difficulty_hint":"易|中|难",
  "unsure":false,
  "unsure_reason":"",
  "group_note":""
}]}`
}

/**
 * 调一次窗口。
 *
 * @param params.apiKey - 密钥。
 * @param params.baseUrl - API 根。
 * @param params.model - 模型名。
 * @param params.window - 窗口。
 * @returns `{ questions, usage, ms }`。
 */
async function callWindow({ apiKey, baseUrl, model, window }) {
  const t0 = Date.now()
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildWindowPrompt(window) }],
      temperature: 0,
      // 一窗最多约 20 题、每题几百字 → 给足，但不要夸张到掩盖"这题出问题了"
      max_tokens: 16000,
      response_format: { type: 'json_object' },
    }),
  })
  const bodyText = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 200)}`)
  const body = JSON.parse(bodyText)
  const text = body.choices?.[0]?.message?.content ?? ''
  const finish = body.choices?.[0]?.finish_reason
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`回复不是合法 JSON（finish=${finish}，前 120 字：${text.slice(0, 120)}）`)
  }
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
  return { questions, usage: body.usage ?? {}, ms: Date.now() - t0, finish, raw: text }
}

// ══════════════════════════════════════════════════════════════════════════
// 第四部分：命令
// ══════════════════════════════════════════════════════════════════════════

/**
 * 读 OCR 目录里的页。
 *
 * @param dir - OCR 目录。
 * @returns `[{ page, text }]`（按页码排序）。
 */
function loadPages(dir) {
  const files = readdirSync(dir).filter((f) => /^page-\d+\.json$/.test(f))
  const pages = files.map((f) => {
    const payload = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    return { page: payload.page, text: payload.text ?? '' }
  })
  pages.sort((a, b) => a.page - b.page)
  return pages
}

const ocrDir = resolve(repoRoot, arg('ocr', 'data/ocr/align解析上'))
if (!existsSync(ocrDir)) {
  console.error(`OCR 目录不存在：${ocrDir}`)
  process.exit(2)
}
const pages = loadPages(ocrDir)

if (mode === 'plan') {
  const options = {
    maxQuestionsPerWindow: Number(arg('max-questions', '14')),
    maxQuestionPages: Number(arg('max-question-pages', '1')),
  }
  const windows = planWindows({ pages, ...options })
  console.log(`OCR 目录 ${ocrDir}，共 ${pages.length} 页`)
  console.log(`切窗参数：一窗最多 ${options.maxQuestionsPerWindow} 题；跨页保护回退 ${Math.max(0, options.maxQuestionPages - 1)} 页\n`)
  console.log('窗口表：')
  for (const w of windows) {
    const nums = new Set(w.pages.flatMap((p) => scanPageAnchors(p.text).questionNumbers))
    console.log(
      `  ${String(w.group ?? '(无分组)').padEnd(12)} 第 ${String(w.from).padStart(3)}–${String(w.to).padEnd(3)} 页 ` +
        `(${String(w.pages.length).padStart(2)} 页, 程序数到 ${String(nums.size).padStart(2)} 个题号)  锚=${w.groupSource}`,
    )
  }
  if (windows.length === 0) console.log('  ⚠ 一个窗口都没切出来')
  const totalQ = windows.reduce((s, w) => s + w.questionCount, 0)
  console.log(`\n共 ${windows.length} 个窗口，程序数到的题号合计 ${totalQ} 个（每窗最多 ${options.maxQuestionsPerWindow} 题）`)
} else if (mode === 'run') {
  const apiKey = process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY
  if (apiKey === undefined || apiKey === '') {
    console.error('缺少 XIAOMI_TOKEN_PLAN_AMS_API_KEY')
    process.exit(2)
  }
  const baseUrl = 'https://token-plan-cn.xiaomimimo.com/v1'
  const model = 'mimo-v2.5-pro'
  const all = planWindows({
    pages,
    maxQuestionsPerWindow: Number(arg('max-questions', '14')),
    maxQuestionPages: Number(arg('max-question-pages', '1')),
  })
  const setsWanted = Number(arg('sets', '1'))
  const windows = all.slice(0, setsWanted)
  const concurrency = Number(arg('concurrency', '2'))
  console.log(`跑 ${windows.length} 个窗口（并发 ${concurrency}），模型 ${model}\n`)

  const results = []
  let tokenIn = 0
  let tokenOut = 0
  let reasoning = 0
  const t0 = Date.now()
  const queue = [...windows]
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const w = queue.shift()
        if (w === undefined) continue
        try {
          const r = await callWindow({ apiKey, baseUrl, model, window: w })
          tokenIn += r.usage.prompt_tokens ?? 0
          tokenOut += r.usage.completion_tokens ?? 0
          reasoning += r.usage.completion_tokens_details?.reasoning_tokens ?? 0
          const v = verifyExtraction({ window: w, questions: r.questions })
          results.push({ window: `${w.from}-${w.to}`, group: w.group, ms: r.ms, usage: r.usage, verify: v.report, items: v.items, questions: r.questions })
          const mark = v.ok ? '✓' : '⚠'
          console.log(
            `  ${mark} ${String(w.group ?? '(无分组)').padEnd(12)} p${w.from}-${w.to}  ${r.questions.length} 题 ` +
              `(程序扫到 ${v.report.programNumbers} 个题号)  ${(r.ms / 1000).toFixed(1)}s  输出 ${r.usage.completion_tokens ?? 0}`,
          )
          if (!v.ok) {
            if (v.report.countMismatch !== 0) console.log(`      数量对不上：差 ${v.report.countMismatch}`)
            if (v.report.lowSimilarity.length > 0) console.log(`      文本保真低的题：${JSON.stringify(v.report.lowSimilarity)}`)
            if (v.report.numbersNotSeenByProgram.length > 0)
              console.log(`      题号程序没扫到：${v.report.numbersNotSeenByProgram.map((x) => `${x.number}(p${x.page})`).join(',')}`)
            if (v.report.unsureCount > 0)
              console.log(`      模型自报读不准：${v.report.unsureItems.map((x) => `#${x.number}(p${x.page}): ${x.reason}`).join(' | ')}`)
            if (v.report.unmappedTopics.length > 0)
              console.log(`      词表外的知识点（未采纳，作为词表该扩的证据）：${v.report.unmappedTopics.join('、')}`)
          }
        } catch (error) {
          console.log(`  ✗ p${w.from}-${w.to}: ${error.message}`)
          results.push({ window: `${w.from}-${w.to}`, group: w.group, error: error.message })
        }
      }
    }),
  )

  const wallMs = Date.now() - t0
  const allItems = results.flatMap((r) => (r.items ?? []).map((x) => ({ ...x, window: r.window })))
  const cross = crossCheck(allItems)
  const total = tokenIn + tokenOut

  console.log(`\n── 汇总 ──`)
  console.log(`  墙钟 ${(wallMs / 1000).toFixed(1)}s`)
  console.log(`  token：输入 ${tokenIn} + 输出 ${tokenOut} = **${total}**（推理 ${reasoning}，占 ${total ? Math.round((reasoning / total) * 100) : 0}%）`)
  console.log(`  校验：${results.filter((r) => r.verify?.ok).length}/${results.length} 个窗口全过`)
  const allUnmapped = [...new Set(results.flatMap((r) => r.verify?.unmappedTopics ?? []))]
  if (allUnmapped.length > 0) {
    console.log(`  词表外的知识点（${allUnmapped.length} 个，未采纳）：${allUnmapped.join('、')}`)
  }
  console.log(`  跨窗口复核：重叠题 ${cross.total} 道，一致 ${cross.agreed}，**不一致 ${cross.disagreed}**`)
  for (const d of cross.details) console.log(`    ✗ ${d.key} 答案 ${d.answers.join(' vs ')}  窗口 ${d.windows.join(', ')}`)

  const outDir = join(repoRoot, 'data', 'extract')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${arg('name', 'probe')}.json`)
  writeFileSync(
    outPath,
    JSON.stringify({ model, ocrDir, ranAt: new Date().toISOString(), wallMs, tokenIn, tokenOut, reasoning, cross, results }, null, 2),
    'utf8',
  )
  console.log(`\n  产物：${outPath}`)
} else if (mode === 'verify') {
  const resultPath = resolve(repoRoot, arg('result', ''))
  if (!existsSync(resultPath)) {
    console.error(`结果文件不存在：${resultPath}`)
    process.exit(2)
  }
  const saved = JSON.parse(readFileSync(resultPath, 'utf8'))
  const items = (saved.results ?? []).flatMap((r) => (r.items ?? []).map((x) => ({ ...x, window: r.window })))
  const cross = crossCheck(items)
  console.log(`只读校验（不花 token）：${resultPath}`)
  console.log(`  窗口 ${saved.results.length} 个，跨窗口复核 ${cross.total} 道（一致 ${cross.agreed} / 不一致 ${cross.disagreed}）`)
  for (const d of cross.details) console.log(`    ✗ ${d.key} 答案 ${d.answers.join(' vs ')}  窗口 ${d.windows.join(', ')}`)
} else {
  console.error(`未知模式：${mode}（可用：plan / run / verify）`)
  process.exit(2)
}
