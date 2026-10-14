/**
 * 闸门：LH 客户端 bundle 访问的每个 `ctx.<服务>`，都必须在本模块导出的
 * `exports.inject`（服务名数组）里声明。
 *
 * ═══ 为什么必须有这个脚本（它是一次真实事故的产物）═══
 * 事故现象：dsh 启动屏（HARNESS / Loading plugins…）卡在
 *   Failed to load plugins
 *   @lh/practice
 *   failed to apply loader entry dab8e238 (@lh/practice):
 *     cannot get property "slots" without inject
 *
 * 根因：`plugins/lh-practice/client.js` 的 apply() 访问了 `ctx.slots`，
 * 但模块没有导出 `inject`。浏览器的插件 fiber 因此不带 `slots` 注入，
 * cordis 的 inject 门禁在访问点抛错，整条 loader entry apply 失败。
 *
 * **关键认知差**（事故里付学费学到的）：
 * package.json 的 `dsh.client.inject`（包名数组）只进 boot manifest，
 * 宿主当前版本**不拿它装配 fiber 的 inject**；门禁认的是**模块导出的
 * `exports.inject`（服务名数组）**。对照宿主自己的客户端包可证
 * （如 dsh-session-log-export/lib/client.js 导出 `inject = ["slots", "locale"]`）。
 * 只在 package.json 里声明、模块里不导出 = 启动屏上那条错。
 *
 * ═══ 它的边界（必须说清，否则会给人假的安全感）═══
 * 本脚本是**静态检查**：正则扫 `ctx.<名>` 访问，对照导出的 inject 名单。
 * 它不能证明：
 *   · 服务在真实启动时真的就绪（那归 cordis 的等待机制管）；
 *   · bundle 在浏览器里真的能跑（语法、require 解析归 check-plugin-imports 与真启动管）。
 * 只排除"访问了服务但没声明 inject"这一类启动失败。
 *
 * 用法: node scripts/check-client-inject.mjs
 * 退出码 0 = 全部声明齐全；1 = 有漏声明（dsh 启动屏会卡"Failed to load plugins"）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installedProfiles, describeHome } from './lib/dsh-home.mjs'

/** 工作区根（scripts/ 的上一级）。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 要检查的客户端 bundle：源码树 + profile 里已安装的生产副本（真正被 serve 的那份）。
 *
 * ⚠ `profile:*` 这几行原来**写死了** `USERPROFILE/.dsh`。作者把开发迁到
 * "工作区自持"（`DSH_HOME` 指向仓库里的 `.dsh/`）之后，写死的路径会继续指向**旧目录**——
 * 于是闸门可能对着旧副本变绿（"测过了"是假的），或者报"找不到 profile"（像配置坏了）。
 * 现在统一问 `lib/dsh-home.mjs`，并**把看的是哪个家打出来**，好让"两个家并存"一眼可见。
 */
const SEARCH_ROOTS = [
  { label: '源码', dir: join(ROOT, 'plugins') },
  ...installedProfiles().map((p) => ({ label: `profile:${p.name}`, dir: p.lhNodeModules })),
]

// 每次跑都自证看的是哪个家：迁移期最危险的状态是"两个家并存、而两边都能给出结果"。
console.log(describeHome('check-client-inject'))

/**
 * cordis 上下文自带的成员（方法/属性），不是服务。
 * `ctx.<名>` 命中这个名单就不算"服务访问"（它们不触发 inject 门禁）。
 * 名单取 cordis Context 的公开 API；漏了某个只会造成误报，不会造成漏报。
 */
const CTX_MEMBERS = new Set([
  'effect', 'on', 'once', 'off', 'emit', 'waterfall', 'parallel', 'serial',
  'get', 'set', 'inject', 'plugin', 'extend', 'fork', 'dispose', 'logger',
  'collect', 'accept', 'provide', 'alias', 'scope', 'baseUrl', 'root',
  'reflect', 'runtime', 'fiber', 'events', 'config', 'uid', 'state',
  'context', 'source', 'status', 'isolate', 'shadow', 'intercept', 'entries',
])

/**
 * 去掉注释（以及可选的字符串字面量），避免把注释/字符串里的 `ctx.xxx`
 * 当成访问。手写 scanner（状态机比正则稳）：处理 //、/* *\/、'…'、"…"、`…`。
 *
 * @param text - 源文件全文。
 * @param options - `blankStrings` 为 true 时字符串内容也抹掉（用于扫 ctx 访问）；
 *   为 false 时保留字符串内容（用于读 inject 名单——名字在字符串里，不能抹）。
 * @returns 净化后的文本（被抹掉的部分用空格替换，结构/行号不变）。
 */
function stripCommentsAndStrings(text, options = {}) {
  const blankStrings = options.blankStrings !== false
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && next === '*') {
      out += '  '; i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '; i += 2
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c
      if (!blankStrings) { out += c; i++ } else { out += ' '; i++ }
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') {
          out += blankStrings ? ' ' : text[i]
          i++
          if (i < n) { out += blankStrings ? ' ' : text[i]; i++ }
          continue
        }
        out += blankStrings ? (text[i] === '\n' ? '\n' : ' ') : text[i]
        i++
      }
      if (i < n) { out += blankStrings ? ' ' : quote; i++ }
    } else {
      out += c
      i++
    }
  }
  return out
}

/**
 * 解析数组字面量里的字符串元素（['a', "b"] → ['a', 'b']）。
 * 容忍多行与尾部逗号；跳过非字符串元素（本闸门只关心字符串服务名）。
 *
 * @param text - 数组字面量**内部**文本（不含方括号）。
 * @returns 字符串元素列表。
 */
function parseStringArray(text) {
  const out = []
  for (const m of text.matchAll(/['"]([^'"]+)['"]/g)) out.push(m[1])
  return out
}

/**
 * 提取一个客户端 bundle 导出的 inject 服务名。
 * 支持两种写法：
 *   · `exports.inject = ['a', 'b']`（直接数组字面量）
 *   · `const inject = ['a', 'b']; … exports.inject = inject`（先声明后导出）
 *
 * @param text - 净化后的源文本。
 * @returns 服务名数组；没找到导出的 inject 时返回 []（并靠调用方报告）。
 */
function extractExportedInject(text) {
  const direct = /exports\.inject\s*=\s*\[([^\]]*)\]/s.exec(text)
  if (direct) return parseStringArray(direct[1])
  const alias = /exports\.inject\s*=\s*([A-Za-z_$][\w$]*)/.exec(text)
  if (alias) {
    const decl = new RegExp(`(?:const|let|var)\\s+${alias[1]}\\s*=\\s*\\[([^\\]]*)\\]`, 's').exec(text)
    if (decl) return parseStringArray(decl[1])
  }
  return []
}

/**
 * 提取 `ctx.<名>` 的服务访问（第一级）。
 * `ctx.sessions.list` 记作 `sessions`；`ctx.effect` 这类 cordis 自带成员不计。
 *
 * @param text - 净化后的源文本。
 * @returns 去重后的服务名列表。
 */
function extractCtxServices(text) {
  const found = new Set()
  for (const m of text.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    if (!CTX_MEMBERS.has(m[1])) found.add(m[1])
  }
  return [...found]
}

/** 收集所有要检查的 client.js（存在才收）。 */
const targets = []
for (const root of SEARCH_ROOTS) {
  if (!existsSync(root.dir)) continue
  for (const name of readdirSync(root.dir)) {
    const clientJs = join(root.dir, name, 'client.js')
    if (existsSync(clientJs)) targets.push({ where: `${root.label}/${name}`, path: clientJs })
  }
}

if (targets.length === 0) {
  console.log('没有找到任何客户端 bundle（源码树与 profile 都没有 client.js）')
  process.exit(0)
}

console.log(`检查 ${targets.length} 个客户端 bundle 的 inject 声明（ctx 服务访问 vs exports.inject）\n`)

let bad = 0
for (const t of targets) {
  const raw = readFileSync(t.path, 'utf8')
  const used = extractCtxServices(stripCommentsAndStrings(raw, { blankStrings: true }))
  const declared = extractExportedInject(stripCommentsAndStrings(raw, { blankStrings: false }))
  const missing = used.filter((s) => !declared.includes(s))

  if (used.length === 0) {
    console.log(`  ✓ ${t.where}  （不访问 ctx 服务，无需 inject）`)
  } else if (missing.length === 0) {
    console.log(`  ✓ ${t.where}  (访问: ${used.join(', ')}；已声明: ${declared.join(', ') || '—'})`)
  } else {
    bad += 1
    console.log(`  ✗ ${t.where}`)
    console.log(`      访问了但未在 exports.inject 声明：${missing.join(', ')}`)
    console.log(`      已声明：${declared.join(', ') || '（没有导出 inject）'}`)
    console.log(`      → dsh 启动屏会报 cannot get property "${missing[0]}" without inject，该插件加载失败。`)
  }
}

console.log('')
if (bad > 0) {
  console.log(`══ ${bad} 个客户端 bundle 的 inject 声明不全 —— dsh 启动会卡在 "Failed to load plugins"。`)
  process.exit(1)
}
console.log('══ 全部客户端 bundle 的 inject 声明齐全。')
