/**
 * 日程的**唯一投影实现** —— 一条日程 = `lh/schedule/*` 事件的重放结果。
 *
 * ═══ 为什么投影与写入分成两个文件（同 @lh/course-tree）═══
 * `schedule.js`（本文件）= 投影：纯函数、零依赖、可以被任何一半引用
 * （preset 里的工具、profile 里的 HTTP 路由、将来的 .ics 导出插件）；
 * `commands.js` = 写入：唯一构造信封的地方。
 * 谁都不许自己拼一条 `lh/schedule/*` 事件——同语义两种字节的后果是
 * "投影认一边、另一边静默忽略"，那是本项目记录过的失败形状。
 *
 * ═══ 本文件刻意不依赖 @lh/course-tree ═══
 * 这条是**加载安全**考虑，不是洁癖：
 *   · 本包会被 preset 行按**绝对路径**从源码树加载
 *     （`D:\LearningHarnessv0.1\plugins\lh-schedule\index.js`），
 *     而源码树的 `node_modules/@lh/` 下**只装了根 package.json 声明过的包**
 *     （实测：`node_modules/@lh/course-tree` 不存在）。
 *   · preset 行导入失败 = **该 preset 的所有会话都建不起来**（PLUGIN_CONTRACT §〇 形态②）。
 * 所以 preset 那一半的静态导入链只允许出现 `@lh/event-store/*`（它确实在根 node_modules 里）。
 * 课程标题的解析因此不在本文件里做：`calendar.js` 把课程清单**当参数收**，
 * 由拿得到 `@lh/course-tree` 的那一半（profile 里的界面服务端）喂进来。
 *
 * ═══ 时间为什么存"墙上时间字符串"而不是时间戳 ═══
 * 日程是人排的："周三 3 月 5 日 09:00 学资料分析"。`day` 存 `YYYY-MM-DD`、
 * `start`/`end` 存 `HH:MM`，是**没有时区的墙上时间**——它不需要换算，
 * 也不会因为夏令时或换机器而漂移。写的时候把当时的时区记进 `tz` 字段，
 * 是为了将来"跨时区"这种形状出现时能解释这条日程是按哪个时区排的。
 *
 * 而**事实**（`lh/trace/observed` 的学习痕迹）是带时间戳的，读的时候才按
 * "查询时指定的时区"折算成哪一天（见 `calendar.js` 的 `dayKeyOf`）。
 * 两类东西的时区语义不同，所以处理方式不同——这不是不一致。
 */

import { randomUUID } from 'node:crypto'

/** 事件族。**只做加法**：新动词可以加，已写出的字段语义不许改（契约 §2.2）。 */
export const SCHEDULE_EVENT_TYPES = Object.freeze({
  /** 新建一条日程。data: item_id, title, day, start?, end?, kind, note?, course_id?, session_id?, minutes_planned?, tz?, source? */
  CREATED: 'lh/schedule/created',
  /** 改字段（只带真的改了的字段）。data: item_id + 要改的键 */
  UPDATED: 'lh/schedule/updated',
  /** 绑课程 / 绑对话（null = 解绑）。data: item_id, course_id, session_id */
  LINKED: 'lh/schedule/linked',
  /** **事实**：这次计划真的发生了。data: item_id, done_at, session_id?, minutes_actual? */
  DONE: 'lh/schedule/done',
  /** 撤销（不是删除：历史留在日志里，可用 updated 改回 planned）。data: item_id, reason? */
  CANCELLED: 'lh/schedule/cancelled',
})

/** 事件族前缀。判定一条事件属不属于日程，只看这个——不看具体动词。 */
export const SCHEDULE_PREFIX = 'lh/schedule/'

/**
 * 日程类型（封闭词表）。
 *
 * ⚠ **投影不校验**这个表：认不出的 kind 原样保留（前向兼容——老代码读到新动词
 * 应该如实显示而不是静默丢掉，ADR-019 决定 4）。校验只发生在**写入入口**
 * （工具参数用 enum 挡住模型、HTTP 路由返回带可选值的 400），
 * 因为那里是能给调用方纠错信息的地方。
 *
 * `mock`（模拟考）与 `final`（最终大考）是 2026-10-09 按作者要求加的**验收期**类型，
 * 与 `exam`/`deadline` 一起构成「验收期」（见 `MILESTONE_KINDS`）。
 */
export const ITEM_KINDS = Object.freeze([
  'study',
  'review',
  'class',
  'exam',
  'mock',
  'final',
  'rest',
  'deadline',
])

/**
 * **验收期**的类型集合。
 *
 * ═══ 什么叫"验收期"（以及为什么它不是新的事件族）═══
 * 作者的原话：验收期"可以是一次模拟考，也可以是 ddl，也可以是最终的大考"，
 * 要"显示在下端带倒计时"，并且"与课程联系"。
 *
 * 它**就是一条日程项**：有日期、能绑课程、能标记完成——所以直接复用
 * `lh/schedule/*`，不新增事件族。倒计时是**派生量**（今天到那一天还有几天），
 * 按 ADR-014「可派生的不进日志」不进事件。新增的只有两样：
 *   · 上面两个 kind（模拟考 / 最终大考）；
 *   · 一个可选的 `until`（"验收期的最后一天"）——"期"是个窗口，
 *     而窗口的两个端点都是**人排的**，所以它进日志。
 */
export const MILESTONE_KINDS = Object.freeze(['exam', 'mock', 'final', 'deadline'])

/** 状态词表。`planned` 之外都是终态，但**都可以改回来**（append-only，没有真删除）。 */
export const ITEM_STATUSES = Object.freeze(['planned', 'done', 'cancelled', 'skipped'])

/** 类型 → 中文（渲染用；界面与服务端共用一份，避免两处各写一遍）。 */
export const KIND_LABELS = Object.freeze({
  study: '学习',
  review: '复习',
  class: '上课',
  exam: '考试',
  mock: '模拟考',
  final: '最终大考',
  rest: '休息',
  deadline: '截止',
})

/** 状态 → 中文。 */
export const STATUS_LABELS = Object.freeze({
  planned: '计划中',
  done: '已完成',
  cancelled: '已撤销',
  skipped: '已跳过',
})

/** 星期几的中文（索引 0=周日，与 `Date.getUTCDay()` 对齐）。 */
export const WEEKDAY_LABELS = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六'])

/**
 * 一条事件属不属于日程事件族。
 * @param event - LH 事件。
 * @returns 布尔。
 */
export function isScheduleEvent(event) {
  return typeof event?.type === 'string' && event.type.startsWith(SCHEDULE_PREFIX)
}

/**
 * 新日程 id。
 *
 * 形状与课程节点同构（`schedule-1a2b3c4d`）：**前缀说明它是什么**，
 * 因为 id 会出现在工具的返回值、HTTP 响应和界面按钮上，
 * 一个光秃秃的 uuid 在那里无法自证身份。
 *
 * @returns 新 id。
 */
export function newItemId() {
  return `schedule-${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

/**
 * 一条日程的作用域路径。
 *
 * ═══ 为什么不是 `course/<node_id>`（哪怕这条日程绑了课）═══
 * 日程是**独立对象**，课程只是它的一个字段。把它写进课程作用域会立刻遇到
 * 一个表达不了的形状："这条日程同时与两门课有关"，或者"先建日程、后绑课"
 * （那时 scope 已经写死在日志里了，而 scope 是不可改的信封字段）。
 * 所以 scope 一律是日程自己，课程关系放 `data.course_id`——
 * 这是"信封记坐标、data 记语义"的用法，不是把 scope 当标签用。
 *
 * @param itemId - 日程 id。
 * @returns `schedule/<id>`。
 */
export function scopeOf(itemId) {
  return `schedule/${String(itemId)}`
}

// ══════════════════════════════════════════════════════════════════════════
// 日期工具（全部以"没有时区的日历日字符串"为中心）
// ══════════════════════════════════════════════════════════════════════════

/** `YYYY-MM-DD` 的形状。 */
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/** `HH:MM` 的形状（24 小时制）。 */
const TIME_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * 一个字符串是不是合法的日历日。
 *
 * 光看形状不够：`2026-02-30` 形状对、日期不存在。所以还要**回环验证**
 * （用 UTC 建一个日期再格式化回来，不相等就是假的）。用 UTC 是因为
 * 这里只做日期算术，不该被本地时区影响。
 *
 * @param value - 待检值。
 * @returns 合法返回原字符串，否则 null。
 */
export function asDayKey(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!DAY_SHAPE.test(text)) return null
  const ms = Date.parse(`${text}T00:00:00Z`)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString().slice(0, 10) === text ? text : null
}

/**
 * 一个字符串是不是合法的 `HH:MM`。
 * @param value - 待检值。
 * @returns 合法返回原字符串，否则 null。
 */
export function asTimeKey(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return TIME_SHAPE.test(text) ? text : null
}

/**
 * 把一个**时刻**折算成某个时区里的日历日。
 *
 * ═══ 为什么用 Intl 而不是自己减时区偏移 ═══
 * 手算偏移会在夏令时切换那天错一小时，而那一天恰好是"排了 09:00 的日程"最可能出问题的一天。
 * `Intl.DateTimeFormat` 带 `timeZone` 是平台实现，夏令时是它的职责。
 *
 * ═══ 为什么走 formatToParts 而不是直接 format ═══
 * 直接 format 的结果形状随 locale 变（'2026-10-09' / '10/9/2026'）；
 * formatToParts 拿到的是**部件**，自己拼出 `YYYY-MM-DD`，与 locale 无关。
 *
 * ═══ 时区入参的三种情况 ═══
 *   · 给了合法时区 → 按它折算；
 *   · 给了**认不出**的时区 → 回退到 UTC，并置 `fallback: true`
 *     （调用方必须把这件事说出来，否则"某天少了两条活动"会查不出来）；
 *   · **没给** → 按**进程本地时区**折算（不是 UTC），`fallback: false`。
 *     这一条是刻意的：工具与运行时上下文那一侧没有浏览器上下文（浏览器时区随请求来），
 *     而"今天有哪些日程"如果按 UTC 算，东八区晚上 8 点之后就会全部错一天——
 *     那恰好是学习者最常看日程的时段。
 *
 * @param instant - ISO 时间戳、epoch 毫秒，或可被 `Date.parse` 接受的值。
 * @param tz - IANA 时区名（如 `Asia/Shanghai`）；省略/null = 进程本地时区。
 * @returns `{ day, fallback }`；时刻无法解析时 day 为 null。
 */
export function dayKeyOf(instant, tz) {
  const ms = typeof instant === 'number' ? instant : Date.parse(String(instant ?? ''))
  if (!Number.isFinite(ms)) return { day: null, fallback: false }
  const date = new Date(ms)

  if (typeof tz === 'string' && tz.trim() !== '') {
    const formatter = formatterFor(tz.trim())
    if (formatter !== null) {
      const day = partsToDay(formatter, date)
      if (day !== null) return { day, fallback: false }
    }
    return { day: date.toISOString().slice(0, 10), fallback: true }
  }

  const local = localFormatter()
  if (local !== null) {
    const day = partsToDay(local, date)
    if (day !== null) return { day, fallback: false }
  }
  return { day: date.toISOString().slice(0, 10), fallback: true }
}

/**
 * 取（并缓存）某个时区的日期格式化器。
 *
 * ═══ 为什么要缓存 ═══
 * 日历视图要对**每一条**事件求一次日期，而 `new Intl.DateTimeFormat` 是重操作。
 * 缓存的主题是时区字符串，所以"一个月的视图"只建一次格式化器。
 * 认不出的时区缓存 null，避免每次请求都重新抛一遍。
 *
 * @param tz - IANA 时区名。
 * @returns 格式化器或 null。
 */
const FORMATTERS = new Map()
function formatterFor(tz) {
  if (FORMATTERS.has(tz)) return FORMATTERS.get(tz)
  let formatter = null
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch {
    formatter = null
  }
  FORMATTERS.set(tz, formatter)
  return formatter
}

/**
 * 运行机器的本地时区名。
 *
 * 用途有两个：① 没给时区时按它折算日期（见 `dayKeyOf`）；
 * ② 让它出现在工具/接口的返回值里——**报出来的时区必须是真的那一个**，
 * 不写死 'UTC' 假装。问不出来时返回 'UTC'（并如实承担差一天的风险）。
 *
 * @returns IANA 时区名。
 */
export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 不带 `timeZone` 的格式化器（Intl 会用它自己的默认时区 = 进程本地时区）。 */
let LOCAL_FORMATTER

/**
 * 取（并缓存）进程本地时区的日期格式化器。
 * `undefined` = 还没算过；`null` = 算不出来（Intl 不可用），不再重试。
 * @returns 格式化器或 null。
 */
function localFormatter() {
  if (LOCAL_FORMATTER !== undefined) return LOCAL_FORMATTER
  try {
    LOCAL_FORMATTER = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch {
    LOCAL_FORMATTER = null
  }
  return LOCAL_FORMATTER
}

/**
 * 从一个格式化器取出 `YYYY-MM-DD`（locale 无关）。
 * @param formatter - Intl.DateTimeFormat。
 * @param date - Date。
 * @returns 日历日或 null。
 */
function partsToDay(formatter, date) {
  const parts = formatter.formatToParts(date)
  const get = (type) => parts.find((p) => p.type === type)?.value
  const y = get('year')
  const m = get('month')
  const d = get('day')
  return typeof y === 'string' && typeof m === 'string' && typeof d === 'string' ? `${y}-${m}-${d}` : null
}

/**
 * 日历日 → 星期几（0=周日）。
 * 用 UTC 建日期：`YYYY-MM-DDT00:00:00Z` 的 `getUTCDay()` 与"这一天是星期几"永远一致，
 * 不受运行机器时区影响。
 *
 * @param day - 日历日。
 * @returns 0..6；非法日期返回 null。
 */
export function weekdayOf(day) {
  const key = asDayKey(day)
  if (key === null) return null
  return new Date(Date.parse(`${key}T00:00:00Z`)).getUTCDay()
}

/**
 * 日历日加减天数。
 * @param day - 起始日。
 * @param delta - 天数（可为负）。
 * @returns 新的日历日；入参非法时返回 null。
 */
export function addDays(day, delta) {
  const key = asDayKey(day)
  if (key === null) return null
  const ms = Date.parse(`${key}T00:00:00Z`) + Math.round(Number(delta) || 0) * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * 两个日历日之间相差几天（含符号：`to - from`）。
 * @param from - 起始日。
 * @param to - 结束日。
 * @returns 天数；入参非法返回 null。
 */
export function daysBetween(from, to) {
  const a = asDayKey(from)
  const b = asDayKey(to)
  if (a === null || b === null) return null
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

/**
 * 一个闭区间里的全部日历日（最多 max 个）。
 *
 * ═══ 为什么要 max ═══
 * 模型可以给出 `from=1970-01-01`。不加闸门的话，一次工具调用会生成两万个日期桶、
 * 把工具结果撑爆（契约 §七："render 不把大内容塞进对话"）。
 * 所以**截断并且如实回报截断了**（`truncated: true`），不静默截断。
 *
 * @param from - 起始日。
 * @param to - 结束日。
 * @param max - 最多几天（默认 62 = 两个月）。
 * @returns `{ days, truncated }`。
 */
export function dayRange(from, to, max = 62) {
  const a = asDayKey(from)
  const b = asDayKey(to)
  if (a === null || b === null) return { days: [], truncated: false }
  const span = daysBetween(a, b)
  if (span === null || span < 0) return { days: [], truncated: false }
  const out = []
  for (let i = 0; i <= span; i += 1) {
    if (out.length >= max) return { days: out, truncated: true }
    out.push(addDays(a, i))
  }
  return { days: out, truncated: false }
}

/**
 * `YYYY-MM` → 这个月的第一天与最后一天。
 * @param month - `YYYY-MM`。
 * @returns `{ from, to }`；非法返回 null。
 */
export function monthBounds(month) {
  if (typeof month !== 'string') return null
  const m = month.trim()
  if (!/^\d{4}-\d{2}$/.test(m)) return null
  const from = asDayKey(`${m}-01`)
  if (from === null) return null
  // 下个月 1 号减一天 = 本月最后一天。用 Date 处理闰年与大小月（不自己算）。
  const next = new Date(Date.parse(`${from}T00:00:00Z`))
  next.setUTCMonth(next.getUTCMonth() + 1)
  const to = addDays(next.toISOString().slice(0, 10), -1)
  return to === null ? null : { from, to }
}

/**
 * `YYYY-MM` 相对偏移若干个月。
 * @param month - `YYYY-MM`。
 * @param delta - 月数（可为负）。
 * @returns 新的 `YYYY-MM`；非法返回 null。
 */
export function addMonths(month, delta) {
  const bounds = monthBounds(month)
  if (bounds === null) return null
  const d = new Date(Date.parse(`${bounds.from}T00:00:00Z`))
  d.setUTCMonth(d.getUTCMonth() + Math.round(Number(delta) || 0))
  return d.toISOString().slice(0, 7)
}

/**
 * "今天"（按给定时区）。
 * @param tz - IANA 时区名；省略或认不出时按 UTC（调用方据 `fallback` 决定要不要说明）。
 * @returns `{ day, fallback }`。
 */
export function todayKey(tz) {
  return dayKeyOf(Date.now(), tz)
}

// ══════════════════════════════════════════════════════════════════════════
// 投影
// ══════════════════════════════════════════════════════════════════════════

/** 取一个非空字符串（投影的取值口径：空白一律当"没有"）。 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 取一个正整数（分钟数之类）。 */
function positiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/** 空日程项（`created` 之前的默认形状）。 */
function blankItem(id) {
  return {
    item_id: id,
    title: '(未命名日程)',
    day: null,
    // 验收期的最后一天（可选）：`day` 是起点、`until` 是终点。
    // 两个端点都是人排的，所以都进日志；"还剩几天"是派生量，不进。
    until: null,
    start: null,
    end: null,
    kind: 'study',
    status: 'planned',
    course_id: null,
    session_id: null,
    note: null,
    minutes_planned: null,
    minutes_actual: null,
    tz: null,
    source: null,
    created_at: null,
    updated_at: null,
    done_at: null,
    cancelled_at: null,
    cancel_reason: null,
    /** 这条日程经历过哪些事件（按时间序）。审计与界面展开用。 */
    history: [],
  }
}

/** `updated` 能改的**可清空**字段（写成 null 表示清掉）。 */
const NULLABLE_PATCH_KEYS = [
  'until',
  'start',
  'end',
  'note',
  'minutes_planned',
  'minutes_actual',
  'course_id',
  'session_id',
]

/**
 * 把事件重放成日程集合。
 *
 * ═══ 认不出的事件怎么处理 ═══
 * 同族但未知的动词（将来加的）**不猜语义**，只计数并如实回报
 * （`unknown_types`）——"某类事件被静默丢掉了"是查不出来的那种错。
 * `item_id` 缺失的事件同样计数（`orphan_events`）：它是一条写了但投影不了的记录，
 * 那本身是要被人看见的事实，不是噪声。
 *
 * @param events - LH 全量事件（可含其它族，内部只挑 `lh/schedule/*`）。
 * @returns `{ byId, order, items, unknown_types, orphan_events, event_count }`：
 *   - `byId`: 普通对象（不是 Map），便于 JSON 序列化；
 *   - `order`: item_id 的插入序（`created` 的先后）；
 *   - `items`: 按 order 排列的日程数组。
 */
export function buildSchedule(events) {
  const byId = Object.create(null)
  const order = []
  const unknownTypes = Object.create(null)
  let orphanEvents = 0
  let eventCount = 0

  for (const event of Array.isArray(events) ? events : []) {
    if (!isScheduleEvent(event)) continue
    eventCount += 1

    const type = event.type
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const id = text(data.item_id)

    if (id === null) {
      orphanEvents += 1
      continue
    }

    switch (type) {
      case SCHEDULE_EVENT_TYPES.CREATED: {
        if (byId[id] === undefined) {
          byId[id] = blankItem(id)
          order.push(id)
        }
        const item = byId[id]
        const title = text(data.title)
        if (title !== null) item.title = title
        const day = asDayKey(data.day)
        if (day !== null) item.day = day
        // 验收期的窗口终点（可选）。`asDayKey` 认不出就是 null = 没有窗口。
        item.until = asDayKey(data.until)
        item.start = asTimeKey(data.start)
        item.end = asTimeKey(data.end)
        const kind = text(data.kind)
        if (kind !== null) item.kind = kind
        item.note = text(data.note)
        item.course_id = text(data.course_id)
        item.session_id = text(data.session_id)
        item.minutes_planned = positiveInt(data.minutes_planned)
        item.tz = text(data.tz)
        item.source = text(data.source)
        item.created_at = typeof event.timestamp === 'string' ? event.timestamp : null
        item.updated_at = item.created_at
        break
      }

      case SCHEDULE_EVENT_TYPES.UPDATED: {
        const item = byId[id]
        if (item === undefined) {
          orphanEvents += 1
          break
        }
        const title = text(data.title)
        if (title !== null) item.title = title
        // ⚠ `day` 现在是**可清空**的（2026-10-09，应作者要求）：`updated` 里显式出现
        //   `"day": null` 表示**无限期推迟**——这条日程变成待办，不占任何一天。
        //   所以判据是"**data 里有没有这个键**"，而不是"解析出来的值非不非空"：
        //   后者会让"清空日期"这条永远写不进去（静默失败，本项目记过很多次那种形状）。
        //   （`until` 一直是这个判据，见下面 NULLABLE_PATCH_KEYS 那一圈。）
        if (Object.prototype.hasOwnProperty.call(data, 'day')) item.day = asDayKey(data.day)
        const kind = text(data.kind)
        if (kind !== null) item.kind = kind
        const status = text(data.status)
        if (status !== null && ITEM_STATUSES.includes(status)) item.status = status
        for (const key of NULLABLE_PATCH_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(data, key)) continue
          // `until` 是**日期**型（不是时间型，也不是文本），所以单独一条。
          if (key === 'until') item.until = asDayKey(data[key])
          else if (key === 'start' || key === 'end') item[key] = asTimeKey(data[key])
          else if (key === 'note' || key === 'course_id' || key === 'session_id') item[key] = text(data[key])
          else item[key] = positiveInt(data[key])
        }
        item.updated_at = typeof event.timestamp === 'string' ? event.timestamp : item.updated_at
        break
      }

      case SCHEDULE_EVENT_TYPES.LINKED: {
        const item = byId[id]
        if (item === undefined) {
          orphanEvents += 1
          break
        }
        // `linked` 的语义是"现在绑到哪儿"，所以**两个字段都按本次事件定**：
        // 缺字段 = 没给 = 清空（而不是"保持不变"）。
        // 这条与 `updated` 的补丁语义不同，是刻意的：绑定关系是一个整体状态。
        item.course_id = text(data.course_id)
        item.session_id = text(data.session_id)
        item.updated_at = typeof event.timestamp === 'string' ? event.timestamp : item.updated_at
        break
      }

      case SCHEDULE_EVENT_TYPES.DONE: {
        const item = byId[id]
        if (item === undefined) {
          orphanEvents += 1
          break
        }
        item.status = 'done'
        item.done_at = text(data.done_at) ?? (typeof event.timestamp === 'string' ? event.timestamp : null)
        item.minutes_actual = positiveInt(data.minutes_actual)
        const sid = text(data.session_id)
        if (sid !== null) item.session_id = sid
        item.updated_at = typeof event.timestamp === 'string' ? event.timestamp : item.updated_at
        break
      }

      case SCHEDULE_EVENT_TYPES.CANCELLED: {
        const item = byId[id]
        if (item === undefined) {
          orphanEvents += 1
          break
        }
        item.status = 'cancelled'
        item.cancelled_at = typeof event.timestamp === 'string' ? event.timestamp : null
        item.cancel_reason = text(data.reason)
        item.updated_at = item.cancelled_at
        break
      }

      default:
        unknownTypes[type] = (unknownTypes[type] ?? 0) + 1
    }

    const touched = byId[id]
    if (touched !== undefined) {
      touched.history.push({
        type,
        at: typeof event.timestamp === 'string' ? event.timestamp : null,
        actor: typeof event.actor === 'string' ? event.actor : null,
      })
    }
  }

  const items = order.map((id) => byId[id])
  return { byId, order, items, unknown_types: unknownTypes, orphan_events: orphanEvents, event_count: eventCount }
}

/**
 * 把事件重放成**只读的序列化视图**（去掉 `history` 之外的内部结构，便于 JSON 出去）。
 *
 * 为什么不直接返回 `byId`：`byId` 是 `Object.create(null)`，序列化没问题，
 * 但调用方容易顺手改它。这里给的是**新对象**，`schedule.js` 的投影结果因此
 * 在"读到"与"改到"之间有一道明确的边界。
 *
 * @param events - LH 全量事件。
 * @returns 日程数组（按创建序）。
 */
export function scheduleItems(events) {
  return buildSchedule(events).items
}

/**
 * 把"用户/模型说的那条日程"解析成唯一一条。
 *
 * 两条路径，按可靠性排序：
 *   1. `item_id`（`schedule-xxxxxxxx`）—— 精确；
 *   2. 标题 —— 先精确匹配，再唯一的大小写不敏感匹配。
 *
 * **有歧义不猜**（WORKFLOW 规则 5）：猜错会改到另一条日程上，而那种错
 * 在日志里看不出来（两条都"看起来对"）。所以歧义要把候选列出来。
 *
 * @param plan - `buildSchedule` 的结果。
 * @param ref - id 或标题。
 * @returns `{ item }` | `{ ambiguous: item[] }` | `{ item: null }`。
 */
export function resolveItemRef(plan, ref) {
  const raw = typeof ref === 'string' ? ref.trim() : ''
  if (raw === '') return { item: null }

  if (plan.byId[raw] !== undefined) return { item: plan.byId[raw] }

  const exact = plan.items.filter((item) => item.title === raw)
  if (exact.length === 1) return { item: exact[0] }
  if (exact.length > 1) return { ambiguous: exact }

  const lower = raw.toLowerCase()
  const loose = plan.items.filter((item) => String(item.title).toLowerCase() === lower)
  if (loose.length === 1) return { item: loose[0] }
  if (loose.length > 1) return { ambiguous: loose }

  return { item: null }
}

/**
 * 一条日程在某一天"露不露面"的判据（日历用）。
 *
 * 三种露面方式，缺一不可：
 *   · 计划在当天（`day === day`）；
 *   · 在当天完成（`done_at` 折算到当天）——一条排在前天、昨天才做完的日程，
 *     应该出现在**昨天**，因为"昨天真的学了"才是需要被看见的事实；
 *   · 当天被撤销（同上，撤销也是一种发生过的决定）。
 *
 * @param item - 日程项。
 * @param day - 日历日。
 * @param tz - 折算 done_at / cancelled_at 用的时区。
 * @returns 露面方式数组（空数组 = 这天与它无关）。
 */
export function appearancesOn(item, day, tz) {
  const ways = []
  if (item.day === day) ways.push('planned')
  if (typeof item.done_at === 'string' && dayKeyOf(item.done_at, tz).day === day) ways.push('done')
  if (typeof item.cancelled_at === 'string' && dayKeyOf(item.cancelled_at, tz).day === day) ways.push('cancelled')
  return ways
}

/**
 * 当天的排序权重：先按开始时间（没写开始时间的排最后），再按创建时间。
 * @param item - 日程项。
 * @returns 可比较的字符串键。
 */
export function timeSortKey(item) {
  const start = item.start === null || item.start === undefined ? '99:99' : item.start
  return `${start}|${item.created_at ?? ''}|${item.item_id}`
}

/**
 * 一条日程是不是**验收期**。
 * @param item - 日程项。
 * @returns 布尔。
 */
export function isMilestone(item) {
  return item !== null && typeof item === 'object' && MILESTONE_KINDS.includes(item.kind)
}

/**
 * 一条日程是不是**待办**（无日期、且还没做）。
 *
 * ═══ 为什么"无日期"是一个正当状态，而不是数据缺失（2026-10-09 作者要求）═══
 * 原话是：日程很可能是模型生成的，用户可能在确认时没细看、或被打断——所以需要
 * "无限期推迟"：**先把它从日历上拿下来，但不丢掉**。落点就是 `day = null`。
 * 于是"待办区"不是一个新对象，而是投影的一个**分组口径**：
 * 有日期的按日期排，没日期的排在最前面等你处理。
 *
 * 它**不**算过期（`isOverdue` 要求有日期）、**不**进倒计时
 * （`milestoneCountdown` 对 `day === null` 直接返回 null）——没定日子就没有"迟"可言。
 *
 * @param item - 日程项。
 * @returns 布尔。
 */
export function isBacklog(item) {
  return item !== null && typeof item === 'object' && item.day === null && item.status === 'planned'
}

/**
 * 验收期的**倒计时**（纯派生量：不进日志，随"今天"变）。
 *
 * 四种相位，分开是因为它们要说的话完全不同：
 *   · `before`  还没到（显示"还有 N 天"）；
 *   · `today`   就是今天（显示"就是今天"）；
 *   · `during`  落在窗口里（`day < today <= until`，显示"进行中，还剩 N 天"）；
 *   · `past`    已经过去（显示"已过 N 天"——**如实显示，不评判**：
 *               它还是 planned 就说明没人标记完成，那是数据，不是罪状）。
 *
 * ═══ 为什么窗口终点缺省时不把"过去"算成"仍在进行" ═══
 * 没有 `until` 的一次模拟考，过了就是过了。把"没有终点"解释成"永远进行中"
 * 会让倒计时永远停在"进行中"，那等于没有倒计时。
 *
 * @param item - 日程项。
 * @param today - 今天（`YYYY-MM-DD`）。
 * @returns `{ phase, days_left, days_to_end }`；不是验收期或没有日期时返回 null。
 */
export function milestoneCountdown(item, today) {
  if (!isMilestone(item)) return null
  if (item.day === null || today === null) return null
  const daysLeft = daysBetween(today, item.day)
  if (daysLeft === null) return null
  const hasWindow = typeof item.until === 'string' && item.until !== '' && item.until >= item.day
  const daysToEnd = hasWindow ? daysBetween(today, item.until) : null

  if (daysLeft > 0) return { phase: 'before', days_left: daysLeft, days_to_end: daysToEnd }
  if (daysLeft === 0) return { phase: 'today', days_left: 0, days_to_end: daysToEnd }
  if (hasWindow && daysToEnd !== null && daysToEnd >= 0) {
    return { phase: 'during', days_left: daysLeft, days_to_end: daysToEnd }
  }
  return { phase: 'past', days_left: daysLeft, days_to_end: daysToEnd }
}

/**
 * 把倒计时渲染成一句人话（**唯一**的渲染点：界面、工具、上下文注入共用）。
 * @param item - 日程项。
 * @param countdown - `milestoneCountdown` 的结果。
 * @returns 文本。
 */
export function countdownText(item, countdown) {
  const kind = KIND_LABELS[item.kind] ?? item.kind
  if (countdown === null) return kind
  const name = item.title === '' ? kind : item.title
  switch (countdown.phase) {
    case 'before':
      return `${name}还有 ${countdown.days_left} 天`
    case 'today':
      return `${name}就是今天`
    case 'during':
      return `${name}进行中（还剩 ${countdown.days_to_end} 天）`
    default:
      return `${name}已过 ${Math.abs(countdown.days_left)} 天`
  }
}
