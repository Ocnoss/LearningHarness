/**
 * 题库的落盘层 —— 读、写、合并。
 *
 * ═══ 依据 ═══
 * `docs/archive/decisions/018` 决定 2、3：
 *   - 题库以文件形式存在**工作区**（属于学习内容，跟着学习者走）；
 *   - 更新 = 同名重写 + 事件里记 `supersedes`，**文件名不带时间戳**（引用它的路径必须稳定）。
 *
 * ═══ 为什么文件读写单独一层 ═══
 * 与 `question.js`（纯函数）分开的理由是**可测性**：
 * 纯函数层不需要文件系统就能验 schema，这一层才碰盘。
 * 混在一起会让"schema 对不对"的测试也得建临时目录。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildBank, validateBank, BANK_SCHEMA_VERSION } from './question.js'

/** 题库在工作区下的目录名。与 `lh-index/` 平级：都是 LH 在学习者资料旁的产物。 */
export const BANK_DIR_NAME = 'lh-questions'

/** 题库文件扩展名。 */
export const BANK_EXT = '.json'

/**
 * 把字符串安全化成文件名片段。
 *
 * 与 `lh-event-store` 的 `safeFileSegment` 同源思路，但**刻意不复用**：
 * 那个函数服务于"外置内容指针"（要保留扩展名等），这里服务于"用户可读的题库名"，
 * 需求不同（题库名应当允许多少字符是产品决定）。共用会让两边互相牵制。
 *
 * @param name - 用户给的题库名。
 * @returns 可安全作为文件名的片段。
 */
export function safeBankName(name) {
  const cleaned = String(name ?? '')
    .trim()
    // Windows 非法字符 + 路径分隔符
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    // 折叠连续空白与横线
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    // 结尾的点和空格在 Windows 上会被静默吃掉，导致"文件名与预期不符"
    .replace(/[.\s]+$/, '')
    .slice(0, 60)
  return cleaned === '' ? '题库' : cleaned
}

/**
 * 算出一个题库的文件路径。
 *
 * @param params.workspaceRoot - 工作区绝对路径（会话的 cwd）。
 * @param params.bankName - 题库名。
 * @returns 题库文件的绝对路径。
 */
export function resolveBankPath({ workspaceRoot, bankName }) {
  return join(workspaceRoot, BANK_DIR_NAME, `${safeBankName(bankName)}${BANK_EXT}`)
}

/**
 * 读一个题库文件。
 *
 * @param path - 题库文件绝对路径。
 * @returns `{ bank, errors }`；文件不存在时 bank 为 null 且 errors 为空（"还没有"不是错误）。
 */
export function loadBank(path) {
  if (!existsSync(path)) return { bank: null, errors: [] }

  let parsed
  try {
    // 去 BOM：踩过 PowerShell 写 UTF-8 带 BOM 导致 `Unexpected token '﻿'` 的坑。
    // 题库文件是**用户可能手改**的，所以这里必须容忍 BOM。
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    parsed = JSON.parse(text)
  } catch (error) {
    return { bank: null, errors: [`题库文件无法解析：${error?.message ?? String(error)}`] }
  }

  const check = validateBank(parsed)
  // 校验不过仍然把内容交出去：调用方可能想显示"哪里坏了"，
  // 而"读不出来"与"读出来但不合格"是两件事。
  return { bank: parsed, errors: check.ok ? [] : check.errors }
}

/**
 * 写一个题库文件（原子替换）。
 *
 * ═══ 为什么是"临时文件 + rename" ═══
 * 直接 `writeFileSync` 到目标路径时，若进程在写到一半时被中断（重启、崩溃），
 * 文件会变成半截 JSON——**下一次读取会解析失败，于是整个题库看起来消失了**。
 * 先写临时文件再 rename 是原子的：要么是旧的完整内容，要么是新的完整内容。
 * 题库是学习者的资产，不该有"半截"这个状态。
 *
 * @param params.path - 目标路径。
 * @param params.bank - 题库对象。
 * @returns 写入的路径。
 */
export function saveBank({ path, bank }) {
  mkdirSync(dirname(path), { recursive: true })
  const json = JSON.stringify(bank, null, 2)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, json, 'utf8')
  renameSync(tmp, path)
  return path
}

/**
 * 合并新题到一个已有题库（或新建）。
 *
 * ═══ 合并语义：同 id 覆盖，其余保留 ═══
 * 题库会分批导入（先抽了一份，后来又抽一份），所以必须支持追加。
 * 同一 id 出现时以**新的为准**：那通常意味着"这一题被修正了"
 * （抽取插件改进了、或人工改了错字），而旧的那份是错的。
 * 但这不等于静默覆盖——`replaced` 会如实报出被替换的 id。
 *
 * @param params.existing - 已有题库（可为 null）。
 * @param params.questions - 新规范化的题目。
 * @param params.meta - `{ title, sourceRoot, generatedAt, provenance }`。
 * @returns `{ bank, added, replaced }`。
 */
export function mergeIntoBank({ existing, questions, meta }) {
  const byId = new Map()
  for (const q of existing?.questions ?? []) byId.set(q.id, q)

  const added = []
  const replaced = []
  for (const q of questions) {
    if (byId.has(q.id)) replaced.push(q.id)
    else added.push(q.id)
    byId.set(q.id, q)
  }

  const bank = buildBank({
    questions: [...byId.values()],
    meta: {
      title: existing?.title ?? meta?.title ?? '题库',
      sourceRoot: existing?.source_root ?? meta?.sourceRoot ?? null,
      // 重导会刷新 generated_at，但题库**名与路径不变**（ADR-018 决定 3）
      generatedAt: meta?.generatedAt,
      provenance: meta?.provenance,
    },
  })

  return { bank, added, replaced }
}

/**
 * 从 JSON 文本或已解析对象里取出一批题目。
 *
 * 接受三种形态（都是实际会出现的）：
 *   1. 题目数组 `[{...}, {...}]`
 *   2. 题库对象 `{ questions: [...] }`（题库文件本身就是这个形态）
 *   3. 单题对象 `{ stem, ... }`
 *
 * 为什么要容忍这么多：出题来源很杂（抽取插件的产物、人写的 JSON、旧项目的格式），
 * 而**格式适配是机械劳动**，让模型去转格式是浪费它的判断力。
 *
 * @param input - 解析后的 JSON 值。
 * @returns `{ rawList, title }`；认不出来时 rawList 为空数组。
 */
export function extractRawQuestions(input) {
  if (Array.isArray(input)) return { rawList: input, title: null }
  if (input !== null && typeof input === 'object') {
    if (Array.isArray(input.questions)) {
      return { rawList: input.questions, title: typeof input.title === 'string' ? input.title : null }
    }
    if (typeof input.stem === 'string') return { rawList: [input], title: null }
  }
  return { rawList: [], title: null }
}

/**
 * 题库的伴生文件后缀。它们也以 `.json` 结尾，**不是题库**。
 *
 * ═══ 为什么必须显式排除 ═══
 * `build_bank.py` 会在题库旁边产出配套文件（选项评注、抽取报告），
 * 文件名形如 `片段阅读600题.option-notes.json`。
 * 第一版的 `listQuestionBanks` 只判断"以 .json 结尾"，
 * 于是把它们也列成了"题库"——**agent 会看到三个名字很像的选项**，
 * 选错任何一个都会报 `缺少 questions 数组` 之类的错。
 * 实测报错文案里就出现了这三行。
 *
 * 判据用"文件名里含这些后缀"：因为后缀在 `.json` 之前，
 * `entry.endsWith(BANK_EXT)` 拦不住。
 *
 * ⚠ 2026-10-13 **从 `index.js` 下沉到这里**：它们是纯文件/目录层的判断，
 *   而 `index.js` 会拖进 `@lh/model-tier`（模型白名单硬闸）。题库管理面板
 *   （`@lh/question-bank-ui`，profile 行）要用**同一份**判据，如果只能从
 *   `index.js` 取，就得把 `@lh/model-tier` 也拖进界面包——而"界面插件导入不到包
 *   = 整棵插件树加载失败 = dsh 起不来"是本项目最贵的失败形状。
 *   下沉之后，界面只依赖 `bank.js`（→ `question.js` → `topics.js`），依赖链干净。
 */
export const BANK_COMPANION_SUFFIXES = ['.option-notes', '.extract-report', '.preview', '.预览']

/**
 * 这个文件名是题库本体吗（而不是伴生文件）？
 *
 * @param entry - 目录里的文件名。
 * @returns 是题库本体返回 true。
 */
export function isBankFile(entry) {
  if (!entry.endsWith(BANK_EXT)) return false
  const stem = entry.slice(0, -BANK_EXT.length)
  return !BANK_COMPANION_SUFFIXES.some((s) => stem.endsWith(s))
}

/**
 * 列出工作区里有哪些题库。
 *
 * ═══ 为什么这个能力必须有 ═══
 * 没有它，agent 只能靠学习者在对话里说出题库名——而题库名是文件名，
 * 学习者没有理由记得住。实测的心智模型是"我要刷常识判断"，
 * 而文件叫 `行测-常识判断.json`，中间那层映射不该由人来维护。
 *
 * @param params.workspaceRoot - 工作区绝对路径。
 * @returns `{ banks }`，每项 `{ name, path, ok, errors, title, question_count, source_root, generated_at }`。
 */
export function listQuestionBanks({ workspaceRoot }) {
  const dir = join(workspaceRoot, BANK_DIR_NAME)
  if (!existsSync(dir)) return { banks: [] }

  const banks = []
  for (const entry of readdirSync(dir)) {
    if (!isBankFile(entry)) continue
    const path = join(dir, entry)
    const { bank, errors } = loadBank(path)
    const name = entry.slice(0, -BANK_EXT.length)
    banks.push({
      name,
      path,
      // 坏掉的题库仍然列出来，但标注它坏了——隐藏它会让"我的题库去哪了"变成谜
      ok: errors.length === 0,
      errors,
      title: bank?.title ?? name,
      question_count: Array.isArray(bank?.questions) ? bank.questions.length : 0,
      source_root: bank?.source_root ?? null,
      generated_at: bank?.generated_at ?? null,
    })
  }
  banks.sort((a, b) => a.name.localeCompare(b.name))
  return { banks }
}

/**
 * 按名字找一个题库，找不到时**把可选项直接写进错误里**。
 *
 * ═══ 为什么不做模糊匹配 ═══
 * 实测 agent 会把 `片段阅读600题` 说成 `片段阅读`（截断），也会记错名字。
 * 两种修法：
 *   A. 模糊匹配，猜一个最像的 → **危险**：猜错了就是拿另一个题库刷题，
 *      而学习者不会发现（题目看起来都正常）。配对错位的教训刚吃过（ADR-020 决定 1）。
 *   B. 只做**精确匹配**，但失败时把现有题库列出来 → 让 agent（或人）看着真名再调一次。
 *
 * 选 B。理由：**名称错误是可恢复的，选错题库是不可恢复的**——
 * 前者多一轮对话，后者静默污染学习数据。
 *
 * ═══ 为什么错误信息里直接列名字，而不是"请调用 list_question_banks" ═══
 * 实测报错写的是"用 list_question_banks 看有哪些题库"，**而 agent 没有去调，
 * 直接把错误抛给了学习者**。所以指路式的提示不可靠——
 * 把可选项直接写进错误里，agent 不需要额外一步就能自我纠正。
 *
 * @param params.workspaceRoot - 工作区绝对路径。
 * @param params.bankName - 请求的题库名。
 * @returns `{ path, bank }`，其中 `bank` 是**完整题库对象**（含 questions）。
 * @throws 当题库不存在或不合格时（错误信息含可用题库清单与相近名提示）。
 */
export function requireBank({ workspaceRoot, bankName }) {
  const wanted = String(bankName ?? '').trim()
  const { banks } = listQuestionBanks({ workspaceRoot })
  const available = banks.map((b) => b.name)

  const found = banks.find((b) => b.name === wanted)
  if (found === undefined) {
    const parts = [`题库「${wanted}」不存在。`]
    if (available.length === 0) {
      parts.push('当前工作区里还没有任何题库（可能还没录入过题）。')
    } else {
      parts.push(`可用的题库名（请用其中之一原样重试）：${available.map((n) => `「${n}」`).join('、')}`)
      // 相近名提示：只提示，不代替选择
      const near = available.filter((n) => n.includes(wanted) || wanted.includes(n))
      if (near.length > 0) parts.push(`名字相近的有：${near.map((n) => `「${n}」`).join('、')}`)
    }
    throw new Error(parts.join('\n'))
  }

  // ═══ 必须重新读完整内容 ═══
  // ⚠ 这里踩过一个严重的坑：`listQuestionBanks` 返回的是**目录条目**
  // （只有 name/path/ok/question_count/title），**没有 `questions` 数组**。
  // 第一版直接把那个条目当成题库对象返回，于是 getQuestions 与 recordAttempt
  // 拿到的是 `{name, path, ok, …}` —— `bank.questions` 是 undefined，
  // 取题永远返回空、作答永远报"没有 id 为 X 的题（共 N 道）"。
  //
  // 症状极具误导性：报错说"题库里有 N 道题"，N 是对的（来自题目计数），
  // 但每道题的 id 都"不存在"——因为根本没读到题。
  // 定位它花了三轮猜测，最后靠 debug-id-mismatch.mjs 把两边的值打出来才看清。
  const { bank, errors } = loadBank(found.path)
  if (bank === null) throw new Error(`题库「${wanted}」读不出内容：${found.path}`)
  if (errors.length > 0) {
    throw new Error(`题库「${wanted}」存在但不合格，拒绝使用：\n  ${errors.join('\n  ')}`)
  }
  if (!Array.isArray(bank.questions)) {
    // 防的是"读了但结构不对"——那种对象会让下游静默返回空结果
    throw new Error(`题库「${wanted}」的内容里没有 questions 数组：${found.path}`)
  }
  return { path: found.path, bank }
}

/** 导出给插件层复用，避免两处各自 import 同一批符号。 */
export { validateBank, BANK_SCHEMA_VERSION }
