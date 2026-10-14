/**
 * lh-course-ui 的【服务端半】—— 给课程树面板提供只读数据。
 *
 * ═══ 它做什么 ═══
 * 在 `/lh/course` 前缀下注册三条**只读**路由，把"课程树 + 断言 + 传递边"从事件日志
 * 投影出来发给浏览器面板：
 *   · `GET /tree`             —— 整棵树（每节点带断言计数、当前绑定会话）；
 *   · `GET /assertions?scope=`—— 某节点的断言事件 + 传递边（derived_from / propagate_to）；
 *   · `GET /recent?since=`    —— 某时刻之后的断言/传递事件（面板轮询它做"向上传递"动画）。
 *
 * ═══ 为什么走 HTTP 路由而不是 ctx.remote（同 lh-practice）═══
 * 界面是浏览器里的 React 组件，`ctx.remote` 要求服务端导出**构建期生成**的 `./typert`
 * 契约，而生成器没随发行版发布。所以用最朴素也最稳的通道：`ctx.webServer.register`。
 *
 * ═══ 为什么是"只读"、且不重复实现树逻辑 ═══
 * 树的形状**只有一处实现**：`@lh/course-tree/tree` 的 `buildTree`（ADR-032）。
 * 本插件只是它的一个**调用者**——与 agent 用 `list_courses` 工具、断言器定位父节点
 * 走的是同一套投影。界面绝不自己再推一遍"谁是根的谁"，否则两处迟早不一致，
 * 而不一致会让面板画出一棵与断言传递路径**不同**的树（那种错肉眼极难发现）。
 *
 * ═══ 装载期不抛错（契约 §五之二，同 lh-practice）═══
 * `apply()` 里不解析数据目录、不读日志——数据目录没配好时那些会抛，而 profile 插件
 * apply 抛错会让整棵插件树加载失败、dsh 起不来。读失败留到请求那一刻，返回 503 + fix。
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 跨包引用一律用**包名**（PLUGIN_CONTRACT §3）：本包会被 pnpm 装进 profiles/web/node_modules，
// 那时相对路径 `../lh-event-store/…` 不再可达，导入失败会让 dsh 完全起不来。
import { readEvents } from '@lh/event-store/store'
import { buildTree, nodeIdOfScope } from '@lh/course-tree/tree'

/** 插件名。 */
export const name = 'lh-course-ui'

/** 声明依赖：`webServer` 用于注册 HTTP 路由。 */
export const inject = ['webServer']

/** 路由前缀。与 practice 的 `/lh/practice` 不撞。 */
export const ROUTE_PREFIX = '/lh/course'

/** 断言事件类型（与 lh-asserter 写的一致）。 */
const ASSERTION_EVENT = 'lh/assertion/made'

/** /recent 单次最多回多少条（防日志很大时一次吐爆面板）。 */
const RECENT_LIMIT = 200

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 记一条调试痕迹（与 LH 事件严格分开）。
 * @param line - 文本。
 */
function trace(line) {
  try {
    appendFileSync(join(HERE, 'trace.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

/**
 * 发一个 JSON 响应。
 * @param res - ServerResponse。
 * @param status - HTTP 状态码。
 * @param body - 要序列化的对象。
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 把一条断言事件映射成面板要的形状（去掉信封噪声，只留面板用得上的字段）。
 * @param event - `lh/assertion/made` 事件。
 * @returns 断言视图对象。
 */
function assertionView(event) {
  const d = event.data ?? {}
  return {
    id: event.id,
    timestamp: event.timestamp,
    node_id: typeof d.node_id === 'string' ? d.node_id : null,
    asserter: typeof d.asserter === 'string' ? d.asserter : null,
    statement: typeof d.statement === 'string' ? d.statement : '',
    evidence: Array.isArray(d.evidence) ? d.evidence : [],
    derived_from: Array.isArray(d.derived_from) ? d.derived_from : [],
    propagate_to: typeof d.propagate_to === 'string' ? d.propagate_to : null,
    confidence: typeof d.confidence === 'number' ? d.confidence : null,
    model: d.model ?? null,
  }
}

/**
 * 从事件日志里挑出所有断言事件（按写入序）。
 * @param events - 全量事件。
 * @returns 断言视图数组。
 */
function assertionEvents(events) {
  const out = []
  for (const e of events) {
    if (e !== null && typeof e === 'object' && e.type === ASSERTION_EVENT) out.push(assertionView(e))
  }
  return out
}

/**
 * 读事件；数据目录没配好时返回 null（调用方转 503，而不是让 apply/请求崩掉）。
 * @returns 事件数组或 null。
 */
function safeReadEvents() {
  try {
    return readEvents()
  } catch (error) {
    trace(`READ_EVENTS_FAILED  ${error?.message ?? error}`)
    return null
  }
}

/** 数据目录没配好时给面板的统一说明（照 practice 的 503 + fix 形状）。 */
const NO_DATA = {
  error: '读不到 LH 事件日志，取不了课程树。',
  fix: [
    '在 lh-install.json 里配好 repo_root / data_dir，或设环境变量 LH_DATA_DIR / LH_EVENT_LOG',
    '然后重启 dsh（数据目录是启动时定位的）',
  ],
  why: '课程树与断言都是事件日志的投影；日志读不到就无从投影。刻意不在装载期抛错——那会让 dsh 起不来。',
}

/**
 * 组装 `/tree` 的返回：树 + 每节点断言计数 + 会话绑定。
 * @param events - 全量事件。
 * @returns 树视图对象。
 */
function buildTreeView(events) {
  const tree = buildTree(events)
  const assertions = assertionEvents(events)

  // 每节点断言计数（面板在节点上标"n 条断言"）。
  const countByNode = Object.create(null)
  for (const a of assertions) {
    if (a.node_id !== null) countByNode[a.node_id] = (countByNode[a.node_id] ?? 0) + 1
  }

  // 每节点绑定了哪些会话（面板高亮"当前会话所在节点"用）。
  const sessionsByNode = Object.create(null)
  for (const [sid, nid] of Object.entries(tree.sessionBindings)) {
    ;(sessionsByNode[nid] ??= []).push(sid)
  }

  const nodes = tree.nodes.map((n) => ({
    node_id: n.id,
    title: n.title,
    level: n.level,
    parent_id: n.parentId,
    asserter: n.asserter,
    assertion_count: countByNode[n.id] ?? 0,
    sessions: sessionsByNode[n.id] ?? [],
  }))

  return {
    nodes,
    roots: tree.roots,
    // childrenOf 用普通对象，键是父 id（根的键是空串）——直接可序列化。
    children_of: tree.childrenOf,
    session_bindings: tree.sessionBindings,
    assertion_total: assertions.length,
  }
}

/**
 * 插件体。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  trace('APPLY_CALLED')

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'

        try {
          // ── GET /lh/course/tree ──
          if (route === '/tree' && req.method === 'GET') {
            const events = safeReadEvents()
            if (events === null) { sendJson(res, 503, NO_DATA); return }
            const view = buildTreeView(events)
            trace(`GET /tree  nodes=${view.nodes.length} assertions=${view.assertion_total}`)
            sendJson(res, 200, view)
            return
          }

          // ── GET /lh/course/assertions?scope=course/<id>  （或 ?node=<id>）──
          if (route === '/assertions' && req.method === 'GET') {
            const events = safeReadEvents()
            if (events === null) { sendJson(res, 503, NO_DATA); return }
            const scope = url.searchParams.get('scope') ?? ''
            const nodeParam = url.searchParams.get('node') ?? ''
            const nodeId = nodeParam !== '' ? nodeParam : nodeIdOfScope(scope)
            const all = assertionEvents(events)
            const scoped = nodeId === null ? all : all.filter((a) => a.node_id === nodeId)

            // 传递边：把 derived_from / propagate_to 整理成面板能直接画的边。
            // from = 子断言事件 id，to = 父断言事件 id（沿 derived_from 反查）。
            const byId = Object.create(null)
            for (const a of all) byId[a.id] = a
            const edges = []
            for (const a of scoped) {
              for (const parentId of a.derived_from) {
                const parent = byId[parentId]
                if (parent !== undefined) {
                  edges.push({
                    from_node: a.node_id,
                    to_node: parent.node_id,
                    from_assertion: a.id,
                    to_assertion: parent.id,
                  })
                }
              }
            }

            trace(`GET /assertions  node=${nodeId ?? '(all)'} n=${scoped.length} edges=${edges.length}`)
            sendJson(res, 200, { node_id: nodeId, assertions: scoped, edges })
            return
          }

          // ── GET /lh/course/recent?since=<ISO> ──
          // 面板轮询它做"向上传递"动画：只回 since 之后新出现的断言。
          if (route === '/recent' && req.method === 'GET') {
            const events = safeReadEvents()
            if (events === null) { sendJson(res, 503, NO_DATA); return }
            const since = url.searchParams.get('since') ?? ''
            const all = assertionEvents(events)
            const fresh = since === ''
              ? all.slice(-RECENT_LIMIT)
              : all.filter((a) => typeof a.timestamp === 'string' && a.timestamp > since)
            trace(`GET /recent  since=${since === '' ? '(none)' : since} n=${fresh.length}`)
            sendJson(res, 200, {
              assertions: fresh.slice(-RECENT_LIMIT),
              server_time: new Date().toISOString(),
            })
            return
          }

          sendJson(res, 404, { error: `未知路由 ${route}` })
        } catch (error) {
          trace(`ROUTE_ERROR ${route}  ${error?.message ?? error}`)
          sendJson(res, 500, { error: error?.message ?? String(error) })
        }
      },
    })
    trace(`ROUTE_REGISTERED  ${ROUTE_PREFIX} (prefix)`)
    return dispose
  })

  ctx.on('dispose', () => trace('DISPOSED'))
}
