/**
 * 从宿主的 `app.asar` 里按「行号区间 / 正则上下文」取源码片段。
 *
 * ═══ 为什么需要它 ═══
 * 宿主源码打包在 `resources/app.asar` 这**一个文件**里（本机约 122 MB、234 万行）。
 * 而 read 工具在这个文件上会抛 `Cannot mix BigInt and other types, use explicit conversions`
 * ——读小文件正常，所以这是该文件触发的工具缺陷，不是权限问题。
 * grep 工具能搜到匹配行，但给不了上下文，而"这块代码是怎么组织的"恰恰要靠上下文。
 * 这个脚本补上那一步：带行号的上下文窗口。
 *
 * ═══ 为什么路径是参数、不写死 ═══
 * 本项目有一条闸门专抓"写死盘符"（`check-hardcoded-paths.mjs`）。
 * 写死自己机器上的安装路径，正是它防的那类错误（换台机器就静默跑错文件）。
 * 所以路径必须由调用方给；找不到就报错并说明怎么找。
 *
 * ═══ 用法 ═══
 *   node scripts/inspect-asar.mjs stat
 *   node scripts/inspect-asar.mjs range <from> <to>            # 1-based，含两端
 *   node scripts/inspect-asar.mjs find <regex> [before] [after] # 最多打印 8 个匹配
 *
 * 路径来源（按优先级）：`--asar <路径>` 参数 > `ASAR_PATH` 环境变量。
 * 输出：设了 `ASAR_OUT` 就整段写进那个文件（UTF-8），否则打 stdout——
 * 因为 pwsh 通道会把长输出**截断到尾部**，写文件再用 read 看才不丢头。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)

/** 从 `--asar <路径>` 里取路径。 */
function asarFromArgs() {
  const i = argv.indexOf('--asar')
  return i === -1 ? null : (argv[i + 1] ?? null)
}

const ASAR = asarFromArgs() ?? process.env.ASAR_PATH ?? null

if (ASAR === null) {
  console.error(
    'inspect-asar: 没给 app.asar 的路径。\n' +
      '  用法：node scripts/inspect-asar.mjs --asar "<app.asar 的绝对路径>" stat\n' +
      '  或设环境变量 ASAR_PATH。\n' +
      '  典型位置：<DeepSeek Harness 安装目录>\\resources\\app.asar',
  )
  process.exit(2)
}

const args = argv.filter((a, i) => a !== '--asar' && argv[i - 1] !== '--asar')

let text
try {
  text = readFileSync(ASAR, 'utf8')
} catch (error) {
  console.error(`inspect-asar: 读不了 ${ASAR} —— ${error?.message ?? error}`)
  process.exit(2)
}

const lines = text.split(/\r?\n/)
const mode = args[0]

/**
 * 输出缓冲：设了 `ASAR_OUT` 就整段写文件，否则打 stdout。
 * @param chunk - 要输出的文本。
 */
const buffer = []
function out(chunk) {
  if (process.env.ASAR_OUT !== undefined && process.env.ASAR_OUT !== '') buffer.push(chunk)
  else process.stdout.write(chunk)
}

/**
 * 打印一个 1-based 的闭区间。
 * @param from - 起始行号。
 * @param to - 结束行号。
 */
function range(from, to) {
  for (let i = from; i <= to && i <= lines.length; i += 1) out(`${i}: ${lines[i - 1]}\n`)
}

/**
 * 按正则找行，并打印其前后若干行。
 * @param pattern - 正则源码。
 * @param before - 向前几行。
 * @param after - 向后几行。
 */
function search(pattern, before, after) {
  const re = new RegExp(pattern)
  let shown = 0
  let total = 0
  for (let i = 1; i <= lines.length; i += 1) {
    if (!re.test(lines[i - 1])) continue
    total += 1
    if (shown >= 8) continue
    shown += 1
    out(`--- match @${i} ---\n`)
    for (let j = Math.max(1, i - before); j <= Math.min(lines.length, i + after); j += 1) {
      out(`${j}: ${lines[j - 1]}\n`)
    }
  }
  out(`[matches=${total} shown=${shown} totalLines=${lines.length}]\n`)
}

if (mode === 'range') range(Number(args[1]), Number(args[2]))
else if (mode === 'find') search(args[1], Number(args[2] ?? 0), Number(args[3] ?? 0))
else if (mode === 'stat') out(`file=${ASAR}\nlines=${lines.length} bytes=${Buffer.byteLength(text)}\n`)
else out('usage: stat | range <from> <to> | find <regex> [before] [after]（路径用 --asar 或 ASAR_PATH）\n')

if (buffer.length > 0) writeFileSync(process.env.ASAR_OUT, buffer.join(''), 'utf8')
