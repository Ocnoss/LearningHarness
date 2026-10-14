/**
 * 闸门：profile 里的 LH 插件，**apply() 会不会抛错**。
 *
 * ═══ 为什么需要它（承接"导入闸门"）═══
 * `check-plugin-imports.mjs` 只证明"模块能被 import"。
 * 但一次事故的代价不只来自 import —— **apply() 抛错同样会让插件树加载失败、dsh 起不来**。
 * 而这两件事都在 profile/host 层，比 agent preset 层的失败更严重。
 *
 * 所以本脚本再往前一步：用一个**记账式的假 ctx** 真跑一遍每个插件的 `apply()`，
 * 看它抛不抛、注册了什么、声明 inject 的东西有没有人来给。
 *
 * ═══ 它的边界（必须说清，否则会给人假的安全感）═══
 * 假 ctx 能验证：
 *   · apply() 不抛错；
 *   · 它注册了哪些工具 / 上下文 / 路由；
 *   · 它 inject 的服务名，是否在"宿主会提供的服务"清单里。
 * 假 ctx **不能**验证：
 *   · 宿主真的会按这个顺序、这个作用域调度；
 *   · 服务在真实启动时是否真的就绪；
 *   · 客户端半能否在浏览器跑起来。
 * → 所以它**不能替代一次真启动**。见 ARCHITECTURE §0.1 约束 6。
 *
 * 用法: node scripts/check-profile-apply.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { profilesDir, describeHome } from './lib/dsh-home.mjs'

/** 宿主会提供的服务名（白名单）。
 *
 * ⚠ 第一版没这份清单时，把 `tools`/`sessions`/`llm` 全报成"无提供者"——六条全是误报。
 * **满屏误报的检查器等于没有检查器**：人会学会忽略它，于是真的那条也被忽略。
 * 依据：ARCHITECTURE §0.1 约束 5（实测 preset 作用域能拿到这些），
 * 以及 web profile 的 bundle 组成（`webServer` 来自 `dsh-host-webserver` 行）。
 */
const HOST_SERVICES = new Set([
  'tools', 'sessions', 'llm', 'systemPrompt', 'sessionProjections',
  'jobs', 'skills', 'commands', 'approval', 'fs', 'shell', 'subagents',
  'webServer', 'invariants', 'storage', 'settings', 'workspaces',
])

/**
 * profile 位置。
 *
 * ⚠ 原来写死了 `USERPROFILE/.dsh/profiles/web|dev`。迁移到"工作区自持"之后那条路会指向
 * **旧目录**，于是这道闸门（它专门走**生产路径**跑 apply）证明的会是另一份代码。
 * 现在按 `DSH_HOME` 找，并按目录实际存在什么来枚举。
 */
const PROFILES = existsSync(profilesDir())
  ? readdirSync(profilesDir())
      .filter((name) => existsSync(join(profilesDir(), name, 'node_modules', '@lh')))
      .map((name) => join(profilesDir(), name))
  : []

console.log(describeHome('check-profile-apply'))

/**
 * 列出 profile 里装的 LH 自有包。
 *
 * @param profileDir - profile 根。
 * @returns `{ name, dir, entry }[]`。
 */
/** 跳过的 bundle 声明包名（不是插件，没有 apply()）。 */
const skippedBundles = []

function listOwnPackages(profileDir) {
  const nm = join(profileDir, 'node_modules')
  if (!existsSync(nm)) return []
  const out = []
  const lhDir = join(nm, '@lh')
  if (existsSync(lhDir)) {
    for (const sub of readdirSync(lhDir)) {
      const dir = join(lhDir, sub)
      let entry = join(dir, 'index.js')
      try {
        const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        // bundle 声明包（dsh.bundle.patch）不是插件：没有 apply()，形状由 check-bundle.mjs 验
        //（2026-10-13：@lh/bundle 装进 desktop profile 后本闸门误红过）。
        if (typeof pj?.dsh?.bundle?.patch === 'string') {
          skippedBundles.push(`@lh/${sub}`)
          continue
        }
        const dot = pj.exports?.['.']
        const mainField = typeof dot === 'string' ? dot : (dot?.default ?? pj.main)
        if (typeof mainField === 'string') entry = join(dir, mainField)
      } catch {
        /* 用默认 */
      }
      out.push({ name: `@lh/${sub}`, dir, entry })
    }
  }
  return out
}

/**
 * 造一个记账式假 ctx。
 *
 * @param log - 记录动作的数组。
 * @param pluginName - 当前插件名。
 * @returns 假 ctx。
 */
function makeProbeCtx(log, pluginName) {
  const ctx = {
    inject(names, cb) {
      const list = Array.isArray(names) ? names : [names]
      log.push({ kind: 'inject', plugin: pluginName, names: list })
      if (typeof cb === 'function') {
        // 服务视为已就绪（真实就绪与否不归本脚本管），但要记下回调是否抛错
        try {
          cb(makeProbeCtx(log, pluginName))
        } catch (error) {
          log.push({ kind: 'inject-cb-threw', plugin: pluginName, names: list, message: error?.message ?? String(error) })
        }
      }
      return ctx
    },
    on(event) {
      log.push({ kind: 'on', plugin: pluginName, event })
      return ctx
    },
    plugin(sub) {
      log.push({ kind: 'plugin', plugin: pluginName, value: typeof sub === 'function' ? sub.name || '(匿名)' : String(sub) })
      return ctx
    },
    effect(fn) {
      // 真跑一次并立刻 dispose：既验证它不抛错，也不留下副作用
      const dispose = fn()
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch {
          /* dispose 抛错不影响结论 */
        }
      }
      return () => {}
    },
    tools: { register: (def) => log.push({ kind: 'tool', plugin: pluginName, name: def?.name }) },
    systemPrompt: { context: (def) => log.push({ kind: 'context', plugin: pluginName, name: def?.name }) },
    webServer: {
      register: (route) => {
        log.push({ kind: 'route', plugin: pluginName, path: route?.path, routeKind: route?.kind })
        return () => {}
      },
    },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    // 补桩：宿主**确实提供** `sessionProjections`（第二方插件用它接统计）。
    // 不补的话，`lh-event-store` 的 inject 回调会因我的桩不全而报
    // "Cannot read properties of undefined (reading 'register')" ——
    // 那是**假 ctx 的缺陷**，不是插件的问题。而这类误报会让人学会忽略输出，
    // 于是真的问题也被忽略。所以宁可把桩补齐。
    sessionProjections: { register: () => () => {} },
    llm: { listProviders: () => [], stream: () => (async function* () {})() },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    set() {},
    get() {},
  }
  ctx.fork = () => ctx
  ctx.extend = () => ctx
  return ctx
}

const targets = []
for (const profileDir of PROFILES) {
  if (!existsSync(profileDir)) continue
  for (const p of listOwnPackages(profileDir)) targets.push({ ...p, profile: profileDir })
}

if (targets.length === 0) {
  console.log('profile 里没有装 LH 自己的包')
  process.exit(0)
}

console.log(`用记账式假 ctx 跑 ${targets.length} 个插件的 apply()（**生产路径**）`)
if (skippedBundles.length > 0) {
  console.log(`（跳过 ${skippedBundles.length} 个 bundle 声明包：${skippedBundles.join('、')} —— 没有 apply()，形状由 check-bundle.mjs 验）`)
}
console.log('')

const log = []
let bad = 0
let warned = 0

for (const t of targets) {
  if (!existsSync(t.entry)) {
    console.log(`  ✗ ${t.name}  入口不存在：${t.entry}`)
    bad += 1
    continue
  }
  let mod
  try {
    mod = await import(pathToFileURL(t.entry).href)
  } catch (error) {
    console.log(`  ✗ ${t.name}  import 失败：${error?.message ?? error}`)
    bad += 1
    continue
  }
  if (typeof mod.apply !== 'function') {
    console.log(`  ✗ ${t.name}  没有导出 apply（宿主不会挂载它）`)
    bad += 1
    continue
  }

  const inject = Array.isArray(mod.inject) ? mod.inject : mod.inject === undefined ? [] : [mod.inject]
  const missing = inject.filter((s) => !HOST_SERVICES.has(s))

  try {
    mod.apply(makeProbeCtx(log, t.name))
  } catch (error) {
    console.log(`  ✗ ${t.name}  apply() 抛错：${error?.message ?? error}`)
    bad += 1
    continue
  }

  if (missing.length > 0) {
    console.log(`  ⚠ ${t.name}  apply() 没抛错，但 inject 了未知服务：${missing.join(', ')}`)
    console.log(`      → 若宿主不提供它，这一行会静默等待；严重时整棵插件树加载失败。`)
    warned += 1
  } else {
    console.log(`  ✓ ${t.name}${inject.length ? `  (inject: ${inject.join(', ')})` : ''}`)
  }
}

console.log('\n  注册动作：')
for (const e of log.filter((x) => x.kind === 'tool')) console.log(`    工具      ${e.name}   ← ${e.plugin}`)
for (const e of log.filter((x) => x.kind === 'context')) console.log(`    上下文    ${e.name}   ← ${e.plugin}`)
for (const e of log.filter((x) => x.kind === 'route')) console.log(`    HTTP 路由 ${e.routeKind} ${e.path}   ← ${e.plugin}`)
for (const e of log.filter((x) => x.kind === 'plugin')) console.log(`    子插件    ${e.value}   ← ${e.plugin}`)

const cbThrew = log.filter((x) => x.kind === 'inject-cb-threw')
if (cbThrew.length > 0) {
  console.log('\n  inject 回调里抛错的：')
  for (const e of cbThrew) console.log(`    ${e.plugin} 等 [${e.names.join(', ')}]：${e.message}`)
}

console.log('')
if (bad > 0) {
  console.log(`══ ${bad} 个插件的 apply() 有问题 —— 这会让 dsh 起不来。`)
  process.exit(1)
}
console.log(`══ 全部 ${targets.length} 个插件的 apply() 跑通${warned ? `（${warned} 个有警告）` : ''}。`)
console.log('')
console.log('边界：假 ctx 不能证明宿主真的会这样调度，也不能证明服务真的就绪。')
console.log('      它只排除"apply 自身抛错"这一类启动失败。仍需一次真启动。')
