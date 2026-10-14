/**
 * 闸门：**客户端插件在启动时不得注册到"还没声明的插槽"**。
 *
 * ═══ 为什么需要它（这个 bug 已经造成两次启动失败）═══
 * 2026-09-19 生产事故：`@lh/practice` 在 apply 里直接
 * `ctx.slots.register({ name: 'shell.overlay' }, …)`，而 `shell.overlay`
 * **不是内核内置插槽** —— 它由宿主 `ui-layout` 的 root 条目**在它 apply 时**才声明。
 * 浏览器 boot 是 `Promise.all` **并发**拉起所有客户端插件的，本插件的依赖
 * （slots/sessions，来自 runtime 核心）第一批就满足，于是**抢在 ui-layout 前面** apply：
 *
 *     slot "shell.overlay" is not declared
 *     → 插件 fiber 失败 → 启动屏 "Failed to load plugins" → **整个界面起不来**
 *
 * 修法是把注册挂进 `slots.inject('<插槽>', …)`：声明已存在就同步执行，
 * 否则推迟到声明提交那一刻。**启动顺序的责任交回宿主。**
 *
 * ═══ 为什么这道闸门必须存在（而不是只在某个插件的自测里）═══
 * 同一个 bug 在补修里**又出现了一次**：`shell.overlay` 改好了，
 * 而卡片挂的 `tool.call.toolview`（由 **ui-tool** 声明，同一种"晚声明"）
 * 仍是直接 register。它当时没暴露，只因为报错发生在第一个注册就中断了 apply，
 * **根本没走到卡片那一行**。第二次的后果形态还不同：有 try/catch 兜着，
 * 所以**不白屏**，而是**静默地少一个入口**。
 *
 * → 一条"某个插槽要小心"的经验救不了下一个插件。
 *   **这道闸门按"插件"普查，而不是按"已知出事的插槽"打补丁。**
 *
 * ═══ 它怎么判 ═══
 * 用一个假 `slots` 把每个客户端 bundle 真的 apply 一遍，而这个假 slots
 * **什么都不声明**（register 直接抛 SlotCore 的同款错）。断言两条：
 *   1. `apply()` **不抛错**（抛错在生产里就是白屏）；
 *   2. **零注册**（有任何注册落进来，就说明有人在插槽未声明时直接 register）。
 * 推迟掉几条（`inject` 的次数）也一并报出来，便于人核对条数对不对。
 *
 * ⚠ 它验不到的：真实宿主里插槽**什么时候**声明、以及推迟之后是否真的会被执行。
 *   那必须真启动才算数（本闸门只证明"不会因为抢跑而炸"）。
 * ⚠ 它自带一个**故意写坏**的合成 bundle**：先确认判据抓得住已知的坏形状，
 *   再去看真插件的结果——否则"全绿"可能只是判据不工作。
 *
 * 运行：node scripts/check-client-slot-timing.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = join(repoRoot, 'plugins')

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const red = (s) => c('31', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

/**
 * 把一个客户端 bundle 放进假环境跑 `apply()`。
 *
 * @param source - bundle 源码。
 * @param opts.declaredSlots - 一开始就**已声明**的插槽（真插件用空集：模拟"抢跑"）。
 * @returns `{ registrations, injected, error }`。
 */
function runBundle(source, { declaredSlots = new Set() } = {}) {
  const registrations = []
  const injected = []
  const pending = []

  const slots = {
    register: (opts) => {
      if (!declaredSlots.has(opts.name)) {
        // 与 SlotCore 的原文一致 —— 闸门要复现的是**生产那条报错**。
        throw new Error(`slot "${opts.name}" is not declared (a parent entry's children table must declare it)`)
      }
      registrations.push(opts)
      return () => {}
    },
    inject: (key, callback) => {
      injected.push(key)
      if (declaredSlots.has(key)) callback()
      else pending.push({ key, callback })
      return () => {}
    },
  }

  /** 未知服务一律给个宽容的桩：本闸门只关心 slots 的时序，不关心别的服务。 */
  const permissive = () => new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined
      return (..._args) => permissive()
    },
  })

  const ctx = new Proxy(
    { slots, sessions: { list: { getSnapshot: () => ({ current: null }), subscribe: () => () => {} } } },
    {
      get: (target, prop) => {
        if (prop in target) return target[prop]
        return permissive()
      },
    },
  )

  let captured = null
  const windowStub = {
    __ModuleLoader__: { load: (def) => { captured = def } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useSyncExternalStore: (_sub, get) => get(),
  }

  const requireStub = (id) => {
    if (id === 'react') return ReactStub
    return permissive()
  }

  try {
    // eslint-disable-next-line no-new-func
    new Function('window', source)(windowStub)
    if (captured === null) return { registrations, injected, error: 'bundle 没有调用 __ModuleLoader__.load' }
    const exported = captured.factory(requireStub)
    if (typeof exported.apply !== 'function') return { registrations, injected, error: '没有导出 apply' }
    exported.apply(ctx)
  } catch (error) {
    return { registrations, injected, error: error?.message ?? String(error) }
  }

  return { registrations, injected, error: null }
}

// ── 先确认判据抓得住已知的坏形状 ──────────────────────────────────────────

console.log('══ 0. 判据自检（拿故意写坏的 bundle 试它必须报警）══\n')

const BROKEN = `
window.__ModuleLoader__.load({
  id: '@lh/broken-fixture',
  factory: (require) => {
    var exports = {}
    exports.apply = (ctx) => {
      ctx.slots.register({ id: 'x', name: 'shell.overlay' }, () => null)
    }
    exports.inject = ['slots']
    return exports
  },
})
`

const GOOD = `
window.__ModuleLoader__.load({
  id: '@lh/good-fixture',
  factory: (require) => {
    var exports = {}
    exports.apply = (ctx) => {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ id: 'x', name: 'shell.overlay' }, () => null))
    }
    exports.inject = ['slots']
    return exports
  },
})
`

const brokenResult = runBundle(BROKEN)
const goodResult = runBundle(GOOD)

let selfTestOk = true
if (brokenResult.error === null) {
  console.log(red('  ✗ 判据抓不住"未声明就直接 register" —— 它给的绿都是假的'))
  selfTestOk = false
} else {
  console.log(`${green('  ✓')} 判据能抓住坏形状：${dim(brokenResult.error.slice(0, 80))}`)
}
if (goodResult.error !== null || goodResult.registrations.length !== 0) {
  console.log(red(`  ✗ 判据把好形状也判成了坏：error=${goodResult.error}`))
  selfTestOk = false
} else {
  console.log(`${green('  ✓')} 判据不误伤好形状（经 inject 推迟 → 零注册、零抛错）`)
}

if (!selfTestOk) {
  console.log(red('\n闸门自身不可信，停止。'))
  process.exit(1)
}

// ── 普查所有客户端 bundle ─────────────────────────────────────────────────

const pluginDirs = readdirSync(pluginsDir).filter((n) => existsSync(join(pluginsDir, n, 'package.json')))

console.log('\n══ 1. 普查：apply 时一个插槽都没声明（= 抢在最前面跑）══\n')

const failures = []
let checked = 0
let skipped = 0

for (const dirName of pluginDirs) {
  const pkgPath = join(pluginsDir, dirName, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    continue
  }
  const clientRel = pkg.exports?.['./client']?.default ?? pkg.exports?.['./client']
  if (typeof clientRel !== 'string' || pkg.dsh?.client === undefined) continue

  const file = join(pluginsDir, dirName, clientRel.replace(/^\.\//, ''))
  if (!existsSync(file)) continue

  const source = readFileSync(file, 'utf8')
  const label = pkg.name ?? dirName

  // 只普查"会注册插槽"的 bundle —— 其余不可能有这个竞态，逐个报"不参与"更诚实。
  if (!source.includes('slots.register')) {
    console.log(`${label.padEnd(22)} ${dim('没有 slots.register（不参与本闸门）')}`)
    skipped += 1
    continue
  }

  checked += 1
  const r = runBundle(source)
  const problems = []
  if (r.error !== null) problems.push(`apply 抛错：${r.error}`)
  if (r.registrations.length > 0) {
    problems.push(`插槽未声明却注册了 ${r.registrations.length} 个：${r.registrations.map((x) => x.name).join('、')}`)
  }

  if (problems.length === 0) {
    console.log(`${label.padEnd(22)} ${green('✓ 抢跑安全')}  ${dim(`推迟 ${r.injected.length} 条（${[...new Set(r.injected)].join('、')}）`)}`)
  } else {
    console.log(`${label.padEnd(22)} ${red('✗ 会在抢跑时炸')}`)
    for (const p of problems) console.log(`    ${red(p)}`)
    failures.push(`${label}: ${problems.join('；')}`)
  }
}

console.log('')
console.log(`普查 ${checked} 个会注册插槽的 bundle（另有 ${skipped} 个不注册，跳过）`)

if (failures.length > 0) {
  console.log('')
  console.log(red(`══ 失败 ${failures.length} 条 ══`))
  for (const f of failures) console.log(`  ${red('✗')} ${f}`)
  console.log('')
  console.log('  修法：把 `ctx.slots.register({name:' + "'<插槽>'" + '}, …)` 包进')
  console.log('        `ctx.slots.inject(' + "'<插槽>'" + ', () => ctx.slots.register(…))`。')
  console.log('  理由：`shell.overlay`（ui-layout 声明）与 `tool.call.toolview`（ui-tool 声明）')
  console.log('        都不是内核内置插槽，都是在各自插件 apply 时才声明的；')
  console.log('        而浏览器 boot 是并发的，本插件可能先跑。')
  process.exit(1)
}

console.log('')
console.log(green('══ 所有会注册插槽的客户端插件，在"插槽全未声明"时都不炸。 ══'))
console.log(dim('  边界：它证明的是"不会因为抢跑而炸"，不证明真实宿主里插槽何时声明、'))
console.log(dim('        也不证明推迟后的注册真的会被执行 —— 那要真启动才算数。'))
