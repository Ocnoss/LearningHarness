/**
 * lh-schedule-ui 的【服务端半】—— 给「学习日历」面板提供数据与写入。
 *
 * ═══ 它做什么 ═══
 * 在 `/lh/schedule` 前缀下注册这几条路由：
 *   · `GET  /health`    自检：日志读不读得到、现在有多少条日程、今天是哪天；
 *   · `GET  /calendar`  一个区间（默认一个月）的三合一视图：
 *                       计划（日程） + 事实（哪段对话动过） + 课程动作；
 *   · `POST /create`    新建日程；
 *   · `POST /update`    改期/改名/标记完成/绑课程/绑对话；
 *   · `POST /cancel`    撤销（可恢复）。
 *
 * ═══ 写路由不做任何判断（与 @lh/workspace-ui 同一条分工）═══
 * **判断归 agent，机械动作归界面**：这三条写路由只把学习者点的那一下翻译成
 * 一次 `@lh/schedule/commands` 调用——与 agent 工具**同一份代码**。
 * 所以"在日历上点的"和"模型建的"日程，在事件日志里字节级同形。
 *
 * ═══ 为什么走 HTTP 路由而不是 ctx.remote ═══
 * `ctx.remote` 要求服务端导出**构建期生成**的 `./typert` 契约，而生成器
 * 没有随发行版发布（PLUGIN_CONTRACT §九 实测）。所以用最朴素也最稳的通道：
 * `ctx.webServer.register`。
 *
 * ═══ 装载期不抛错（契约 §五之二）═══
 * `apply()` 里不解析数据目录、不读日志——那些会抛，而 profile 插件 apply 抛错会让
 * 整棵插件树加载失败、dsh 起不来。读失败留到请求那一刻，返回 503 + fix。
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 跨包引用一律用**包名**（PLUGIN_CONTRACT §3）：本包会被 pnpm 装进
// profiles/<名>/node_modules，那时相对路径 `../lh-event-store/…` 不再可达。
import { readEvents } from '@lh/event-store/store'
import { buildDirectoryView } from '@lh/course-tree/directory'
import { ACTOR_USER, applySchedulePatch, cancelScheduleItem, createScheduleItem, readSchedule } from '@lh/schedule/commands'
import { buildCalendarView, buildTodoView, weekBounds } from '@lh/schedule/calendar'

/** 插件名。 */
export const name = 'lh-schedule-ui'

/** 声明依赖：`webServer` 用于注册 HTTP 路由。 */
export const inject = ['webServer']

/** 路由前缀。与 `/lh/workspace`、`/lh/course`、`/lh/practice` 都不撞。 */
export const ROUTE_PREFIX = '/lh/schedule'

/** 请求体上限。日程的载荷都是几个短字符串，64KB 已经宽得离谱。 */
const MAX_BODY_BYTES = 64 * 1024

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 记一条调试痕迹（与 LH 事件严格分开，同其它插件）。
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
 * @param req - IncomingMessage。
 * @returns 解析后的对象；空体返回 `{}`。
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
 * 请求体里有没有**我们不认识的字段**。
 *
 * ═══ 为什么这道检查是硬的（它是一次实测的产物）═══
 * 2026-10-09 的日期编排实测里出现了一个"比报错更糟"的形状：模型给工具传了
 * `until`，而**运行中的插件是旧版本、schema 里没有这个参数**——宿主把它
 * **静默丢弃**，工具正常返回、事件也写进去了，只是窗口不存在。
 * 调用方（模型）因此以为自己设好了窗口，而日志里什么都没有。
 *
 * 这条与契约 §七 的两条同源：「写入的字段不是'声明了却不生效'的」
 * 「认不出的如实回报而不是静默丢弃」。所以在**我们自己能控制的那一层**
 * （HTTP 写路由收得到原始 body）把它挡住：不认识的字段一律 400 + 列出可用的字段名。
 *
 * ⚠ 工具那一侧做不到这件事（host 传给 execute 的 args 已经过 schema 过滤，
 *   被丢弃的字段在插件里根本看不见）——**能挡的只有 HTTP 这条路**，
 *   这也是为什么这条检查必须写在这里。
 *
 * @param body - 解析后的请求体。
 * @param allowed - 该路由允许的字段名。
 * @returns 不认识的字段名数组。
 */
function unknownFields(body, allowed) {
  const known = new Set(allowed)
  return Object.keys(body ?? {}).filter((key) => !known.has(key))
}

/** `/create` 允许的字段。（`source` 允许显式给：自检脚本用 'selftest' 区分自己的数据；默认为 'ui'。） */
const CREATE_FIELDS = [
  'title',
  'day',
  'until',
  'start',
  'end',
  'kind',
  'note',
  'minutes',
  'course_id',
  'session_id',
  'tz',
  'source',
]
/** `/update` 允许的字段（`item_id`/`item` 二选一指定改哪条）。 */
const UPDATE_FIELDS = [
  'item_id',
  'item',
  'title',
  'day',
  'until',
  'start',
  'end',
  'kind',
  'note',
  'minutes_planned',
  'minutes_actual',
  'status',
  'course_id',
  'session_id',
]

/**
 * 数据目录没配好时给面板的统一说明（照 practice / workspace-ui 的 503 + fix 形状）。 */
const NO_DATA = {
  error: '读不到 LH 事件日志，取不了日程。',
  fix: [
    '在 lh-install.json 里配好 repo_root / workspace，或设环境变量 LH_DATA_DIR / LH_EVENT_LOG',
    '然后重启 dsh（数据目录是启动时定位的）',
  ],
  why: '日程是 lh/schedule/* 事件的投影；日志读不到就无从投影。刻意不在装载期抛错——那会让 dsh 起不来。',
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

/**
 * 取一个非空字符串（空/空白一律当"没有"）。
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
 *   · 输入有问题（日期认不出、找不到那条日程、有歧义）→ 400，
 *     把命令层那句话原样端出去（它已经写成"读者能照做"的形状了）。
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
 * 课程清单（供界面上的下拉选择）。
 *
 * ═══ 为什么这里可以 import @lh/course-tree ═══
 * 本插件是 **profile 行**，从 profile 的 node_modules 加载，那里 `@lh/course-tree`
 * 确实存在（它是 profile 的依赖）。而 preset 那一半（`@lh/schedule`）刻意不依赖它——
 * 因为 preset 行从**源码树**按绝对路径加载，源码树的 node_modules 里没有这个包。
 *
 * ═══ 为什么带 path ═══
 * 课程树是递归的，同名子课程（"复习"挂在两门课下）在只给 title 时会撞；
 * 界面上显示"行测 / 资料分析"才不会有歧义。path 在这里由 parent_id 链现算
 * ——**树的结构仍然只有 `buildDirectoryView` 一处推导**，这里只做展示用的拼接。
 *
 * @param events - LH 全量事件。
 * @returns `[{ node_id, title, level, path }]`。
 */
function courseOptions(events) {
  try {
    const view = buildDirectoryView(events)
    const byId = new Map(view.nodes.map((n) => [n.node_id, n]))
    return view.nodes.map((n) => {
      const chain = []
      let cursor = n
      let guard = 0
      while (cursor !== undefined && guard < 32) {
        chain.unshift(cursor.title)
        cursor = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id)
        guard += 1
      }
      return { node_id: n.node_id, title: n.title, level: n.level, path: chain }
    })
  } catch (error) {
    // 课程树读不出来不该让日历整块白掉：日程本来就可以不绑课。
    trace(`COURSE_OPTIONS_FAILED  ${error?.message ?? error}`)
    return []
  }
}

/**
 * 插件体。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  trace('APPLY_CALLED')
  ctx.on('dispose', () => trace('DISPOSED'))

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'

        try {
          // ── GET /lh/schedule/health ──
          //
          // 一条**不碰浏览器**的自检入口：作者能用 curl / 浏览器直接打它，
          // 确认"日志读得到吗、有多少条日程、今天算出来是哪天"。
          // 没有它的话，日历面板白屏时根本分不清是"没有日程"还是"读不到日志"。
          if (route === '/health' && req.method === 'GET') {
            const events = safeReadEvents()
            if (events === null) {
              sendJson(res, 503, NO_DATA)
              return
            }
            const plan = readSchedule()
            const view = buildCalendarView(events, { tz: nonEmptyString(url.searchParams.get('tz')), courses: [] })
            sendJson(res, 200, {
              ok: true,
              plugin: '@lh/schedule-ui',
              event_count: events.length,
              schedule_event_count: plan.event_count,
              item_count: plan.items.length,
              unknown_event_types: Object.entries(plan.unknown_types).map(([type, count]) => ({ type, count })),
              orphan_events: plan.orphan_events,
              today: view.today,
              tz: view.tz,
              tz_fallback: view.tz_fallback,
              route_prefix: ROUTE_PREFIX,
            })
            return
          }

          // ── GET /lh/schedule/calendar ──
          if (route === '/calendar' && req.method === 'GET') {
            const events = safeReadEvents()
            if (events === null) {
              sendJson(res, 503, NO_DATA)
              return
            }
            const tz = nonEmptyString(url.searchParams.get('tz'))
            const month = nonEmptyString(url.searchParams.get('month'))
            const from = nonEmptyString(url.searchParams.get('from'))
            const to = nonEmptyString(url.searchParams.get('to'))
            const week = nonEmptyString(url.searchParams.get('week'))

            // `week=<某天>` 是"那一周（周一到周日）"的快捷方式，
            // 让界面不必自己算周界（两处各算一遍迟早不一致）。
            let rangeFrom = from
            let rangeTo = to
            if (week !== null) {
              const bounds = weekBounds(week, tz)
              rangeFrom = bounds.from
              rangeTo = bounds.to
            }

            const view = buildCalendarView(events, {
              from: rangeFrom,
              to: rangeTo,
              month: week === null ? month : null,
              tz,
              courses: courseOptions(events),
            })
            trace(`GET /calendar  ${view.from}~${view.to}  days=${view.days.length} items=${view.summary.item_count}`)
            sendJson(res, 200, view)
            return
          }

          // ── GET /lh/schedule/todo ──
          //
          // 「待办区」的读法：**只列有内容的日子**（不像日历要铺满整月），
          // 并把"无日期待办"与"欠账"提到最前——它们是**需要现在做决定**的东西
          // （定个日子 / 顺延 / 撤掉），而未来的日程只是"知道就好"。
          // 它与 /calendar 共用同一份视图组装（`buildTodoView` 内部就是调它再重排），
          // 所以两个视图永远不会看见不同的日程。
          if (route === '/todo' && req.method === 'GET') {
            const events = safeReadEvents()
            if (events === null) {
              sendJson(res, 503, NO_DATA)
              return
            }
            const daysParam = Number(url.searchParams.get('days'))
            const view = buildTodoView(events, {
              tz: nonEmptyString(url.searchParams.get('tz')),
              horizonDays: Number.isFinite(daysParam) && daysParam > 0 ? daysParam : undefined,
              courses: courseOptions(events),
            })
            trace(
              `GET /todo  ${view.from}~${view.to}  backlog=${view.summary.backlog} overdue=${view.summary.overdue} days=${view.day_count}`,
            )
            sendJson(res, 200, view)
            return
          }

          // ── POST /lh/schedule/create ──
          if (route === '/create' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const unknown = unknownFields(body, CREATE_FIELDS)
            if (unknown.length > 0) {
              trace(`POST /create  UNKNOWN_FIELDS  ${unknown.join(',')}`)
              sendJson(res, 400, {
                error: `不认识的字段：${unknown.join('、')}。**没有任何东西被写下去**（静默丢弃会让调用方以为自己设好了）。`,
                accepted: CREATE_FIELDS,
                fix: ['用 accepted 里列出的字段名重发一次；日期字段一律是 YYYY-MM-DD 字符串'],
              })
              return
            }
            const created = createScheduleItem({
              title: body.title,
              // 日期可以不给（= 进待办区）。缺字段/空串都读成"不定日期"，
              // 但**不**把 `undefined` 透下去——命令层要的是"明确没有日期"。
              day: body.day === undefined || body.day === null || body.day === '' ? null : body.day,
              until: body.until ?? null,
              start: body.start ?? null,
              end: body.end ?? null,
              kind: body.kind ?? 'study',
              note: body.note ?? null,
              courseId: nonEmptyString(body.course_id),
              sessionId: nonEmptyString(body.session_id),
              minutes: typeof body.minutes === 'number' ? body.minutes : null,
              tz: nonEmptyString(body.tz),
              // 默认 'ui'（这是界面那条写路径）；自检脚本可以显式写 'selftest'，
              // 好让"这是自检数据"这件事在日志里自证，而不是靠标题去猜。
              source: nonEmptyString(body.source) ?? 'ui',
              actor: ACTOR_USER,
            })
            const plan = readSchedule()
            trace(`POST /create  item=${created.item_id} day=${created.day}`)
            sendJson(res, 200, { created: true, item: plan.byId[created.item_id] ?? null })
            return
          }

          // ── POST /lh/schedule/update ──
          //
          // 请求体里的字段名与 `@lh/schedule/commands` 的 patch 键**同名**，
          // 所以这里是"白名单挑字段"而不是"翻译字段"——多一个翻译层就多一处会写错的地方。
          if (route === '/update' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const unknown = unknownFields(body, UPDATE_FIELDS)
            if (unknown.length > 0) {
              trace(`POST /update  UNKNOWN_FIELDS  ${unknown.join(',')}`)
              sendJson(res, 400, {
                error: `不认识的字段：${unknown.join('、')}。**没有改任何东西**。`,
                accepted: UPDATE_FIELDS,
                fix: ['用 accepted 里列出的字段名重发一次'],
              })
              return
            }
            const itemRef = nonEmptyString(body.item_id) ?? nonEmptyString(body.item)
            const patch = {}
            for (const key of [
              'title',
              'day',
              'until',
              'start',
              'end',
              'kind',
              'note',
              'minutes_planned',
              'minutes_actual',
              'status',
              'course_id',
              'session_id',
            ]) {
              if (!Object.prototype.hasOwnProperty.call(body, key)) continue
              // 显式 null 与 '' 都表示"清空"（界面上的"解绑"按钮发的是空串）。
              patch[key] = body[key] === null ? null : body[key]
            }
            const result = applySchedulePatch({ itemRef, patch, actor: ACTOR_USER })
            trace(`POST /update  item=${result.item.item_id} changed=${result.changed.join(',') || '(无)'}`)
            sendJson(res, 200, { changed: result.changed, item: result.item, events: result.events })
            return
          }

          // ── POST /lh/schedule/cancel ──
          if (route === '/cancel' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const unknown = unknownFields(body, ['item_id', 'item', 'reason'])
            if (unknown.length > 0) {
              sendJson(res, 400, {
                error: `不认识的字段：${unknown.join('、')}。**没有撤销任何东西**。`,
                accepted: ['item_id', 'item', 'reason'],
              })
              return
            }
            const itemRef = nonEmptyString(body.item_id) ?? nonEmptyString(body.item)
            const result = cancelScheduleItem({ itemRef, reason: body.reason ?? null, actor: ACTOR_USER })
            trace(`POST /cancel  item=${result.item.item_id} already=${result.already === true}`)
            sendJson(res, 200, { cancelled: !result.already, already: result.already === true, item: result.item })
            return
          }

          sendJson(res, 404, {
            error: `未知路由 ${route}（支持 GET /health|/calendar|/todo 与 POST /create|/update|cancel）`,
          })
        } catch (error) {
          const { status, body } = classify(error)
          trace(`ROUTE_ERROR ${req.method} ${route}  ${status}  ${error?.message ?? error}`)
          sendJson(res, status, body)
        }
      },
    })
    trace(`ROUTE_REGISTERED  ${ROUTE_PREFIX} (prefix)  GET /health|/calendar + POST /create|/update|cancel`)
    return dispose
  })

  trace('APPLY_DONE')
}
