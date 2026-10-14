/**
 * 闸门：**profile 的 patch 文件能不能解析、里面的 `@lh/*` 行能不能解析到包与两半**。
 *
 * ═══ 它补的是哪一类洞 ═══
 * 本项目为"让 dsh 起不来"付过四次代价（`docs/archive/experience/插件开发者/` 里那一串）。
 * 现有的闸门已经覆盖了其中三类：能不能 import（`check-plugin-imports`）、
 * `apply()` 会不会抛（`check-profile-apply`）、副本是不是最新（`check-installed-copies`）。
 *
 * **剩下的那一类没人管，而它恰好最致命**：宿主文档原话是
 * "Bundle resolution, manifest, and patch-loading failures skip that bundle …
 *  **profile and user-patch errors still fail startup**"。
 * 也就是说：**profile 的 `cordis.patch.yml` 出错 = 应用直接起不来**，
 * 而且发生在启动最前面——连界面都看不到，学习者被锁在门外。
 *
 * 两种坏法都真实存在，而且都不会被上面三道闸门发现：
 *   1. **YAML 本身坏了**（一个缩进写错、一次用 shell 重定向改文件写进了 BOM）；
 *   2. **行还在，但包解析不到**（依赖删了、`exports` 少了 `./client`、
 *      忘了 `dsh.client` 声明）——这种宿主**只是跳过那一行**，
 *      表现为"界面少了个入口"，而**不报错**（最贵的那种静默）。
 *
 * ═══ 关于 YAML 解析器（为什么找不到就跳过，而不是红）═══
 * 仓库自己**不依赖** YAML 解析器（`yaml` / `js-yaml` 都解析不到）。
 * 但每个 profile 都能从它自己的解析上下文里拿到宿主的 `yaml`
 * （dsh 装在哪，它就在哪——实测 `…/npm/node_modules/@deepseek-ai/dsh/node_modules/yaml`）。
 * 拿不到时**跳过并说明**，而不是红：一个"因为没有解析器而永远红"的闸门
 * 会被条件反射地忽略，那比没有闸门更坏。
 *
 * 用法：node scripts/check-profile-patch.mjs
 *       DSH_HOME=<家> node scripts/check-profile-patch.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { describeHome, installedProfiles } from './lib/dsh-home.mjs'

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const green = (s) => c('32', s)
const red = (s) => c('31', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

const PATCH_FILENAME = 'cordis.patch.yml'

console.log(describeHome('check-profile-patch'))

const profiles = installedProfiles()
if (profiles.length === 0) {
  console.log('  · 这个家里没有装了 LH 的 profile，没什么可查的。')
  process.exit(0)
}

let failures = 0
let checkedRows = 0
let skipped = 0

for (const profile of profiles) {
  const patchPath = join(profile.dir, PATCH_FILENAME)
  console.log(`\nprofile:${profile.name}  ${dim(patchPath)}`)

  if (!existsSync(patchPath)) {
    console.log(`  ${yellow('!')} 没有 ${PATCH_FILENAME}（尚未初始化？）——跳过`)
    skipped += 1
    continue
  }

  // ── 1. 先解决解析器 ──
  let parseYaml = null
  try {
    const req = createRequire(join(profile.dir, 'package.json'))
    const mod = req('yaml')
    parseYaml = (text) => mod.parse(text)
  } catch {
    try {
      const req = createRequire(join(profile.dir, 'package.json'))
      const mod = req('js-yaml')
      parseYaml = (text) => mod.load(text)
    } catch {
      parseYaml = null
    }
  }
  if (parseYaml === null) {
    console.log(`  ${yellow('!')} 从本 profile 的解析上下文里拿不到 yaml/js-yaml —— 跳过解析检查`)
    skipped += 1
    continue
  }

  // ── 2. YAML 能不能解析、形状对不对 ──
  let doc = null
  try {
    doc = parseYaml(readFileSync(patchPath, 'utf8'))
  } catch (error) {
    console.log(`  ${red('✗')} YAML 解析失败：${error?.message ?? error}`)
    failures += 1
    continue
  }
  if (!Array.isArray(doc)) {
    // 宿主把 patch 当**顶层数组**读；不是数组 = 这份 patch 等于空的（或直接报错）。
    console.log(`  ${red('✗')} 顶层不是数组（实际 ${doc === null ? 'null' : typeof doc}）——宿主按 patch 列表读它`)
    failures += 1
    continue
  }
  console.log(`  ${green('✓')} YAML 解析成功（${doc.length} 个顶层条目）`)

  // ── 3. 每个 @lh/* 行能不能解析到包、包有没有两半 ──
  const rows = []
  for (const entry of doc) {
    if (entry !== null && typeof entry === 'object' && Array.isArray(entry.insert)) {
      for (const row of entry.insert) rows.push(row)
    }
  }
  const lhRows = rows.filter((r) => r !== null && typeof r === 'object' && typeof r.name === 'string' && r.name.startsWith('@lh/'))

  if (lhRows.length === 0) {
    console.log(`  · 没有 @lh/* 的 insert 行`)
    continue
  }

  for (const row of lhRows) {
    checkedRows += 1
    const id = typeof row.id === 'string' ? row.id : '(无 id)'
    const short = row.name.replace(/^@lh\//, '')
    const pkgDir = join(profile.dir, 'node_modules', '@lh', short)
    const pkgJsonPath = join(pkgDir, 'package.json')

    if (!existsSync(pkgJsonPath)) {
      console.log(`  ${red('✗')} ${id} → ${row.name}：node_modules 里没有这个包（宿主会跳过这一行 → 入口静默消失）`)
      failures += 1
      continue
    }

    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    } catch (error) {
      console.log(`  ${red('✗')} ${id} → ${row.name}：package.json 读不出来（${error?.message ?? error}）`)
      failures += 1
      continue
    }

    const problems = []
    const entryRel = pkg.exports?.['.']?.default
    if (typeof entryRel !== 'string' || !existsSync(join(pkgDir, entryRel))) {
      problems.push(`exports["."] 指向的服务端半不存在（${String(entryRel)}）`)
    }
    // 客户端半是**界面能不能出现**的关键：宿主靠扫描 dsh.client + exports["./client"] 投放它。
    const clientRel = pkg.exports?.['./client']?.default
    if (pkg.dsh?.client !== undefined && (typeof clientRel !== 'string' || !existsSync(join(pkgDir, clientRel)))) {
      problems.push(`声明了 dsh.client 但 exports["./client"] 指不到文件（${String(clientRel)}）`)
    }
    // files 清单漏了入口 = 副本里不会有它（这是"改了没生效"的一种真因）。
    const declaredFiles = Array.isArray(pkg.files) ? pkg.files : null
    if (declaredFiles !== null && typeof entryRel === 'string' && !declaredFiles.includes(entryRel.replace(/^\.\//, ''))) {
      problems.push(`files 清单里没有服务端半 ${entryRel}（副本会缺文件）`)
    }

    if (problems.length === 0) {
      console.log(`  ${green('✓')} ${id} → ${row.name}@${pkg.version}${pkg.dsh?.client !== undefined ? '（含客户端半）' : ''}`)
    } else {
      for (const p of problems) console.log(`  ${red('✗')} ${id} → ${row.name}：${p}`)
      failures += 1
    }
  }
}

console.log('')
if (skipped > 0) console.log(dim(`  （${skipped} 个 profile 被跳过，原因见上）`))
if (failures > 0) {
  console.log(red(`══ ${failures} 项有问题。profile 的 patch 出错会让应用**直接起不来**，先修它。 ══`))
  process.exit(1)
}
console.log(green(`══ ${checkedRows} 个 @lh 行都能解析到包与两半，patch 也是合法 YAML。 ══`))
console.log(dim('  它证明不了"宿主会真的加载这个包"，只证明"启动时不会因为这两件事失败"。'))
