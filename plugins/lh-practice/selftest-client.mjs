/**
 * 客户端半的离线测试 —— 把 bundle 在 Node 里跑起来（用假的 loader 与 React）。
 *
 * ═══ 为什么值得为"客户端"搭这么一套假环境 ═══
 * 客户端半一直是最难验的一块：它只在浏览器里跑，而**浏览器里的错误只能靠眼睛发现**。
 * 这一轮加进来的东西恰好全是"眼睛很难发现"的类型：
 *
 *   - **对比色计算**（`readableOn`）：算错了就是浅底白字。模型看不到结果、
 *     测试原本也看不到——而学习者只会觉得"卡片坏了"。
 *   - **样式回退**（`resolveStyle`）：服务端加了新 token 而客户端没跟上时，
 *     正确行为是"那个旋钮没效果"，不是画出坏掉的东西。
 *
 * 这些都是纯函数，天生可离线验；障碍只是它们在被 `__ModuleLoader__` 调用的
 * factory 闭包里。所以这里造一个最小的假宿主把 factory 叫起来。
 *
 * ⚠ 这套假环境**不能**证明真实渲染正确（React 是桩、DOM 是桩）。
 * 它证明的是纯函数的取值——**变量的口径**，不是布局。
 *
 * 运行：node plugins/lh-practice/selftest-client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0
const failures = []

/**
 * 断言并计数。
 * @param label - 这条在验什么。
 * @param fn - 断言体。
 */
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL ${label}`)
    console.log(`       ${error.message.split('\n').join('\n       ')}`)
  }
}

// ── 造一个假宿主 ──────────────────────────────────────────────────────────

/**
 * 极简 React 桩。
 *
 * `createElement` 返回一个普通对象（不渲染），因为这里要验的是**取值**：
 * 组件函数不被调用也没关系——`__test` 里的纯函数不依赖 React。
 * hooks 都返回固定值，仅为让组件定义期的顶层调用不炸。
 *
 * ⚠ 每个 hook 都会**计数**：这是第 8 节验 "hook 顺序" 的手段（见那里的注释）。
 */
let hookCalls = 0
const bump = () => { hookCalls += 1 }

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => { bump(); return [typeof init === 'function' ? init() : init, () => {}] },
  useRef: (init) => { bump(); return { current: init } },
  useCallback: (fn) => { bump(); return fn },
  useEffect: () => { bump() },
  useMemo: (fn) => { bump(); return fn() },
  useSyncExternalStore: (_sub, get) => { bump(); return get() },
}

/** localStorage 桩：记在内存里。 */
const storage = new Map()

/** 收集宿主注册的插槽，便于断言"注册了什么"。 */
const registered = []

/**
 * 假插槽的"已声明"表 + 待执行的 inject 回调。
 *
 * ═══ 为什么要模拟"声明"这个概念 ═══
 * 生产事故（2026-09-19）：`shell.overlay` 由宿主 ui-layout 的 root 条目**在它 apply 时**
 * 才声明，而浏览器是**并发**拉起所有客户端插件的 —— 本插件可能先跑。
 * 那时直接 `slots.register` 会被 SlotCore 抛
 * `slot "shell.overlay" is not declared`，整个界面起不来。
 * 修法是把注册挂进 `slots.inject('shell.overlay', …)`，声明到达才执行。
 * 这里的假 slots 把这两条语义都演出来：register 对未声明的插槽**抛同款错**，
 * inject 先把回调存下，`declareSlot()` 模拟"宿主声明了该插槽"这一刻。
 */
const declaredSlots = new Set()
const pendingInjects = []

const fakeSlots = {
  register: (opts) => {
    if (!declaredSlots.has(opts.name)) {
      throw new Error(`slot "${opts.name}" is not declared (a parent entry's children table must declare it)`)
    }
    registered.push(opts)
    return () => {}
  },
  inject: (key, callback) => {
    if (declaredSlots.has(key)) {
      callback()
      return () => {}
    }
    const rec = { key, callback }
    pendingInjects.push(rec)
    return () => {
      const i = pendingInjects.indexOf(rec)
      if (i >= 0) pendingInjects.splice(i, 1)
    }
  },
}

/** 模拟"宿主条目注册了 root（children 里声明了该插槽）"这一刻。 */
function declareSlot(key) {
  declaredSlots.add(key)
  // ⚠ 必须**保留** key 不匹配的那些回调。
  // 原来这里写的是 `for (const rec of pendingInjects.splice(0)) { if (rec.key === key) rec.callback() }`
  // —— splice(0) 把整个队列清空，于是**声明一个插槽会把别的插槽的待办悄悄扔掉**。
  // 那是个假实现里的真 bug：它让"卡片那条推迟注册"永远等不到自己的声明，
  // 于是一条本该验"推迟后能注册成功"的用例永远红。
  // 假实现出错比真实现出错更隐蔽——**它会把测试的结论整个翻过来**。
  const keep = []
  for (const rec of pendingInjects) {
    if (rec.key === key) rec.callback()
    else keep.push(rec)
  }
  pendingInjects.length = 0
  pendingInjects.push(...keep)
}

let captured = null

globalThis.window = {
  __ModuleLoader__: {
    load: (def) => {
      captured = def
    },
  },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener: () => {},
  removeEventListener: () => {},
}

/** 假 `require`：只提供 seed 模块里本文件真正用到的两个。 */
function fakeRequire(id) {
  if (id === 'react') return ReactStub
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Button: function Button() {} }
  }
  throw new Error(`假 require 不认识模块 ${id}（若客户端半新增了 seed 模块，这里要补上）`)
}

// 加载并执行 bundle
const source = readFileSync(join(here, 'client.js'), 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)

assert.ok(captured !== null, 'bundle 没有调用 window.__ModuleLoader__.load —— 宿主不会加载它')
assert.equal(captured.id, '@lh/practice')

const exports_ = captured.factory(fakeRequire)

console.log('\n══ 1. 契约面 ══')

check('导出了 apply / name / inject', () => {
  assert.equal(typeof exports_.apply, 'function')
  assert.equal(exports_.name, 'lh-practice')
  // `sessions` 是「AI深解」发消息要用的（按 sessionId 寻址）。
  // **故意不用 `conversation`**：那个服务按"当前作用域"找会话，
  // 而本插件的 apply 不在会话作用域里；更要紧的是 inject 里声明一个
  // **没出现**的服务会让 apply 永不执行 —— 插件静默不工作，风险更大。
  assert.deepEqual(exports_.inject, ['slots', 'sessions'])
})

check('★ apply() 在**两个**插槽都还没声明时不抛错、也不注册（生产事故的完整复现形状）', () => {
  // ═══ 生产现场 ═══
  // 宿主 boot 是 `Promise.all` **并发**拉起所有客户端插件。本插件的依赖
  // （slots/sessions，runtime 核心提供）第一批就满足，而：
  //   · `shell.overlay` 由 ui-layout 声明，ui-layout 还要等 ui-theme 的 theme 服务；
  //   · `tool.call.toolview` 由 **ui-tool** 声明，ui-tool 同样是"在它 apply 时"
  //     才把插槽写进父条目的 children 表。
  // 于是本插件**可能先于两者** apply —— 那一刻直接 register 就会被 SlotCore 抛
  // `slot "..." is not declared`，插件 fiber 失败 → "Failed to load plugins" → 整个界面起不来。
  //
  // ⚠ 这条测试**故意不预先声明 `tool.call.toolview`**。
  // 上一版是这样写的：`declareSlot('tool.call.toolview') // 卡片插槽已声明（直接 register 的老路不受影响）`
  // —— 那句话把测试布置成**看不见**剩下的 bug：卡片仍然是直接 register，
  // 只是被"预先声明"喂住了，于是同样的竞态在测试里永远不会暴露。
  // **一个为了迁就实现而预先满足前提的测试，等于把要守的东西绕过去了。**
  declaredSlots.clear()
  pendingInjects.length = 0
  registered.length = 0
  exports_.apply({
    slots: fakeSlots,
    sessions: { list: { getSnapshot: () => ({ current: null }), subscribe: () => () => {} } },
  })
  assert.equal(registered.length, 0, `两个插槽都没声明，不该注册任何东西，实际注册了 ${registered.length} 个`)
  // 三条 = 面板 + 兜底（都挂 shell.overlay）+ 卡片（挂 tool.call.toolview）。
  // 这个数字**必须等于注册点的个数**：少一条就说明有人又改回了直接 register
  // （那正是上一版漏掉的那一半）。
  assert.equal(pendingInjects.length, 3, `三个注册点都该推迟（等待声明），实际推迟了 ${pendingInjects.length} 条`)
})

check('★ 卡片插槽声明到达前，apply 也不得抛错（竞态对 tool.call.toolview 一样成立）', () => {
  // 单独把这一条列出来，是因为它是**上一版修复漏掉的那一半**：
  // shell.overlay 改成了 inject，卡片却仍是直接 register。
  // 上一次没暴露，只因为报错发生在第一个注册（shell.overlay）就中断了 apply，
  // **根本没走到卡片那一行**。
  declaredSlots.clear()
  pendingInjects.length = 0
  registered.length = 0
  assert.doesNotThrow(() => {
    exports_.apply({
      slots: fakeSlots,
      sessions: { list: { getSnapshot: () => ({ current: null }), subscribe: () => () => {} } },
    })
  }, 'tool.call.toolview 未声明时直接 register 会抛 —— 生产里就是白屏')
  assert.equal(registered.length, 0)
})

check('shell.overlay 声明到达后，面板与兜底条目都注册成功且各带 id', () => {
  declareSlot('shell.overlay')
  const ov = registered.filter((r) => r.name === 'shell.overlay')
  assert.equal(ov.length, 2, `应恰好两个 shell.overlay 条目（面板+兜底），实际 ${ov.length}`)
  // list 型插槽必须给 id（宿主校验，缺了会让界面起不来）
  for (const r of ov) assert.ok(r.id, 'shell.overlay 是 list 型，必须给 id')
})

check('★ tool.call.toolview 声明到达后，卡片也注册成功', () => {
  declareSlot('tool.call.toolview')
  const card = registered.find((r) => r.name === 'tool.call.toolview')
  assert.ok(card, '卡片插槽声明到达后仍未注册 —— 对话里就不会出现刷题卡片')
})

check('卡片注册用的 key 与工具名逐字一致', () => {
  const card = registered.find((r) => r.name === 'tool.call.toolview')
  assert.equal(card.key, 'start_practice', '键写错不会报错、只会永远不渲染，所以这一条必须锁住')
})

// ── 纯函数 ────────────────────────────────────────────────────────────────

const t = exports_.__test
assert.ok(t !== undefined, '没有 __test 出口 —— 纯函数无法离线验证')

console.log('\n══ 2. 对比色：自由颜色的安全前提 ══')

check('浅底 → 深字；深底 → 浅字', () => {
  assert.equal(t.readableOn('#ffffff'), '#111111')
  assert.equal(t.readableOn('#000000'), '#f5f5f5')
})

check('★ 纯蓝被当作深色（相对亮度，不是三通道平均）', () => {
  // 若用 (r+g+b)/3，#0000ff 会被算成 85/255≈0.33 → 误判为"亮"，配上深色字就看不见。
  // 用 Rec.709 系数（人眼对蓝最不敏感）它才正确地落在深色一侧。
  assert.equal(t.readableOn('#0000ff'), '#f5f5f5')
})

check('三个缩写的 #rgb 也认', () => {
  assert.equal(t.readableOn('#fff'), '#111111')
  assert.equal(t.readableOn('#000'), '#f5f5f5')
})

check('非法颜色不猜（返回 null，由调用方保留默认）', () => {
  for (const bad of ['red', '#12345', '', null, undefined, 42, {}]) {
    assert.equal(t.readableOn(bad), null, `${JSON.stringify(bad)} 不该被当成颜色`)
  }
})

console.log('\n══ 3. resolveStyle：回退，而不是画坏 ══')

check('空/缺省 → 全套默认（与没有 style 时行为一致）', () => {
  for (const input of [null, undefined, {}, 'nonsense', 42, []]) {
    const s = t.resolveStyle(input, 'card')
    assert.equal(s.radius, '10px', `radius 应回退到默认，输入=${JSON.stringify(input)}`)
    assert.equal(s.scale.font, '14px')
    assert.ok(s.bg, 'bg 必须有值')
    assert.deepEqual(s.show, ['bank', 'count', 'hint'], '不给 show 时必须与旧版显示一致')
  }
})

check('★ 自定义背景色 → 文字色由背景算出来', () => {
  const light = t.resolveStyle({ background_color: '#eeeeee' }, 'card')
  assert.equal(light.fg, '#111111', '浅底应配深字')
  const dark = t.resolveStyle({ background_color: '#111111' }, 'card')
  assert.equal(dark.fg, '#f5f5f5', '深底应配浅字')
})

check('★ 非法自定义色被忽略，不覆盖默认', () => {
  const s = t.resolveStyle({ background_color: 'red' }, 'card')
  assert.ok(s.bg.includes('--dsw-alias'), `非法色不该生效，实际 bg=${s.bg}`)
})

check('认知的 token 生效', () => {
  const s = t.resolveStyle({ font_scale: 'xlarge', radius: 'pill', layout: 'stack', preview_questions: 3 }, 'card')
  assert.equal(s.scale.font, '18px')
  assert.equal(s.radius, '999px')
  assert.equal(s.layout, 'stack')
  assert.equal(s.preview, 3)
})

check('不认识的 token → 落到默认（将来服务端加新 token 时不会画坏）', () => {
  const s = t.resolveStyle({ font_scale: 'gigantic', radius: 'wobbly', accent: 'chartreuse' }, 'card')
  assert.equal(s.scale.font, '14px')
  assert.equal(s.radius, '10px')
  assert.ok(s.accent.includes('--dsw-alias'), '未知 accent 应回到主题变量')
})

check('panel_width 只影响面板宽度，且非数字时回退', () => {
  assert.equal(t.resolveStyle({ panel_width: 700 }, 'panel').width, 700)
  assert.equal(t.resolveStyle({ panel_width: 'wide' }, 'panel').width, 520)
  assert.equal(t.resolveStyle({ panel_width: 99999 }, 'panel').width, 99999, '客户端不再夹紧（服务端已夹）')
})

console.log('\n══ 4. 每张卡片读自己的样式（新样式只落在新卡片上）══')

check('★ 三态语义：拿不到 → undefined；明确没有 → null；有 → 对象', () => {
  // 这个三态是"改样式只影响新卡片"的**全部依据**。
  // 把 null 也当成"回退到最近一次"是最容易犯的错：那会让一张本来没声明
  // 样式的旧卡片跟着最新请求一起变——正是要修掉的那个毛病。
  assert.equal(t.styleFromBlock(undefined), undefined, '没有 block → 拿不到')
  assert.equal(t.styleFromBlock({}), undefined, 'block 里没有 argsRaw → 拿不到')
  assert.equal(t.styleFromBlock({ argsRaw: '{"bank_name":"x"}' }), null, '有参数但没 style → 明确没有')
  assert.equal(t.styleFromBlock({ call: { argsRaw: '{"bank_name":"x"}' } }), null, '完成态同理')
  assert.deepEqual(t.styleFromBlock({ argsRaw: '{"style":{"accent":"focus"}}' }), { accent: 'focus' })
  assert.deepEqual(t.styleFromBlock({ call: { argsRaw: '{"style":{"accent":"calm"}}' } }), { accent: 'calm' })
})

check('坏 JSON / 非对象参数不抛错', () => {
  for (const bad of ['{', 'null', '[]', '"x"', '42', '{"style":"focus"}', '{"style":[]}']) {
    const r = t.styleFromBlock({ argsRaw: bad })
    assert.equal(r === null || typeof r === 'object', true, `${bad} 的返回值应可用，实际 ${JSON.stringify(r)}`)
    assert.ok(r === null || !Array.isArray(r), `${bad} 不该返回数组`)
  }
})

check('★ 运行态与完成态都能读到（两种 node 形状）', () => {
  // 运行态 `RunningToolCall.argsRaw`（字串）；完成态 `ToolResultNode.call.argsRaw`。
  // 完成态的 `call` 可能是 null（上下文截断把那次调用移出窗口）→ 必须退化成"拿不到"。
  assert.deepEqual(t.styleFromBlock({ argsRaw: '{"style":{"radius":"pill"}}' }), { radius: 'pill' })
  assert.deepEqual(t.styleFromBlock({ call: { name: 'start_practice', argsRaw: '{"style":{"radius":"pill"}}' } }), { radius: 'pill' })
  assert.equal(t.styleFromBlock({ call: null }), undefined, 'call 为 null（被截断）时要能区分于"没有 style"')
})

console.log('\n══ 5. 参数侧的防护（参数是发出前的原文，没经过服务端夹紧）══')

check('★ 荒谬数值被夹紧', () => {
  assert.equal(t.guardRawStyle({ panel_width: 99999 }).panel_width, 900)
  assert.equal(t.guardRawStyle({ panel_width: 10 }).panel_width, 320)
  assert.equal(t.guardRawStyle({ preview_questions: 1000 }).preview_questions, 8)
  assert.equal(t.guardRawStyle({ preview_questions: -5 }).preview_questions, 0)
})

check('NaN / Infinity 被丢掉', () => {
  assert.equal(t.guardRawStyle({ panel_width: Number.NaN }).panel_width, undefined)
  assert.equal(t.guardRawStyle({ preview_questions: Number.POSITIVE_INFINITY }).preview_questions, undefined)
})

check('字符串与数组照传（token 由查表决定有没有效果）', () => {
  const g = t.guardRawStyle({ accent: 'focus', show: ['bank'], background_color: '#fff' })
  assert.equal(g.accent, 'focus')
  assert.deepEqual(g.show, ['bank'])
  assert.equal(g.background_color, '#fff')
})

check('不可用的类型被丢掉', () => {
  const g = t.guardRawStyle({ accent: { nested: true }, show: 'bank', background: true, radius: null })
  assert.equal(g.accent, undefined)
  assert.equal(g.background, undefined)
  assert.equal(g.radius, undefined)
})

check('非对象输入安全返回 null', () => {
  for (const bad of [null, undefined, 'x', 1, [], true]) {
    assert.equal(t.guardRawStyle(bad), null, `${JSON.stringify(bad)} 应回 null`)
  }
})

console.log('\n══ 6. 面板尺寸夹紧（拖动改尺寸的安全网）══')

check('尺寸上下界与可视区都被尊重', () => {
  assert.deepEqual(t.clampPanelSize(100, 100), { w: 320, h: 180 }, '过小要抬到下限')
  assert.equal(t.clampPanelSize(5000, 5000).w, 900, '过宽要压到上限')
  assert.ok(t.clampPanelSize(5000, 5000).w <= 1200 - 16, '不得超过视口')
})

check('尺寸取整（避免半像素抖动）', () => {
  const s = t.clampPanelSize(500.6, 400.2)
  assert.equal(Number.isInteger(s.w), true)
  assert.equal(Number.isInteger(s.h), true)
})

console.log('\n══ 7. 位置夹紧（拖出屏幕外是这类功能最典型的静默失效）══')

check('★ 面板不会被拖到看不见的地方', () => {
  const big = t.clampPanelPos(9999, 9999, { width: 520, height: 320 })
  assert.ok(big.x < 1200 && big.y < 800, `应夹回视口内，实际 ${JSON.stringify(big)}`)
  const neg = t.clampPanelPos(-500, -500, { width: 520, height: 320 })
  assert.ok(neg.x >= 8 && neg.y >= 8, `负坐标要抬回 8px，实际 ${JSON.stringify(neg)}`)
})

check('尺寸未知时用兜底值，不抛错', () => {
  const p = t.clampPanelPos(100, 100, null)
  assert.equal(Number.isFinite(p.x), true)
  assert.equal(Number.isFinite(p.y), true)
})

console.log('\n══ 8. hook 顺序：组件在"关闭/打开"两种状态下 hook 数必须一致 ══')
//
// ═══ 为什么必须有这一节（它是一次真实事故的产物）═══
// 2026-09-18：面板里新加的一个 `useEffect` 被写在了 `if (!open) return null` **之后**。
// 于是面板关着时跑 N 个 hook、打开时跑 N+1 个 —— React 直接抛
// "Rendered more hooks than during the previous render"，**面板永远打不开**。
// 作者刷新浏览器后看到的就是"点了没反应"。
//
// 这类错误的恶劣之处：**静态看每一行都对**（语法、类型、逻辑都合法），
// 只在运行时、且只在状态变化的那一刻才炸。所以它必须由测试来抓。
//
// 判据与 React 一致：**同一个组件，两次渲染的 hook 调用次数必须相同**。
// 数 hook 而不是扫源码，是因为自定义 hook（`usePanelOpen`）不会带 `React.` 前缀，
// 按名字扫会漏（我第一版扫源码的脚本就漏了 `FallbackEntry`）。

/**
 * 数一个组件在给定"模块状态"下的 hook 调用次数。
 *
 * @param Component - 组件函数。
 * @param props - 传给它的 props。
 * @returns `{ hooks, error }`：hook 次数；组件抛错时 error 非空。
 */
function hookCountOf(Component, props) {
  hookCalls = 0
  try {
    Component(props)
  } catch (error) {
    return { hooks: hookCalls, error: error?.message ?? String(error) }
  }
  return { hooks: hookCalls, error: null }
}

check('★ 面板：关闭态与打开态 hook 数一致（不一致 = 会抛错、打不开）', () => {
  t.setPanelOpen(false)
  const closed = hookCountOf(t.PracticePanel, {})
  t.setPanelOpen(true)
  const opened = hookCountOf(t.PracticePanel, {})
  assert.equal(closed.error, null, `关闭态渲染就抛错了：${closed.error}`)
  assert.equal(opened.error, null, `打开态渲染抛错了：${opened.error}`)
  assert.equal(
    opened.hooks,
    closed.hooks,
    `hook 数不一致（关闭 ${closed.hooks} / 打开 ${opened.hooks}）——` +
      '说明有 hook 写在提前 return 之后，面板会打不开',
  )
  t.setPanelOpen(false)
})

check('★ 卡片：有 / 无 block 时 hook 数一致', () => {
  const withBlock = hookCountOf(t.StartPracticeCard, { block: { argsRaw: '{"style":{"accent":"focus"}}' } })
  const noBlock = hookCountOf(t.StartPracticeCard, {})
  assert.equal(withBlock.error, null, `卡片渲染抛错：${withBlock.error}`)
  assert.equal(noBlock.error, null, `卡片渲染抛错：${noBlock.error}`)
  assert.equal(withBlock.hooks, noBlock.hooks, 'hook 数随 block 变化 —— 卡片会在某些消息里直接崩掉')
})

check('★ 兜底入口：出现 / 不出现时 hook 数一致', () => {
  // 它有提前 return（条件不满足时返回 null），正是最容易踩这个坑的形状。
  t.setPendingRequest({ seq: 1, bank: 'b', count: 3, style: null })
  const shown = hookCountOf(t.FallbackEntry, {})
  t.setPendingRequest({ seq: 0, bank: null, count: null, style: null })
  const hidden = hookCountOf(t.FallbackEntry, {})
  assert.equal(shown.error, null, `兜底入口渲染抛错：${shown.error}`)
  assert.equal(hidden.error, null, `兜底入口渲染抛错：${hidden.error}`)
  assert.equal(shown.hooks, hidden.hooks, 'hook 数随显示与否变化')
})

check('★★ 这个判据本身有效（拿一个故意写坏的组件试它必须报警）', () => {
  // 按"闸门要先对着已知坏的状态红一次"的规矩：如果这个判据抓不住
  // 已知的违规写法，那它给的绿就是假绿。
  function DeliberatelyBroken(props) {
    ReactStub.useState(0)
    if (!props.open) return null
    ReactStub.useState(1) // ← 违规：hook 在提前 return 之后
    return null
  }
  const closed = hookCountOf(DeliberatelyBroken, { open: false })
  const opened = hookCountOf(DeliberatelyBroken, { open: true })
  assert.notEqual(
    opened.hooks,
    closed.hooks,
    '判据抓不住已知的违规写法 —— 那上面三条"通过"就没有意义',
  )
})

console.log('\n══ 9. 「AI深解」：消息组装 ══')

const QUESTION = {
  id: 'q-abc123456789',
  number: 'set1-q7',
  kind: 'single_choice',
  stem: '下列说法正确的是：',
  options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }, { label: 'C', text: '丙' }],
}

check('★ 消息里必须有题号与本人答案（作者明确要求的两项）', () => {
  const text = t.composeDeepDive({ bankName: '考公刷题', question: QUESTION, choice: 'C', verdict: { correct: false, answer: ['B'] } })
  assert.ok(text.includes('set1-q7'), '没带题号 —— 学习者在纸质资料上找不到对应那一题')
  assert.ok(text.includes('我的作答：C'), '没带学习者的答案')
  assert.ok(text.includes('q-abc123456789'), '没带题目 id —— agent 拿不到它就没法按 id 查题库解析')
  assert.ok(text.includes('正确答案：B'), '判过分却没带正确答案，模型还要多调一次工具')
})

check('★ 三步顺序必须写进消息（不能靠模型自觉）', () => {
  const text = t.composeDeepDive({ bankName: '考公刷题', question: QUESTION, choice: 'C', verdict: null })
  // 顺序是这条功能的核心：先看参考解析再"自己解"是假的独立解，
  // 而且模型会把自己的推理对齐到参考解析上（看起来更可信，其实更糟）。
  const iSelf = text.indexOf('先自己独立解')
  const iRef = text.indexOf('检索题库里这道题的参考解析')
  const iCause = text.indexOf('帮我分析错因')
  assert.ok(iSelf >= 0, '没要求模型先自己解')
  assert.ok(iRef >= 0, '没要求检索参考解析')
  assert.ok(iCause >= 0, '没要求分析错因')
  assert.ok(iSelf < iRef && iRef < iCause, `三步顺序不对：自己解@${iSelf} 参考@${iRef} 错因@${iCause}`)
})

check('★ 必须如实告知"参考解析可能串行/可能没有"（否则模型会把串行文字当权威）', () => {
  // 这不是客套话：题库里的解析是 OCR 两栏串行的（实测），
  // 不告诉模型，它会拿串行的句子去"解释"，编出连贯但错的道理。
  const text = t.composeDeepDive({ bankName: null, question: QUESTION, choice: '', verdict: null })
  assert.ok(text.includes('串行'), '没提 OCR 两栏串行')
  assert.ok(text.includes('不一定有') || text.includes('没有就直说'), '没说明参考解析可能不存在')
})

check('还没作答时也要能用（深解不是错题专属）', () => {
  const text = t.composeDeepDive({ bankName: 'b', question: QUESTION, choice: '', verdict: null })
  assert.ok(text.includes('还没作答'), '没如实说明还没作答')
  assert.ok(!text.includes('我做错了'), '没作答却写成做错了')
})

check('答对时也能用，且判定如实', () => {
  const text = t.composeDeepDive({ bankName: 'b', question: QUESTION, choice: 'B', verdict: { correct: true, answer: ['B'] } })
  assert.ok(text.includes('我做对了'))
})

check('缺字段不抛错（题目信息不全时仍要能发出去）', () => {
  for (const q of [null, undefined, {}, { id: 'x' }]) {
    const text = t.composeDeepDive({ bankName: null, question: q, choice: '', verdict: null })
    assert.ok(typeof text === 'string' && text.length > 50, `题目=${JSON.stringify(q)} 时组装失败`)
  }
})

console.log('\n══ 10. 发送路径：没有一线先例，所以失败必须可见 ══')

check('★ 拿不到 sessionId 时明确报错（不静默失败）', async () => {
  await assert.rejects(() => t.sendIntoSession({ sessions: {} }, undefined, 'x'), /会话 id/)
})

check('★ 拿不到 sessions 服务时明确报错', async () => {
  await assert.rejects(() => t.sendIntoSession({}, 'sess-1', 'x'), /sessions 服务/)
})

check('★ binding 拿不到 session 时，报错要说清缺的是哪一环', async () => {
  // 这条接口形状是从宿主类型声明读来的、**没有一线插件这么用过**。
  // 所以失败信息必须直接指出"哪个环节缺"，否则只能靠猜。
  await assert.rejects(
    () => t.sendIntoSession({ sessions: { binding: () => ({}) } }, 'sess-1', 'x'),
    /binding=有.*session=无/s,
  )
})

check('★ 成功路径：按 sessionId 寻址、用 queue 模式发一条 text', async () => {
  let captured = null
  const ctx = {
    sessions: {
      binding: (id) => ({
        session: {
          prompt: async (content, mode) => {
            captured = { id, content, mode }
            return { ok: true }
          },
        },
      }),
    },
  }
  const ok = await t.sendIntoSession(ctx, 'sess-7', '你好')
  assert.equal(ok, true)
  assert.equal(captured.id, 'sess-7', '必须发给指定的那个会话')
  assert.deepEqual(captured.content, [{ type: 'text', text: '你好' }])
  assert.equal(captured.mode, 'queue', '必须是 queue —— steer 会打断学习者正在说的话')
})

check('★ 宿主拒绝时抛错（不假装成功）', async () => {
  const ctx = {
    sessions: {
      binding: () => ({ session: { prompt: async () => ({ ok: false, error: { code: 'E_NOPE', message: '不行' } }) } }),
    },
  }
  await assert.rejects(() => t.sendIntoSession(ctx, 's', 'x'), /E_NOPE/)
})

console.log('\n══ 11. 当前会话 id：面板在 root 作用域，props 里没有它 ══')
//
// ═══ 这是「AI深解」第一次跑就失败的根因 ═══
// `sessionId` 只发给**会话作用域**的插槽，而面板注册在 `shell.overlay`（root 作用域）
// —— 因为面板要跨会话、浮在最上面。于是 `props.sessionId` 永远是 undefined，
// 报错就是"拿不到当前会话 id"。修法是去问会话服务要**当前会话**。

check('★ 还没装 ctx 时，一切都不抛错（面板其余功能不该因没会话而失效）', () => {
  assert.equal(t.currentSessionId(), null)
  assert.equal(t.resolveSessionId({}), null)
  assert.equal(t.resolveSessionId(undefined), null)
  assert.equal(t.resolveSessionId({ sessionId: '' }), null, '空字符串不算会话 id')
})

check('★ props 上有就用 props（会话作用域插槽的情形）', () => {
  assert.equal(t.resolveSessionId({ sessionId: 'sess-prop' }), 'sess-prop')
})

check('★★ props 没有 → 从会话服务读"当前会话"（这就是那个 bug 的修法）', () => {
  // ⚠ 这一条必须**真的装一个假 ctx**再验：`currentSessionId` 读的是 apply 存下的
  // 那个 ctxRef。只断言"函数存在"等于没测（第一版就是这么写的，等于假绿）。
  // 因为它会留下模块级状态，所以顺序上放在"还没装 ctx"那条之后。
  const fakeSessions = {
    list: {
      getSnapshot: () => ({ current: 'sess-current' }),
      subscribe: () => () => {},
    },
  }
  exports_.apply({ slots: { register: () => {}, inject: (_k, cb) => { cb() } }, sessions: fakeSessions })

  assert.equal(t.currentSessionId(), 'sess-current', '应当能从会话服务读到当前会话')
  assert.equal(t.resolveSessionId({}), 'sess-current', 'props 没有时应退回当前会话')
  assert.equal(t.resolveSessionId({ sessionId: 'sess-prop' }), 'sess-prop', 'props 仍然优先')
})

check('会话服务形状不符时不抛错（服务没就绪 / 形状变了）', () => {
  // 宿主接口是读类型声明得来的，形状真的变了也不该让面板崩掉。
  for (const bad of [{}, { list: {} }, { list: { getSnapshot: () => ({}) } }, { list: null }]) {
    exports_.apply({ slots: { register: () => {}, inject: (_k, cb) => { cb() } }, sessions: bad })
    assert.equal(t.currentSessionId(), null, `sessions=${JSON.stringify(bad)} 时应回 null`)
  }
  // 复位成"能读到会话"的状态，免得影响后面的用例
  exports_.apply({ slots: { register: () => {}, inject: (_k, cb) => { cb() } }, sessions: { list: { getSnapshot: () => ({ current: 'sess-current' }), subscribe: () => () => {} } } })
})

console.log('\n══ 12. 收起态（胶囊）不该破坏 hook 顺序 ══')

check('★ 展开 / 收起两种状态 hook 数必须一致', () => {
  // 收起是一个**新的提前 return**（return 胶囊），和"关闭"是同一个形状的风险：
  // 若把 hook 写在它之后，面板一收起来就再也展不开（React 抛 hook 数不一致）。
  t.setPanelOpen(true)
  t.setCollapsed(false)
  const expanded = hookCountOf(t.PracticePanel, {})
  t.setCollapsed(true)
  const capsule = hookCountOf(t.PracticePanel, {})
  t.setCollapsed(false)
  t.setPanelOpen(false)
  assert.equal(expanded.error, null, `展开态渲染抛错：${expanded.error}`)
  assert.equal(capsule.error, null, `收起态渲染抛错：${capsule.error}`)
  assert.equal(capsule.hooks, expanded.hooks, `收起后 hook 数变了（展开 ${expanded.hooks} / 收起 ${capsule.hooks}）`)
})

console.log('\n══ 13. 收起态**不得否决**显式打开（这个 bug 坑过一次）══')
//
// ═══ 现场 ═══
// 作者切过一次会话（自动收起）之后，**点卡片只得到一颗胶囊**，感受是"卡片打不开了"。
// 而服务端 trace 里 `GET /bank` 每秒一次 —— 点击其实完全正常、题也在取，
// 坏的只有"渲染成什么"。**"逻辑都跑对了、只是没显示"是最难从现象反推的一类。**
//
// 规则：收起 = "我暂时不想看"，**不是**"我拒绝再看"。所以任何显式打开都必须清掉它。

check('★★ 收起状态下显式打开 → 必须展开（不是只 setOpen）', () => {
  t.setPanelOpen(false)
  t.setCollapsed(true)
  t.openPanelWith({ count: 1 })
  assert.equal(t.isCollapsed(), false, '收起态没被清掉 —— 点了卡片只会渲染出胶囊')
  assert.equal(t.isPanelOpen(), true, '面板没被打开')
})

check('★ 面板关着且收起态为真时，也照样能被显式打开', () => {
  // 这条对应"切换会话时面板本来是关的"那条路径：
  // 旧实现会把收起态设上（没有任何收益），于是**下一次打开被否决**。
  // 所以"只在面板开着时才收起"也是这条修法的一半。
  t.setPanelOpen(false)
  t.setCollapsed(true)
  t.openPanelWith({ count: 1 })
  assert.equal(t.isPanelOpen(), true)
  assert.equal(t.isCollapsed(), false)
})

console.log('\n══ 14. 作答历史：一句话把"这题你做过"说清楚 ══')

check('★ 第一次做（history=null / attempts=0）→ 什么都不显示', () => {
  assert.equal(t.formatHistory(null), null, '第一次做不该显示历史（作者要求"在本次作答之后"才有这条）')
  assert.equal(t.formatHistory(undefined), null)
  assert.equal(t.formatHistory({ attempts: 0 }), null, 'attempts=0 同样不该显示')
})

check('★ 做过 → 说清"几次 + 上次选了什么 + 对错"', () => {
  const line = t.formatHistory({
    attempts: 2,
    last_response: 'C',
    last_correct: false,
    last_at: '2026-09-20T10:00:00.000Z',
  })
  assert.match(line, /2 次/, '要报出做过几次')
  assert.match(line, /C/, '要报出上次选了什么')
  assert.match(line, /答错/, '要报出上次对错')
})

check('判不了时如实说"判不了"（不写成答错）', () => {
  const line = t.formatHistory({ attempts: 1, last_response: 'x', last_correct: null, last_at: null })
  assert.match(line, /判不了/)
  assert.ok(!line.includes('答错'), '判不了不该说成答错')
})

check('上次没记作答内容时，不显示空引号', () => {
  const line = t.formatHistory({ attempts: 1, last_response: '', last_correct: true, last_at: null })
  assert.ok(!line.includes('「」'), `不该出现空引号：${line}`)
  assert.match(line, /答对/)
})

check('★ 时间说成"多久以前"（学习者关心的是"是不是最近做的"）', () => {
  const now = Date.parse('2026-09-20T12:00:00.000Z')
  const at = (iso) => t.formatWhen(iso, now)
  assert.equal(at('2026-09-20T11:59:30.000Z'), '刚刚')
  assert.equal(at('2026-09-20T11:30:00.000Z'), '30 分钟前')
  assert.equal(at('2026-09-20T09:00:00.000Z'), '3 小时前')
  assert.equal(at('2026-09-19T12:00:00.000Z'), '昨天')
  assert.equal(at('2026-09-17T12:00:00.000Z'), '3 天前')
  // 超过一个月就直接给日期，别再说"47 天前"（那反而不直观）
  assert.equal(at('2026-07-01T12:00:00.000Z'), '2026-07-01')
})

check('时间解析不了时不抛错（退回原样前 10 字符）', () => {
  assert.equal(t.formatWhen('不是时间', Date.now()), '不是时间')
  assert.equal(t.formatWhen(null, Date.now()), 'null')
})

console.log('\n══ 15. 卡片承载选择：卡片上写的就是面板要给的 ══')
//
// ═══ 为什么这一节存在 ═══
// 作者反馈（2026-09-19）："我说'给我 10 题'或'我想重刷做过的题目'，
// 弹出的卡片依然是 49 题的全题库……而不能呈现出 10 道题或是仅有错题的卡片。"
// 两半原因：① 工具没有表达选择的词汇；② 卡片上只写题库名，读起来就像"整个题库"。

check('★ 三种说法各自映射到一句人话（卡片上那一行）', () => {
  assert.equal(t.describeSelectionLine({ order: 'missed' }, 10), '只出错题 · 10 道')
  assert.equal(t.describeSelectionLine({ order: 'attempted' }, null), '只出做过的')
  assert.equal(t.describeSelectionLine({ order: 'unseen' }, 5), '只出没做过的 · 5 道')
})

check('★ 没给选择时**什么都不说**（不编一句"按顺序"误导人）', () => {
  // 面板此时按自己的默认（unseen）走。若这里写"按顺序"，那句话与事实不符——
  // 而学习者会照它理解，于是"卡片说的是 A、做的是 B"。
  assert.equal(t.describeSelectionLine(null, null), null)
  assert.equal(t.describeSelectionLine({}, null), null)
  assert.equal(t.describeSelectionLine({ order: '不认识的档位' }, null), null, '不认识的档位不该编标签')
})

check('指定了 ids → 说"指定的 N 道"', () => {
  assert.match(t.describeSelectionLine({ ids: ['a', 'b', 'c'] }, 3), /指定的 3 道/)
})

check('知识点也说出来', () => {
  const line = t.describeSelectionLine({ order: 'missed', topic: '片段阅读' }, 5)
  assert.match(line, /只出错题/)
  assert.match(line, /片段阅读/)
})

check('★ 三态：拿不到自己那次调用 → undefined；明确没有 → null', () => {
  // 与 styleFromBlock 同一套语义（见第 4 节）。搞错这一层会让旧卡片
  // 跟着最新一次请求一起变——那正是"改样式只影响新卡片"要修掉的东西。
  assert.equal(t.selectionFromBlock(undefined), undefined)
  assert.equal(t.selectionFromBlock({}), undefined)
  assert.equal(t.selectionFromBlock({ argsRaw: '{"bank_name":"x"}' }), null)
  assert.deepEqual(t.selectionFromBlock({ argsRaw: '{"order":"missed","count":10}' }), { order: 'missed' })
  assert.deepEqual(t.selectionFromBlock({ call: { argsRaw: '{"order":"attempted"}' } }), { order: 'attempted' })
})

check('坏参数不抛错', () => {
  for (const bad of ['{', 'null', '[]', '{"order":null}', '{"ids":"x"}', '42']) {
    const r = t.selectionFromBlock({ argsRaw: bad })
    assert.ok(r === undefined || r === null || typeof r === 'object', `${bad} 的返回值应可用`)
  }
})

check('guardRawSelection：荒谬的 ids 被截断，非字符串被丢掉', () => {
  const many = Array.from({ length: 500 }, (_, i) => `q-${i}`)
  assert.equal(t.guardRawSelection({ ids: many }).ids.length, 200, 'ids 应被截到 200')
  assert.deepEqual(t.guardRawSelection({ ids: [1, null, 'ok', ''] }).ids, ['ok'])
  assert.equal(t.guardRawSelection({ ids: [] }), null, '空 ids 等于没有选择')
  assert.equal(t.guardRawSelection('x'), null)
})

check('★ 卡片在"有选择/无选择"两种状态下 hook 数一致（启动安全）', () => {
  // 收起态那次事故（hook 写在提前 return 之后）之后，凡新增渲染分支都要过这一关。
  // 卡片这一节新增了"选择那一行"，就是一个**新的条件渲染分支**。
  const withSel = hookCountOf(t.StartPracticeCard, { block: { argsRaw: '{"order":"missed","count":10}' } })
  const without = hookCountOf(t.StartPracticeCard, { block: { argsRaw: '{"bank_name":"x"}' } })
  const noBlock = hookCountOf(t.StartPracticeCard, {})
  assert.equal(withSel.error, null, `有选择时卡片渲染抛错：${withSel.error}`)
  assert.equal(without.error, null, `无选择时卡片渲染抛错：${without.error}`)
  assert.equal(noBlock.error, null, `无 block 时卡片渲染抛错：${noBlock.error}`)
  assert.equal(withSel.hooks, without.hooks, '有/无选择时 hook 数不一致')
  assert.equal(withSel.hooks, noBlock.hooks, '有 block / 无 block 时 hook 数不一致')
})

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('全部通过。')
console.log('边界：React 与 DOM 都是桩，所以这里证明的是**纯函数取值**，不是布局。')
