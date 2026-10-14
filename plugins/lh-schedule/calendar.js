/**
 * 日历的**唯一视图组装** —— 把三件不同来源的事按日期索引到同一张表上。
 *
 * ═══ 三件事，一个日期轴 ═══
 *   · **计划**：`lh/schedule/*` 投影出来的日程项（"我打算哪天学什么"）；
 *   · **事实**：`lh/trace/observed` 的坐标事件（"哪天哪段对话真的动过"）——
 *     这是记录器插件一直在写的东西，本文件只是把它**按天分组**；
 *   · **课程安排**：`lh/course/*`（建课 / 改名 / 绑会话——"课程结构什么时候变的"）。
 *
 * 把三者放在一张表上，是为了回答一个此前没人能回答的问题：
 * **"我排的计划，和我实际做的事，对得上吗？"**
 * 对不上是最有价值的信息（排了没做 / 没排却做了），而它只有把两类数据并到
 * 同一天才看得见——分成两个界面就永远看不出来。
 *
 * ═══ 为什么这不是"第二份投影" ═══
 * 日程项的字段、状态、露面规则全部来自 `schedule.js`（唯一的折叠实现）；
 * 本文件只做**投影之上的分组**（把"一条日程的一项属性"翻成"某天有哪些日程"）。
 * 课程清单同理：**当参数收**，不在这里读课程事件推树——
 * 那需要 `@lh/course-tree/tree`，而本包在 preset 作用域加载时必须能少依赖就少依赖
 * （见 `schedule.js` 顶部"刻意不依赖 course-tree"那一段）。
 *
 * ═══ 时区口径（一处说清，别处不重复）═══
 * `day`/`start` 是**墙上时间**（排的时候怎么想就怎么写）；
 * 时间戳（事件、完成时刻）是**绝对时刻**，读的时候按调用方给的时区折算成天。
 * 所以同一个 `tz` 参数贯穿全文件，只有一处折算函数（`dayKeyOf`）。
 */

import {
  SCHEDULE_EVENT_TYPES,
  addDays,
  asDayKey,
  buildSchedule,
  dayKeyOf,
  dayRange,
  isBacklog,
  isMilestone,
  localTimeZone,
  milestoneCountdown,
  monthBounds,
  timeSortKey,
  todayKey,
  weekdayOf,
} from './schedule.js'

/** 一次最多铺多少天（防"from=1970-01-01"这种输入把结果撑爆）。 */
export const MAX_VIEW_DAYS = 62
/** 每天最多列多少段对话。 */
export const MAX_SESSIONS_PER_DAY = 20
/** 每天最多列多少条日程。 */
export const MAX_ITEMS_PER_DAY = 50

/** 事实类事件族（用于"哪天动过"的索引）。 */
const TRACE_PREFIX = 'lh/trace/'
/** 课程事件族（用于"课程结构什么时候变的"）。 */
const COURSE_PREFIX = 'lh/course/'

/** 取一个非空字符串。 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 一条事件"发生在哪一天"。
 *
 * ═══ 为什么优先用 `data.time` 而不是信封的 `timestamp` ═══
 * 信封时间戳是**LH 记录它**的时刻；`data.time` 是**宿主事件本来发生**的时刻。
 * 两者通常相差毫秒，但补写历史（重放、迁移、离线导入）时可能差很远——
 * 那时"这次学习发生在哪天"应该以学习发生的时刻为准，而不是以我们记账的时刻。
 * 认不出 `data.time` 就退回信封时间戳（宁可粗一点，不要丢）。
 *
 * @param event - LH 事件。
 * @param tz - 折算时区。
 * @returns 日历日或 null。
 */
function eventDay(event, tz) {
  const raw = event?.data !== null && typeof event?.data === 'object' ? event.data.time : undefined
  const candidates = []
  if (typeof raw === 'number' && Number.isFinite(raw)) candidates.push(raw)
  else if (typeof raw === 'string' && raw.trim() !== '') candidates.push(raw)
  candidates.push(event?.timestamp)
  for (const candidate of candidates) {
    const { day } = dayKeyOf(candidate, tz)
    if (day !== null) return day
  }
  return null
}

/**
 * 组装日历视图（可直接 JSON 序列化发给浏览器，也可以喂给模型）。
 *
 * @param events - LH 全量事件。
 * @param options.from - 起始日（含）；省略时取 `to` 所在月的 1 号，或本月 1 号。
 * @param options.to - 结束日（含）；省略时取 `from` 之后 13 天。
 * @param options.tz - 折算时区（IANA 名）。认不出会回退到 UTC 并置 `tz_fallback`。
 * @param options.courses - 课程清单 `[{ node_id, title, level, path }]`（**由调用方提供**）。
 * @param options.maxDays - 最多几天（默认 62）。
 * @param options.includeActivity - 是否带上"事实"与"课程安排"（默认 true）。
 * @returns 见文件头与 `index.js` 的输出 schema。
 */
export function buildCalendarView(events, options = {}) {
  // 没给时区时用**进程本地时区**，并把真正的那个名字报出去——
  // 报 'UTC' 假装是错的：它会让人以为折算没问题，而实际差一天。
  const tz = text(options.tz) ?? localTimeZone()
  const maxDays = Number.isFinite(options.maxDays) ? Math.max(1, Math.min(MAX_VIEW_DAYS, options.maxDays)) : MAX_VIEW_DAYS
  const includeActivity = options.includeActivity !== false

  const probe = todayKey(tz)
  const today = probe.day

  // ── 区间：三种给法都收（都不给 = 本月）──
  const monthGiven = text(options.month)
  const month = monthGiven === null ? null : monthBounds(monthGiven)
  let from = asDayKey(options.from)
  let to = asDayKey(options.to)
  if (from === null && to === null) {
    // 两个都不给 = 本月（`month` 参数优先，其次"今天所在的那个月"）。
    const bounds = month ?? monthBounds(String(today ?? '').slice(0, 7))
    from = bounds === null ? today : bounds.from
    to = bounds === null ? today : bounds.to
  } else if (from === null) {
    from = addDays(to, -13)
  } else if (to === null) {
    to = addDays(from, 13)
  }
  if (from === null || to === null) {
    // 走到这里只可能是"连今天都算不出来"（时钟坏了）。如实回一个空视图。
    return {
      from: null,
      to: null,
      month: null,
      tz: tz ?? 'UTC',
      tz_fallback: probe.fallback,
      today: null,
      days: [],
      items: [],
      milestones: [],
      backlog: [],
      overdue: [],
      courses: normalizeCourses(options.courses),
      summary: emptySummary(),
      unknown_event_types: [],
      orphan_events: 0,
      truncated: false,
      notes: ['算不出日期：宿主时钟或时区不可用。'],
    }
  }
  if (to < from) {
    const swap = from
    from = to
    to = swap
  }

  const range = dayRange(from, to, maxDays)
  const days = range.days
  const daySet = new Set(days)
  const plan = buildSchedule(events)

  // ── 每天一个桶 ──
  const buckets = new Map()
  for (const day of days) {
    buckets.set(day, {
      day,
      weekday: weekdayOf(day),
      items: [],
      sessions: [],
      course_events: [],
      sessions_truncated: false,
      items_truncated: false,
    })
  }

  // ── 计划：一条日程可能"露面"在多于一天（排在前天、昨天才做完）──
  //
  // 用"先算候选日、再查表"的方式，避免 O(条数 × 天数) 的双重循环——
  // 那是"日志一大就变慢"的经典写法，而日志只会变大（ADR-012 的失效信号）。
  for (const item of plan.items) {
    const planDay = item.day
    const doneDay = typeof item.done_at === 'string' ? dayKeyOf(item.done_at, tz).day : null
    const cancelledDay = typeof item.cancelled_at === 'string' ? dayKeyOf(item.cancelled_at, tz).day : null
    // 一天可能被"露面"多次（排在这天、也在这天完成），所以按天合并、`how` 记全。
    const merged = new Map()
    const note = (day, how) => {
      if (day === null || !daySet.has(day)) return
      const list = merged.get(day) ?? []
      if (!list.includes(how)) list.push(how)
      merged.set(day, list)
    }
    note(planDay, 'planned')
    note(doneDay, 'done')
    note(cancelledDay, 'cancelled')

    for (const [day, how] of merged) {
      const bucket = buckets.get(day)
      if (bucket === undefined) continue
      if (bucket.items.length >= MAX_ITEMS_PER_DAY) {
        bucket.items_truncated = true
        continue
      }
      bucket.items.push({ ...item, history: undefined, appearances: how })
    }
  }

  // ── 事实与课程安排 ──
  let droppedSessions = 0
  if (includeActivity) {
    const sessionIndex = new Map() // `${day}|${sessionId}` → 汇总
    for (const event of Array.isArray(events) ? events : []) {
      const type = typeof event?.type === 'string' ? event.type : ''
      const isTrace = type.startsWith(TRACE_PREFIX)
      const isCourse = type.startsWith(COURSE_PREFIX)
      if (!isTrace && !isCourse) continue

      const day = eventDay(event, tz)
      if (day === null || !daySet.has(day)) continue
      const bucket = buckets.get(day)
      if (bucket === undefined) continue

      if (isCourse) {
        const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
        bucket.course_events.push({
          type,
          node_id: text(data.node_id),
          title: text(data.title),
          session_id: text(data.session_id),
          at: text(event.timestamp),
        })
        continue
      }

      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      const sessionId = text(event.session_ref) ?? text(data.session_id)
      if (sessionId === null) continue
      const key = `${day}|${sessionId}`
      let row = sessionIndex.get(key)
      if (row === undefined) {
        row = { day, session_id: sessionId, events: 0, first_at: null, last_at: null, host_types: Object.create(null) }
        sessionIndex.set(key, row)
      }
      row.events += 1
      const at = text(event.timestamp)
      if (at !== null) {
        if (row.first_at === null || at < row.first_at) row.first_at = at
        if (row.last_at === null || at > row.last_at) row.last_at = at
      }
      const hostType = text(data.host_type)
      if (hostType !== null) row.host_types[hostType] = (row.host_types[hostType] ?? 0) + 1
    }

    for (const row of sessionIndex.values()) {
      const bucket = buckets.get(row.day)
      if (bucket === undefined) continue
      if (bucket.sessions.length >= MAX_SESSIONS_PER_DAY) {
        bucket.sessions_truncated = true
        droppedSessions += 1
        continue
      }
      bucket.sessions.push(row)
    }
  }

  // ── 排序与收尾 ──
  for (const bucket of buckets.values()) {
    bucket.items.sort((a, b) => timeSortKey(a).localeCompare(timeSortKey(b)))
    bucket.sessions.sort((a, b) => b.events - a.events || a.session_id.localeCompare(b.session_id))
    bucket.course_events.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  }

  const flatItems = plan.items.filter((item) => inRange(item, daySet, tz))
  // ⚠ `overdue` 是**全局**的（整份日志里所有"计划日已过、仍是 planned"的日程），
  //   不是区间内的。理由：它回答的是"我总共欠了多少"，而那个数字**不该在你翻月份时跳来跳去**
  //   ——一种"这个月欠 3 条、上个月欠 8 条"的显示会让人以为债消失了。
  //   区间内的"这一天该做什么 / 哪天欠着"由每天的 items 与格子上的欠徽章表达。
  let overdue = 0

  // ── 待办（无日期、还没做）与过期清单：两者都是**全局**的 ──
  //
  // ⚠ `overdue` 从"只给个数"改成"也给清单"，因为**数必须等于清单的长度**：
  //   数在一处算、清单在另一处算，两边口径迟早会分叉（而分叉时人只会相信其中一个）。
  //   所以只有一份列表，数从它来。
  const backlog = plan.items
    .filter((item) => isBacklog(item))
    // 待办按**记下的先后**排（FIFO）：等得最久的那条排最前——它最可能已经不重要了，
    // 而这正是待办区该让人一眼看见的事（"这条挂了两个月了，还做吗？"）。
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
    .map((item) => ({ ...item, history: undefined }))
  const overdueItems = plan.items
    .filter((item) => isOverdue(item, today))
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .map((item) => ({ ...item, history: undefined }))
  // 数从清单来（只有一份事实，见上面的注释）。
  overdue = overdueItems.length

  // ── 验收期：也是**全局**的，且带倒计时 ──
  //
  // 为什么不能只在当前月里找：倒计时的全部意义就是"离那天还有多久"，
  // 所以 12 月的期末考在 10 月的日历上必须照样显示"还有 71 天"。
  // 排序口径：**未完成的在前**（按日期升序＝最近的先），已完成的在后（按日期降序＝最近的先）；
  // 已撤销的不出现（撤销的语义就是"这条不做了"）。
  const milestones = plan.items
    .filter((item) => isMilestone(item) && item.status !== 'cancelled')
    .map((item) => ({ item, countdown: milestoneCountdown(item, today) }))
    .filter((row) => row.countdown !== null)
    .sort((a, b) => {
      const aDone = a.item.status === 'done' ? 1 : 0
      const bDone = b.item.status === 'done' ? 1 : 0
      if (aDone !== bDone) return aDone - bDone
      return aDone === 0
        ? String(a.item.day).localeCompare(String(b.item.day))
        : String(b.item.day).localeCompare(String(a.item.day))
    })
    .slice(0, 8)
    .map(({ item, countdown }) => ({ ...item, history: undefined, countdown }))

  const summary = {
    planned: plan.items.filter((it) => it.status === 'planned' && it.day !== null && daySet.has(it.day)).length,
    done: plan.items.filter((it) => it.status === 'done' && typeof it.done_at === 'string' && daySet.has(dayKeyOf(it.done_at, tz).day)).length,
    cancelled: plan.items.filter((it) => it.status === 'cancelled').length,
    overdue,
    active_days: [...buckets.values()].filter((b) => b.sessions.length > 0 || b.course_events.length > 0).length,
    session_count: new Set([...buckets.values()].flatMap((b) => b.sessions.map((s) => s.session_id))).size,
    item_count: flatItems.length,
  }

  const notes = []
  if (probe.fallback) notes.push(`时区 "${tz}" 认不出，已按 UTC 折算日期——同一天的分组可能与你看到的差一天。`)
  if (range.truncated) notes.push(`区间超过 ${maxDays} 天，已截断：只铺了前 ${days.length} 天（truncated=true）。`)
  if (droppedSessions > 0) notes.push(`有 ${droppedSessions} 段对话因为超出"每天 ${MAX_SESSIONS_PER_DAY} 段"的上限没有列出。`)

  return {
    from,
    to,
    month: String(from).slice(0, 7),
    tz: tz ?? 'UTC',
    tz_fallback: probe.fallback,
    today,
    days: days.map((day) => buckets.get(day)),
    items: flatItems.map((item) => ({ ...item, history: undefined })),
    milestones,
    backlog,
    overdue: overdueItems,
    courses: normalizeCourses(options.courses),
    summary,
    unknown_event_types: Object.entries(plan.unknown_types).map(([type, count]) => ({ type, count })),
    orphan_events: plan.orphan_events,
    truncated: range.truncated,
    notes,
  }
}

/**
 * 一条日程与这个区间有没有关系（`items` 平铺清单只列区间内的）。
 *
 * 三种关系，与"露面"的三种方式一一对应：排在这段时间里、在这段时间里做完、
 * 在这段时间里被撤销。**漏掉后两种会让"我上周做完的事"从记录里消失**——
 * 那正是复盘时要看的东西。
 *
 * @param item - 日程项。
 * @param daySet - 区间内的日期集合。
 * @param tz - 折算时区。
 * @returns 布尔。
 */
export function inRange(item, daySet, tz) {
  if (item.day !== null && daySet.has(item.day)) return true
  if (typeof item.done_at === 'string' && daySet.has(dayKeyOf(item.done_at, tz).day)) return true
  if (typeof item.cancelled_at === 'string' && daySet.has(dayKeyOf(item.cancelled_at, tz).day)) return true
  return false
}

/** 一条日程是不是"过期未完成"（计划日早于今天、且仍是计划中）。 */
export function isOverdue(item, today) {
  return item.status === 'planned' && item.day !== null && today !== null && item.day < today
}

/** 空 summary（时钟坏掉时的兜底）。 */
function emptySummary() {
  return { planned: 0, done: 0, cancelled: 0, overdue: 0, active_days: 0, session_count: 0, item_count: 0 }
}

/**
 * 规范化课程清单。
 *
 * ═══ 为什么"认不出"也要留一行 ═══
 * 日程绑了一门课，而那门课被删了（或者课程清单没被传进来）——这时
 * **不能悄悄不显示**：学习者会以为这条日程没绑课。所以留 `{ node_id, title: null, unresolved: true }`，
 * 界面据此显示"课程已不存在"，而不是假装没绑。
 *
 * @param courses - 调用方给的清单（可为空）。
 * @returns `[{ node_id, title, level, path }]`。
 */
export function normalizeCourses(courses) {
  if (!Array.isArray(courses)) return []
  const out = []
  for (const raw of courses) {
    if (raw === null || typeof raw !== 'object') continue
    const nodeId = text(raw.node_id)
    if (nodeId === null) continue
    out.push({
      node_id: nodeId,
      title: text(raw.title),
      level: Number.isFinite(raw.level) ? raw.level : 1,
      path: Array.isArray(raw.path) ? raw.path.filter((p) => typeof p === 'string') : [],
    })
  }
  return out
}

/**
 * 把"某天有哪些日程"整理成给模型/人看的短清单（**唯一**的日程文本渲染）。
 *
 * ═══ 为什么渲染只有一处 ═══
 * 工具结果、上下文注入、HTTP 响应各写一遍渲染的话，同一天在三个地方会长得不一样，
 * 而模型正是靠这些文本判断"今天该干什么"。长相不一致 = 判断依据不一致。
 *
 * @param items - 某天的日程项（已排序）。
 * @param options.limit - 最多几行（默认 8）。
 * @param options.emptyText - 没有日程时的那句话。
 * @returns 文本行数组。
 */
export function renderDayItems(items, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 8
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return [options.emptyText ?? '（没有日程）']
  const lines = []
  for (const item of list.slice(0, limit)) {
    const when = item.start === null || item.start === undefined ? '' : item.end ? `${item.start}-${item.end} ` : `${item.start} `
    const mark = item.status === 'done' ? '✓' : item.status === 'cancelled' ? '✗' : item.status === 'skipped' ? '↷' : '·'
    const note = item.note === null || item.note === undefined ? '' : `（${item.note}）`
    const course = item.course_id === null || item.course_id === undefined ? '' : ` [${item.course_id}]`
    lines.push(`${mark} ${when}${item.title}${course}${note}`)
  }
  if (list.length > limit) lines.push(`…还有 ${list.length - limit} 条`)
  return lines
}

/**
 * "今天"的日程摘要 —— 专给**运行时上下文注入**用。
 *
 * 与 `buildCalendarView` 分开的原因：上下文注入每次模型步都要跑，
 * 而它只要一小段文本；铺一整张月历再从中取今天，是把成本花在没人看的地方。
 *
 * @param plan - `buildSchedule` 的结果。
 * @param options.tz - 时区。
 * @param options.limit - 今天最多列几条（默认 6）。
 * @param options.overdueLimit - 过期最多列几条（默认 3）。
 * @returns `{ today, weekday, today_items, overdue_items, overdue_count }`。
 */
export function todayAgenda(plan, options = {}) {
  const tz = text(options.tz)
  const limit = Number.isFinite(options.limit) ? options.limit : 6
  const overdueLimit = Number.isFinite(options.overdueLimit) ? options.overdueLimit : 3
  const { day: today } = todayKey(tz)
  const items = Array.isArray(plan?.items) ? plan.items : []

  const todayItems = items
    .filter((item) => item.day === today && item.status !== 'cancelled')
    .sort((a, b) => timeSortKey(a).localeCompare(timeSortKey(b)))
  const overdueItems = items
    .filter((item) => isOverdue(item, today))
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))

  // 最近的验收期（**没过去的**才算）："离大考还有几天"是模型在排计划时最该知道的一件事，
  // 所以它跟着 `lh:agenda` 每次组装都进上下文。
  const upcoming = items
    .filter((item) => isMilestone(item) && item.status === 'planned' && typeof item.day === 'string')
    .map((item) => ({ item, countdown: milestoneCountdown(item, today) }))
    .filter((row) => row.countdown !== null && row.countdown.phase !== 'past')
    .sort((a, b) => String(a.item.day).localeCompare(String(b.item.day)))
  const nearest = upcoming.length === 0 ? null : upcoming[0]

  // 待办（无日期）：把它也带进上下文，否则模型永远只看得见"有日期的世界"，
  // 而那些"想做但没定日子"的事会静静地消失——它们恰恰最需要被问一句"还做吗"。
  const backlogItems = items
    .filter((item) => isBacklog(item))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))

  return {
    today,
    weekday: weekdayOf(today),
    today_items: todayItems.slice(0, limit),
    today_count: todayItems.length,
    overdue_items: overdueItems.slice(0, overdueLimit),
    overdue_count: overdueItems.length,
    backlog_items: backlogItems.slice(0, Number.isFinite(options.backlogLimit) ? options.backlogLimit : 3),
    backlog_count: backlogItems.length,
    nearest_milestone: nearest === null ? null : { ...nearest.item, history: undefined, countdown: nearest.countdown },
    milestone_count: upcoming.length,
  }
}

/**
 * 默认区间：以某天为中心的"一周"（周一到周日）。
 * 界面上的"这周"按钮用；放在这里，免得服务端与客户端各算一遍。
 *
 * @param day - 基准日（默认今天）。
 * @param tz - 时区。
 * @returns `{ from, to }`。
 */
export function weekBounds(day, tz) {
  const base = asDayKey(day) ?? todayKey(tz).day
  if (base === null) return { from: null, to: null }
  // getUTCDay(): 0=周日。中国的习惯是周一开头，所以周日要往回退 6 天。
  const weekday = weekdayOf(base)
  const back = weekday === 0 ? 6 : weekday - 1
  const from = addDays(base, -back)
  return { from, to: addDays(from, 6) }
}

/** 供调用方按需引用的常量（界面显示"最多两个月"之类的地方会用到）。 */
export const RANGE_LIMITS = Object.freeze({ MAX_VIEW_DAYS, MAX_SESSIONS_PER_DAY, MAX_ITEMS_PER_DAY })

/**
 * 「**待办区**」的视图组装 —— 只回答一个问题：**接下来该做什么，按时间顺序。**
 *
 * ═══ 为什么它不是 `buildCalendarView` 换几个参数就能当 ═══
 * 日历是**网格**（每一天都要出现，包括空的），待办区是**列表**（只有有内容的日子才出现）。
 * 同一份投影喂两种排布，但返回的形状要各自服务于自己的消费方：
 *   · 网格要"整月都在"，空日子是必要信息（连着一周空 = 计划失效的信号）；
 *   · 列表要"一眼扫完接下来"，几十个空桶在那里是纯粹的噪声与体积。
 * 所以它在日历视图之上**重排**（滤掉空日子、把待办与欠账提前），而**不重算投影**。
 *
 * ═══ 为什么 `backlog` 与 `overdue` 排在最前 ═══
 * 它们是"需要你现在做决定"的东西（定个日子 / 顺延 / 撤掉 / 还是算了），
 * 而未来的日程只是"知道就好"。这正是作者要的那句
 * **"无限期推迟 → 放到待办置顶的位置"**：没日期的不是被丢掉了，是被顶到你眼前等你处理。
 *
 * @param events - LH 全量事件。
 * @param options.tz - 折算时区。
 * @param options.horizonDays - 往后铺多少天（默认 62 = 两个月，上限同 `MAX_VIEW_DAYS`）。
 * @param options.courses - 课程清单（由界面那一半提供）。
 * @returns 见 `@lh/schedule-ui` 的 `GET /todo` 输出 schema。
 */
export function buildTodoView(events, options = {}) {
  const tz = text(options.tz)
  const horizonDays = Number.isFinite(options.horizonDays)
    ? Math.max(1, Math.min(MAX_VIEW_DAYS, options.horizonDays))
    : MAX_VIEW_DAYS

  // ⚠ 起点默认是**今天**，不是"本月 1 号"。
  //   待办区回答的是"接下来做什么"，而"接下来"**必然跨月**：
  //   早先这里把默认交给 `buildCalendarView`（它的默认 = 本月），
  //   于是"11 月 20 日"这样一条日程在 10 月看是**看不见**的——
  //   而它已经定好日子、就在待办区该出现的范围里。这条是路由自检抓到的。
  const today = todayKey(tz).day
  const from = asDayKey(options.from) ?? today
  const to = from === null ? null : addDays(from, horizonDays - 1)

  const view = buildCalendarView(events, {
    from,
    to,
    tz,
    courses: options.courses,
    maxDays: horizonDays,
    includeActivity: options.includeActivity !== false,
  })

  // ⚠ 待办区**只列还没做的**（`planned`）。
  //   日历是**记录**视图：已完成/已撤销也要显示（带 ✓ / 删除线）——那是"发生过什么"。
  //   待办区是**决策**视图：它只该回答"接下来做什么"，把做完的和撤掉的混在里面，
  //   列表就会越用越长、而越长的待办列表越没人看。（这条是跑真实日志时发现的：
  //   自检留下的十几条已撤销日程全挤在同一天里。）
  const days = view.days
    .map((day) => ({ ...day, items: day.items.filter((item) => item.status === 'planned') }))
    .filter((day) => day.items.length > 0)

  return {
    today: view.today,
    from: view.from,
    to: view.to,
    tz: view.tz,
    tz_fallback: view.tz_fallback,
    horizon_days: horizonDays,
    backlog: view.backlog,
    overdue: view.overdue,
    days,
    day_count: days.length,
    milestones: view.milestones,
    courses: view.courses,
    summary: {
      backlog: view.backlog.length,
      overdue: view.overdue.length,
      planned: view.summary.planned,
      done: view.summary.done,
      cancelled: view.summary.cancelled,
    },
    notes: view.notes,
    truncated: view.truncated,
  }
}

/** 供调用方引用的日程事件动词（避免各处硬编字符串）。 */
export const SCHEDULE_VERBS = SCHEDULE_EVENT_TYPES
