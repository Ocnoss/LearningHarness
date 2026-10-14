/**
 * lh-workspace-ui 的路由与写入自测 —— **不开浏览器也能证明这条路是通的**。
 *
 * ═══ 为什么必须有它（它是哪种缺失的补丁）═══
 * 本项目有一条反复出现的失败形状：**"形态正确 ≠ 功能可达"**。
 * 客户端半的手工 bundle 在闸门眼里只是"一个能被 import 的文件"——
 * 它有没有真的注册进插槽、按钮点下去有没有路可走，闸门一概不知道。
 * 而 AI 是无头的：界面长什么样、点得动点不动，它**永远看不见**。
 *
 * 所以这里退一步，测**界面唯一依赖的那条通道**：
 *   服务端路由 → @lh/course-tree/commands（唯一写入）→ 事件日志 → 投影 → 回给界面。
 * 这条链上任何一环断了，界面上就是"点了没反应"——而那种失败静默、代价高。
 * 界面外观仍然只能由作者看一眼（B10），但"点了有没有用"从此有闸门管。
 *
 * ═══ 为什么用临时数据目录 ═══
 * `paths.js` 的优先级第一是 `LH_DATA_DIR`，所以本测试把它指到系统临时目录下的
 * 一次性目录：**绝不碰真实学习史**（本项目为"测试写进真实日志"付过代价）。
 *
 * 运行：node plugins/lh-workspace-ui/selftest.mjs
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠ 必须在**任何调用之前**设好（paths.js 是惰性求值，import 时读不到才对）。
const sandbox = mkdtempSync(join(tmpdir(), 'lh-workspace-ui-selftest-'))
process.env.LH_DATA_DIR = sandbox
delete process.env.LH_EVENT_LOG

const { apply: applyWorkspaceUi, ROUTE_PREFIX } = await import('./index.js')
const { apply: applyCourseTree } = await import('@lh/course-tree')
const { coursePathText, cachedTree } = await import('@lh/course-tree/commands')

let pass = 0
let fail = 0

/**
 * 一条断言。
 * @param label - 断言说明。
 * @param ok - 是否成立。
 * @param detail - 失败时附加的信息。
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

// ── 把服务端半挂到一个假 ctx 上，抓住它注册的路由处理体 ──

/** 捕获到的路由选项。 */
let route = null
applyWorkspaceUi({
  effect: (fn) => fn(),
  on: () => {},
  webServer: {
    register: (options) => {
      route = options
      return () => {}
    },
  },
})

if (route === null) {
  console.error('✗ 服务端半没有注册任何路由')
  process.exit(1)
}

/**
 * 造一个最小的请求对象（够 `readJsonBody` 与 handler 用）。
 * @param method - HTTP 方法。
 * @param path - ROUTE_PREFIX 之后的路由。
 * @param body - 请求体对象（省略表示空体）。
 * @returns 假 req。
 */
function makeReq(method, path, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const listeners = new Map()
  const req = {
    method,
    url: `${ROUTE_PREFIX}${path}`,
    on(event, cb) {
      listeners.set(event, cb)
      return req
    },
    destroy() {},
  }
  // handler 是 async 的：先把它自己挂上去，再触发 data/end。
  queueMicrotask(() => {
    if (text !== '') listeners.get('data')?.(Buffer.from(text, 'utf8'))
    listeners.get('end')?.()
  })
  return req
}

/**
 * 调一次路由，拿回 `{ status, body }`。
 * @param method - HTTP 方法。
 * @param path - 路由。
 * @param body - 请求体。
 * @returns `{ status, body }`。
 */
async function call(method, path, body) {
  let status = 0
  let raw = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(text) {
      raw = text
    },
  }
  await route.handler(makeReq(method, path, body), res)
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = raw
  }
  return { status, body: parsed }
}

console.log(`\n=== 1. GET /tree：空日志时是空树，不是 500 ===`)
{
  const r = await call('GET', '/tree')
  check('状态 200', r.status === 200, `实际 ${r.status}`)
  check('节点数为 0', r.body?.node_count === 0, JSON.stringify(r.body))
  check('有 roots 数组', Array.isArray(r.body?.roots))
}

console.log(`\n=== 2. POST /course：建顶层课程 ===`)
let rootId = null
{
  const r = await call('POST', '/course', { title: '行测' })
  check('状态 200', r.status === 200, JSON.stringify(r.body))
  check('层级为 1', r.body?.level === 1, JSON.stringify(r.body))
  check('parent_id 为 null', r.body?.parent_id === null)
  check('path 只有自己', Array.isArray(r.body?.path) && r.body.path.length === 1)
  rootId = r.body?.node_id ?? null
}

console.log(`\n=== 3. POST /course：在它下面建子课程（层级 +1） ===`)
let childId = null
{
  const r = await call('POST', '/course', { title: '资料分析', parent_id: rootId })
  check('状态 200', r.status === 200, JSON.stringify(r.body))
  check('层级为 2', r.body?.level === 2, JSON.stringify(r.body))
  check('parent_id 指向父节点', r.body?.parent_id === rootId)
  check('path = [行测, 资料分析]', JSON.stringify(r.body?.path) === JSON.stringify(['行测', '资料分析']), JSON.stringify(r.body?.path))
  childId = r.body?.node_id ?? null

  // 再深一层：证明"递归"不是嘴上说的。
  const r3 = await call('POST', '/course', { title: '增长率', parent_id: childId })
  check('第三层层级为 3', r3.body?.level === 3, JSON.stringify(r3.body))
}

console.log(`\n=== 4. GET /tree：父子关系与会话分组 ===`)
{
  const r = await call('GET', '/tree')
  check('节点数为 3', r.body?.node_count === 3, String(r.body?.node_count))
  check('roots 只有一个', Array.isArray(r.body?.roots) && r.body.roots.length === 1, JSON.stringify(r.body?.roots))
  check('行测 的子节点是 资料分析', JSON.stringify(r.body?.children_of?.[rootId]) === JSON.stringify([childId]), JSON.stringify(r.body?.children_of))
}

console.log(`\n=== 5. POST /bind：把一个会话绑到子课程 ===`)
{
  const r = await call('POST', '/bind', { node_id: childId, session_id: 'session-test-1' })
  check('状态 200', r.status === 200, JSON.stringify(r.body))
  check('回报绑到了哪个节点', r.body?.node_id === childId)
  check('回报绑了哪个会话', r.body?.session_id === 'session-test-1')

  const t = await call('GET', '/tree')
  check('树里出现这条绑定', t.body?.session_bindings?.['session-test-1'] === childId, JSON.stringify(t.body?.session_bindings))
  const node = (t.body?.nodes ?? []).find((n) => n.node_id === childId)
  check('该节点下挂着这个会话', JSON.stringify(node?.sessions) === JSON.stringify(['session-test-1']), JSON.stringify(node?.sessions))
  check('session_count = 1', t.body?.session_count === 1, String(t.body?.session_count))
}

console.log(`\n=== 6. 再绑一次：取最新一次绑定（不删历史） ===`)
{
  await call('POST', '/bind', { node_id: rootId, session_id: 'session-test-1' })
  const t = await call('GET', '/tree')
  check('绑定改到了 行测', t.body?.session_bindings?.['session-test-1'] === rootId)
  const log = readFileSync(join(sandbox, 'events.jsonl'), 'utf8').trim().split('\n')
  const boundEvents = log.filter((l) => l.includes('lh/course/session-bound'))
  check('日志里有两条 session-bound（历史没被改写）', boundEvents.length === 2, `实际 ${boundEvents.length}`)
}

console.log(`\n=== 7. POST /rename：改名是追加事件 ===`)
{
  const r = await call('POST', '/rename', { node_id: childId, title: '资料分析（第2版）' })
  check('状态 200', r.status === 200, JSON.stringify(r.body))
  const t = await call('GET', '/tree')
  const node = (t.body?.nodes ?? []).find((n) => n.node_id === childId)
  check('新名字生效', node?.title === '资料分析（第2版）', String(node?.title))
}

console.log(`\n=== 8. 输入有问题时是 400，且话说得能照做 ===`)
{
  const empty = await call('POST', '/course', { title: '   ' })
  check('空课程名 → 400', empty.status === 400, `实际 ${empty.status}`)
  check('错误信息可读', typeof empty.body?.error === 'string' && empty.body.error.includes('课程名'), JSON.stringify(empty.body))

  const missing = await call('POST', '/course', { title: '新课', parent_id: '不存在的课' })
  check('父课程找不到 → 400', missing.status === 400, `实际 ${missing.status}`)
  check('提示去看 list_courses', String(missing.body?.error ?? '').includes('list_courses'), JSON.stringify(missing.body))

  const noSession = await call('POST', '/bind', { node_id: childId, session_id: '' })
  check('空会话 id → 400（编号缺失不许编）', noSession.status === 400, JSON.stringify(noSession.body))

  const badRoute = await call('GET', '/nope')
  check('未知路由 → 404', badRoute.status === 404, `实际 ${badRoute.status}`)
}

console.log(`\n=== 9. 课程路径文本（R5：层级与名字要进上下文） ===`)
{
  const { tree } = cachedTree()
  const text = coursePathText(tree, 'session-test-1')
  // 第 6 步把它绑回了 行测（第 1 层）。
  check('绑到顶层时文本含课程名与层数', text !== null && text.includes('行测') && text.includes('第 1 层'), String(text))
  check('未绑定的会话返回 null（不编一句空话）', coursePathText(tree, 'session-never-bound') === null)
}

console.log(`\n=== 10. 课程归属真的进了系统提示词（R5 的落点） ===`)
{
  /** 抓住 course-tree 注册的运行时上下文。 */
  let contextDecl = null
  applyCourseTree({
    on: () => {},
    inject: (services, cb) => {
      // 宿主注入口：这里只关心 systemPrompt 那一次。
      if (services.includes('systemPrompt')) {
        cb({
          systemPrompt: {
            context: (decl) => {
              contextDecl = decl
              return () => {}
            },
          },
        })
      }
    },
    tools: { register: () => () => {} },
  })

  check('注册了运行时上下文', contextDecl !== null)
  check('名字是 lh:course', contextDecl?.name === 'lh:course', String(contextDecl?.name))
  check('order 是 117', contextDecl?.order === 117, String(contextDecl?.order))

  const assembled = contextDecl.text({ agent: { session: { header: { id: 'session-test-1' } } } })
  check('已绑定的会话：文本里有课程路径', typeof assembled === 'string' && assembled.includes('行测'), JSON.stringify(assembled).slice(0, 120))
  check('文本里点明"当前会话所属课程"', String(assembled).includes('当前会话所属课程'))

  const unbound = contextDecl.text({ agent: { session: { header: { id: 'session-never-bound' } } } })
  check('未绑定：注入空串（不打扰）', unbound === '', JSON.stringify(unbound))

  const noAgent = contextDecl.text({})
  check('没有 agent：注入空串（诊断性组装不带 agent）', noAgent === '')
}

console.log(`\n=== 11. 事件日志确实写到了临时沙箱（没碰真实学习史） ===`)
{
  const logPath = join(sandbox, 'events.jsonl')
  check('沙箱里有 events.jsonl', existsSync(logPath), logPath)
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  check('每行都是合法 JSON', lines.every((l) => { try { JSON.parse(l); return true } catch { return false } }))
  const types = lines.map((l) => JSON.parse(l).type)
  check('写的是 lh/course/* 事件', types.every((t) => String(t).startsWith('lh/course/')), JSON.stringify(types))
  const provenance = JSON.parse(lines[0]).provenance
  check('provenance 带插件名与版本', provenance?.plugin === '@lh/course-tree' && typeof provenance?.version === 'string', JSON.stringify(provenance))
}

// ── 收尾：删掉一次性沙箱。只删自己建的那一个目录（白名单，不按"像不像"删）──
rmSync(sandbox, { recursive: true, force: true })

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
if (fail > 0) process.exit(1)
