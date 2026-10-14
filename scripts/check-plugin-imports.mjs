/**
 * 闸门：检查每个装进 profile 的 LH 包，**用 profile 的解析上下文**能不能 import。
 *
 * ═══ 为什么必须有这个脚本（它是一次真实事故的产物）═══
 * 事故经过：`plugins/lh-practice/index.js` 里有
 *     import { … } from '../lh-question-bank/index.js'
 * 这个相对导入**只在源码目录成立**。pnpm 把包装进
 * `profiles/web/node_modules/@lh/practice` 之后，兄弟目录不再相对可达，
 * Node 按 ESM 规则把它解析成 `@lh/lh-question-bank`，抛 `ERR_MODULE_NOT_FOUND`。
 *
 * **而插件的导入失败会让整棵插件树加载失败 → dsh 完全无法启动。**
 *
 * ═══ 为什么当时"全部测试绿"却没拦住 ═══
 * 因为**测试跑在源码目录、生产跑在 install 后的副本里** ——
 * 两条路径的**模块解析不同**：
 *   · 源码目录：`../lh-question-bank/index.js` 能解析（兄弟目录真的在）
 *   · 生产副本：不能（`node_modules/@lh/` 下只有被安装的那几个包）
 * 我离线跑了 18 项断言全绿，而它们恰好绕过了真实的解析路径。
 *
 * ═══ 这个脚本补的就是那个缺口 ═══
 * 它不看源码目录，而是**把 profile 的已安装副本当作入口**去 import，
 * 于是走的是**生产路径**。失败就红。
 *
 * 用法: node scripts/check-plugin-imports.mjs
 * 退出码 0 = 全部可在生产路径解析；1 = 有包会拖垮启动。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { profilesDir, describeHome } from './lib/dsh-home.mjs'

/**
 * profile 目录（生产解析的起点）。
 *
 * ⚠ 这里原来**写死了** `USERPROFILE/.dsh/profiles/web|dev`。作者把开发迁到
 * "工作区自持"（`DSH_HOME` 指向仓库里的 `.dsh/`）之后，写死的路径会继续读**旧目录**——
 * 而本闸门的全部价值就是"import 的是**生产那份副本**"；指错了目录，
 * 它证明的东西就变成了**另一份代码**。现在按目录**实际存在什么**来枚举。
 */
const PROFILES = existsSync(profilesDir())
  ? readdirSync(profilesDir())
      .filter((name) => existsSync(join(profilesDir(), name, 'node_modules', '@lh')))
      .map((name) => join(profilesDir(), name))
  : []

console.log(describeHome('check-plugin-imports'))

/**
 * 列出某个 profile 里装的自有包（`@lh/*` 与 `lh-*`）。
 *
 * 只认**我们自己**的包：宿主的包（`@deepseek-ai/*`）不归本闸管，
 * 而且它们数量太多，全 import 一遍既慢又没意义。
 *
 * @param profileDir - profile 根目录。
 * @returns `{ name, dir, entry }[]`。
 */
/** 跳过的 bundle 声明包名（不是插件，见 collect 内说明）。 */
const skippedBundles = []

function listOwnPackages(profileDir) {
  const nm = join(profileDir, 'node_modules')
  if (!existsSync(nm)) return []
  const out = []

  /**
   * 收一个包的入口信息。
   *
   * @param name - 包名（含 scope）。
   * @param dir - 包目录。
   */
  function collect(name, dir) {
    if (!existsSync(dir)) return
    let entry = join(dir, 'index.js')
    try {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      // bundle 声明包（package.json 带 dsh.bundle.patch）不是插件：没有入口、没有 apply()。
      // 它的形状由 check-bundle.mjs 验；当插件查它只会误报"入口不存在"
      //（2026-10-13：@lh/bundle 装进 desktop profile 后本闸门误红过）。
      if (typeof pj?.dsh?.bundle?.patch === 'string') {
        skippedBundles.push(name)
        return
      }
      // 有 exports 时以 exports['.'] 为准；否则用 main；再不行退回 index.js
      const dot = pj.exports?.['.']
      const mainField = typeof dot === 'string' ? dot : (dot?.default ?? pj.main)
      if (typeof mainField === 'string') entry = join(dir, mainField)
    } catch {
      /* 没有 package.json 就用默认 index.js */
    }
    out.push({ name, dir, entry })
  }

  for (const name of readdirSync(nm)) {
    if (name.startsWith('@')) {
      const scopeDir = join(nm, name)
      for (const sub of readdirSync(scopeDir)) {
        // 只认 @lh/*：宿主的 @deepseek-ai/* 不归本闸管
        // （它们数量多、且是宿主自己的启动问题）
        if (name === '@lh') collect(`${name}/${sub}`, join(scopeDir, sub))
      }
      continue
    }
    if (name.startsWith('lh-')) collect(name, join(nm, name))
  }
  return out
}

/** 收集要检查的包（去掉重复：同一个真实路径只查一次）。 */
const targets = []
for (const profileDir of PROFILES) {
  if (!existsSync(profileDir)) continue
  for (const pkg of listOwnPackages(profileDir)) {
    targets.push({ ...pkg, profile: profileDir })
  }
}

if (targets.length === 0) {
  console.log('profile 里没有装 LH 自己的包（可能还没装，或路径不对）')
  console.log('检查过的位置：')
  for (const p of PROFILES) console.log(`  ${p}  exists=${existsSync(p)}`)
  process.exit(0)
}

console.log(`用 profile 的解析上下文检查 ${targets.length} 个包（走的是**生产路径**）`)
if (skippedBundles.length > 0) {
  console.log(`（跳过 ${skippedBundles.length} 个 bundle 声明包：${skippedBundles.join('、')} —— 不是插件，形状由 check-bundle.mjs 验）`)
}
console.log('')

let bad = 0
for (const t of targets) {
  const rel = t.dir.replace(process.env.USERPROFILE ?? '', '~')
  if (!existsSync(t.entry)) {
    console.log(`  ✗ ${t.name}`)
    console.log(`      入口不存在：${t.entry}`)
    bad += 1
    continue
  }
  try {
    // ⚠ 关键：import 的是 **profile 里那个副本**，不是源码目录。
    //   于是它内部的每一个 import 都按生产路径解析——正是事故的现场。
    await import(pathToFileURL(t.entry).href)
    console.log(`  ✓ ${t.name}`)
    console.log(`      ${rel}`)
  } catch (error) {
    bad += 1
    console.log(`  ✗ ${t.name}`)
    console.log(`      ${rel}`)
    console.log(`      ${error?.message ?? error}`)
    // 把 cause 链打出来：宿主报的错常常三层嵌套，最内层才是真因
    let cause = error?.cause
    let depth = 0
    while (cause && depth < 4) {
      console.log(`      ↳ ${cause?.message ?? cause}`)
      cause = cause?.cause
      depth += 1
    }
  }
}

console.log('')
if (bad > 0) {
  console.log(`══ ${bad} 个包在**生产路径**上无法加载。`)
  console.log('')
  console.log('这会让 dsh 完全无法启动（插件导入失败 → 整棵插件树加载失败）。')
  console.log('常见原因：包内用了相对路径去 import 别的插件（如 `../lh-question-bank/index.js`）。')
  console.log('修法：把它声明成本包的 file: 依赖，并改用包名 import。')
  process.exit(1)
}
console.log('══ 全部可在生产路径解析。')
console.log('')
console.log('注意：这只证明"能被 import"。它不能证明 apply() 不抛错、')
console.log('也不能证明行会激活（那需要真启动）。见 scripts/check-preset-mount.mjs。')
