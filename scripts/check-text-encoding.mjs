/**
 * 文本文件的编码健康检查 —— **BOM 与被写坏的多字节字符**。
 *
 * ═══ 为什么需要它（是我自己反复犯的错逼出来的）═══
 * 同一条规矩我记了三次、犯了四次：**改文本文件不要用 shell**
 * （`Set-Content -Encoding UTF8` 在 PowerShell 5.1 上会写 BOM；
 *  更重的一次是把多字节字符写成 `U+FFFD`，文件坏到连读都读不出来）。
 *
 * 前几次的处置都是"记进经验文档"——而**记进文档的规矩拦不住手**。
 * 所以这里把它变成闸门：**对"已知坏的状态"报错，而不是靠我记得**。
 *
 * ═══ 它查什么 ═══
 * 1. 文本文件**以 BOM 开头**（UTF-8 BOM：`EF BB BF`）；
 * 2. 文件里出现 **`U+FFFD`**（替换字符）——那是"编码转换把字符弄丢了"的化石。
 *
 * ═══ 两个刻意的取舍 ═══
 * - **只查我们自己写的源码与文档**（`.js/.mjs/.py/.md/.json/.yml`），
 *   不查 `node_modules`、`data/`、以及 profile 里的副本——那些是别人的/派生的；
 * - **允许显式例外**：万一某个文件真的需要 BOM（比如给 Windows 工具的 CSV），
 *   就在那一行写 `bom-ok`，并说明理由（与其他闸门"例外要带理由"的纪律一致）。
 *
 * 用法: node scripts/check-text-encoding.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 要查的扩展名。 */
const EXTS = new Set(['.js', '.mjs', '.cjs', '.py', '.md', '.json', '.yml', '.yaml', '.ps1'])

/** 不进去的目录（派生/第三方的地盘）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', '.lh-sync-backup', 'reports', '.workbuddy'])

/** UTF-8 BOM。 */
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * 递归收集要检查的文件。
 *
 * @param dir - 起始目录。
 * @param out - 累加数组。
 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collect(join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (!EXTS.has(extname(entry.name))) continue
    // 只查仓库里的常规文件；符号链接跳过（可能是别人地盘）
    const full = join(dir, entry.name)
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    out.push(full)
  }
  return out
}

const files = collect(repoRoot)
const problems = []

for (const file of files) {
  const buf = readFileSync(file)
  const rel = relative(repoRoot, file)
  if (buf.subarray(0, 3).equals(BOM)) {
    const head = buf.toString('utf8', 0, 400)
    if (!head.includes('bom-ok')) problems.push({ rel, kind: 'BOM', detail: '文件以 UTF-8 BOM 开头' })
  }
  // U+FFFD 的 UTF-8 编码是 EF BF BD
  const text = buf.toString('utf8')
  const badIndex = text.indexOf('\uFFFD')
  if (badIndex >= 0) {
    const before = text.slice(Math.max(0, badIndex - 40), badIndex)
    problems.push({ rel, kind: 'U+FFFD', detail: `第 ${text.slice(0, badIndex).split('\n').length} 行附近：…${before}` })
  }
}

console.log(`检查 ${files.length} 个文本文件的编码健康（BOM / U+FFFD）`)

if (problems.length === 0) {
  console.log('\n══ 没有 BOM、也没有被编码转换弄丢的字符。 ══')
  console.log('   （本闸门存在的原因见文件头：这条规矩我犯过四次，记文档拦不住手。）')
  process.exit(0)
}

console.log('')
for (const p of problems) console.log(`  ✗ ${p.rel}  [${p.kind}] ${p.detail}`)
console.log(`\n══ ${problems.length} 处编码问题 ══`)
console.log('  修法（**不要再用 shell 改**）：用编辑器或 `edit` 工具把文件另存为 UTF-8 无 BOM；')
console.log('  U+FFFD 的那种只能回去对照源文件重写那一段（字符已经丢了）。')
process.exit(1)
