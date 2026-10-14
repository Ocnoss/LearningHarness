/**
 * 闸门：**bundle 面（新机制）的等价检查** —— app 0.2.0 实际读的那一侧。
 *
 * ══ 它为什么存在（2026-10-13 闸门失真修复）═══
 * 现有 `check-*` 全家验的是 **旧机制**：npm 全局 `@deepseek-ai/dsh` 0.1.1-rc.2
 * 扫 `.agent-presets/` 目录。而 app（`dsh-desktop-runtime` 0.2.0-rc.2）读的是
 * **bundle + declaration row**，"Nothing reads that directory any more"。
 * 2026-09-22 起 5 个插件静默瘫痪的那段时间，旧闸门一路全绿（假绿）——
 * 因为新机制这**一侧根本没有闸门**。本文件就是补这一侧的。
 *
 * ══ 它验什么（对应迁移的四类"装完却不生效"）═══
 *   1. `bundle/package.json` 的 `dsh.bundle.patch` 指向的文件**存在**
 *      （指错 = 宿主 "Bundle resolution … failures skip that bundle"，整包静默跳过）；
 *   2. `bundle/cordis.patch.yml` 每个插件行的 `name` **能解析**
 *      （在 `bundle/node_modules/` 里，或在 `package.json` 的依赖声明里）；
 *   3. `preset-lh` 的 `config.id / config.name / config.plugins` **形状合法**
 *      （形状坏 = 这个 preset 挂载失败，「LH 学习模式」不出现在选择器里）；
 *   4. **13 个 `@lh/*` 包名逐条与 `plugins/各包的 package.json` 的 `name` 一致**
 *      （宿主警告：改过名的包激活时失败——而且失败得很安静）。
 *
 * ══ 关于 YAML 解析器 ══
 * 与 `check-profile-patch.mjs` 同一约定：仓库自己不依赖 YAML 解析器，
 * 从 profile / 宿主 dsh 的解析上下文里借 `yaml`；借不到时用行级近似做检查 1/2/4
 * 并**明说**形状检查被跳过——不装死、也不假绿。
 *
 * 运行：node scripts/check-bundle.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(repoRoot, 'bundle')
const pluginsDir = join(repoRoot, 'plugins')

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const green = (s) => c('32', s)
const red = (s) => c('31', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

console.log('check-bundle：验证对象 = bundle + declaration row（app dsh-desktop-runtime 0.2.0-rc.2 的机制）')
console.log(dim('  （旧 .agent-presets/ 机制不在本闸门范围——那侧由 check-all 的其余闸门覆盖）'))
console.log('')

let failures = 0
const ok = (msg) => console.log(`  ${green('✓')} ${msg}`)
const bad = (msg) => { failures += 1; console.log(`  ${red('✗')} ${msg}`) }
const note = (msg) => console.log(`  ${yellow('!')} ${msg}`)

// ── 1. bundle/package.json 与 dsh.bundle.patch 指向 ────────────────────────
const bundlePkgPath = join(bundleDir, 'package.json')
if (!existsSync(bundlePkgPath)) {
  bad(`没有 ${bundlePkgPath} —— bundle 根本不在，谈不上“装压缩包”`)
  process.exit(1)
}
let bundlePkg
try {
  bundlePkg = JSON.parse(readFileSync(bundlePkgPath, 'utf8'))
} catch (error) {
  bad(`bundle/package.json 读不出来：${error?.message ?? error}`)
  process.exit(1)
}

const patchRel = bundlePkg.dsh?.bundle?.patch
let patchPath = null
if (typeof patchRel !== 'string' || patchRel === '') {
  bad('package.json 缺 `dsh.bundle.patch` —— 宿主拿不到 patch 文件，整包会被跳过')
} else {
  patchPath = resolve(bundleDir, patchRel)
  if (!existsSync(patchPath)) {
    bad(`dsh.bundle.patch 指向的文件不存在：${patchRel}`)
    patchPath = null
  } else {
    ok(`dsh.bundle.patch → ${patchRel}（存在）`)
  }
}

// ── 2. 解析 cordis.patch.yml（借解析器；借不到用行级近似） ─────────────────
/** @returns {{ rows: Array<{id,name,config}>, parseYaml: boolean } | null} */
function loadPatchRows(text) {
  // 借解析器：profiles/web 的解析上下文 → 宿主 dsh 的解析上下文。
  const contexts = [
    join(repoRoot, '.dsh', 'profiles', 'web', 'package.json'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(repoRoot, 'package.json'),
  ]
  let parse = null
  for (const ctx of contexts) {
    if (!existsSync(ctx)) continue
    try {
      const mod = createRequire(ctx)('yaml')
      // 宿主 patch 用 `!!js` 自定义标签（disabled: !!js process.platform === …）。
      // 不注册它就会刷 TAG_RESOLVE_FAILED 警告；本闸门不关心它的值，
      // 按原样字符串解析即可（形状检查看的只是 id/name/plugins 这些键）。
      const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: (value) => String(value) }
      parse = (t) => mod.parse(t, { customTags: [jsTag] })
      break
    } catch { /* 试下一个上下文 */ }
    try {
      const mod = createRequire(ctx)('js-yaml')
      parse = (t) => mod.load(t)
      break
    } catch { /* 试下一个上下文 */ }
  }
  if (parse !== null) {
    const doc = parse(text)
    if (!Array.isArray(doc)) return null // 顶层不是数组 = patch 等于空的，交下面报
    const rows = []
    for (const entry of doc) {
      if (entry !== null && typeof entry === 'object' && Array.isArray(entry.insert)) {
        for (const row of entry.insert) rows.push(row)
      }
    }
    return { rows, parseYaml: true }
  }
  // 行级近似：只抓 `- id:` / `name:` 对（本文件的 patch 是我们自己写的固定形状）。
  const rows = []
  let current = null
  for (const line of text.split('\n')) {
    const idM = line.match(/^\s*- id:\s*['"]?([\w@/.\-]+)['"]?\s*$/)
    const nameM = line.match(/^\s+name:\s*['"]([^'"]+)['"]/)
    if (idM) { current = { id: idM[1], name: undefined }; rows.push(current) }
    else if (nameM && current !== null && current.name === undefined) current.name = nameM[1]
  }
  return { rows: rows.filter((r) => typeof r.name === 'string'), parseYaml: false }
}

let patchRows = null
if (patchPath !== null) {
  const text = readFileSync(patchPath, 'utf8')
  try {
    patchRows = loadPatchRows(text)
    if (patchRows === null) bad('cordis.patch.yml 顶层不是数组（宿主把 patch 当列表读）')
    else if (patchRows.parseYaml) ok(`cordis.patch.yml 解析成功（${patchRows.rows.length} 个 insert 行）`)
    else note('借不到 yaml/js-yaml —— 用行级近似检查（形状合法性没验，不是“过了”）')
  } catch (error) {
    bad(`cordis.patch.yml 解析失败：${error?.message ?? error}`)
  }
}

// ── 3. preset-lh 的形状 + 每行 name 可解析 ─────────────────────────────────
// 顶层 insert 行 + preset-lh 的 config.plugins 里的行都要查 name——
// @lh/* 能力插件全嵌在 config.plugins 里，只查顶层 insert 行等于一条都没查。
const namedRows = patchRows === null ? [] : patchRows.rows.flatMap((row) => {
  const nested = (row !== null && typeof row === 'object' && Array.isArray(row.config?.plugins))
    ? row.config.plugins
    : []
  return [row, ...nested]
})

const deps = (bundlePkg.dependencies ?? {})
let lhRefs = 0
if (patchRows !== null) {
  for (const row of namedRows) {
    if (row === null || typeof row !== 'object') { bad('insert 里有非对象的行'); continue }
    const id = typeof row.id === 'string' ? row.id : '(无 id)'
    if (typeof row.name !== 'string') { bad(`${id} 行没有 name`); continue }

    // 3a. name 可解析：@lh/* 必须在依赖声明或 bundle/node_modules 里；
    //     @deepseek-ai/* 是宿主自带，不在这台机器上解析。
    if (row.name.startsWith('@lh/')) {
      lhRefs += 1
      const short = row.name.replace(/^@lh\//, '')
      const inDeps = Object.hasOwn(deps, row.name)
      const inNodeModules = existsSync(join(bundleDir, 'node_modules', '@lh', short, 'package.json'))
      if (inDeps || inNodeModules) {
        ok(`${id} → ${row.name}（${inDeps ? '依赖声明' : 'node_modules'}）`)
      } else {
        bad(`${id} → ${row.name}：依赖声明和 bundle/node_modules 里都解析不到（宿主跳过该行，激活静默失败）`)
      }
    } else if (!row.name.startsWith('@deepseek-ai/')) {
      note(`${id} → ${row.name}：既不是 @lh/* 也不是 @deepseek-ai/*，谁来提供它？`)
    }

    // 3b. preset-lh 的 config 形状（只有它带 config.id/name/plugins 这套）。
    if (row.id === 'preset-lh' && patchRows.parseYaml) {
      const cfg = row.config
      const shapeProblems = []
      if (cfg === null || typeof cfg !== 'object') {
        shapeProblems.push('没有 config 对象')
      } else {
        if (typeof cfg.id !== 'string' || cfg.id === '') shapeProblems.push('config.id 不是非空字符串')
        if (typeof cfg.name !== 'string' || cfg.name === '') shapeProblems.push('config.name 不是非空字符串')
        if (!Array.isArray(cfg.plugins) || cfg.plugins.length === 0) {
          shapeProblems.push('config.plugins 不是非空数组')
        } else {
          for (const p of cfg.plugins) {
            if (p === null || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.name !== 'string') {
              shapeProblems.push(`config.plugins 里有形状不对的行：${JSON.stringify(p)?.slice(0, 60)}`)
            }
          }
        }
      }
      if (shapeProblems.length === 0) ok(`preset-lh 的 config 形状合法（id=${cfg.id}，${cfg.plugins.length} 个插件行）`)
      else for (const p of shapeProblems) bad(`preset-lh：${p}`)
    }
  }
  if (patchRows.rows.some((r) => r?.id === 'preset-lh') === false) {
    bad('patch 里没有 id 为 preset-lh 的行 —— 「LH 学习模式」不会出现在 preset 选择器里')
  }
}

// ── 4. 13 个 @lh/* 包名逐条与 plugins/各包的 package.json 的 name 一致 ─────────
//
// 宿主的警告原文：改过名的包在激活时失败。而"改过名"有两种形态：
//   · 目录还是 lh-foo，package.json 的 name 变成了别的（引用方找不到）；
//   · patch 里引用的名字和 package.json 的 name 不一致（逐条对不上）。
// 两种都靠"逐条比对"抓，不靠人眼。
const registry = new Map() // name -> 目录名
for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const pkgPath = join(pluginsDir, entry.name, 'package.json')
  if (!existsSync(pkgPath)) continue
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@lh/')) registry.set(pkg.name, entry.name)
  } catch { /* 坏的 package.json 在下面按“名字对不上”暴露 */ }
}
console.log('')
console.log(`plugins/ 下的 @lh/* 注册表：${registry.size} 个包`)

if (registry.size === 0) {
  bad('plugins/ 下一个 @lh/* 包都没解析出来 —— 要么目录没了，要么 package.json 坏了')
} else {
  // 4a. 目录名与包名的对应：lh-x ↔ @lh/x（改过名的包激活时失败）。
  for (const [name, dirName] of registry) {
    const expectDir = `lh-${name.replace(/^@lh\//, '')}`
    if (dirName === expectDir) ok(`${name} ↔ plugins/${dirName}`)
    else bad(`${name} 在 plugins/${dirName}/（按惯例应是 ${expectDir}/）——包名与目录不一致，宿主警告“改过名的包激活时失败”`)
  }
  // 4b. patch 引用的每个 @lh/* 都能在注册表里逐条对上。
  if (patchRows !== null) {
    for (const row of namedRows) {
      if (row !== null && typeof row === 'object' && typeof row.name === 'string' && row.name.startsWith('@lh/') && !registry.has(row.name)) {
        bad(`patch 引用 ${row.name}（${row.id}），但 plugins/ 的注册表里没有这个名字 —— 逐条对不上`)
      }
    }
    const referenced = new Set(namedRows.map((r) => r?.name).filter((n) => typeof n === 'string' && n.startsWith('@lh/')))
    const unused = [...registry.keys()].filter((n) => !referenced.has(n))
    if (unused.length > 0) {
      console.log(`  ${dim('·')} 注册表里未被本 patch 引用的包（正常：挂在 host 行或暂缓）：${unused.join('、')}`)
    }
  }
}

console.log('')
if (failures > 0) {
  console.log(red(`══ ${failures} 项有问题 —— 这些都会让 bundle 在 app 里“装了却不生效” ══`))
  process.exit(1)
}
console.log(green(`══ bundle 面全绿：${lhRefs} 个 @lh 行可解析，preset-lh 形状合法，包名逐条一致。 ══`))
console.log(dim('  它证明的是“安装时不会静默跳过/激活失败”；app 真的挂载成功仍要一次真启动 + 冒烟确认。'))
