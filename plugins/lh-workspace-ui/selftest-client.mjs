/**
 * lh-workspace-ui 的**客户端半**离线测试 —— 把 bundle 在 Node 里跑起来。
 *
 * ═══ 为什么值得为"客户端"搭一套假环境 ═══
 * 客户端半一直是最难验的一块：它只在浏览器里跑，而**浏览器里的错误只能靠眼睛发现**，
 * 而本项目的 AI 是**无头**的——它永远看不见界面。所以"面板能不能画出来"这件事
 * 必须由别的机制兜住，否则每次界面改动的验收成本都落在作者身上。
 *
 * 这套假环境证明的不是"好不好看"，而是三件**静默且昂贵**的事：
 *   1. **模块能被 factory 跑起来**（`exports.inject` 缺失 = 浏览器卡 `Failed to load plugins`）；
 *   2. **三个插槽都注册上了**（少一个 = 某个入口永不出现，而宿主**不报错**）；
 *   3. **组件真的能画**（组件里抛错 = 白屏；hook 顺序错 = React 直接炸）。
 *
 * ═══ 它比"桩"更进一步：fetch 打的是**真服务端半** ═══
 * `globalThis.fetch` 被接到本插件 `index.js` 注册的那条真路由上，于是这一条链
 * 在测试里是**真的**：客户端 → 路由 → @lh/course-tree/commands → 事件日志 → 投影 → 客户端。
 * 桩只桩掉浏览器（React / localStorage / DOM），**不桩业务**。
 *
 * 运行：node plugins/lh-workspace-ui/selftest-client.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠ 必须在调用之前设（paths.js 惰性求值）。
const sandbox = mkdtempSync(join(tmpdir(), 'lh-workspace-ui-client-selftest-'))
process.env.LH_DATA_DIR = sandbox
delete process.env.LH_EVENT_LOG

let pass = 0
let fail = 0

/**
 * 一条断言。
 * @param label - 断言说明。
 * @param ok - 是否成立。
 * @param detail - 失败时的补充。
 */
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail === '' ? '' : `  —— ${detail}`}`)
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 假浏览器：React / localStorage / __ModuleLoader__
// ══════════════════════════════════════════════════════════════════════════

/** hook 调用计数：hook 顺序错会让 React 直接抛，这里至少保证"数量稳定"。 */
let hookCalls = 0
const bump = () => {
  hookCalls += 1
}

/**
 * 待执行的 effect 队列。
 *
 * ═══ 为什么 effect 必须真的跑（第一版是 no-op，于是漏掉了一个真行为）═══
 * 第一版把 `useEffect` 写成空函数。后果不是"少测一点"，而是**测错了东西**：
 * 本插件用 effect 记录"最近一次显示在对话里的会话"，而"新对话该落在哪个工作区"
 * 就是靠它推出来的。effect 不跑 → 那个值永远是 null → 界面总是退回"第一个工作区"。
 * 断言于是失败在**测试替身上**，看起来像产品 bug。
 * 现在：effect 在组件函数返回后立即执行一次（React 也是在提交后跑），
 * 于是"跑两遍渲染"就等价于真实环境里"effect 触发一次重渲染"。
 */
let pendingEffects = []

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => {
    bump()
    return [typeof init === 'function' ? init() : init, () => {}]
  },
  useRef: (init) => {
    bump()
    return { current: init }
  },
  useCallback: (fn) => {
    bump()
    return fn
  },
  useEffect: (fn) => {
    bump()
    pendingEffects.push(fn)
  },
  useMemo: (fn) => {
    bump()
    return fn()
  },
  useSyncExternalStore: (_sub, get) => {
    bump()
    return get()
  },
}

/** localStorage 桩（记在内存里）。 */
const storage = new Map()
const localStorageStub = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
}

/** 捕获 factory 的假模块加载器。 */
let factory = null
const moduleLoader = {
  load: ({ id, factory: f }) => {
    factory = { id, f }
  },
}

/** 记录"重载界面"被调用了几次。 */
const reloadCalls = []

globalThis.window = {
  __ModuleLoader__: moduleLoader,
  localStorage: localStorageStub,
  // 假 location：只关心 reload 有没有被调到。
  location: { reload: () => reloadCalls.push('reload') },
  // 入场动画用 `window.setTimeout` 做延迟；假 window 也得有它，
  // 否则 effect 一跑就抛 —— 而那是**测试替身不全**，不是产品问题。
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
}

// ══════════════════════════════════════════════════════════════════════════
// 假 ctx：**声明感知**的 slots（抢跑要抛同款错，见 lh-practice 的注释）
// ══════════════════════════════════════════════════════════════════════════

/** 已声明的插槽。列表型/键控型都给一份：本插件不注册它们，但依赖它们已被声明。 */
const declared = new Set([
  'main',
  'sidebar.panellist',
  'shell.overlay',
  'settings.general.item',
])

/** 收集注册结果。 */
const registered = []

/** 待执行的 inject 回调（插槽尚未声明时排队）。 */
const pendingInjects = []

/** 假的 `ctx.layout`：记录 selectPanel 的调用。 */
const layoutCalls = []

/** 假的 `uiWorkspace`：记录 openSession 的调用。 */
const openSessionCalls = []

/**
 * 假的 `uiWorkspace.connectWorkspace`：**每次给一个新的会话 id**。
 *
 * 为什么必须让它每次返回新 id：它是"在课程下新建对话"能不能**绑得上**的唯一依赖。
 * 如果它返回 undefined，界面会走"新建失败"的降级分支——那也是一种正确行为，
 * 但测试就永远验不到"绑定真的发生了"，于是这条链看起来绿、实际从没跑过。
 * 所以这里显式给 id，并且把调用参数记下来供断言。
 */
const connectCalls = []
let nextSessionSeq = 1

const ctx = {
  slots: {
    inject: (key, callback) => {
      if (!declared.has(key)) {
        pendingInjects.push({ key, callback })
        return () => {}
      }
      callback()
      return () => {}
    },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
  layout: {
    selectPanel: (id) => layoutCalls.push(id),
  },
  get: (name) => {
    if (name === 'uiWorkspace') {
      return {
        openSession: (id) => openSessionCalls.push(id),
        connectWorkspace: (workspaceId) => {
          connectCalls.push(workspaceId)
          return Promise.resolve(`session-new-${nextSessionSeq++}`)
        },
      }
    }
    return undefined
  },
}

// ══════════════════════════════════════════════════════════════════════════
// 把 fetch 接到**真服务端半**上（桩浏览器，不桩业务）
// ══════════════════════════════════════════════════════════════════════════

const { apply: applyServerUi, ROUTE_PREFIX } = await import('./index.js')

/** 服务端半注册的路由选项。 */
let serverRoute = null
applyServerUi({
  effect: (fn) => fn(),
  on: () => {},
  webServer: {
    register: (options) => {
      serverRoute = options
      return () => {}
    },
  },
})

globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? 'GET'
  // ⚠ **要连查询串一起转发**，不能只取 pathname。
  //   第一版写成 `.split('?')[0]`，于是 `/impact?node=xxx` 到达服务端时没有 node 参数——
  //   而那只表现为"确认卡不出来"，看起来像界面 bug，实际是**测试替身悄悄吞了参数**。
  //   这种"替身与真实载体不同构"正是本项目记录过的形状（测试全绿、生产坏）。
  const rest = String(url).slice(ROUTE_PREFIX.length)
  const body = typeof options.body === 'string' ? options.body : ''
  const listeners = new Map()
  const req = {
    method,
    url: `${ROUTE_PREFIX}${rest}`,
    on(event, cb) {
      listeners.set(event, cb)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== '') listeners.get('data')?.(Buffer.from(body, 'utf8'))
    listeners.get('end')?.()
  })
  let status = 200
  let text = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(t) {
      text = t
    },
  }
  await serverRoute.handler(req, res)
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 跑起来
// ══════════════════════════════════════════════════════════════════════════

console.log('\n=== 1. bundle 能被加载并装配（缺 inject 就是"Failed to load plugins"） ===')

await import('./client.js')

check('__ModuleLoader__ 拿到了一个 factory', factory !== null, String(factory))
check('id 是 @lh/workspace-ui', factory?.id === '@lh/workspace-ui', String(factory?.id))

/**
 * 假 `require`：factory 的参数就是这个 —— 只认识 'react'（seed 里也只投放它和 react-dom）。
 * @param name - 模块名。
 * @returns 模块导出。
 */
function fakeRequire(name) {
  if (name === 'react') return ReactStub
  throw new Error(`selftest: 假 loader 不认识模块 ${JSON.stringify(name)}`)
}

/**
 * **递归**展开元素树：函数组件真的被调用，子组件也一样。
 *
 * ═══ 为什么这一步不能省（本测试第一版就栽在这里）═══
 * 桩版 `createElement` 只把 `{type, props}` 记下来。于是 `panel(props)` 里那个
 * `React.createElement(DirectoryBody, …)` **只是一个对象**——`DirectoryBody`
 * 从来没被调用，树、会话、空状态文案全都不会出现。
 * 那样得到的"绿"是**假的**：它证明的只是"最外层那一个组件没抛"，
 * 而真正会白屏的嵌套组件一个都没跑。
 * （这正是本项目反复记的形状：**绿得没有信息量，比红更危险**。）
 *
 * @param el - createElement 的产物（或数组 / 字符串 / null）。
 * @returns 展开后的普通对象树（宿主元素），函数组件已被调用。
 */
function render(el) {
  if (el === null || el === undefined || typeof el === 'boolean') return null
  if (typeof el === 'string' || typeof el === 'number') return el
  if (Array.isArray(el)) return el.map((child) => render(child))
  if (typeof el.type === 'function') {
    // 函数组件：调用、**把它的 effect 跑掉**，再继续展开它的返回。
    const out = el.type(el.props ?? {})
    const effects = pendingEffects
    pendingEffects = []
    for (const fn of effects) {
      try {
        fn()
      } catch (error) {
        throw new Error(`effect 抛错：${error?.message ?? error}`)
      }
    }
    return render(out)
  }
  return {
    type: el.type,
    props: el.props,
    children: (el.children ?? []).map((child) => render(child)),
  }
}

/**
 * 深度优先找一个满足条件的元素。
 *
 * ⚠ 必须在**模块作用域**：第一版把它写在 `=== 4 ===` 的块里，于是后面的小节
 * 全都够不着它（块级作用域），只能各写一遍——那种"每节抄一遍"的辅助函数
 * 迟早会有一处抄歪。
 *
 * @param node - 渲染树节点。
 * @param pred - 判定函数。
 * @returns 命中的元素或 null。
 */
function findElement(node, pred) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, pred)
      if (hit !== null) return hit
    }
    return null
  }
  if (pred(node)) return node
  return findElement(node.children, pred)
}

/**
 * 找所有"标签为某几个之一"的按钮元素。
 *
 * 凭什么认出按钮：本插件的按钮都是 `createElement('button', {...}, label)`，
 * 所以 `type === 'button'` 且 children 里含目标标签。这样断言的是**学习者看得到的那颗按钮**，
 * 而不是某个内部函数。
 *
 * @param node - 渲染树。
 * @param labels - 目标标签数组。
 * @returns 命中的元素数组。
 */
function findButtons(node, labels) {
  const out = []
  const walk = (n) => {
    if (n === null || n === undefined || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const child of n) walk(child)
      return
    }
    if (n.type === 'button') {
      const text = (n.children ?? []).filter((c) => typeof c === 'string').join('')
      if (labels.some((label) => text === label || text.includes(label))) out.push(n)
      return
    }
    walk(n.children)
  }
  walk(node)
  return out
}

/**
 * 找所有 `title` 里含某个片段的按钮元素。
 *
 * ═══ 为什么需要它（本测试第一版栽在这里）═══
 * 行内操作是**字形按钮**（`＋` / `✎` / `✕`），文字匹配找不到它们。
 * 按 `title` 找是对的：那也是**学习者悬停时真正看到的那句话**，
 * 所以断言落在"人能看到的东西"上，而不是某个内部函数名。
 *
 * @param node - 渲染树。
 * @param needle - title 里要包含的片段。
 * @returns 命中的元素数组。
 */
function findButtonsByTitle(node, needle) {
  const out = []
  const walk = (n) => {
    if (n === null || n === undefined || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const child of n) walk(child)
      return
    }
    if (n.type === 'button' && typeof n.props?.title === 'string' && n.props.title.includes(needle)) out.push(n)
    walk(n.children)
  }
  walk(node)
  return out
}

/** 左列（课程树那一栏）的判定：它的宽度是写死的 320px。断言"树折起来了"必须只看它。 */
const isLeftColumn = (el) => el?.props?.style?.width === '320px'

// ── 宿主给的 standard props（模块级：后面每一节都拿同一份）──
//
// `main` 槽确实提供 useSessions / useWorkspaces（Cordis Inspect 的 catalog.standardProps 实测）。
// 会话行带上 `cwd`：新建对话要挑"当前对话所在的工作区"，那个匹配就靠它。
//
// ⚠ 夹具里的路径**刻意不是绝对路径**（`ws-one` 而不是 `D:\ws-one`）：
//   这条测试要验的是"工作区的 path 与会话的 cwd **相等**时被挑中"，
//   与盘符无关。写成绝对路径会让 `check-hardcoded-paths` 闸门正确地报红，
//   而给它加例外标记又等于把"夹具"当成"合理的写死"——那会稀释那条闸门。
const sessionsSnapshot = {
  byId: {
    'session-a': { id: 'session-a', title: '问一道资料分析', retainedBy: { mainView: 1 }, cwd: 'ws-one' },
    'session-b': { id: 'session-b', title: '辨析增长率', retainedBy: { mainView: 0 }, cwd: 'ws-two' },
  },
}
const workspacesSnapshot = {
  items: [
    { workspaceId: 'ws-2', path: 'ws-two', title: 'ws-two' },
    { workspaceId: 'ws-1', path: 'ws-one', title: 'ws-one' },
  ],
}
const props = {
  useSessions: (sel) => sel(sessionsSnapshot),
  useWorkspaces: (sel) => sel(workspacesSnapshot),
}

const exports_ = factory.f(fakeRequire)
check('导出了 apply', typeof exports_.apply === 'function')
check('导出了 name', exports_.name === 'lh-workspace-ui', String(exports_.name))
check('导出了 inject 且是数组', Array.isArray(exports_.inject), JSON.stringify(exports_.inject))
check('inject 含 slots', exports_.inject?.includes('slots'))
check('inject 含 layout', exports_.inject?.includes('layout'))

// 未声明的插槽必须排队等声明，而不是抢跑去 register。
check('装载时没有未声明插槽的 inject 被立即执行', pendingInjects.length === 0, JSON.stringify(pendingInjects.map((p) => p.key)))

exports_.apply(ctx)

console.log('\n=== 2. 三个插槽都注册上了（少一个 = 入口静默消失） ===')
{
  const byName = new Map(registered.map((r) => [r.options.name, r.options]))
  check('注册了 main', byName.has('main'), JSON.stringify([...byName.keys()]))
  check('main 的 key 是 lh', byName.get('main')?.key === 'lh', String(byName.get('main')?.key))
  check('注册了 sidebar.panellist', byName.has('sidebar.panellist'))
  check('panellist 的 id 与 main 的 key **同名**（不同名就点不动）',
    byName.get('sidebar.panellist')?.id === byName.get('main')?.key,
    `${byName.get('sidebar.panellist')?.id} vs ${byName.get('main')?.key}`)
  check('注册了 shell.overlay 兜底', byName.has('shell.overlay'))
  check('注册了 settings.general.item（左下 Settings 里的重载行）',
    byName.get('settings.general.item')?.id === 'lh-reload-ui',
    JSON.stringify([...byName.keys()]))
  check('三个条目的 component 都是函数', [...byName.values()].every((o) => {
    const entry = registered.find((r) => r.options === o)
    return typeof entry?.component === 'function'
  }))
}

console.log('\n=== 2.5 面板被"恢复成选中态"时，必须自己去取数 ===')
{
  // ══════════════════════════════════════════════════════════════════════
  // 这一节钉的是**真机上"课程全没了"那个假象的根因**。
  //
  // 宿主记得上次选中的面板（layout store 的 activePanelId），所以重启/重载之后
  // 课程目录可能**直接被挂载**——那条路径不经过 `openDirectory()`，
  // 而第一版的 `load()` 只在 openDirectory 里调。结果：标题显示「课程 0」、
  // 左列写「还没有课程」、右列写「左边还没有选中的课程」，**并且一条错误都没有**。
  // ══════════════════════════════════════════════════════════════════════
  const panel = registered.find((r) => r.options.name === 'main')?.component

  // 先在**不经过界面**的情况下往真日志里放一门课（模拟"以前就建好的课程"）。
  await fetch(`${ROUTE_PREFIX}/course`, { method: 'POST', body: JSON.stringify({ title: '早先就有的课' }) })

  // 此刻模块状态里 data 仍是 null（没人点过侧栏图标）——正是被恢复时的状态。
  const first = JSON.stringify(render(panel(props)))
  check('还没取到数时不谎报"还没有课程"', !first.includes('还没有课程'), first.slice(0, 300))
  check('显示的是"正在读取"（或已由 effect 取到）', first.includes('正在读取课程目录') || first.includes('早先就有的课'), first.slice(0, 300))

  // 渲染时 effect 已经触发了 load()，把微任务放完。
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0))

  const settled = JSON.stringify(render(panel(props)))
  check('**没人点任何按钮，面板自己把课程取回来了**', settled.includes('早先就有的课'), settled.slice(0, 400))
  check('左列标题不再是 0', !settled.includes('课程\\"') || settled.includes('早先就有的课'))

  // 收拾干净：把这门课删掉，让后面的小节从空树开始。
  const tree = await (await fetch(`${ROUTE_PREFIX}/tree`)).json()
  const node = tree.nodes.find((n) => n.title === '早先就有的课')
  await fetch(`${ROUTE_PREFIX}/delete`, { method: 'POST', body: JSON.stringify({ node_id: node.node_id, confirm: true }) })
  const after = await (await fetch(`${ROUTE_PREFIX}/tree`)).json()
  check('测试留下的课程已清理（后面的小节从空树开始）', after.node_count === 0, String(after.node_count))
}

console.log('\n=== 3. 侧栏图标：点一下要真的切面板并取数 ===')
{
  const icon = registered.find((r) => r.options.name === 'sidebar.panellist')?.component
  const el = icon({ size: 18, active: false })
  check('图标渲染出元素', el !== null && typeof el === 'object')
  check('图标有 title', el?.props?.title === '课程目录', String(el?.props?.title))
  check('图标有 onClick', typeof el?.props?.onClick === 'function')

  el.props.onClick()
  check('点击调用了 selectPanel("lh")', layoutCalls.includes('lh'), JSON.stringify(layoutCalls))

  // 等 fetch 那一轮微任务跑完。
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0))
}

console.log('\n=== 4. 面板组件：画得出来，且数据是真的 ===')
{
  const panel = registered.find((r) => r.options.name === 'main')?.component

  // 宿主给的 standard props（`main` 槽确实提供 useSessions / useWorkspaces，见 Inspect 的 standardProps）。
  // 它们是模块级的 `props`（见上方定义）——后面的小节都要用同一个。

  let tree = null
  let threw = null
  try {
    tree = panel(props)
  } catch (error) {
    threw = error
  }
  check('面板渲染不抛错', threw === null, String(threw?.message ?? ''))
  check('渲染出了元素树', tree !== null && tree !== undefined)

  const flat = JSON.stringify(render(tree))
  check('面板标题里有「课程目录」', flat.includes('课程目录'))

  // 这时还建过任何课程吗？没有——应该给出"还没有课程"的引导，而不是白屏或报错。
  // 这是"空状态"必须验的那一条：空状态是最常见的首屏，也是最容易白屏的一屏。
  check('空树时给的是引导文案，不是白屏', flat.includes('还没有课程'), flat.slice(0, 400))

  // 用真路由建一门课 + 建子课程，再刷新面板，验证界面真的画得出来。
  await fetch(`${ROUTE_PREFIX}/course`, { method: 'POST', body: JSON.stringify({ title: '行测' }) })
  await fetch(`${ROUTE_PREFIX}/course`, { method: 'POST', body: JSON.stringify({ title: '资料分析', parent_id: '行测' }) })
  const icon = registered.find((r) => r.options.name === 'sidebar.panellist')?.component
  icon({}).props.onClick()
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0))

  const rendered = render(panel(props))
  const refreshed = JSON.stringify(rendered)
  check('刷新后画出了「行测」', refreshed.includes('行测'), refreshed.slice(0, 400))
  check('刷新后画出了子课程「资料分析」', refreshed.includes('资料分析'))
  check('刷新后画出了会话标题（未归课列表）', refreshed.includes('问一道资料分析'))
  check('未归课程要求先建课程时给了入口', refreshed.includes('建顶层课程') || refreshed.includes('子课程'))

  // ── 折叠：用户明确要的那一条（"可折叠的课程区域"）──
  // 找那个折叠头（它带 title，对学习者也是悬停提示）并点一下。
  // （`findElement` / `isLeftColumn` 在模块作用域，见上面的定义。）
  const header = findElement(rendered, (el) => el?.props?.title === '折起课程区')
  check('课程区有一个可点的折叠头', header !== null && typeof header?.props?.onClick === 'function')
  check('折起前左列有课程行', JSON.stringify(findElement(rendered, isLeftColumn)).includes('行测'))
  check('折起前左列有子课程行', JSON.stringify(findElement(rendered, isLeftColumn)).includes('资料分析'))
  if (header !== null) {
    header.props.onClick()
    const afterCollapse = render(panel(props))
    const leftAfter = JSON.stringify(findElement(afterCollapse, isLeftColumn))
    check('点一下之后**左列**的课程树收起来了', !leftAfter.includes('行测'), leftAfter.slice(0, 300))
    check('折起状态写进了浏览器本地（刷新后还记得）', storage.get('lh.course.treeOpen') === '0', String(storage.get('lh.course.treeOpen')))
    // 再点回来，免得影响后面的断言。
    const reopen = findElement(afterCollapse, (el) => el?.props?.title === '展开课程区')
    check('折起后折叠头的提示变成「展开课程区」', reopen !== null)
    reopen?.props?.onClick?.()
    check('再点一下能展开回来', JSON.stringify(findElement(render(panel(props)), isLeftColumn)).includes('行测'))
  }
}

console.log('\n=== 5. 宿主的 useSessions 缺席时：降级但不白屏 ===')
{
  const panel = registered.find((r) => r.options.name === 'main')?.component
  let tree = null
  let threw = null
  try {
    tree = panel({})
  } catch (error) {
    threw = error
  }
  check('没有 useSessions 也不抛错', threw === null, String(threw?.message ?? ''))
  const flat = JSON.stringify(render(tree))
  check('如实说明降级原因', flat.includes('useSessions'), flat.slice(0, 200))
  check('树仍然画出来（不是整块白屏）', flat.includes('课程'))
}

console.log('\n=== 6. 浮层兜底：关着的时候必须是 null（hook 先行） ===')
{
  const overlay = registered.find((r) => r.options.name === 'shell.overlay')?.component
  // main 注册成功 → 浮层永远不渲染（它只是"万一面板没注册上"的退路）。
  let el = null
  let threw = null
  try {
    el = overlay({})
  } catch (error) {
    threw = error
  }
  check('浮层渲染不抛错', threw === null, String(threw?.message ?? ''))
  check('main 已注册时浮层返回 null', el === null, JSON.stringify(el)?.slice(0, 120))
}

console.log('\n=== 7. hook 调用次数为 0 说明组件根本没被画（这是最容易骗过自己的绿） ===')
check('假 React 的 hook 计数 > 0（组件真的跑了）', hookCalls > 0, String(hookCalls))

// ══════════════════════════════════════════════════════════════════════════
// 第二轮新增的三块：课程操作按钮组 / 对话索引 / 删除两段式 / 新建对话
//
// 这一组验的是**作者明确要的功能**能不能走到，而不是"代码看起来对"：
// 每个断言都点一个真按钮（或调一个真组件）、打真路由、看结果。
// ══════════════════════════════════════════════════════════════════════════

console.log('\n=== 8. 课程操作收在一个「⋯」里（右对齐），点开才展开 ===')
{
  const panel = registered.find((r) => r.options.name === 'main')?.component
  const rendered = render(panel(props))
  const left = findElement(rendered, isLeftColumn)
  const leftText = JSON.stringify(left)

  // 作者 2026-10-08 的两次要求合起来是：动作从右列搬到**左列的行里**，
  // 而且"三个图标的界面太混乱" → **收成一个「⋯」**，点开才展开。
  const dots = findButtonsByTitle(left, '的操作')
  check('每个可见行有一个「⋯」（2 个节点 → 2 个）', dots.length === 2, String(dots.length))

  // 收起来的状态下，左列**不该**出现那三个动作的按钮（那才是"不混乱"）。
  check('收起时左列没有「改名」按钮', findButtons(left, ['改名']).length === 0)
  check('收起时左列没有「删除」按钮', findButtons(left, ['删除']).length === 0)
  // ⚠ 只数**行内**那三个字形：标题旁那个 ＋（建顶层课程）是保留的，不该被这条误伤。
  check('收起时左列没有 ✎ / ✕ 这两个只属于行内的字形',
    !leftText.includes('"✎"') && !leftText.includes('"✕"'), leftText.slice(0, 200))
  check('左列只有一个 ＋（标题旁建顶层课程），行里没有',
    [...leftText.matchAll(/"＋"/g)].length === 1,
    String([...leftText.matchAll(/"＋"/g)].length))

  // 右对齐：行尾那个「⋯」所在容器必须有 `marginLeft: auto`。
  const trailing = findElement(left, (el) => el?.props?.style?.marginLeft === 'auto')
  check('行尾（徽章 + ⋯）是 marginLeft:auto 右对齐的', trailing !== null)

  check('「课程」标题旁有「建顶层课程」', findButtonsByTitle(left, '建一门顶层课程').length > 0)

  // 说明性文案按作者要求压掉。
  check('没有"层级与名字会自动进入上下文"这类解释', !JSON.stringify(rendered).includes('会自动进入'), '')
  check('没有"（课程区已折起，里面还有…）"这句补丁文案', !JSON.stringify(rendered).includes('课程区已折起'), '')
  check('没有"另有 N 个节点已被删除"这句', !JSON.stringify(rendered).includes('已被删除、不再显示'), '')

  // 点「⋯」→ 三个动作在**那一行**下面展开。
  dots[0].props.onClick()
  const opened = render(panel(props))
  const leftOpened = findElement(opened, isLeftColumn)
  check('点「⋯」展开动作条（在左列里）', findElement(leftOpened, (el) => el?.type !== undefined) !== null)
  check('展开后能看到「子课程」', findButtons(leftOpened, ['子课程']).length > 0)
  check('展开后能看到「改名」', findButtons(leftOpened, ['改名']).length > 0)
  check('展开后能看到「删除」', findButtons(leftOpened, ['删除']).length > 0)

  // 动作条里的「改名」→ 输入框出现在那一行下面。
  findButtons(leftOpened, ['改名'])[0].props.onClick()
  const afterRename = render(panel(props))
  const leftAfter = findElement(afterRename, isLeftColumn)
  check('点动作条里的「改名」会在**左列**展开输入框', findElement(leftAfter, (el) => el?.type === 'input') !== null)
  check('改名用输入框，而不是 window.prompt（后者在 Electron 里不可用）',
    findElement(leftAfter, (el) => el?.type === 'input')?.props?.placeholder === '行测')
  check('输入框出现后动作条收起（同一时刻只有一个东西展开）',
    findButtons(leftAfter, ['子课程']).length === 0)
}

console.log('\n=== 9. 删除：两段式（先看影响面，再确认） ===')
{
  const panel = registered.find((r) => r.options.name === 'main')?.component

  /** 打开某一行的「⋯」，返回那一行展开后的左列渲染。 */
  const openRowMenu = (index) => {
    const left0 = findElement(render(panel(props)), isLeftColumn)
    findButtonsByTitle(left0, '的操作')[index].props.onClick()
    return findElement(render(panel(props)), isLeftColumn)
  }

  const menu = openRowMenu(0)
  check('删除按钮的提示里写明"会先列出影响面"',
    String(findButtons(menu, ['删除'])[0]?.props?.title).includes('影响面'))

  // 第一段：点动作条里的「删除」→ 界面去取影响面（打真路由 /impact），**此时什么都没删**。
  findButtons(menu, ['删除'])[0].props.onClick()
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0))

  const confirming = render(panel(props))
  const confirmText = JSON.stringify(confirming)
  check('出现了确认卡', confirmText.includes('确认删除'))
  // ⚠ 断言要落在**确认卡那一句独有的文案**上。第一版只查 '资料分析'，
  //   而那个名字在左列树上本来就有——于是它"通过"了，却什么也没证明。
  check('确认卡里列出了会一起消失的子课程名',
    confirmText.includes('会一起消失的子课程') && confirmText.includes('资料分析'), confirmText.slice(0, 400))
  check('确认卡说明了"对话不会被删除"', confirmText.includes('不会被删除'))
  check('确认卡出现在**左列**（跟着那一行）',
    JSON.stringify(findElement(confirming, isLeftColumn)).includes('确认删除'))

  // 此时树还在（预览不写任何东西）。
  const stillThere = render(panel(props))
  check('**预览阶段树没变**（点删除不等于删）',
    JSON.stringify(findElement(stillThere, isLeftColumn)).includes('行测'))

  // 第二段：确认。删的是「行测」，它的子课程「资料分析」应一起消失。
  const confirmBtn = findButtons(confirming, ['确认删除'])[0]
  check('有「确认删除」按钮', confirmBtn !== undefined)
  await confirmBtn.props.onClick()
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0))

  const after = render(panel(props))
  const left = JSON.stringify(findElement(after, isLeftColumn))
  // ⚠ 不能断言"左列里没有『行测』这三个字"——空状态的提示语里就写着"例如「行测」"，
  //   那样断言会在"树真的空了"的时候反而失败（假阴性），而它测的其实是文案。
  //   正确的判据是"左列进入了空状态"。
  check('确认后左列进入"还没有课程"的空状态（行测与子课程都没了）',
    left.includes('还没有课程') && !left.includes('资料分析'), left.slice(0, 300))
  // ⚠ 这一条**断言的是"那句话不在了"**：第一版在左列写过
  //   「（另有 N 个节点已被删除、不再显示）」，作者 2026-10-08 明确要求去掉它。
  //   所以这里反过来钉住"别再把它加回来"——同时下面那条仍然保证
  //   **被删课程的对话不会跟着消失**（那才是真正要防的事）。
  check('按作者要求，那句"另有 N 个节点已被删除"不再出现',
    !JSON.stringify(after).includes('已被删除、不再显示'), '')

  // 删完之后，原来绑在它下面的会话应当回到"未归课"（索引里看得出来）。
  const idx = JSON.stringify(after)
  check('被删课程的对话回到未归课（索引里仍看得见那段对话）', idx.includes('问一道资料分析') || idx.includes('辨析增长率'))
}

console.log('\n=== 10. 对话索引：所有对话一张表 + 过滤 ===')
{
  const panel = registered.find((r) => r.options.name === 'main')?.component
  const rendered = render(panel(props))
  const text = JSON.stringify(rendered)
  check('有「对话索引」标题', text.includes('对话索引'))
  check('索引里列了全部对话（含未归课的）', text.includes('问一道资料分析') && text.includes('辨析增长率'))
  check('索引行有"未归课"徽章', text.includes('未归课'))
  check('索引行有短 id（便于与日志对照）', text.includes('on-a') || text.includes('session-a'))

  // 过滤：输入一个匹配「辨析」的词，另一条应当被滤掉。
  const box = findElement(rendered, (el) => el?.props?.placeholder === '按标题或 id 过滤…')
  check('索引有一个过滤输入框', box !== null)
  box.props.onChange({ target: { value: '辨析' } })
  const filtered = JSON.stringify(render(panel(props)))
  check('过滤后只剩匹配的那条', filtered.includes('辨析增长率') && !filtered.includes('问一道资料分析'), filtered.slice(0, 300))
  box.props.onChange({ target: { value: '' } })
  check('清空过滤后两条都回来',
    JSON.stringify(render(panel(props))).includes('问一道资料分析'))
}

console.log('\n=== 11. 在课程下新建对话并**建立索引** ===')
{
  // 先建一门课（前面的删除把树清空了）。
  await fetch(`${ROUTE_PREFIX}/course`, { method: 'POST', body: JSON.stringify({ title: '申论' }) })
  const panel = registered.find((r) => r.options.name === 'main')?.component
  const icon = registered.find((r) => r.options.name === 'sidebar.panellist')?.component
  icon({}).props.onClick()
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0))

  const rendered = render(panel(props))
  const newBtn = findButtons(rendered, ['＋ 新对话'])[0]
  check('有「＋ 新对话」按钮', newBtn !== undefined)
  check('按钮没被禁用（有可用工作区）', newBtn?.props?.disabled !== true)

  // ⚠ 渲染**两遍**：第一遍的 effect 才会记下"最近显示在对话里的会话"，
  //   第二遍才用得上它。真实 React 里这就是"effect 触发一次重渲染"。
  const renderedAgain = render(panel(props))
  const newBtn2 = findButtons(renderedAgain, ['＋ 新对话'])[0]

  const connectBefore = connectCalls.length
  await newBtn2.props.onClick()
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0))

  check('调用了 connectWorkspace（拿新会话 id 的唯一公开面）', connectCalls.length === connectBefore + 1, JSON.stringify(connectCalls))
  check('挑的工作区是"当前对话所在的那个"（session-a 的 cwd = D:\\ws-one）',
    connectCalls[connectCalls.length - 1] === 'ws-1', JSON.stringify(connectCalls))
  check('新对话被导航过去打开', openSessionCalls.length > 0, JSON.stringify(openSessionCalls))

  // 关键：**绑定真的发生了**——查真日志，而不是看界面文案。
  const view = await (await fetch(`${ROUTE_PREFIX}/tree`)).json()
  const boundTo = Object.entries(view.session_bindings).find(([, nodeId]) => {
    const n = view.nodes.find((x) => x.node_id === nodeId)
    return n?.title === '申论'
  })
  check('新对话真的被写进了课程索引（服务端树里查得到）', boundTo !== undefined, JSON.stringify(view.session_bindings))
  // 而它确实在界面上也显示为这门课的对话。
  check('界面把这个新对话列在「申论」下',
    JSON.stringify(render(panel(props))).includes(String(boundTo?.[0] ?? '')) || JSON.stringify(render(panel(props))).includes('这门课的对话'),
    String(boundTo?.[0] ?? ''))
}

console.log('\n=== 12. 色彩与动效：只能用主题令牌 + 内联 transition ===')
{
  const panel = registered.find((r) => r.options.name === 'main')?.component
  const text = JSON.stringify(render(panel(props)))
  check('渲染结果里出现主题令牌（不是写死的颜色）', text.includes('var(--dsw-alias-'))
  // 写死的十六进制只允许出现在 `var(--令牌, 兜底)` 的兜底位。
  // 抓"不跟着 var( 的裸色值"——那才是会在另一种模式下坏掉的东西。
  const nakedHex = [...text.matchAll(/"([^"]*#[0-9a-fA-F]{3,8}[^"]*)"/g)]
    .map((m) => m[1])
    .filter((s) => !s.includes('var(--dsw-alias-'))
  check('没有"不挂在令牌上的"裸颜色', nakedHex.length === 0, JSON.stringify(nakedHex.slice(0, 3)))
  check('用了语义状态色（未归课=warn、当前=success、删除=error）',
    text.includes('state-warn-primary') || text.includes('state-success-primary') || text.includes('state-error-primary'))
  check('有 transition（动效的最小可表达形态）', text.includes('transition'))
  check('折叠箭头用 transform 旋转表达开合', text.includes('rotate(90deg)') || text.includes('rotate('))
}

console.log('\n=== 13. 左下 Settings 里的「重载界面」行：按钮真的会重载 ===')
{
  const row = registered.find((r) => r.options.name === 'settings.general.item')?.component
  check('注册的组件是函数', typeof row === 'function')

  let el = null
  let threw = null
  try {
    el = render(row({}))
  } catch (error) {
    threw = error
  }
  check('行渲染不抛错（这一行的 schema 规定**拿不到任何 props**，必须自包含）',
    threw === null, String(threw?.message ?? ''))
  const text = JSON.stringify(el)
  check('行里自己画了标签（宿主不会替它投影 label）', text.includes('重载界面'))
  check('行里说明了它只重载页面、不动进程', text.includes('重启应用') || text.includes('重新加载'))

  const btn = findButtons(el, ['重载界面'])[0]
  check('行里有一颗可点的按钮', btn !== undefined && typeof btn?.props?.onClick === 'function')
  const before = reloadCalls.length
  btn?.props?.onClick?.()
  check('点它真的调了 location.reload()', reloadCalls.length === before + 1, JSON.stringify(reloadCalls))
}

// ── 收尾：只删自己建的那一个沙箱目录 ──
rmSync(sandbox, { recursive: true, force: true })

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
if (fail > 0) process.exit(1)
