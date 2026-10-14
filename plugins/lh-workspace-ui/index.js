/**
 * lh-workspace-ui 的【服务端半】—— 给「课程目录」面板提供数据与写入。
 *
 * ═══ 它做什么 ═══
 * 在 `/lh/workspace` 前缀下注册四条路由：
 *   · `GET  /tree`    课程树 + 每节点绑定的会话 + 未绑定会话清单；
 *   · `POST /course`  建课程 / 子课程；
 *   · `POST /rename`  改课程名（追加 renamed 事件）；
 *   · `POST /bind`    把某个**宿主会话**绑到某门课。
 *
 * ═══ 为什么这里会有写路由（而不是像第一版那样只读）═══
 * 第一版刻意只读，理由是"写入仍走 agent 工具"。那在**只有对话一个入口**时成立；
 * 但「课程树视图用来管理会话」这件事本身就要求**在树上直接操作**：
 * 建子课程、改名字、把会话挪到某门课下。全都要先说一句话让模型去调工具，
 * 那就不是"视图管理"，是"对话管理 + 一个只读显示器"。
 *
 * 分工因此改成：**判断归 agent，机械动作归界面**——
 *   · 写路由**不做任何教学判断**，它只把学习者点的那一下翻译成一条课程事件；
 *   · 事件怎么拼、层级怎么算、歧义怎么报，全部复用 `@lh/course-tree/commands`
 *     ——与 agent 工具**同一份代码**，所以两条路写出来的日志一模一样。
 *
 * ═══ 为什么不复用 /lh/course/tree，而要新开一条 ═══
 * 不是重复实现，是**消费者的分工不同**：
 *   · `/lh/course/tree`（lh-course-ui）服务于"看断言怎么沿树上行"——它把断言计数与传递边
 *     当主角，树是配角；
 *   · `/lh/workspace/tree`（本插件）服务于"管理我的课程与会话"——树是主角，
 *     每个课程下**挂着哪些会话**才是要回答的问题。
 * 两者都调同一个 `buildDirectoryView`（唯一视图组装），所以"树长什么样"永远只有一处定义。
 *
 * ═══ 为什么走 HTTP 路由而不是 ctx.remote（同 lh-practice / lh-course-ui）═══
 * 界面是浏览器里的 React 组件，`ctx.remote` 要求服务端导出**构建期生成**的 `./typert`
 * 契约，而生成器没随发行版发布。所以用最朴素也最稳的通道：`ctx.webServer.register`。
 *
 * ═══ 装载期不抛错（契约 §五之二）═══
 * `apply()` 里不解析数据目录、不读日志——那些会抛，而 profile 插件 apply 抛错会让
 * 整棵插件树加载失败、dsh 起不来。读失败留到请求那一刻，返回 503 + fix。
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 跨包引用一律用**包名**（PLUGIN_CONTRACT §3）：本包会被 pnpm 装进 profiles/<名>/node_modules，
// 那时相对路径 `../lh-event-store/…` 不再可达，导入失败会让 dsh 完全起不来。
import { readEvents } from '@lh/event-store/store'
import { buildDirectoryView } from '@lh/course-tree/directory'
import { ACTOR_USER, bindSession, createCourse, deleteCourse, previewDelete, renameCourse } from '@lh/course-tree/commands'

/** 插件名。 */
export const name = 'lh-workspace-ui'

/** 声明依赖：`webServer` 用于注册 HTTP 路由。 */
export const inject = ['webServer']

/** 路由前缀。与 `/lh/practice`、`/lh/course` 都不撞。 */
export const ROUTE_PREFIX = '/lh/workspace'

/** 请求体上限。课程动作的载荷都是几个短字符串，64KB 已经宽得离谱。 */
const MAX_BODY_BYTES = 64 * 1024

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
 * 读并解析 JSON 请求体（带上限，避免一个坏请求把内存吃干）。
 *
 * @param req - IncomingMessage。
 * @returns 解析后的对象；空体返回 `{}`。
 * @throws 体超限或不是合法 JSON 时。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限。`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`))
      }
    })
  })
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
  error: '读不到 LH 事件日志，取不了课程目录。',
  fix: [
    '在 lh-install.json 里配好 repo_root / workspace，或设环境变量 LH_DATA_DIR / LH_EVENT_LOG',
    '然后重启 dsh（数据目录是启动时定位的）',
  ],
  why: '课程树是 lh/course/* 事件的投影；日志读不到就无从投影。刻意不在装载期抛错——那会让 dsh 起不来。',
}

/**
 * 服务端半**拒绝**的请求形状（与课程无关的输入）。
 *
 * 为什么单独一个判定：`POST /bind` 的 `session_id` 是**宿主会话 id**，
 * 而我们无法在服务端核实它真的存在（服务端没有会话注册表）。
 * 于是这里只挡住"空/非字符串"这类明显错误，剩下的事实在读取端体现
 * ——面板会把它列在"未归课的会话"之外，学习者立刻看得见它没上榜。
 * 这比在这里猜一个会话全集要诚实（猜错 = 静默吞掉真实会话）。
 *
 * @param value - 待检值。
 * @returns 干净的字符串或 null。
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 把命令层抛出的错误分类成 HTTP 状态。
 *
 * 两类必须分开，否则学习者看到的东西完全不同：
 *   · 数据目录没配好 → 503 + fix（"去改配置"是唯一出路，重试没有意义）；
 *   · 输入有问题（课程名空、课程找不到、有歧义）→ 400，把命令层那句话原样端出去
 *     （它已经写成"读者能照做"的形状了）。
 *
 * @param error - 捕获到的错误。
 * @returns `{ status, body }`。
 */
function classify(error) {
  const message = String(error?.message ?? error)
  if (message.includes('lh-paths') || message.includes('找不到 LH 的数据目录')) {
    return { status: 503, body: { ...NO_DATA, detail: message } }
  }
  return { status: 400, body: { error: message } }
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
          // ── GET /lh/workspace/tree ──
          if (route === '/tree' && req.method === 'GET') {
            const events = safeReadEvents()
            if (events === null) {
              sendJson(res, 503, NO_DATA)
              return
            }
            const view = buildDirectoryView(events)
            trace(`GET /tree  nodes=${view.node_count} sessions=${view.session_count}`)
            sendJson(res, 200, view)
            return
          }

          // ── POST /lh/workspace/course ──
          if (route === '/course' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const created = createCourse({
              title: body.title,
              parentRef: nonEmptyString(body.parent_id),
              actor: ACTOR_USER,
            })
            trace(`POST /course  node=${created.node_id} level=${created.level} title=${created.title}`)
            sendJson(res, 200, created)
            return
          }

          // ── GET /lh/workspace/impact?node=<id|标题> ──
          //
          // 删除的**只读前置**：算出"删了会怎样"，什么都不改。
          // 界面拿它渲染确认框里的清单（哪些子课程会消失、哪些会话会变成未归课）。
          // 它复用 `previewDelete`（纯函数），与 agent 那条两段式工具看的是同一份计算。
          if (route === '/impact' && req.method === 'GET') {
            const impact = previewDelete({ nodeRef: nonEmptyString(url.searchParams.get('node')) })
            trace(`GET /impact  node=${impact.node_id} subs=${impact.sub_courses.length} sessions=${impact.session_ids.length}`)
            sendJson(res, 200, impact)
            return
          }

          // ── POST /lh/workspace/delete ──
          //
          // ⚠ **必须显式带 `confirm: true`**。不带就把影响面回给他、并拒绝执行。
          // 这一道不是给界面用的（界面自己会先问一次），而是给**任何将来的调用方**用的：
          // 一个"点一下就删掉一棵树"的接口，迟早会被某处顺手调用。
          // 项目规则 4 是"破坏性操作一律白名单"——白名单要挡在**接口**上，不能只挡在按钮上。
          if (route === '/delete' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const nodeRef = nonEmptyString(body.node_id)
            if (body.confirm !== true) {
              const impact = previewDelete({ nodeRef })
              trace(`POST /delete  REFUSED(no confirm)  node=${impact.node_id}`)
              sendJson(res, 409, {
                error: '删除需要显式确认（confirm: true）。这是影响面：',
                impact,
                fix: ['先 GET /lh/workspace/impact 或看这里的 impact 字段，确认之后带 confirm: true 再调一次'],
              })
              return
            }
            const impact = deleteCourse({ nodeRef, actor: ACTOR_USER })
            trace(`POST /delete  node=${impact.node_id} subs=${impact.sub_courses.length} sessions=${impact.session_ids.length}`)
            sendJson(res, 200, { ...impact, deleted: true })
            return
          }

          // ── POST /lh/workspace/rename ──
          if (route === '/rename' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const changed = renameCourse({
              nodeRef: nonEmptyString(body.node_id),
              title: body.title,
              actor: ACTOR_USER,
            })
            trace(`POST /rename  node=${changed.node_id} title=${changed.title}`)
            sendJson(res, 200, changed)
            return
          }

          // ── POST /lh/workspace/bind ──
          if (route === '/bind' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const bound = bindSession({
              nodeRef: nonEmptyString(body.node_id),
              sessionId: nonEmptyString(body.session_id),
              actor: ACTOR_USER,
            })
            trace(`POST /bind  node=${bound.node_id} session=${bound.session_id}`)
            sendJson(res, 200, bound)
            return
          }

          sendJson(res, 404, { error: `未知路由 ${route}（支持 GET /tree|/impact 与 POST /course|/rename|/bind|/delete）` })
        } catch (error) {
          const { status, body } = classify(error)
          trace(`ROUTE_ERROR ${req.method} ${route}  ${status}  ${error?.message ?? error}`)
          sendJson(res, status, body)
        }
      },
    })
    trace(`ROUTE_REGISTERED  ${ROUTE_PREFIX} (prefix)  GET /tree + POST /course|/rename|/bind`)
    return dispose
  })

  ctx.on('dispose', () => trace('DISPOSED'))
}
