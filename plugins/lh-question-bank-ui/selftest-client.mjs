/**
 * `@lh/question-bank-ui` 的**客户端半**离线测试 —— 把 bundle 在 Node 里跑起来。
 *
 * ═══ 为什么值得为"客户端"搭一套假环境 ═══
 * 客户端半只在浏览器里跑，而浏览器里的错误**只能靠眼睛发现**——本项目是**无头**的，
 * 看不见界面。所以"面板能不能画出来"必须由别的机制兜住。
 * 这套假环境证明的不是"好不好看"，而是三件**静默且昂贵**的事：
 *   1. **模块能被 factory 跑起来**（`exports.inject` 缺失 = 浏览器卡在 `Failed to load plugins`）；
 *   2. **三个插槽都注册上了**（少一个 = 某个入口永不出现，而宿主**不报错**）；
 *   3. **组件真的能画**（组件里抛错 = 白屏；hook 顺序错 = React 直接炸）。
 *
 * ═══ 它比"桩"更进一步：fetch 打的是**真服务端半** ═══
 * `globalThis.fetch` 被接到本插件 `index.js` 注册的那条真路由上，于是这条链在测试里是真的：
 *   客户端 → 路由 → @lh/question-bank/bank（读题库文件）→ view.js（组装）→ 客户端渲染。
 * 桩只桩掉浏览器（React / localStorage / matchMedia），**不桩业务**。
 *
 * 运行：node plugins/lh-question-bank-ui/selftest-client.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

// ⚠ 真实学习史的字节数：跑之前记下，跑完必须一致（闸门不许自己制造垃圾）。
const REAL_LOG = join(REPO_ROOT, 'data', 'events.jsonl')
const realLogBytesBefore = existsSync(REAL_LOG) ? statSync(REAL_LOG).size : 0

// ── 沙盒：假工作区 + 假事件日志（必须在 import 服务端半之前设好环境变量）──
const sandbox = mkdtempSync(join(tmpdir(), 'lh-bank-client-selftest-'))
const WS = join(sandbox, 'ws')
const BANK_DIR = join(WS, 'lh-questions')
const ARCHIVE_DIR = join(BANK_DIR, '.archived')
mkdirSync(ARCHIVE_DIR, { recursive: true })
process.env.LH_WORKSPACE = WS
process.env.LH_EVENT_LOG = join(sandbox, 'events.jsonl')

// 夹具用的假路径：只当字符串标签用（`source_root` 会显示在来源段，`cwd` 本插件不读）。
const FIXTURE_SOURCE_ROOT = 'D:\\考公资料' // lh-path-ok: 测试夹具；只是 source_root 的字符串标签，不读它
const FIXTURE_CWD = 'D:\\learning Harness test' // lh-path-ok: 测试夹具；模拟会话行里的 cwd，面板不读它

/** 造一个题库对象。 */
function bank(title, questions) {
  return {
    schema_version: 1,
    title,
    source_root: FIXTURE_SOURCE_ROOT,
    generated_at: '2026-09-17T15:00:00.000Z',
    provenance: { plugin: '@lh/extractor', version: '0.1.0', extraction: 'rule' },
    question_count: questions.length,
    duplicate_ids: [],
    questions,
  }
}

const qA1 = { id: 'q-a1', kind: 'single_choice', stem: '甲题：这段文字旨在说明？', options: ['选项一', '选项二'], answer: ['A'], accept: [], analysis: '甲解析正文', topics: ['片段阅读'], unmapped_topics: [], source: { path: 'f1.pdf', number: '1', page: 3 }, provenance: {} }
const qA2 = { id: 'q-a2', kind: 'fill_blank', stem: '乙题：横线处填什么？', options: [], answer: ['42'], accept: ['四十二'], analysis: '', topics: [], unmapped_topics: [], source: { path: 'f2.pdf', number: '2' }, provenance: {} }
const qB1 = { id: 'q-b1', kind: 'single_choice', stem: '丙题？', options: ['A', 'B'], answer: ['B'], accept: [], analysis: '丙解析', topics: [], unmapped_topics: [], source: { path: 'g1.pdf', number: '9' }, provenance: {} }

// 填充题：把 A 库凑到 12 题 —— 只有这样才测得到"分页"（每页 10 → 正好两页）
const fillers = Array.from({ length: 10 }, (_, i) => ({
  id: `q-fill-${i + 1}`,
  kind: 'single_choice',
  stem: `填充题 ${i + 1}：这段文字旨在说明？`,
  options: ['选项甲', '选项乙'],
  answer: ['A'],
  accept: [],
  analysis: '填充解析',
  topics: ['片段阅读'],
  unmapped_topics: [],
  source: { path: 'f3.pdf', number: String(10 + i) },
  provenance: {},
}))

writeFileSync(join(BANK_DIR, 'A库.json'), JSON.stringify(bank('A库', [qA1, qA2, ...fillers]), null, 2), 'utf8')
writeFileSync(join(BANK_DIR, 'B库.json'), JSON.stringify(bank('B库', [qB1]), null, 2), 'utf8')
writeFileSync(join(ARCHIVE_DIR, '旧库.json'), JSON.stringify(bank('旧库', [qB1]), null, 2), 'utf8')

const T = { a1: '2026-09-17T15:10:51.557Z', a2: '2026-09-18T09:00:00.000Z', a3: '2026-09-20T09:00:00.000Z', orphan: '2026-09-21T09:56:34.338Z' }
const S1 = 'session-619f2624-b2b5-443c-bacb-9b86c764fb46'
const attempt = (qid, response, correct, source, timestamp, sessionRef, extras = {}) => ({
  id: `e-${qid}-${timestamp}`,
  timestamp,
  actor: source,
  type: 'lh/user/attempt',
  provenance: { plugin: '@lh/question-bank', version: '0.0.1' },
  scope: 'root',
  session_ref: sessionRef ?? null,
  content_ref: null,
  data: { question_id: qid, response, correct, source, model: extras.model ?? null, score_got: extras.scoreGot ?? null, score_total: extras.scoreTotal ?? null, duration_ms: 4937, context: { session_ref: sessionRef ?? null, seq: null } },
})
writeFileSync(
  process.env.LH_EVENT_LOG,
  [
    JSON.stringify(attempt('q-a1', 'A', true, 'human', T.a1, S1)),
    JSON.stringify(attempt('q-a2', 'B', false, 'human', T.a2, null)),
    JSON.stringify(attempt('q-orphan999', 'C', true, 'human', T.orphan, null)),
    // 一条**部分正确的模型作答**：答案文本故意用独一无二的「四十二」，
    // 型号是 DeepSeek-v4.1、分数 6/12。面板默认应当看不见它
    // （模型答对了不是我会了），打开「含模型作答」才看得见——
    // 那时"作答者"列应显示型号、"结果"列应显示"部分正确 6/12"。
    JSON.stringify(attempt('q-a2', '四十二', false, 'llm', T.a3, null, { model: 'DeepSeek-v4.1', scoreGot: 6, scoreTotal: 12 })),
  ].join('\n') + '\n',
  'utf8',
)

// ── 断言 ────────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail === '' ? '' : `  —— ${detail}`}`)
  }
}

// ── 假浏览器 ────────────────────────────────────────────────────────────

/** 待执行的 effect 队列（React 也是在提交后跑 effect）。 */
let pendingEffects = []
/** 已注册的清理函数（本测试不主动卸载，留着以防将来加）。 */
const cleanups = []

/** 记录 matchMedia 是否命中"减少动效"。 */
let reduceMotion = false

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useEffect: (fn) => {
    pendingEffects.push(fn)
  },
  useMemo: (fn) => fn(),
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

globalThis.window = {
  __ModuleLoader__: moduleLoader,
  localStorage: localStorageStub,
  matchMedia: () => ({ matches: reduceMotion }),
  requestAnimationFrame: (fn) => globalThis.setTimeout(fn, 0),
  cancelAnimationFrame: (id) => globalThis.clearTimeout(id),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
}

// ── 假 req / res：把 fetch 接到**真**路由上 ─────────────────────────────

function makeReq(method, url, body) {
  const listeners = new Map()
  const req = {
    method,
    url,
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) {
      for (const handler of listeners.get('data') ?? []) handler(Buffer.from(JSON.stringify(body), 'utf8'))
    }
    for (const handler of listeners.get('end') ?? []) handler()
  })
  return req
}

function makeRes() {
  let status = null
  let text = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      if (typeof chunk === 'string') text += chunk
    },
  }
  return {
    res,
    read() {
      let body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch {
        body = { __raw: text }
      }
      return { status, body }
    },
  }
}

/** 服务端半注册的那条路由（由 apply() 填进来）。 */
let serverHandler = null

/** 打过的请求 URL（用来断言**接线**：分页参数、answerers 空选都走查询串）。 */
const requestLog = []

/** fetch 桩：只换传输层，业务走真实现。 */
globalThis.fetch = async (url, options = {}) => {
  const full = new URL(String(url), 'http://localhost')
  requestLog.push(full.pathname + full.search)
  const { res, read } = makeRes()
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined
  await serverHandler(makeReq(options.method ?? 'GET', full.pathname + full.search, body), res)
  const { status, body: parsed } = read()
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => parsed,
  }
}

// ── 极简渲染器 ──────────────────────────────────────────────────────────

/**
 * 渲染一个元素树：函数组件就地调用，宿主元素展开成 `{ type, props, children }`。
 * @param element - React 元素（本测试里是普通对象）。
 * @returns 展开后的树。
 */
function render(element) {
  // ⚠ 数组必须单独处理：`createElement('div', {}, [a, b])` 会让 children 里嵌一个数组，
  //   而"数组当元素展开"这条如果不写，那一整块子节点会被**静默丢掉**——
  //   测试替身不全的症状（面板看起来"少了内容"）与产品 bug 长得一模一样。
  if (Array.isArray(element)) return element.map(render)
  if (element === null || element === undefined || typeof element !== 'object') return element
  const { type, props, children } = element
  if (typeof type === 'function') {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return render(type(merged))
  }
  return { type, props: props ?? {}, children: (children ?? []).map(render) }
}

/** 渲染一次并跑掉 effect。 */
function renderOnce(element) {
  const tree = render(element)
  const queued = pendingEffects
  pendingEffects = []
  for (const fn of queued) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return tree
}

/** 等异步取数落定。 */
const tick = (ms = 15) => new Promise((r) => globalThis.setTimeout(r, ms))

/** 收集树里所有宿主元素。 */
function elements(tree, out = []) {
  if (tree === null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const item of tree) elements(item, out)
    return out
  }
  out.push(tree)
  for (const child of tree.children ?? []) elements(child, out)
  return out
}

/** 树里的全部文本（用来断言"屏幕上有没有这句话"）。 */
function allText(tree) {
  const parts = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return parts.join(' ▸ ')
}

/** 按条件找元素。 */
function find(tree, predicate) {
  return elements(tree).find(predicate) ?? null
}

/** 找按钮（本插件的小按钮都是 `button` 且文字在 children 里）。 */
function findButton(tree, label) {
  return find(tree, (el) => el.type === 'button' && allText(el).includes(label))
}

// ── 主流程 ──────────────────────────────────────────────────────────────

// 1) 服务端半：注册路由
const server = await import(pathToFileURL(join(HERE, 'index.js')).href)
const serverRegistered = []
await server.apply({
  on() {},
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  webServer: {
    register(options) {
      serverRegistered.push(options)
      return () => {}
    },
  },
})
serverHandler = serverRegistered[0]?.handler ?? null
check('服务端半注册了路由', typeof serverHandler === 'function')

// 2) 客户端半：跑 factory
await import(pathToFileURL(join(HERE, 'client.js')).href)
check('客户端半调用了 __ModuleLoader__.load', factory !== null && factory.id === '@lh/question-bank-ui')
if (factory === null) {
  console.log('无法继续：factory 没被捕获')
  process.exit(1)
}
const exportsObj = factory.f((name) => {
  if (name === 'react') return ReactStub
  throw new Error(`未知 require：${name}`)
})
check('exports.name', exportsObj.name === 'lh-question-bank-ui')
check("exports.inject 是 ['slots']（少了会卡 Failed to load plugins）", JSON.stringify(exportsObj.inject) === JSON.stringify(['slots']))

// 3) 注册插槽
const declared = new Set(['main', 'sidebar.panellist', 'shell.overlay'])
const registrations = []
const layoutCalls = []
exportsObj.apply({
  get: () => undefined,
  slots: {
    inject(name, fn) {
      if (!declared.has(name)) throw new Error(`slot "${name}" is not declared`)
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  layout: {
    selectPanel(key) {
      layoutCalls.push(key)
    },
  },
})
const mainReg = registrations.find((r) => r.options.name === 'main')
const sideReg = registrations.find((r) => r.options.name === 'sidebar.panellist')
const overlayReg = registrations.find((r) => r.options.name === 'shell.overlay')
check('注册了 main 面板，key = lh-bank', mainReg?.options?.key === 'lh-bank', JSON.stringify(mainReg?.options))
check('注册了侧栏图标，**同名 id** lh-bank', sideReg?.options?.id === 'lh-bank', JSON.stringify(sideReg?.options))
check('侧栏 label 是「题库」', sideReg?.options?.label === '题库')
check('注册了兜底浮层', overlayReg?.options?.id === 'lh-bank-directory')

// 4) 渲染中央面板（带 useSessions：会话标题能被翻出来）
const sessions = {
  byId: {
    [S1]: { title: '刷片段阅读那一段', cwd: FIXTURE_CWD, updatedAt: 1790000000000 },
  },
}
const useSessions = (selector) => selector({ byId: sessions.byId })

let tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
await tick()
tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))

const text = allText(tree)
check('面板标题是「题库管理」', text.includes('题库管理'))
check('左列列出题库清单', text.includes('A库') && text.includes('B库'))
check('左列有「全部题库」入口', text.includes('全部题库'))
check('左列有已归档区', text.includes('已归档'))
check('右列三段都在：来源 / 题目 / 做题记录', text.includes('来源') && text.includes('题目') && text.includes('做题记录'))
check('「记录」已改名为「做题记录」', text.includes('做题记录'))
check('来源段显示抽取方式与来源根', text.includes('抽取：rule') && text.includes(FIXTURE_SOURCE_ROOT))
check('来源段列出来源文件', text.includes('f1.pdf') && text.includes('f2.pdf'))
check('题目段列出题干', text.includes('甲题'))
check('做题记录段给出时间、作答与结果', text.includes('09-17') && text.includes('对'))
check('做题记录段把 session_ref 翻成**会话标题**', text.includes('刷片段阅读那一段'), text.slice(0, 400))
check('没有会话坐标的那条如实写「无会话坐标」', text.includes('无会话坐标'))
check('做题记录段如实报出孤儿作答条数（不静默丢）', text.includes('未列入'))

// refresh() 路径的分页接线（2026-10-14 审查回归：refresh 曾用已改名的 state.aLimit →
// 请求里 limit/offset 整个消失，表格显示的与分页条报的各说各话）
{
  const reqs = requestLog.filter((u) => u.startsWith('/lh/bank/attempts'))
  check(
    'refresh 取做题记录也带 limit 与 offset（与翻页同形）',
    reqs.length > 0 && reqs.every((u) => /[?&]limit=\d+/.test(u) && /[?&]offset=\d+/.test(u)),
    reqs.join(' | '),
  )
}

// 4a) 口径：默认只看人的，模型作答**不计入但要如实说明**；打开开关才看得见
// 4a) 作答者：默认只看「用户」；模型作答要**显式勾选**才看得到
check('默认「作答者」按钮显示「用户」（不写"人"这种口语）', text.includes('作答者：用户'), text.slice(0, 240))
check('默认不含模型：模型作答「四十二」不出现在任何地方', !text.includes('四十二'), text.slice(0, 200))
check('默认如实说明"另有 N 条未计入"', text.includes('非人作答') || text.includes('未计入'), text.slice(0, 300))
const answererBtn = findButton(tree, '作答者：用户')
check('作答者按钮找得到（点开是复选框浮层）', answererBtn !== null)
if (answererBtn !== null) {
  answererBtn.props.onClick()
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  const openText = allText(tree)
  check('浮层里有「选中所有模型」按钮', findButton(tree, '选中所有模型') !== null, openText.slice(0, 200))
  check('浮层里有「只看用户」按钮', findButton(tree, '只看用户') !== null)
  check('浮层里列出模型（含条数）', openText.includes('DeepSeek-v4.1'), openText.slice(0, 300))
  // 点「选中所有模型」
  const allModels = findButton(tree, '选中所有模型')
  allModels.props.onClick()
  await tick(40)
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  const withModels = allText(tree)
  check('勾上模型后那条模型作答出现了（可见，但不混入统计）', withModels.includes('四十二'), withModels.slice(0, 300))
  check('「作答者」列显示**型号**（不是笼统的"模型"）', withModels.includes('DeepSeek-v4.1'), withModels.slice(0, 400))
  check('「结果」列显示四态判决：「部分正确 6/12」', withModels.includes('部分正确 6/12'), withModels.slice(0, 400))
  check('「正确答案」列是**字符型**官方答案（q-a2 的答案 42）', withModels.includes('42'))
  // 点「只看用户」回到默认
  const onlyUser = findButton(tree, '只看用户')
  onlyUser.props.onClick()
  await tick(40)
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  check('「只看用户」后模型作答又不可见', !allText(tree).includes('四十二'))
}

// 4a-2) 空选：一个都没勾 = 不显示任何记录
//（2026-10-14 审查修的缺陷：旧实现把空选当"没给"，服务端退回 human 口径——
//  界面承诺"不显示任何记录"，实际把用户的记录全显示了）
{
  // 浮层可能已经开着（4a 的「只看用户」是在浮层里点的，不关它）——先看再点，别把它点关了
  if (findButton(tree, '选中所有模型') === null) {
    const btn = findButton(tree, '作答者：用户')
    btn.props.onClick()
    tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  }
  const boxes = elements(tree).filter((el) => el.type === 'input' && el.props?.type === 'checkbox')
  check('作答者浮层里的复选框找得到（用户 + 模型）', boxes.length >= 2, String(boxes.length))
  for (const box of boxes) box.props.onChange({ target: { checked: false } })
  await tick(40)
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  const emptyText = allText(tree)
  check('空选时如实提示「一个都没勾 = 不显示任何记录」', emptyText.includes('一个都没勾'), emptyText.slice(0, 200))
  check('空选后任何作答记录都不显示（连用户的也不显示）', !emptyText.includes('刷片段阅读那一段'), emptyText.slice(0, 300))
  const reqs = requestLog.filter((u) => u.startsWith('/lh/bank/attempts'))
  const lastReq = reqs[reqs.length - 1] ?? ''
  check(
    '空选请求的 answerers 是**空值**（明确表达"一个都不选"，而不是省略/退回 human）',
    new URL(lastReq, 'http://localhost').searchParams.get('answerers') === '',
    lastReq,
  )
  check('空选偏好照存（空串 = "我故意什么都不看"是正当状态）', storage.get('lh.bank.answerers') === '')
  const back = findButton(tree, '只看用户')
  check('浮层里的「只看用户」找得到（能把选择拉回来）', back !== null)
  if (back !== null) {
    back.props.onClick()
    await tick(40)
    tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
    check('恢复「只看用户」后记录又回来了', allText(tree).includes('刷片段阅读那一段'))
  }
}

// 4b) 题目段是**表格**：表头五列齐全
check('题目段有表格表头（题号/题干/知识点/作答/详情）', ['题号', '题干', '知识点', '作答', '详情'].every((t) => allText(tree).includes(t)))
check('做题记录段是表格，且表头九列齐全（含「正确答案」「作答者」「备注」）', ['时间', '题目', '作答', '正确答案', '结果', '作答者', '用时', '会话', '备注'].every((t) => allText(tree).includes(t)))

// 备注：点一下就在这一行下面展开读/写区（不加宽列——长文本塞进列里等于没显示）
const noteCell = find(tree, (el) => el.type === 'span' && typeof el.props?.onClick === 'function' && allText(el).includes('＋'))
check('每行有备注入口（无备注时显示「＋」）', noteCell !== null)
if (noteCell !== null) {
  noteCell.props.onClick()
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  const opened = allText(tree)
  check('点开后出现备注读/写区（含保存按钮与思路/反思两种）', opened.includes('保存备注') && opened.includes('思路（答题时）') && opened.includes('反思（答题后）'), opened.slice(0, 300))
  check('还没有备注时如实说，而不是空白', opened.includes('这条作答还没有备注'), opened.slice(0, 300))
  // 行内展开：备注区必须在**表格容器之内**（作者要求：不要在整张表下面）
  const tableEl = find(tree, (el) => {
    if (el.type !== 'div') return false
    const txt = allText(el)
    return ['时间', '题目', '作答', '正确答案', '结果', '作答者', '用时', '会话', '备注'].every((k) => txt.includes(k)) && txt.includes('保存备注')
  })
  check('备注读/写区落在**表格之内**（行内展开，不是整表下面）', tableEl !== null, allText(tree).slice(0, 200))
  const pagerText = allText(tree)
  check('做题记录也有分页条（共 N 条 + 每页 5/10/20）', pagerText.includes('共 3 条') || pagerText.includes('共 4 条') || /共 \d+ 条/.test(pagerText), pagerText.slice(0, 200))
  // 空正文保存 → 给人话，不写入
  const save = findButton(tree, '保存备注')
  save.props.onClick()
  await tick(20)
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  check('空备注保存被拒并给出人话（不写一条空记录）', allText(tree).includes('不必存一条空的'), allText(tree).slice(0, 300))
  // 收起来，后面的断言在默认状态下进行
  const cell2 = find(tree, (el) => el.type === 'span' && typeof el.props?.onClick === 'function' && allText(el).includes('＋'))
  if (cell2 !== null) {
    cell2.props.onClick()
    tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  }
}
// saveNote 只能有一份定义（2026-10-14 审查抓到过两份逐字重复的——后者生效、前者是死代码）
check(
  'saveNote 只有一份定义（重复定义 = 死代码，且没有报错）',
  (readFileSync(join(HERE, 'client.js'), 'utf8').match(/async function saveNote/g) ?? []).length === 1,
)
// 4c) 分页：12 题 / 每页 10 → 两页；可切每页 20；可翻页
const pageText = () => allText(renderOnce(ReactStub.createElement(mainReg.component, { useSessions })))
/**
 * 只取**题目表格**的行文字。
 *
 * ⚠ 不能用整棵树的文字去断言"这一页有没有某道题"：**做题记录段**也会显示题干预览，
 *   于是"甲题不在第 2 页"会被那条记录文本证伪（第一版就是这么错的）。
 *   判据用题目表的列模板——它只有题目表格用。
 */
const Q_COLS = '64px minmax(0, 1fr) 108px 92px 76px'
const questionTableText = (t) =>
  elements(t)
    .filter((el) => el.props?.style?.gridTemplateColumns === Q_COLS)
    .map((el) => allText(el))
    .join(' ▸ ')

check('分页条给出总数与页码（默认每页 5 → 共 12 题、1 / 3）', pageText().includes('共 12 题') && pageText().includes('1 / 3'))
check('第一页的题目表里有甲题', questionTableText(tree).includes('甲题'))
check('分页条有每页 5 / 10 / 20 三个选项', pageText().includes('每页') && [5, 10, 20].every((n) => find(tree, (el) => el.type === 'button' && allText(el) === String(n)) !== null))
const nextBtn = findButton(tree, '下一页')
check('第一页上「下一页」可点', nextBtn !== null && nextBtn.props.disabled !== true)
if (nextBtn !== null) {
  nextBtn.props.onClick()
  await tick(30)
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  const p2 = allText(tree)
  check('翻到第 2 页（页码变 2 / 3）', p2.includes('2 / 3'))
  check('第 2 页的题目表里**没有**第 1 页的甲题', !questionTableText(tree).includes('甲题'), questionTableText(tree).slice(0, 200))
  check('第 2 页列出填充题', questionTableText(tree).includes('填充题'))
}
// 换每页 20 → 一页装下 12 题，页码归 1 / 1
const size20 = find(tree, (el) => el.type === 'button' && allText(el) === '20')
check('每页 20 的按钮找得到', size20 !== null)
if (size20 !== null) {
  size20.props.onClick()
  await tick(30)
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  const p20 = allText(tree)
  check('换每页 20 后页码归位（1 / 1）', p20.includes('1 / 1'), p20.slice(0, 300))
  check('换每页后回到第一页（又看得到甲题）', questionTableText(tree).includes('甲题'))
}
// 换每页 5 → 12 题变 3 页（作者 2026-10-13 新增的档位）
const size5 = find(tree, (el) => el.type === 'button' && allText(el) === '5')
check('每页 5 的按钮找得到', size5 !== null)
if (size5 !== null) {
  size5.props.onClick()
  await tick(30)
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  const p5 = allText(tree)
  check('换每页 5 后页码是 1 / 3', p5.includes('1 / 3'), p5.slice(0, 300))
  // 回到每页 10，后面的展开/归档断言都在"默认档位"下进行
  const back10 = find(tree, (el) => el.type === 'button' && allText(el) === '10')
  if (back10 !== null) {
    back10.props.onClick()
    await tick(30)
    tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
    check('换回每页 10 后页码是 1 / 2', allText(tree).includes('1 / 2'))
  }
}

// 5) 展开一道题：管理视角应当看得到答案与解析
const qRow = find(tree, (el) => el.type === 'div' && typeof el.props?.onClick === 'function' && allText(el).includes('甲题'))
check('找到题目行（可点开）', qRow !== null)
if (qRow !== null) {
  qRow.props.onClick()
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  const expanded = allText(tree)
  check('展开后看得到选项', expanded.includes('选项一') && expanded.includes('选项二'))
  check('展开后看得到答案', expanded.includes('答案 A'))
  check('展开后看得到解析', expanded.includes('甲解析正文'))
  check('展开后看得到作答史', expanded.includes('作答 1 次'))
}

// 6) 减少动效：整块不能因为 matchMedia 命中而炸
reduceMotion = true
tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
check('prefers-reduced-motion 命中时仍能渲染', allText(tree).includes('题库管理'))
reduceMotion = false

// 7) 归档 → 清单少一个 + 提示；再恢复 → 复原
const archBtn = findButton(tree, '归档')
check('右列有「归档」按钮', archBtn !== null)
if (archBtn !== null) {
  archBtn.props.onClick()
  await tick(30)
  tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
  const afterArchive = allText(tree)
  check('归档后给出提示', afterArchive.includes('已归档'))
  check('归档后文件真的到了归档区', existsSync(join(ARCHIVE_DIR, 'A库.json')) && !existsSync(join(BANK_DIR, 'A库.json')))
  // 恢复按钮在左列的归档区里（默认展开）。
  // ⚠ 归档区里**本来就有一个**「旧库」，所以不能拿"第一个恢复按钮"——必须按题库名定位那一行，
  //   否则测的是"点了别人的恢复"（第一版就是这么错的）。
  const restoreRow =
    elements(tree)
      .filter((el) => el.type === 'div' && allText(el).includes('A库') && allText(el).includes('恢复'))
      .sort((a, b) => allText(a).length - allText(b).length)[0] ?? null
  const restoreBtn = restoreRow === null ? null : find(restoreRow, (b) => b.type === 'button' && allText(b).includes('恢复'))
  check('归档区出现「恢复」按钮', restoreBtn !== null)
  if (restoreBtn !== null) {
    restoreBtn.props.onClick()
    await tick(30)
    tree = renderOnce(ReactStub.createElement(mainReg.component, { useSessions }))
    check('恢复后给出提示', allText(tree).includes('已恢复'))
    check('恢复后文件回到工作区', existsSync(join(BANK_DIR, 'A库.json')) && !existsSync(join(ARCHIVE_DIR, 'A库.json')))
  }
}

// 8) 侧栏图标：点击应当切到 main 面板（key 正确才不会抛错）
const icon = renderOnce(ReactStub.createElement(sideReg.component, { size: 18, active: false }))
const iconButton = find(icon, (el) => el.type === 'button')
check('侧栏图标渲染出一个按钮', iconButton !== null)
if (iconButton !== null) {
  iconButton.props.onClick()
  check('点击侧栏图标切到 main 面板 lh-bank', layoutCalls.includes('lh-bank'), JSON.stringify(layoutCalls))
}

// 8b) 空选偏好要能被"重新打开面板"读回来（localStorage 往返）。
// 旧实现读侧把空串当"没存过"退回 ['human']——存了也白存，空选永远只活到刷新那一下。
{
  /** 模拟"关掉面板再打开"：重跑一遍 factory + apply + 渲染（选「全部题库」，记录段跨库最明显）。 */
  const reopenWith = async (stored) => {
    storage.set('lh.bank.answerers', stored)
    storage.set('lh.bank.selected', 'all')
    const freshExports = factory.f((name) => {
      if (name === 'react') return ReactStub
      throw new Error(`未知 require：${name}`)
    })
    const freshRegs = []
    freshExports.apply({
      get: () => undefined,
      slots: {
        inject(name, fn) {
          fn()
          return () => {}
        },
        register(options, component) {
          freshRegs.push({ options, component })
          return () => {}
        },
      },
      layout: { selectPanel() {} },
    })
    const freshMain = freshRegs.find((r) => r.options.name === 'main')
    renderOnce(ReactStub.createElement(freshMain.component, { useSessions }))
    await tick()
    return allText(renderOnce(ReactStub.createElement(freshMain.component, { useSessions })))
  }

  const withEmpty = await reopenWith('')
  check('重开面板后空选仍在（不悄悄变回「用户」）', withEmpty.includes('（未选）'), withEmpty.slice(0, 300))
  check('重开面板后确实一条记录都不显示', !withEmpty.includes('刷片段阅读那一段'), withEmpty.slice(0, 300))
  const withHuman = await reopenWith('human')
  check('对照：存的是 human 时记录正常显示（证明上一条不是碰巧落空）', withHuman.includes('刷片段阅读那一段'), withHuman.slice(0, 300))
}

// 9) 收尾：闸门自己不许制造垃圾
const realLogBytesAfter = existsSync(REAL_LOG) ? statSync(REAL_LOG).size : 0
check('真实学习史一个字节都没变', realLogBytesAfter === realLogBytesBefore, `${realLogBytesBefore} → ${realLogBytesAfter}`)

try {
  rmSync(sandbox, { recursive: true, force: true })
} catch {
  /* 删不掉临时目录不该掩盖结果 */
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
if (fail > 0) {
  console.log('全部通过。'.replace('全部通过。', ''))
  process.exit(1)
}
console.log('全部通过。')
process.exit(0)
