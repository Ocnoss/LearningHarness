/**
 * 闸门：插件里不许写死绝对路径。
 *
 * ═══ 为什么需要它（它不是洁癖，是静默错误）═══
 * 写死路径**不会让插件跑不起来**——它会让插件**在别人的机器上跑错目录**。
 * 那是静默的错误，比崩溃更难发现：崩溃会告诉你，而"读错了目录"只会表现为
 * "数据不见了""题库是空的""进度是 0"。
 *
 * 实测（2026-09-18）插件里有 4 处写死路径，且其中一处**已经指的是错的工作区**
 * （作者改过文件夹名，一处跟着改了、另一处没有）：
 *
 *     lh-event-store/store.js    'D:\\LearningHarnessv0.1\\data'
 *     lh-model-tier/tier.js      'D:\\LearningHarnessv0.1\\data\\model-tiers.json'
 *     lh-question-bank/signal.js 'D:\\LearningHarnessv0.1\\data\\practice-signal.json'
 *     lh-practice/index.js       'D:\\learning Harness test'      ← 工作区
 *
 * 前三个是"LH 自己的数据目录"，第四个是"用户的工作区"——**两者都危险，但危险的方式不同**：
 *   · 数据目录写死 → 部署到别人机器上会建一个指向错位置的目录；
 *   · 工作区写死 → **在别人的机器上会去读作者的工作区**（根本不存在）。
 *
 * ═══ 它与契约的关系 ═══
 * 规则写在 `docs/PLUGIN_CONTRACT.md §10`：插件不许写死绝对路径，
 * 必须从环境变量或调用上下文取。本脚本是那条规则的执行者。
 *
 * 用法: node scripts/check-hardcoded-paths.mjs
 * 退出码 0 = 干净；1 = 有写死的绝对路径
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGINS = join(ROOT, 'plugins')

/** 只扫代码，不扫文档/数据。 */
const CODE_EXT = ['.js', '.mjs', '.cjs']

/**
 * 递归列出代码文件。
 *
 * @param dir - 目录。
 * @param out - 累积。
 * @returns 文件路径数组。
 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (CODE_EXT.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

/** 剥掉注释（保留字符串，因为路径就写在字符串里）。 */
function stripComments(text) {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    const nx = text[i + 1]
    if (c === '/' && nx === '/') {
      while (i < n && text[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && nx === '*') {
      out += '  '; i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++ }
      out += '  '; i += 2
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += c; i++
      while (i < n && text[i] !== q) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue }
        out += text[i]; i++
      }
      if (i < n) { out += q; i++ }
    } else {
      out += c; i++
    }
  }
  return out
}

/** 疑似绝对路径：盘符开头（D:\ 或 D:/）。 */
const ABS_WIN = /['"`]([A-Za-z]:[\\/][^'"`\n]*)/g
/**
 * UNC 路径（\\server\share）——**必须要求 server 与 share 两段**。
 * 第一版写成 `\\\\[^'"`]+`，于是把 `ref.startsWith('\\\\')` 这种
 * **检测 UNC 的正则字面量**也当成了绝对路径（一次误报）。
 */
const ABS_UNC = /['"`](\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._$-]+)/g

/**
 * 明确写清意图的例外标记。
 *
 * ⚠ 第一版设计成"行内加标记就放行"，但我发现**标记本身没有义务解释理由**，
 * 于是它会退化成"看到红就加标记"。所以改成**带理由的例外**：
 * 标记后必须跟一个短理由，否则不算数。
 *
 * 用法：`// lh-path-ok: 测试夹具，这个路径只是数据标签，不需要真实存在`
 */
const ALLOW_RE = /lh-path-ok:\s*\S+/

const files = walk(PLUGINS)
console.log(`扫描 ${files.length} 个代码文件，找写死的绝对路径\n`)

const hits = []
for (const file of files) {
  const raw = readFileSync(file, 'utf8')
  const src = stripComments(raw)
  const lines = src.split('\n')
  lines.forEach((line, idx) => {
    // 例外标记写在注释里 → 看原始行；标记必须带理由（见 ALLOW_RE 的注释）
    const rawLine = raw.split('\n')[idx] ?? ''
    if (ALLOW_RE.test(rawLine)) return
    for (const re of [ABS_WIN, ABS_UNC]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(line)) !== null) {
        hits.push({
          file: relative(ROOT, file),
          line: idx + 1,
          path: m[1],
          kind: 'runtime',
          text: line.trim().slice(0, 100),
        })
      }
    }
  })
}

if (hits.length === 0) {
  console.log('══ 没有写死的绝对路径。')
  process.exit(0)
}

for (const h of hits) {
  console.log(`  ✗ ${h.file}:${h.line}`)
  console.log(`      路径: ${h.path}`)
  console.log(`      代码: ${h.text}`)
}
console.log('')
console.log(`══ ${hits.length} 处写死的绝对路径。`)
console.log('')
console.log('规则（PLUGIN_CONTRACT §10）：')
console.log('  · 数据目录：从环境变量 + 相对仓库根推导（不是写死盘符）')
console.log('  · 工作区路径：从调用上下文取（工具的 exec.agent.session.header.cwd，')
console.log('    或 HTTP 路由显式传入）；**不要留一个"默认指向某人的工作区"的常量**')
console.log('')
console.log('确属举例/夹具用途的，在那一行加**带理由**的例外标记：')
console.log('    // lh-path-ok: 理由')
process.exit(1)
