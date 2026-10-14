/**
 * 题库的对象层 —— 题目与题库的 schema、id 派生、校验、归一化。
 *
 * ═══ 本文件是纯函数层 ═══
 * 不碰宿主、不碰事件日志、不碰文件系统（除了显式传入的路径）。
 * 于是它可以被独立测试——实测真实数据之前，schema 的正确性不该依赖 dsh 在跑。
 * 这是 `lh-resource-indexer/scan.js` 已经用过一次的分层，有效。
 *
 * ═══ 设计依据 ═══
 * `docs/archive/decisions/017`：题目是**资源**（可寻址可复用的产物），作答是**事件**（一次性行为）。
 * 本文件只管前者。
 */

import { createHash } from 'node:crypto'
import { normalizeTopics } from './topics.js'

/** 题型。`other` 是显式兜底——遇到无法归类的题型如实标注，不丢题、不强行归类。 */
export const QUESTION_KINDS = ['single_choice', 'multiple_choice', 'fill_blank', 'other']

/** 题库文件的格式版本。只做加法：加字段可以，改语义要升版本。 */
export const BANK_SCHEMA_VERSION = 1

/**
 * 把一段文本压成适合做指纹的形式。
 *
 * 为什么要压：OCR 的同一道题可能差一个空格、一个全角/半角标点，
 * 而这些都是"同一道题"的噪声。压掉空白、统一标点后，指纹才稳定。
 *
 * 导出它是为了**让自测能检查边界**：测试必须用生产这份压缩逻辑，
 * 而不是另抄一份——抄的那份会和这里漂移，于是测的是副本而非本体。
 *
 * @param text - 原始文本。
 * @returns 压缩后的文本。
 */
export function fingerprintStem(text) {
  return String(text ?? '')
    .replace(/\s+/g, '') // 所有空白
    .replace(/[，。、；：？！“”‘’（）《》]/g, (ch) => {
      // 全角标点映射到半角，避免全角/半角差异造成不同指纹
      const map = { '，': ',', '。': '.', '、': ',', '；': ';', '：': ':', '？': '?', '！': '!', '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(', '）': ')', '《': '<', '》': '>' }
      return map[ch] ?? ch
    })
}

/**
 * 派生一道题的稳定 id。
 *
 * ═══ 为什么不用顺序号 ═══
 * `id: 1` 在不同资料里都指第 1 题；重新导入一次就可能全部错位。**顺序号不是身份。**
 *
 * ═══ 为什么是"出处 + 源编号 + 题干指纹"三者 ═══
 * - 出处 + 源编号：让**同一道题从同一份资料里总是得到同一个 id**（幂等重导）；
 * - 题干指纹：有些题集的编号本身会漂移（重排版、合并分册），
 *   加指纹后编号漂移不会让同一道题变成两道。
 * 单独用任何一个都不够：只用内容哈希则 OCR 差一个空格就变 id；
 * 只用出处编号则重排版就全部错位。
 *
 * @param params.sourceRoot - 资料根路径。
 * @param params.sourceFile - 资料内文件路径（相对根）。
 * @param params.number - 资料内的题号。
 * @param params.stem - 题干。
 * @returns 形如 `q-1a2b3c4d5e6f` 的稳定 id。
 */
export function deriveQuestionId({ sourceRoot, sourceFile, number, stem }) {
  const canonical = [
    String(sourceRoot ?? ''),
    String(sourceFile ?? ''),
    number === undefined || number === null ? '' : String(number),
    fingerprintStem(stem).slice(0, 40),
  ].join('|')
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return `q-${digest.slice(0, 12)}`
}

/**
 * 把答案切分成若干"答案项"。
 *
 * `'A,C'` / `'A、C'` / `['A','C']` → `['A','C']`。
 *
 * @param raw - 原始答案。
 * @returns 切分后的字符串数组（未做去空白以外加工）。
 */
function splitAnswer(raw) {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter((v) => v !== '')
  }
  const text = String(raw ?? '').trim()
  if (text === '') return []
  return text.split(/[,，、;；\s]+/).filter((p) => p !== '')
}

/**
 * 归一化答案（**依赖题型**）。
 *
 * ═══ 为什么统一成"数组" ═══
 * 单选与多选共用一套结构，**下游不必为题型分叉**。题型信息留在 `kind` 里。
 *
 * ═══ 为什么必须知道题型：连写不做拆分 ═══
 * `'AB'` 在选择题里是"选 A 和 B"，在填空题里可能就是答案字符串 "AB"。
 * 同一个输入，两种解释。所以拆分**只对选择题生效**——
 * 归一化不能脱离题型独立进行，这不是设计缺陷，是数据本身有歧义。
 *
 * ═══ 它接受什么 ═══
 * - 选择题：`'A'`、`'A,C'`、`'A、C'`、`'AC'`、`['A','C']`
 * - 填空题/其他：整段文本原样作为一个答案项，**只在显式分隔符处切分**
 *
 * @param raw - 原始答案。
 * @param kind - 题型（可选；缺省按"不拆连写"处理，即最保守的解释）。
 * @returns 归一化后的字符串数组；无法解析时返回空数组（由校验报错，不在这里猜）。
 */
export function normalizeAnswer(raw, kind) {
  const hasExplicitSeparator =
    !Array.isArray(raw) && /[,，、;；\s]/.test(String(raw ?? '').trim())

  // 有显式分隔符 → 无论题型，切分都是安全的（用户明确写了分隔）
  if (hasExplicitSeparator) return splitAnswer(raw)

  // 无分隔符：只有选择题才允许把 'AC' 拆成 ['A','C']
  if (kind === 'single_choice' || kind === 'multiple_choice') {
    const text = Array.isArray(raw) ? raw.join('') : String(raw ?? '').trim()
    if (/^[A-Za-z]{2,}$/.test(text)) return text.toUpperCase().split('')
  }

  return splitAnswer(raw)
}

/**
 * 校验并规范化一道题。
 *
 * ═══ 校验的立场：报错，不猜 ═══
 * 缺题干、答案无法解析这类问题**必须抛出**，而不是补一个默认值悄悄跑下去。
 * 理由：题库是下游一切判断的输入，一道静默错误的题会污染断言与策略评估，
 * 而那种污染在事后极难发现（与坐标记录器"写一个坏坐标比不写更糟"同一个道理）。
 *
 * @param params.raw - 原始题目对象（可能来自人工录入、抽取插件或文件）。
 * @param params.origin - 出处信息 `{ sourceRoot, sourceFile, number?, page? }`。
 * @param params.provenance - 产出它的插件 id + 版本（+ 可选 model）。
 * @returns 规范化后的题目对象。
 * @throws 当必填字段缺失或无法解析时。
 */
export function normalizeQuestion({ raw, origin, provenance }) {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('normalizeQuestion: 题目必须是对象')
  }

  const stem = typeof raw.stem === 'string' ? raw.stem.trim() : ''
  if (stem === '') {
    throw new Error(`normalizeQuestion: 缺题干（来源 ${origin?.sourceFile ?? '?'} 第 ${origin?.number ?? '?'} 题）`)
  }

  const kind = QUESTION_KINDS.includes(raw.kind) ? raw.kind : inferKind(raw)
  const options = Array.isArray(raw.options)
    ? raw.options.map((o) => String(o).trim()).filter((o) => o !== '')
    : []
  const answer = normalizeAnswer(raw.answer, kind)
  if (answer.length === 0) {
    throw new Error(`normalizeQuestion: 答案无法解析（题干前 30 字：${stem.slice(0, 30)}）`)
  }

  // 选择题的答案必须是选项标签（A/B/C...），且落在选项数量内——这是能机械查出的错误
  if (kind === 'single_choice' || kind === 'multiple_choice') {
    const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').slice(0, options.length)
    const bad = answer.filter((a) => !labels.includes(a.toUpperCase()))
    if (bad.length > 0) {
      throw new Error(
        `normalizeQuestion: 答案 ${JSON.stringify(bad)} 不是有效选项标签（该题有 ${options.length} 个选项：${labels.join('/')}）`,
      )
    }
  }
  if (kind === 'single_choice' && answer.length > 1) {
    throw new Error(`normalizeQuestion: 单选题有 ${answer.length} 个答案（${answer.join('/')}）`)
  }

  const number = origin?.number
  const id =
    typeof raw.id === 'string' && raw.id !== ''
      ? raw.id
      : deriveQuestionId({ sourceRoot: origin?.sourceRoot, sourceFile: origin?.sourceFile, number, stem })

  const isChoice = kind === 'single_choice' || kind === 'multiple_choice'

  // ═══ 知识点：过封闭词表 ═══
  //
  // 这里**不再原样存下传进来的字符串**（那是第一版的行为）。
  // 理由见 `docs/archive/decisions/021` 结论六/七：自由标签会把"题型/领域/内容词"
  // 混进同一个字段，于是断言层永远说不清"他弱在哪"。
  //
  // ⚠ 认不出的标签**不在这里丢弃，也不在这里报错**——它由 `normalizeQuestionList`
  //   汇总后如实回报给调用方（进 `unmapped_topics`）。在这里丢掉就等于
  //   让词表永远不知道它缺了什么，而那是最不该发生的一种静默。
  const { topics, unmapped } = normalizeTopics(raw.topics)

  return {
    id,
    kind,
    stem,
    options,
    // 选择题的答案统一大写，便于比对；填空保留原样
    answer: isChoice ? answer.map((a) => a.toUpperCase()) : answer,
    // ═══ 其他可接受的答案 ═══
    // 填空题天然多解（"42" / "四十二" / "42人" 都对），标准答案只是其中一种写法。
    // 不表达这一点，"判对错"就会把一个答对的人判错——而那会直接污染学习者模型。
    // `answer` 仍是**标准答案**（人看的时候只该看到这一个），`accept` 是判分时的全集。
    accept: Array.isArray(raw.accept)
      ? raw.accept.flatMap((v) => normalizeAnswer(v, kind)).map((a) => (isChoice ? a.toUpperCase() : a))
      : [],
    analysis: typeof raw.analysis === 'string' ? raw.analysis.trim() : '',
    // 知识点：**封闭词表里的规范名**（题型在前、领域在后）。
    // 空数组仍是合法状态（契约 §4.3：允许没有知识点），但"有标签却一个都没认出来"
    // 与"本来就没有标签"是两件事，后者才该是空数组。
    topics,
    // 认不出的标签如实带着走，由上层汇总（读细：下游可以只看 topics，也可以看这个）
    unmapped_topics: unmapped,
    source: {
      resource_ref: origin?.resourceRef ?? null,
      path: origin?.sourceFile ?? null,
      number: number ?? null,
      page: origin?.page ?? null,
    },
    provenance: { ...(provenance ?? {}) },
  }
}

/**
 * 推断题型（当原始数据没有 `kind` 时）。
 *
 * 只做**能机械判定**的推断：有选项 → 选择题；有选项且答案显式写了多项 → 多选；
 * 没选项 → 填空。它不会返回 `other`——`other` 只能由数据显式声明。
 *
 * 注意这里**不拆连写**：`'AC'` 到底是"选 A 和 B"还是答案文本 "AC"，
 * 正是推断题型时还不知道的事。所以只在有显式分隔符时才判为多选；
 * 连写的 `'AC'` 保守地当单选处理（答案数组留作 `['AC']`，
 * 会被 `normalizeQuestion` 的选项标签校验拦下并报错，交给人修正）。
 *
 * @param raw - 原始题目对象。
 * @returns 题型。
 */
function inferKind(raw) {
  const hasOptions = Array.isArray(raw.options) && raw.options.length > 0
  if (!hasOptions) return 'fill_blank'
  const answers = normalizeAnswer(raw.answer, 'fill_blank') // 传填空 = 禁止拆连写
  return answers.length > 1 ? 'multiple_choice' : 'single_choice'
}

/**
 * 批量规范化，逐题收集错误而不是遇错即停。
 *
 * 为什么不在第一题就抛：抽取一批题时，"哪几道有问题"比"第一道有问题"有用得多——
 * 前者能让人判断是整体质量问题还是个例。
 *
 * ═══ 同时汇总"认不出的知识点标签" ═══
 * 这不是错误，是**词表该扩的证据清单**（`docs/archive/decisions/021` 结论七）。
 * 它必须一路传到调用方，不能在批处理里被吞掉——
 * 吞掉之后的表现是"题都进库了，但知识点永远是空的"，而那不会报错。
 *
 * @param params.rawList - 原始题目数组。
 * @param params.origin - 出处（整批共用）。
 * @param params.provenance - 产出者。
 * @returns `{ questions, errors, unmappedTopics }`；errors 每项含 `{ index, message }`。
 */
export function normalizeQuestionList({ rawList, origin, provenance }) {
  const questions = []
  const errors = []
  const unmappedTopics = []
  const list = Array.isArray(rawList) ? rawList : []
  for (let i = 0; i < list.length; i += 1) {
    // 若某题自带 number 就用它（抽取结果通常带源题号），否则用批内序号
    const perItemOrigin = { ...origin, number: list[i]?.number ?? origin?.number ?? i + 1 }
    try {
      const q = normalizeQuestion({ raw: list[i], origin: perItemOrigin, provenance })
      questions.push(q)
      for (const label of q.unmapped_topics) {
        if (!unmappedTopics.includes(label)) unmappedTopics.push(label)
      }
    } catch (error) {
      errors.push({ index: i, message: error?.message ?? String(error) })
    }
  }
  return { questions, errors, unmappedTopics }
}

/**
 * 组装题库对象（写入文件前的最终形态）。
 *
 * @param params.questions - 已规范化的题目数组。
 * @param params.meta - `{ title, sourceRoot, generatedAt, provenance }`。
 * @returns 题库对象。
 */
export function buildBank({ questions, meta }) {
  // 同 id 去重：同一批里出现重复 id 说明出处+编号+指纹撞了，或来源本身有重复题
  const seen = new Map()
  const duplicates = []
  for (const q of questions) {
    if (seen.has(q.id)) duplicates.push(q.id)
    else seen.set(q.id, q)
  }

  return {
    schema_version: BANK_SCHEMA_VERSION,
    title: meta?.title ?? '题库',
    source_root: meta?.sourceRoot ?? null,
    generated_at: meta?.generatedAt ?? new Date().toISOString(),
    provenance: { ...(meta?.provenance ?? {}) },
    question_count: seen.size,
    // 重复的 id 如实报告，不静默去重——"同一批里有重复"本身是质量信号
    duplicate_ids: duplicates,
    questions: [...seen.values()],
  }
}

/**
 * 校验一个题库对象（读回时用，防 schema 漂移）。
 *
 * @param bank - 题库对象。
 * @returns `{ ok, errors }`。
 */
export function validateBank(bank) {
  const errors = []
  if (bank === null || typeof bank !== 'object') return { ok: false, errors: ['题库不是对象'] }
  if (bank.schema_version !== BANK_SCHEMA_VERSION) {
    errors.push(`schema_version 是 ${bank.schema_version}，本版期望 ${BANK_SCHEMA_VERSION}`)
  }
  if (!Array.isArray(bank.questions)) {
    errors.push('缺 questions 数组')
    return { ok: false, errors }
  }
  const ids = new Set()
  bank.questions.forEach((q, i) => {
    if (typeof q?.id !== 'string' || q.id === '') errors.push(`第 ${i} 题缺 id`)
    else if (ids.has(q.id)) errors.push(`第 ${i} 题 id 重复：${q.id}`)
    else ids.add(q.id)
    if (typeof q?.stem !== 'string' || q.stem === '') errors.push(`第 ${i} 题缺题干`)
    if (!Array.isArray(q?.answer) || q.answer.length === 0) errors.push(`第 ${i} 题缺答案`)
    if (q?.accept !== undefined && !Array.isArray(q.accept)) errors.push(`第 ${i} 题 accept 不是数组`)
    if (!QUESTION_KINDS.includes(q?.kind)) errors.push(`第 ${i} 题题型非法：${q?.kind}`)
  })
  if (bank.question_count !== undefined && bank.question_count !== bank.questions.length) {
    errors.push(`question_count（${bank.question_count}）与实际题数（${bank.questions.length}）不符`)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 从题库里取若干题（给后续的出题/复习用）。
 *
 * @param params.bank - 题库对象。
 * @param params.ids - 要取的题目 id。
 * @returns 找到的题目数组（找不到的跳过）。
 */
export function pickQuestions({ bank, ids }) {
  const byId = new Map((bank?.questions ?? []).map((q) => [q.id, q]))
  return ids.map((id) => byId.get(id)).filter((q) => q !== undefined)
}
