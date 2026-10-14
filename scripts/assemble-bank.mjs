/**
 * 合并入库 —— 把**模型读出的题干**与**规则抽出的官方答案/讲解**对齐成题库，再交给 `import_questions`。
 *
 * ═══ 两边各自负责什么（这是本文件存在的全部理由）═══
 * | 侧 | 谁做 | 产出 |
 * |---|---|---|
 * | 题本 | **模型**（`extract-questions.mjs`）：整体读页、修正 OCR 错字与断行 | 题干 / 选项 / 分组 / 页码 / 它自己的作答 |
 * | 解析 | **规则**（`extract_answers.py`，已有链）：抽 `【参考答案】` / 题型 / 实战解析 | 官方答案 / 讲解 / 置信度 |
 *
 * **为什么题干归模型、答案归规则**：
 *   · 题干要"读对"，而双栏串行与断行是规则链切不好的（实测 20 题里 17 题选项评注全丢）；
 *   · 答案要"不可编造"，而 `【参考答案】C` 是印出来的、规则抽得既准又可复现
 *     （`extract_answers.py` 自己写的判断：*规则可复现、零成本、可审计*）。
 *   所以：**模型答案绝不进判分路径**（ADR-021 决定 3 的红线），它只用来做交叉验证。
 *
 * ═══ 对齐用两道保险 ═══
 * 1. **分组 + 题内号**（确定性键，两边都印在页面上）；
 * 2. **模型独立作答 vs 官方答案**：一致 = 互相印证；不一致 = 进复核清单。
 *    这一道是规则链给不出的（它只能验"文字对上了没有"，验不出"对上的是不是这题"）。
 *
 * ═══ 它不做什么 ═══
 * - **不调模型**（纯读产物 + 合并）；
 * - **不改上游产物**；
 * - **不直接写工作区**：产出题库文件到 `--out`，入库由 `import_questions` 那条路走
 *   （那样才会有 `lh/resource/questions-imported` 事件与稳定 id）。
 *
 * 用法:
 *   node scripts/assemble-bank.mjs \
 *     --questions data/extract/probe-tiben.json \
 *     --answers   data/align/set01-02-run2/extracted.json \
 *     --bank-name '考公刷题-片段阅读-第1册' \
 *     --out data/extract/bank-片段阅读-上-1-2套.json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 用插件自己的对象层：id 派生、校验、题库组装都只该有一处实现。
// 抄一份 = 两套规则，而 id 一旦漂移，已有的作答记录就全部失联（question.js 的注释）。
import { normalizeQuestionList, buildBank, fingerprintStem } from '../plugins/lh-question-bank/question.js'
import { canonicalTopic } from '../plugins/lh-question-bank/topics.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/**
 * 取 `--名字 值` / `--名字=值` 两种写法都要支持。
 *
 * ⚠ 第一版只支持 `=`，于是 `--ocr data/...` 被**静默忽略**、退回默认值——
 * 而那表现成"跑出来的结果是另一份资料的"，极难察觉。所以这里两种都收，
 * 并且对必须的参数做存在性检查。
 *
 * @param name - 参数名。
 * @param fallback - 缺省值。
 * @returns 值。
 */
function arg(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq !== undefined) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1]
  return fallback
}

const questionsPath = resolve(repoRoot, arg('questions', ''))
const answersPath = resolve(repoRoot, arg('answers', ''))
const outPath = resolve(repoRoot, arg('out', 'data/extract/bank-merged.json'))
const bankName = arg('bank-name', '考公刷题-片段阅读')
const sourceRoot = arg('source-root', 'D:\\考公资料')
const sourceFile = arg('source-file', '片段阅读600题/2025年花生片段阅读600题-题本【上】.pdf')
/** 解析每套占几页（该资料的目录印着：第 1 套 p1、第 2 套 p15 → 每套 14 页）。 */
const answerPagesPerSet = Number(arg('answer-pages-per-set', '14'))

for (const [p, label] of [
  [questionsPath, '--questions'],
  [answersPath, '--answers'],
]) {
  if (!existsSync(p)) {
    console.error(`参数 ${label} 指向的文件不存在：${p}`)
    process.exit(2)
  }
}

// ── 读两边产物 ──────────────────────────────────────────────────────────────
const extracted = JSON.parse(readFileSync(questionsPath, 'utf8'))
const answersDoc = JSON.parse(readFileSync(answersPath, 'utf8'))

/** 模型读出的题（跨窗口扁平化 + 去重）。 */
const modelQuestions = []
const seen = new Set()
for (const w of extracted.results ?? []) {
  for (const q of w.questions ?? []) {
    const key = `${q.group ?? '?'}|${q.number ?? '?'}`
    if (seen.has(key)) continue
    seen.add(key)
    modelQuestions.push({ ...q, window: w.window })
  }
}

/**
 * 官方答案索引：`set|no` → item。
 *
 * ⚠ 字段名是 `set` / `no`，**不是** `set` / `question_no`，也没有 `answer_page`
 * （第一版按猜的名字取，于是"解析侧只有 2 条记录"、40 道全被拒——
 *  而它不报错，只表现成"一道都对不上"）。所以这里对每个字段都做了存在性判断。
 */
const answerIndex = new Map()
const answerWarnings = []
for (const item of answersDoc.items ?? []) {
  const set = Number(item.set)
  const no = Number(item.no)
  if (!Number.isFinite(set) || !Number.isFinite(no)) {
    answerWarnings.push(`解析产物里有一条缺 set/no：${JSON.stringify(item).slice(0, 80)}`)
    continue
  }
  const key = `${set}|${no}`
  if (answerIndex.has(key)) {
    answerWarnings.push(`${key} 在解析产物里出现两次，取先出现的`)
    continue
  }
  answerIndex.set(key, item)
}

/** 模型的套名（`练习题01`）→ 套号（1）。 */
function setFromGroupName(group) {
  const m = /(\d{1,3})/.exec(String(group ?? ''))
  return m === null ? null : Number(m[1])
}

/**
 * 把解析侧的字段拼成一段可读的讲解。
 *
 * ═══ 为什么不是只放 `analysis` ═══
 * 解析产物里最有教学价值的是**选项评注**（"A 缺主题词、B 无中生有、D 片面"），
 * 它和正文是分开的字段。旧链里这部分 20 题丢了 17 题，正是栏式排版造成的；
 * 现在既然抽到了，就该让它出现在学习者看得到的地方，而不是躺在 JSON 里。
 *
 * **结构化字段仍然留在 `provenance` 里**（原样），这里只做投影——
 * 想按"哪个选项错在哪"做统计时，读 provenance，不用解析这段文本。
 *
 * @param official - 解析产物里的一条（可能不存在）。
 * @returns 讲解文本；没有任何内容时返回空串（**不编造**）。
 */
function renderAnalysis(official) {
  if (official === undefined || official === null) return ''
  const parts = []
  const analysis = typeof official.analysis === 'string' ? official.analysis.trim() : ''
  if (analysis !== '') parts.push(analysis)
  const notes = Array.isArray(official.option_notes) ? official.option_notes : []
  if (notes.length > 0) {
    parts.push(
      '【各选项评注】\n' +
        notes
          .map((n) => (typeof n === 'string' ? n : `${n.label ?? '?'}. ${n.note ?? n.text ?? ''}`))
          .join('\n'),
    )
  }
  if (typeof official.question_type === 'string' && official.question_type !== '') {
    parts.push(`【题型】${official.question_type}`)
  }
  return parts.join('\n\n')
}

// ── 合并 ────────────────────────────────────────────────────────────────────
const merged = []
const unmatchedModel = []
const officialVsModel = []
/** 题号（全局唯一）→ 出处信息；`normalizeQuestion` 之后按 id 回填进题库对象。 */
const sourceNotes = new Map()

for (const q of modelQuestions) {
  const set = setFromGroupName(q.group)
  const key = `${set}|${Number(q.number)}`
  const official = set === null ? undefined : answerIndex.get(key)
  const officialAnswer = official?.answer?.[0] ?? null
  const myAnswer = q.my_answer ?? null

  officialVsModel.push({
    key,
    group: q.group,
    number: q.number,
    page: q.page,
    modelAnswer: myAnswer,
    officialAnswer,
    agree: officialAnswer !== null && myAnswer !== null ? officialAnswer === myAnswer : null,
    confidence: official?.confidence ?? 'none',
  })

  if (official === undefined) {
    unmatchedModel.push({ key, group: q.group, number: q.number, reason: '解析侧没有对应的答案记录' })
  }

  merged.push({
    number: `${q.group ?? 'set?'}-q${q.number ?? '?'}`,
    kind: 'single_choice',
    stem: String(q.stem ?? '').trim(),
    options: (q.options ?? []).map((o) => (typeof o === 'string' ? o : o.text)),
    // ⚠ **答案只能来自解析侧**（规则抽的 `【参考答案】`）。
    // 模型自己的作答绝不进这个字段——ADR-021 决定 3 的红线：
    // 让模型答案参与判分，会出现"学习者答对了却被判错"，而学习者无从察觉。
    answer: officialAnswer,
    // 讲解：解析的正文 + 选项评注 + 题型。**为什么要把评注拼进来**：
    // 那是这份资料最有教学价值的部分（"A 缺主题词、B 无中生有"），
    // 而它正是被栏式排版打散、旧链 20 题里丢了 17 题的东西。
    analysis: renderAnalysis(official),
    topics: q.topics,
  })

  // ═══ 出处：**在 normalizeQuestion 之后按 id 回填**（2026-09-20 修）═══
  //
  // 为什么不能直接塞进 raw：`normalizeQuestion` 只搬它认识的字段
  // （stem/options/answer/analysis/topics/source），其余一概丢掉；
  // 而 `provenance` 用的是**传进去的参数**，所以塞进 raw 的那份同样被覆盖。
  // 结果不是报错，而是"题库里查不到这题是哪一套的"——静默丢信息。
  //
  // 修法：先把**两道声明的 `number` 换成全局唯一的**（`练习题01-q8`），
  // 于是 `deriveQuestionId` 用到的键天然带上分组（这同时解决了
  // "每套题号从 1 重启、两份资料都印 set1-q1" 那个撞车问题），
  // 再用同一个 number 作键把出处回填进题库对象。
  merged[merged.length - 1].number = `${q.group ?? 'set?'}-q${q.number ?? '?'}`
  sourceNotes.set(merged[merged.length - 1].number, {
    group: q.group ?? null,
    group_source: 'llm-read',
    question_page: q.page ?? null,
    window: q.window,
    answers_from: 'rule:【参考答案】+双信号校验',
    answer_confidence: official?.confidence ?? 'none',
    answer_confidence_basis: official?.confidence_basis ?? null,
    answer_mention: official?.mention_text ?? null,
    question_type: official?.question_type ?? null,
    option_notes: official?.option_notes ?? null,
    wrong_option_notes: official?.wrong_option_notes ?? null,
    analysis_chars: official?.analysis_chars ?? null,
    analysis_is_placeholder: official?.analysis_is_placeholder ?? null,
    model_self_answer: myAnswer,
    model_self_reasoning: q.my_reasoning ?? null,
    llm_unsure: q.unsure === true,
    llm_unsure_reason: q.unsure_reason ?? null,
  })
}

// ── 用插件自己的校验与组装（不自己写一份）──────────────────────────────────
const provenance = {
  plugin: '@lh/extractor',
  version: '0.1.0',
  method: 'llm-read-stem + rule-extract-answer',
  source_answer_file: answersDoc.answer_file ?? null,
}
const { questions, errors, unmappedTopics } = normalizeQuestionList({
  rawList: merged,
  origin: { sourceRoot, sourceFile },
  provenance,
})

const bank = buildBank({
  questions,
  meta: { title: bankName, sourceRoot, generatedAt: new Date().toISOString(), provenance },
})

// ═══ 回填出处（按题号；`number` 已经是全局唯一的 `练习题01-q8` 形态）═══
//
// 用同一个 `number` 作键，是因为 `deriveQuestionId` 用的正是它——
// 于是"id 与出处"绑在同一把钥匙上，不会出现"题 id 变了但出处没跟着变"。
let notesFilled = 0
let notesMissing = 0
bank.questions = bank.questions.map((q) => {
  const note = sourceNotes.get(String(q.source?.number ?? ''))
  if (note === undefined) {
    notesMissing += 1
    return q
  }
  notesFilled += 1
  return { ...q, provenance: { ...q.provenance, ...note } }
})

// ── 报告 ────────────────────────────────────────────────────────────────────
const withAnswer = questions.filter((q) => Array.isArray(q.answer) && q.answer.length > 0).length
const withAnalysis = questions.filter((q) => q.analysis !== '').length
const withTopics = questions.filter((q) => q.topics.length > 0).length
const judged = officialVsModel.filter((x) => x.agree !== null)
const agreed = judged.filter((x) => x.agree === true)
const disagreed = judged.filter((x) => x.agree === false)

console.log(`模型读出的题：${modelQuestions.length} 道（去重后）`)
console.log(`解析侧的答案记录：${answerIndex.size} 条`)
console.log(`\n合并结果：`)
console.log(`  通过校验：${questions.length} 道（被拒 ${errors.length}）`)
console.log(`  有官方答案：${withAnswer}    有讲解：${withAnalysis}    有知识点：${withTopics}`)
console.log(`  出处回填：${notesFilled} 道成功${notesMissing > 0 ? `，**${notesMissing} 道没回填上**（那说明题号键对不上）` : ''}`)
console.log(`\n交叉验证（模型独立作答 vs 官方答案）：`)
console.log(`  可比对 ${judged.length} 道，一致 ${agreed.length}，**不一致 ${disagreed.length}**`)
for (const d of disagreed) {
  console.log(`    ✗ ${d.key} ${d.group} 第${d.number}题（题本p${d.page}）模型=${d.modelAnswer} 官方=${d.officialAnswer} 解析置信度=${d.confidence}`)
}
const lowConf = officialVsModel.filter((x) => x.confidence === 'low' || x.confidence === 'none')
if (lowConf.length > 0) {
  console.log(`\n解析侧置信度低/无的题（${lowConf.length} 道）：`)
  for (const x of lowConf) console.log(`    ${x.key} ${x.group} 第${x.number}题 置信度=${x.confidence} 官方=${x.officialAnswer ?? '(无)'}`)
}
if (unmatchedModel.length > 0) {
  console.log(`\n模型读到了但解析侧没答案的题（${unmatchedModel.length} 道）：`)
  for (const u of unmatchedModel.slice(0, 10)) console.log(`    ${u.key} —— ${u.reason}`)
}
if (unmappedTopics.length > 0) {
  console.log(`\n词表外的知识点（${unmappedTopics.length} 个，未写入题目）：${unmappedTopics.join('、')}`)
}
if (errors.length > 0) {
  console.log(`\n被拒的题：`)
  for (const e of errors.slice(0, 10)) console.log(`    [${e.index}] ${e.message}`)
}
if (answerWarnings.length > 0) {
  console.log(`\n解析侧的重复键警告：${answerWarnings.slice(0, 5).join('；')}`)
}

// 知识点分布（一眼看出"按知识点出题"能不能用）
const topicCount = new Map()
for (const q of questions) for (const t of q.topics) topicCount.set(t, (topicCount.get(t) ?? 0) + 1)
if (topicCount.size > 0) {
  console.log(`\n知识点分布：`)
  for (const [t, n] of [...topicCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${t}  ${n} 道`)
}

writeFileSync(
  outPath,
  JSON.stringify(
    {
      bank,
      report: {
        questionsFile: questionsPath,
        answersFile: answersPath,
        modelQuestions: modelQuestions.length,
        answerRecords: answerIndex.size,
        accepted: questions.length,
        rejected: errors.length,
        withAnswer,
        withAnalysis,
        crossCheck: { judged: judged.length, agreed: agreed.length, disagreed },
        unmappedTopics,
        unmatchedModel,
        answerPagesPerSet,
      },
    },
    null,
    2,
  ),
  'utf8',
)
console.log(`\n题库写入：${outPath}`)
