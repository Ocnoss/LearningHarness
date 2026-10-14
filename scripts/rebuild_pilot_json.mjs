/**
 * 从试点日志重建 JSON —— 不再重跑一次省掉重复的模型花费。
 *
 * ═══ 为什么这么做 ═══
 * 上次跑试点时，脚本末尾落盘那一步因为 `writeFileSync` 没 import 而抛错，
 * JSON 没写出来。但**日志里有全部信息**（每次调用的明细都打出来了）。
 *
 * 重跑一次要再花 ~44k tokens，而重建只读日志。**能用已有数据做的事，不要重跑。**
 *
 * 用法: node scripts/rebuild_pilot_json.mjs data/pilot-run.log
 */

import { readFileSync, writeFileSync } from 'node:fs'

const logPath = process.argv[2] ?? 'data/pilot-run.log'
const outPath = process.argv[3] ?? 'data/llm-preprocess-pilot.json'

/**
 * 读日志，**按 BOM 判编码**。
 *
 * ═══ 为什么必须判编码 ═══
 * 实测踩到：日志是用 PowerShell 的 `>` 重定向写的，而 **PS5 的 `>` 默认写 UTF-16LE**。
 * Node 的 `readFileSync(path, 'utf8')` 读它会得到一堆
 * `\u0000` 夹着的字符，于是**所有 ASCII 正则都失配**——
 * 第一版就是这样"解析出 0 题"，而日志里明明有 20 题的明细。
 *
 * 更恶劣的是它的表现：ASCII 部分还能认出几个词，中文全成乱码，
 * 看起来像"日志损坏"而不是"编码不对"。
 *
 * 同类坑我已经踩过两次（`Set-Content` 写 BOM、`Set-Content` 写坏多字节字符）。
 * 结论写死在这里：**凡读外部文件，先看 BOM 再解码**；
 * 而**要写文本文件，用 Node 写，不要用 shell 重定向**。
 *
 * @param path - 文件路径。
 * @returns 文件文本。
 */
function readTextWithBom(path) {
  const buf = readFileSync(path)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    // UTF-16LE（带 BOM）
    return buf.slice(2).toString('utf16le')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE：Node 无内建解码，交换字节后按 LE 读
    const swapped = Buffer.from(buf.slice(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  let start = 0
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3 // UTF-8 BOM
  return buf.slice(start).toString('utf8')
}

const log = readTextWithBom(logPath)
const lines = log.split(/\r?\n/)

/**
 * 解析日志。
 *
 * 逐题明细的格式（脚本自己打印的）：
 *    set1-q16  (官方 A)
 *      blank_required=false blank_found=null
 *      blank_after : null
 *      blank_before: null
 *      note: …
 *      meta: {...}
 *      答案: B（官方 A）不一致
 *      理由: …
 */
const results = []
let current = null

const RE_HEAD = /^(set\d+-q\d+)\s+\(官方 (\S+?)(?:, 空位真值: (.+?))?\)\s*$/
const RE_ANSWER = /^\s*答案: (\S+)（官方 (\S+)）(一致|不一致)\s*$/

for (const line of lines) {
  const h = line.match(RE_HEAD)
  if (h) {
    current = { number: h[1], official: h[2], blankTruthKind: h[3] ?? null }
    results.push(current)
    continue
  }
  if (!current) continue

  const a = line.match(RE_ANSWER)
  if (a) {
    current.myAnswer = a[1]
    current.agree = a[3] === '一致'
    continue
  }
  if (/^\s*blank_required=/.test(line)) {
    const m = line.match(/blank_required=(\S+)\s+blank_found=(\S+)/)
    if (m) {
      current.blankRequired = m[1] === 'true'
      current.blankFound = m[2] === 'true' ? true : m[2] === 'false' ? false : null
    }
    continue
  }
  matchField(line, 'blank_after', 'blankAfter', current)
  matchField(line, 'blank_before', 'blankBefore', current)
  matchField(line, 'note', 'note', current)
  matchField(line, '理由', 'myReasoning', current)
  const meta = line.match(/^\s*meta: (\{.*\})\s*$/)
  if (meta) {
    try {
      current.meta = JSON.parse(meta[1])
    } catch {
      current.meta = null
    }
  }
}

/**
 * 抽一个 "字段: 值" 行。
 *
 * @param line - 日志行。
 * @param label - 字段标签。
 * @param key - 写入的键。
 * @param target - 目标对象。
 */
function matchField(line, label, key, target) {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.*?)(?:\\s+(✓|✗))?\\s*$`)
  const m = line.match(re)
  if (!m) return
  const raw = m[1]
  if (key === 'blankAfter' || key === 'blankBefore') {
    try {
      const v = JSON.parse(raw)
      target[key] = v
      target[key + 'Ok'] = m[2] === '✓' ? true : m[2] === '✗' ? false : null
    } catch {
      target[key] = raw === 'null' ? null : raw
    }
    return
  }
  target[key] = raw
}

// 从汇总行取统计
const summary = {}
for (const line of lines) {
  let m
  if ((m = line.match(/^空位识别正确 (\d+)\/(\d+)/))) summary.blankOk = Number(m[1]), (summary.blankTotal = Number(m[2]))
  if ((m = line.match(/^自己作答与官方一致 (\d+)\/(\d+)/))) summary.agreed = Number(m[1]), (summary.answered = Number(m[2]))
  if ((m = line.match(/^总 token (\d+)；其中推理 token (\d+)/))) summary.tokens = Number(m[1]), (summary.reasoning = Number(m[2]))
  if ((m = line.match(/^平均每次 ~(\d+)/))) summary.perCall = Number(m[1])
}

const paid = results.filter((r) => r.myAnswer)
const disagreements = paid.filter((r) => r.agree === false)

const out = {
  rebuiltFrom: logPath,
  note: '由 scripts/rebuild_pilot_json.mjs 从日志重建（原脚本落盘失败，未重跑以免重复花费）',
  summary,
  agreement: {
    agreed: summary.agreed ?? disagreements.filter((r) => r.agree === true).length,
    answered: summary.answered ?? paid.length,
  },
  blankJudged: { ok: summary.blankOk ?? null, total: summary.blankTotal ?? null },
  disagreements: disagreements.map((r) => ({
    number: r.number,
    model: r.myAnswer,
    official: r.official,
    reasoning: r.myReasoning,
  })),
  results,
}

writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')
console.log(`解析出 ${results.length} 题（其中 ${paid.length} 题有作答）`)
console.log(`一致 ${out.agreement.agreed}/${out.agreement.answered}；不一致 ${disagreements.length} 道`)
console.log(`token ${summary.tokens ?? '?'}（推理 ${summary.reasoning ?? '?'}，占 ${summary.tokens ? Math.round((summary.reasoning / summary.tokens) * 100) : '?'}%）`)
console.log(`平均 ${summary.perCall ?? '?'} token/题`)
console.log(`\n写入 ${outPath}`)
