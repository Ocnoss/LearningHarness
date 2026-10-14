/**
 * LH 工具入参审计（T4.3 补审计，事故 B 复盘工具）。
 *
 * ═══ 它做什么、不做什么 ═══
 * 做：从宿主会话日志（`.dsh/sessions/<工作区>/<会话>/session.jsonl.zstd`）
 * 提取每次 `tool/call` 的**模型相关入参**（provider / model / provenance_model），
 * 与 `data/model-tiers.json` 的白名单逐条核对，输出人类可读的审计报告——
 * 事故 B（agent 自传 deepseek-official/deepseek-flash 跑按量计费抽取）
 * 在报告里就是三行"白名单外/按量计费"的记录。
 *
 * 不做：**不记录题干、答案等敏感内容**。除 provider/model/provenance_model
 * 三个值外，入参只记**键名**不记值（bank_name/title/questions 的值一律不落盘）。
 *
 * 白名单语义与工具层硬闸同源：直接复用 `@lh/model-tier/model` 的
 * loadModelWhitelist / isWhitelistedModel（BOM 容忍、坏条目只排除不补默认、
 * 文件缺失才退 FALLBACK_WHITELIST_COMBOS），保证审计结论和闸门结论不打架。
 *
 * 用法:
 *   node scripts/audit-tool-args.mjs                      # 扫 .dsh/sessions，报告落 data/audit-tool-args.txt
 *   node scripts/audit-tool-args.mjs --out 报告路径        # 自定义输出
 *   node scripts/audit-tool-args.mjs --sessions-dir 路径   # 自定义会话根
 *   node scripts/audit-tool-args.mjs --tool import_questions_from_source   # 只看某个工具
 *
 * 依赖：Node 23+（node:zlib 的 zstdDecompressSync）。
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

import { loadModelWhitelist, isWhitelistedModel } from '../plugins/lh-model-tier/model.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** zstd 帧魔数（会话日志是多帧拼接，逐帧解码后拼接）。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解码多帧 zstd 缓冲区为字符串。
 *
 * @param buffer - 原始文件内容。
 * @returns 解码后的 JSONL 文本。
 */
function decodeFramed(buffer) {
  const parts = []
  let pos = 0
  while (pos < buffer.length) {
    const next = buffer.indexOf(MAGIC, pos + MAGIC.length)
    const end = next === -1 ? buffer.length : next
    try {
      parts.push(zstdDecompressSync(buffer.subarray(pos, end)).toString('utf8'))
    } catch {
      break // 尾部残帧：解不动就停，已解出的部分照用
    }
    pos = end
  }
  return parts.join('')
}

/**
 * 递归找出会话根下所有 session.jsonl.zstd。
 *
 * 布局：`sessions/<工作区 slug>/<会话 uuid>/session.jsonl.zstd`，
 * 但按文件名递归扫，布局变了也能用。
 *
 * @param root - 会话根目录。
 * @returns 会话日志文件路径数组。
 */
function findSessionLogs(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'session.jsonl.zstd') out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * 解析命令行参数。
 *
 * @param argv - process.argv.slice(2)。
 * @returns `{ sessionsDir, out, tool }`。
 */
function parseArgs(argv) {
  const args = { sessionsDir: join(repoRoot, '.dsh', 'sessions'), out: join(repoRoot, 'data', 'audit-tool-args.txt'), tool: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--sessions-dir') args.sessionsDir = resolve(argv[(i += 1)])
    else if (a === '--out') args.out = resolve(argv[(i += 1)])
    else if (a === '--tool') args.tool = argv[(i += 1)]
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/audit-tool-args.mjs [--sessions-dir 路径] [--out 报告路径] [--tool 工具名]')
      process.exit(0)
    } else {
      console.error(`未知参数：${a}（--help 看用法）`)
      process.exit(2)
    }
  }
  return args
}

const { sessionsDir, out, tool: toolFilter } = parseArgs(process.argv.slice(2))

// ── 白名单：与工具层硬闸同一份语义 ──────────────────────────────────────
const whitelist = loadModelWhitelist()
const comboKey = (c) => `${c.provider} / ${c.model}`

/** 某个组合被哪些档位声明（deepseek-official/deepseek-flash = balance/max，即按量计费面）。 */
function tiersDeclaring(provider, model) {
  const raw = JSON.parse(readFileSync(join(repoRoot, 'data', 'model-tiers.json'), 'utf8').replace(/^\uFEFF/, ''))
  const tiers = []
  for (const [tier, combos] of Object.entries(raw)) {
    if (!Array.isArray(combos)) continue
    if (combos.some((c) => c && c.provider === provider && c.model === model)) tiers.push(tier)
  }
  return tiers
}

// ── 扫描 ────────────────────────────────────────────────────────────────
const files = findSessionLogs(sessionsDir)
const calls = [] // 模型相关的调用明细
const allToolKinds = new Map() // 工具名 → 出现次数（无模型入参的也统计，方便看全貌）

for (const file of files) {
  const text = decodeFramed(readFileSync(file))
  const sessionRef = file.slice(sessionsDir.length + 1).replace(/[\\/]session\.jsonl\.zstd$/, '')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type !== 'tool/call') continue
    const d = rec.data ?? {}
    const name = d.name ?? '(未命名)'
    allToolKinds.set(name, (allToolKinds.get(name) || 0) + 1)
    if (toolFilter && name !== toolFilter) continue
    let args = d.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        args = {}
      }
    }
    if (!args || typeof args !== 'object') args = {}
    // 只取模型相关入参的**值**；其余键只记名字——不给题干/答案任何落盘机会
    const provider = typeof args.provider === 'string' ? args.provider : null
    const model = typeof args.model === 'string' ? args.model : null
    const provenanceModel = typeof args.provenance_model === 'string' ? args.provenance_model : null
    const argKeys = Object.keys(args).sort()
    const hasModelArg = provider !== null || model !== null || provenanceModel !== null
    if (!hasModelArg) continue // 无模型入参的调用不进明细（汇总里有总数）
    const verdict = isWhitelistedModel(whitelist, { provider, model: model ?? provenanceModel ?? undefined })
      ? '在白名单'
      : '⚠ 白名单外'
    calls.push({
      sessionRef,
      seq: rec.seq,
      time: rec.time ? new Date(rec.time).toISOString() : '(无时间)',
      name,
      provider,
      model,
      provenanceModel,
      argKeys,
      verdict,
      tiers: model ? tiersDeclaring(provider, model) : [],
    })
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────
const L = []
L.push('# LH 工具入参审计报告（provider/model 面）')
L.push(`生成时间: ${new Date().toISOString()}`)
L.push(`会话根: ${sessionsDir}`)
L.push(`扫描会话日志: ${files.length} 份；tool/call 记录里模型相关调用: ${calls.length} 条`)
L.push(`白名单来源: data/model-tiers.json（载入 ${whitelist.combos.length} 个组合${whitelist.notes.length ? `，载入备注 ${whitelist.notes.length} 条` : ''}）`)
L.push('隐私声明: 除 provider/model/provenance_model 外，入参只记键名不记值——不含题干、答案。')
L.push('')
L.push('## 明细（模型相关入参的工具调用，按会话/序号）')
for (const c of calls) {
  const pm = c.provenanceModel ? ` provenance_model=${c.provenanceModel}` : ''
  const tierNote = c.tiers.length ? `（档位: ${c.tiers.join(', ')}）` : ''
  L.push(`- [${c.time}] ${c.sessionRef} seq=${c.seq} ${c.name}`)
  L.push(`    provider=${c.provider ?? '(未传)'} model=${c.model ?? '(未传)'}${pm} → ${c.verdict}${tierNote}`)
  L.push(`    入参键: ${c.argKeys.join(', ')}`)
}
L.push('')
L.push('## 汇总（工具 × provider × model）')
const rollup = new Map()
for (const c of calls) {
  const key = `${c.name} | ${c.provider ?? '-'} | ${c.model ?? c.provenanceModel ?? '-'}`
  rollup.set(key, (rollup.get(key) || 0) + 1)
}
for (const [key, n] of [...rollup.entries()].sort((a, b) => b[1] - a[1])) {
  L.push(`- ${key} : ${n} 次`)
}
L.push('')
L.push('## 白名单外调用（需人工复核）')
const outside = calls.filter((c) => c.verdict.startsWith('⚠'))
if (outside.length === 0) {
  L.push('（无）')
} else {
  for (const c of outside) {
    L.push(`- [${c.time}] ${c.sessionRef} seq=${c.seq} ${c.name}: ${c.provider ?? '(未传)'} / ${c.model ?? c.provenanceModel ?? '(未传)'}`)
  }
}
L.push('')
L.push('## 工具全貌（含无模型入参的调用，仅计数）')
for (const [name, n] of [...allToolKinds.entries()].sort((a, b) => b[1] - a[1])) {
  L.push(`- ${name} : ${n} 次`)
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, L.join('\n') + '\n', 'utf8')
console.log(`会话 ${files.length} 份 | 模型相关调用 ${calls.length} 条 | 白名单外 ${outside.length} 条`)
console.log(`白名单: ${whitelist.combos.length} 个组合（data/model-tiers.json）`)
console.log(`报告 -> ${out}`)
