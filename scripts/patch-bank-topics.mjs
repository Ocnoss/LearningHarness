/**
 * 把试点里**已经跑出来的**知识点补进工作区题库。
 *
 * ═══ 为什么需要它 ═══
 * 工作区那份题库是从脚本直接落盘的，**从未经过 `import_questions`**：
 * 事件流里没有它的 `lh/resource/questions-imported`，`topics` 全是空数组，
 * 而 provenance 指向一个不存在的 `@lh/extractor`。
 *
 * 而 `data/pilot-llm-preprocess.json` 里**已经有**模型产出的 `meta.topics`。
 * 那是一笔已经付过钱的资产，接上它比重新跑一次划算。
 *
 * ═══ ⚠ 匹配键：为什么不能用题号 ═══
 * 本题库是**两份资料合并**的（`extraction: rule, merged: true`）：
 *
 *   `2025年花生片段阅读600题-题本【上】.pdf`  20 题，题号 set1-q1 … set1-q20
 *   `逻辑判断600题题本篇.pdf`                29 题，题号 set1-q1 … set1-q20 + set2-q1 … set2-q10
 *
 * **两份都有 `set1-q1`，而它们是完全不同的题**。而试点产物里**没有文件出处**
 * （记录只有 `number`；连"哪个模型跑的"都是 2026-09-19 才补上的，见 docs/decisions/021 结论五）。
 *
 * 更糟的是试点产物**本身就是两次运行的合并**：
 *   前一批 20 条跑的是**片段阅读**（题号 set1-q1…q20）
 *   后一批 29 条跑的是**逻辑判断**（题号 set1-q1…q20 + set2-q1…q10）
 * 两批的题号完全重叠而内容完全不同。**按题号匹配会把两份资料的知识点对调。**
 *
 * 所以本脚本的匹配键是**官方答案**：
 * 每条试点记录都带 `official`，而题库每道题都带 `answer`。
 * `(题号, 官方答案)` 这个组合在该题库里**唯一确定一道题**——
 * 它由数据本身提供，不需要我猜哪一批是哪个文件。
 *
 * ═══ 它刻意不做什么 ═══
 * - **不调模型**：纯读文件 + 过词表。不花 token，不需要密钥。
 * - **不改题干/答案/题解**：只动 `topics`（外加一个记录来源的 `topics_provenance`）。
 * - **不做"清理"**：没有"删掉所有不匹配的"这种判据（`WORKFLOW.md §2 规则 4`）；
 *   只按**明确列出的题目 id** 写字段，其余一律不碰。
 * - **不改事件日志**：这条修补的产物写进题库文件与报告里，
 *   而**不伪造一条当年的 import 事件**——补记历史比缺历史更糟。
 *
 * ═══ 纪律（按 WORKFLOW §2 规则 4）═══
 * 1. 默认**只跑报告模式**（列出将改什么、判据是什么、备份在哪）；
 * 2. 加 `--apply` 才真的写；
 * 3. 写之前**自动备份**，备份路径打进报告；
 * 4. **一次只做一件事**：本脚本只补 topics。
 *
 * 用法:
 *   node scripts/patch-bank-topics.mjs                      # 报告模式
 *   node scripts/patch-bank-topics.mjs --apply              # 真写（先备份）
 *   node scripts/patch-bank-topics.mjs --bank <路径> --pilot <路径>
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeTopics } from '../plugins/lh-question-bank/topics.js'
import { loadBank, saveBank } from '../plugins/lh-question-bank/bank.js'
import { workspaceDir } from '../plugins/lh-event-store/paths.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')

/**
 * 取一个 `--名字 值` 形式的参数。
 *
 * @param name - 参数名（不含 `--`）。
 * @param fallback - 缺省值。
 * @returns 值。
 */
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

/**
 * 读文本，按 BOM 判编码（外部文件都可能被别的工具加 BOM，见 PLUGIN_CONTRACT §五）。
 *
 * @param path - 路径。
 * @returns 文本。
 */
function readTextWithBom(path) {
  const buf = readFileSync(path)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le')
  let start = 0
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3
  return buf.slice(start).toString('utf8')
}

/** 把答案数组压成可比对的字符串（`['C']` → `'C'`）。 */
function answerKey(answer) {
  return Array.isArray(answer) ? answer.join('').toUpperCase() : String(answer ?? '').toUpperCase()
}

const workspace = workspaceDir()
if (workspace === null) {
  console.error('找不到工作区（LH_WORKSPACE 环境变量或 lh-install.json 的 workspace 字段）')
  process.exit(2)
}

const bankPath = arg('bank', join(workspace.dir, 'lh-questions', '考公刷题-片段阅读与逻辑判断.json'))
const pilotPath = arg('pilot', join(repoRoot, 'data', 'pilot-llm-preprocess.json'))

for (const p of [bankPath, pilotPath]) {
  if (!existsSync(p)) {
    console.error(`文件不存在：${p}`)
    process.exit(2)
  }
}

console.log(`工作区: ${workspace.dir}（来源：${workspace.source}）`)
console.log(`题库  : ${bankPath}`)
console.log(`试点  : ${pilotPath}`)
console.log(`模式  : ${APPLY ? '**真写**（会先备份）' : '报告模式（只列出将改什么）'}`)

// ── 读题库（用插件自己的读入口，不另写一个解析器）──────────────────────────
const { bank, errors } = loadBank(bankPath)
if (bank === null || errors.length > 0) {
  console.error(`题库读不出或不合格，拒绝继续：\n  ${errors.join('\n  ')}`)
  process.exit(2)
}

// ── 读试点产物 ────────────────────────────────────────────────────────────
const pilot = JSON.parse(readTextWithBom(pilotPath))
const rows = (Array.isArray(pilot.results) ? pilot.results : []).map((r, index) => ({ ...r, index }))
const withTopics = rows.filter((r) => r?.parsed?.meta?.topics !== undefined && r?.parsed?.meta?.topics !== null && r.parsed.meta.topics !== '')

console.log(
  `\n试点记录 ${rows.length} 条（其中带知识点的 ${withTopics.length} 条），覆盖题号 ${new Set(rows.map((r) => r.number)).size} 个` +
    `，其中只有 ${new Set(withTopics.map((r) => r.number)).size} 个题号有知识点`,
)

// ── 建索引：`题号|官方答案` → 记录列表 ─────────────────────────────────────
//
// 这是本脚本的**全部依据**，所以它单独成段、单独报数。
//
// ⚠ 只收 `agree === true` 的记录，这不是"挑好看的"，而是一条**能实测的排除法**：
//   实测 7 条 `agree === false` 的记录，它们的 `题号 + 官方答案` 在题库里**一道题都对不上**
//   （0/7）。也就是说那 7 条的题号与官方答案属于**另一次取题**，
//   拿它们匹配只会匹配到无关的题——而那种错不会报错，只会把知识点写错。
//   把它们排除后，剩下的 38 个键里 32 个唯一、6 个撞车（下面还有第二道防线）。
const byNumberAnswer = new Map()
let droppedDisagree = 0
for (const r of withTopics) {
  if (r.agree !== true) {
    droppedDisagree += 1
    continue
  }
  const key = `${r.number}|${answerKey(r.official)}`
  if (!byNumberAnswer.has(key)) byNumberAnswer.set(key, [])
  byNumberAnswer.get(key).push(r)
}

console.log(`  其中 ${withTopics.length - droppedDisagree} 条标了 agree=true（用于匹配），${droppedDisagree} 条 agree=false（排除：实测它们对不上题库任何一道题）`)

/** 资料名 → 它对应的领域。用来做第二道防线的判据。 */
function fileDomainOf(file) {
  if (file.includes('逻辑判断')) return '逻辑判断'
  if (file.includes('片段阅读')) return '片段阅读'
  return null
}

// ── 逐题匹配 ──────────────────────────────────────────────────────────────
const changes = []
const skipped = []
const allUnmapped = []
let resolvedByDomain = 0
let domainFilteredCount = 0

for (const q of bank.questions) {
  const number = q?.source?.number
  const file = q?.source?.path ?? '(无 path)'
  if (number === null || number === undefined) {
    skipped.push({ id: q.id, why: '这道题没有 source.number，无法匹配' })
    continue
  }
  const key = `${number}|${answerKey(q.answer)}`
  const candidates = byNumberAnswer.get(key) ?? []
  if (candidates.length === 0) {
    skipped.push({
      id: q.id,
      why: `试点里没有「${number} + 官方答案 ${answerKey(q.answer)}」这条记录（${file}）`,
    })
    continue
  }

  // ═══ 第二道防线：用**领域标签**判这条记录属于哪份资料 ═══
  //
  // `题号 + 官方答案` 在两个文件之间会撞车（实测 6 处）：两份资料的题号都从 set1-q1 起，
  // 答案字母分布也相近。但有一条**独立于匹配键**的证据可用：
  // 试点给这题打的领域标签（`片段阅读` / `逻辑判断`）必须与题号所属的书一致。
  //
  // 优先级：**领域相符** > **领域未知**（记录里没给领域）> 领域矛盾（排除）。
  const want = fileDomainOf(file)
  const scored = candidates.map((r) => {
    const nx = normalizeTopics(r.parsed.meta.topics)
    const domains = nx.byAxis.domain
    const score = want !== null && domains.includes(want) ? 2 : domains.length === 0 ? 1 : 0
    return { r, nx, score }
  })
  const best = scored.filter((s) => s.score === 2)

  // ═══ 第三道防线：**撞车时只认"领域相符"，否则一律不写** ═══
  //
  // 这里曾经留过一个"退而取最早一条"的兜底，现在是**故意去掉的**：
  // 实测两个撞车键（`set1-q13|B`、`set1-q19|D`）在两份资料里都成立，
  // 而试点给它们的标签（`语句排序` / `细节判断`）**在两份资料里都可能出现**——
  // 也就是说池子里**没有任何独立证据**能判别属于哪一份。
  // 那种情况下"取最早一条"不是判据，是掷硬币；而掷错的代价是
  // **把知识点写到另一份资料的题上**，不报错、只是全错。
  //
  // 宁可少补几道（它们本来也没有知识点），不可补错。
  if (best.length === 0) {
    domainFilteredCount += 1
    const got = scored.map((s) => s.nx.byAxis.domain.join('/') || '(无领域)').join('、')
    skipped.push({
      id: q.id,
      why: `匹配键「${key}」撞车（${candidates.length} 条记录），而记录的领域都没有一条与这道题的资料（${want ?? file}）相符：${got}`,
    })
    continue
  }

  const chosen = best[0]
  const { topics, unmapped, byAxis } = chosen.nx
  for (const label of unmapped) if (!allUnmapped.includes(label)) allUnmapped.push(label)

  const decides = candidates.length > 1
  let flag = ''
  if (decides) {
    resolvedByDomain += 1
    flag = `⚠ 匹配键「${key}」有 ${candidates.length} 条记录，按**领域标签**（${byAxis.domain.join('/')}）判定为这一条`
  }

  const before = Array.isArray(q.topics) ? q.topics : []
  const same = before.length === topics.length && before.every((t, i) => t === topics[i])
  if (same && before.length > 0) {
    skipped.push({ id: q.id, why: '已经和将写入的一致（幂等）' })
    continue
  }

  changes.push({
    id: q.id,
    file,
    number,
    official: answerKey(q.answer),
    before,
    after: topics,
    raw: chosen.r.parsed.meta.topics,
    unmapped,
    domains: byAxis.domain,
    candidateCount: candidates.length,
    model: chosen.r.model ?? null,
    flag,
  })
}

console.log(`\n题库共 ${bank.questions.length} 道；将由 ${changes.length} 道写入知识点，跳过 ${skipped.length} 道`)
if (resolvedByDomain > 0) {
  console.log(`  其中 ${resolvedByDomain} 道的匹配键撞车，靠**领域标签**判定了归属（每条都有标注）`)
}
if (domainFilteredCount > 0) {
  console.log(`  ${domainFilteredCount} 道因"撞车 + 无独立证据"被拦下（宁可少补，不可补错）`)
}

if (allUnmapped.length > 0) {
  console.log(`\n⚠ 试点标签里有 ${allUnmapped.length} 个不在词表里（**不会写入题目**，作为词表该扩的证据列在这里）：`)
  console.log(`  ${allUnmapped.join('、')}`)
}

console.log('\n--- 将写入的题（判据：`题号 + 官方答案` 在试点里有唯一对应记录）---')
for (const c of changes) {
  console.log(`  ${c.number}  (官方 ${c.official})  ${c.id}`)
  console.log(`    资料: ${c.file}`)
  console.log(`    before: ${c.before.length === 0 ? '(空)' : c.before.join(' / ')}`)
  console.log(`    after : ${c.after.length === 0 ? '(空 —— 该题的标签一个都没认出来)' : c.after.join(' / ')}`)
  console.log(`    模型原话: ${Array.isArray(c.raw) ? c.raw.join(' / ') : c.raw}`)
  if (c.unmapped.length > 0) console.log(`    认不出: ${c.unmapped.join(' / ')}`)
  if (c.flag !== '') console.log(`   ${c.flag}`)
}

console.log('\n--- 跳过的原因分类 ---')
const reasons = new Map()
for (const s of skipped) {
  const kind = s.why.startsWith('试点里没有')
    ? '试点里没有对应记录'
    : s.why.startsWith('已经')
      ? '已经一致（幂等）'
      : s.why.startsWith('匹配键')
        ? '匹配键撞车且无独立证据（拦下，不猜）'
        : s.why
  reasons.set(kind, (reasons.get(kind) ?? 0) + 1)
}
for (const [kind, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)} 道  ${kind}`)
}
const conflicted = skipped.filter((s) => s.why.startsWith('匹配键'))
if (conflicted.length > 0) {
  console.log('\n  被拦下的题（**宁可少补，不可补错**）：')
  for (const s of conflicted) {
    console.log(`    ${s.id}`)
    console.log(`      ${s.why}`)
    if (s.after !== undefined) console.log(`      本来会写成: ${s.after.join(' / ')}`)
  }
  console.log(
    '    真凶是**试点产物没有文件出处**（docs/decisions/021 结论五）：题号在资料内编号（set1-qN），' +
      '\n    两份资料的题号完全重叠，而记录里既没有文件名、也没有题干。' +
      '\n    要让这些题也有知识点，只能重跑一次试点并让脚本记下用的是哪份资料。',
  )
}
if (skipped.some((s) => s.why.startsWith('试点里没有'))) {
  console.log('\n  未匹配的那些题（如实列出，不做任何猜测性补全）：')
  for (const s of skipped.filter((x) => x.why.startsWith('试点里没有'))) console.log(`    ${s.id}  ${s.why}`)
}

// ── 报告模式到此为止 ────────────────────────────────────────────────────
if (!APPLY) {
  console.log('\n这是报告模式，**什么都没改**。确认上面的判据与结果无误后，加 --apply 真写。')
  process.exit(0)
}

if (changes.length === 0) {
  console.log('\n没有需要改的题，不写文件（避免无意义的备份与 mtime 变化）。')
  process.exit(0)
}

// ── 真写：先备份，再原子替换（saveBank 内部就是 .tmp + rename）────────────
const backupDir = join(repoRoot, '.lh-sync-backup', `bank-topics-${Date.now()}`)
mkdirSync(backupDir, { recursive: true })
const backupPath = join(backupDir, basename(bankPath))
copyFileSync(bankPath, backupPath)
console.log(`\n已备份: ${backupPath}`)

const byId = new Map(changes.map((c) => [c.id, c]))
const patched = {
  ...bank,
  questions: bank.questions.map((q) => {
    const c = byId.get(q.id)
    if (c === undefined) return q
    return {
      ...q,
      topics: c.after,
      // 保留原始产出与来源：将来换词表重放时能看到"当初模型说的是什么"，
      // 而不是只剩一个已归一化的结果（可追溯 > 好看）。
      // 出处必须跟着**每道题**走——顶层写一个 model 只能描述"最后写入的那一次运行"。
      topics_provenance: {
        source: 'pilot-llm-preprocess',
        pilot_file: pilotPath,
        matched_by: 'source.number + official answer',
        source_file: c.file,
        model: c.model,
        raw: c.raw,
        unmapped: c.unmapped,
        note: '知识点由 LLM 预处理试点产出，经 plugins/lh-question-bank/topics.js 的封闭词表归一化后写入；题干/选项/答案/题解未改动。',
        applied_at: new Date().toISOString(),
      },
    }
  }),
}

saveBank({ path: bankPath, bank: patched })

// ── 写完立刻用插件的读入口验一遍（不信自己，信读路径）────────────────────
const after = loadBank(bankPath)
if (after.errors.length > 0) {
  console.error(`\n⚠ 写完之后题库读不回，已备份在 ${backupPath}\n  ${after.errors.join('\n  ')}`)
  process.exit(1)
}
const withTopicsAfter = after.bank.questions.filter((q) => Array.isArray(q.topics) && q.topics.length > 0).length
console.log(`写完复核：题库合格，共 ${after.bank.questions.length} 道，其中 ${withTopicsAfter} 道带知识点。`)
console.log(`（回滚：把 ${backupPath} 复制回 ${bankPath}）`)
