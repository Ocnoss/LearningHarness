/**
 * 日程的**唯一写入路径** —— 谁想把"日程变了"记下来，都经过这里。
 *
 * ═══ 为什么必须只有一处（与 @lh/course-tree/commands.js 同一条纪律）═══
 * 会写日程的有两条路：
 *   · preset 里的 agent 工具（`create_schedule` 等，模型调的）；
 *   · profile 里的 HTTP 写路由（`/lh/schedule/create`，学习者在日历面板上点的）。
 * 如果两条路各自拼一遍信封，就会出现**同一种语义、两种字节**：字段名差一个下划线、
 * 状态写成 `canceled`、`day` 写成时间戳……而投影对认不得的字段是**跳过**
 * （`schedule.js` 的 `text()`/`asDayKey()` 一律"认不出当没有"），
 * 于是界面点的那个动作在模型眼里等于没发生——静默失败，本项目记录过很多次。
 *
 * 所以本文件是日程事件的唯一构造点：工具与界面都调它，谁都不自己拼信封。
 *
 * ═══ 为什么读事件也在这里 ═══
 * 每次写之前都要先投影一次（要解析"改的是哪一条"、要算真的改了哪些字段）。
 * 把"读 + 投影 + 写"合成一个函数，调用方就不可能忘掉其中一步——
 * 而忘掉投影正是"改了一条不存在的日程""写了条空事件"的来源。
 *
 * ═══ 边界：本文件会碰文件，所以绝不能在插件装载期调用 ═══
 * `apply()` 里调它 = 数据目录没配好就抛 = **整棵插件树加载失败 = dsh 起不来**（ADR-025）。
 * 所有调用都发生在"工具被执行"或"HTTP 请求到达"的那一刻。
 */

import { statSync } from 'node:fs'

import { LhEventStore, eventLogPath, readEvents } from '@lh/event-store/store'

import {
  ITEM_KINDS,
  ITEM_STATUSES,
  SCHEDULE_EVENT_TYPES,
  addDays,
  asDayKey,
  asTimeKey,
  buildSchedule,
  newItemId,
  resolveItemRef,
  scopeOf,
  todayKey,
} from './schedule.js'

/**
 * 本插件的出处标识（契约 §1.4：重放正确性的前提，必填）。
 * 版本**跟着包版本走**——两处不一致会让审计拿到错的时间线。
 */
export const PROVENANCE = Object.freeze({ plugin: '@lh/schedule', version: '0.1.0' })

/** 写入方。工具走 'agent'，界面来的写走 'user'（是学习者按的按钮）。 */
export const ACTOR_AGENT = 'agent'
export const ACTOR_USER = 'user'

/** 标题长度上限。与宿主自带「自动化任务」的 120 字符上限取同一个量级。 */
const MAX_TITLE = 120
/** 备注长度上限。备注是给人看的短句，不是文档（长内容该进资源/事件正文）。 */
const MAX_NOTE = 500
/** 单条日程的时长上限（分钟）= 24 小时。 */
const MAX_MINUTES = 1440

/**
 * 把"日期输入"解析成一个日历日。
 *
 * 人（和模型）说日期的方式不止一种：`2026-10-09`、`today`、`明天`。
 * 全都收，但**必须先落成一个确切的日历日**再写进日志——
 * 日志里存 `"tomorrow"` 是没法重放的（明天是哪天取决于读的时候）。
 *
 * 相对日按**宿主进程的本地时区**折算。这是一个已知的口径差：
 * 界面用浏览器时区（见 `@lh/schedule-ui`），进程时区在跨时区使用时可能差一天。
 * 所以工具描述里明确要模型优先给绝对日期，`today` 只是省事的写法。
 *
 * @param value - `YYYY-MM-DD` | today/tomorrow/yesterday | 今天/明天/昨天。
 * @returns 日历日。
 * @throws 认不出时（错误文本里列出可接受的写法——照契约 §七"返回纠错信息"）。
 */
export function resolveDayInput(value) {
  const absolute = asDayKey(value)
  if (absolute !== null) return absolute

  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const today = todayKey().day
  if (raw === 'today' || raw === '今天' || raw === '今日') return today
  if (raw === 'tomorrow' || raw === '明天') return addDays(today, 1)
  if (raw === 'yesterday' || raw === '昨天') return addDays(today, -1)
  if (raw === '后天') return addDays(today, 2)

  throw new Error(
    `认不出日期 "${String(value ?? '')}"。可接受的写法：'YYYY-MM-DD'（如 ${today}）、'today'/'今天'、'tomorrow'/'明天'、'yesterday'/'昨天'。`,
  )
}

/** 取一个 1..MAX_TITLE 的非空标题。 */
function requireTitle(value) {
  const title = typeof value === 'string' ? value.trim() : ''
  if (title === '') throw new Error('日程标题不能为空。')
  if (title.length > MAX_TITLE) throw new Error(`日程标题最多 ${MAX_TITLE} 个字符，当前 ${title.length} 个。`)
  return title
}

/** 取一个可清空的短文本字段。 */
function optionalText(value, max, what) {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return null
  if (text.length > max) throw new Error(`${what}最多 ${max} 个字符，当前 ${text.length} 个。`)
  return text
}

/** 取一个类型（封闭词表；认不出时把可选值列出来）。 */
function requireKind(value) {
  const kind = typeof value === 'string' ? value.trim() : ''
  if (kind === '') return 'study'
  if (!ITEM_KINDS.includes(kind)) {
    throw new Error(`认不出日程类型 "${kind}"。可用的类型：${ITEM_KINDS.join(' / ')}。`)
  }
  return kind
}

/** 取一个可清空的分钟数。 */
function optionalMinutes(value, what) {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${what}要是大于 0 的分钟数，收到 "${String(value)}"。`)
  if (n > MAX_MINUTES) throw new Error(`${what}最多 ${MAX_MINUTES} 分钟（24 小时），收到 ${n}。`)
  return Math.round(n)
}

/** 取一个可清空的时间点。 */
function optionalTime(value, what) {
  if (value === null || value === undefined) return null
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '') return null
  const time = asTimeKey(trimmed)
  if (time === null) throw new Error(`${what}要写成 24 小时制的 'HH:MM'（如 '09:30'），收到 "${String(value)}"。`)
  return time
}

/**
 * 取一个可清空的**日历日**（验收期窗口的终点走这条路）。
 * @param value - `YYYY-MM-DD` 或 today/tomorrow/yesterday；空 = null。
 * @param what - 出错信息里的字段名。
 * @returns 日历日或 null。
 */
function optionalDay(value, what) {
  if (value === null || value === undefined) return null
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '') return null
  try {
    return resolveDayInput(trimmed)
  } catch {
    throw new Error(
      `${what}要写成 'YYYY-MM-DD'（如 2026-12-20）或 today/tomorrow；` +
        `给空字符串 = 不定日期。收到 "${String(value)}"。`,
    )
  }
}

/** 当前时刻（ISO）。集中一处，便于测试替换与审计对齐。 */
function nowIso() {
  return new Date().toISOString()
}

/**
 * 新建一条日程。
 *
 * @param params.title - 标题（必填）。
 * @param params.day - 日期（必填；`YYYY-MM-DD` 或 today/tomorrow/yesterday）。
 * @param params.start - 开始时间 `HH:MM`（可空）。
 * @param params.end - 结束时间 `HH:MM`（可空）。
 * @param params.kind - 类型（默认 'study'）。
 * @param params.note - 备注（可空）。
 * @param params.courseId - 绑定的课程 node_id（可空）。
 * @param params.sessionId - 绑定的宿主会话 id（可空）。
 * @param params.minutes - 预计时长（分钟，可空）。
 * @param params.tz - 排这条日程时所在的时区（可选；只用于解释，不参与计算）。
 * @param params.source - 这条日程从哪来（`agent` / `ui` / 将来的 `fsrs`）。
 * @param params.actor - 写入方。
 * @returns `{ item_id, day, start, end, kind, title, events }`。
 */
export function createScheduleItem({
  title,
  day,
  until = null,
  start = null,
  end = null,
  kind = 'study',
  note = null,
  courseId = null,
  sessionId = null,
  minutes = null,
  tz = null,
  source = 'agent',
  actor = ACTOR_AGENT,
}) {
  const cleanTitle = requireTitle(title)
  // ⚠ `day` 从"必填"放宽为"可空"（2026-10-09，应作者要求）：
  //   日程很可能是模型生成的，而"先记下来、日子以后再说"是真实需求——
  //   于是**没有日期的日程 = 待办**（它不占任何一天，只出现在待办区）。
  //   同一条放宽也给了"无限期推迟"一个落点：`applySchedulePatch({day: ''})`。
  const cleanDay = optionalDay(day, '日期')
  const cleanUntil = optionalDay(until, '验收期的最后一天')
  if (cleanUntil !== null && cleanDay === null) {
    throw new Error('要设验收期的窗口（until），必须先给起始日期（day）——没有起点就没有窗口。')
  }
  if (cleanUntil !== null && cleanDay !== null && cleanUntil < cleanDay) {
    throw new Error(`验收期的最后一天（${cleanUntil}）不能早于起始日（${cleanDay}），没有写任何东西。`)
  }
  const cleanStart = optionalTime(start, '开始时间')
  const cleanEnd = optionalTime(end, '结束时间')
  if (cleanStart !== null && cleanEnd !== null && cleanEnd <= cleanStart) {
    throw new Error(`结束时间（${cleanEnd}）要晚于开始时间（${cleanStart}）。`)
  }

  const itemId = newItemId()
  const store = new LhEventStore()
  store.append({
    actor,
    type: SCHEDULE_EVENT_TYPES.CREATED,
    provenance: PROVENANCE,
    scope: scopeOf(itemId),
    // sessionRef 只记"这条日程与哪段对话有关"；没绑就是 null（信封显式写 null，
    // 读取端要能区分"没有"与"没记"——契约 §2.2）。
    sessionRef: sessionId ?? undefined,
    data: {
      item_id: itemId,
      title: cleanTitle,
      day: cleanDay,
      until: cleanUntil,
      start: cleanStart,
      end: cleanEnd,
      kind: requireKind(kind),
      note: optionalText(note, MAX_NOTE, '备注'),
      course_id: optionalText(courseId, 200, '课程 id'),
      session_id: optionalText(sessionId, 200, '会话 id'),
      minutes_planned: optionalMinutes(minutes, '预计时长'),
      tz: optionalText(tz, 64, '时区'),
      source: optionalText(source, 40, '来源') ?? 'agent',
    },
  })

  return {
    item_id: itemId,
    title: cleanTitle,
    day: cleanDay,
    until: cleanUntil,
    start: cleanStart,
    end: cleanEnd,
    kind: requireKind(kind),
  }
}

/**
 * 改一条日程（**唯一**的改法；工具与 HTTP 路由都调它）。
 *
 * ═══ 为什么一个函数吃掉所有改法 ═══
 * "改时间""改标题""标记完成""绑到这段对话"在界面和工具上是四个按钮，
 * 但在日志里它们是**同一件事的不同字段**。分成四个写入函数的话，
 * 每个调用方都要选对函数，而选错不会报错（写出一条语法合法、语义错的补丁）。
 * 所以这里只有一个入口：`patch` 里出现哪个键就改哪个键。
 *
 * ═══ 一次调用可能写多条事件，这是刻意的（契约 §1.3 写细读粗）═══
 * "把这条日程标记完成、同时绑到当前对话"写两条事件（`done` + `linked`）：
 * 它们在语义上是两件事（一个事实、一个归属），分开记才能在日志里分别被引用。
 * 顺序是 `updated` → `linked` → `done`，因为 `done` 要带上最终的归属。
 *
 * @param params.itemRef - 要改哪条：`item_id` 或（唯一匹配的）标题。
 * @param params.patch - 要改的字段。**没出现的键一律不动**；
 *   值写成 `null` 表示**清空**（只对 start / end / note / minutes_planned / minutes_actual / course_id / session_id 有意义）。
 * @param params.actor - 写入方。
 * @returns `{ item, events, changed }`：改完之后的日程（重新投影得到）、
 *   这次写了哪些事件、改了哪些字段（`changed` 为空 = **什么都没写**）。
 * @throws 找不到/有歧义/字段非法时。
 */
export function applySchedulePatch({ itemRef, patch = {}, actor = ACTOR_USER }) {
  const store = new LhEventStore()
  const before = buildSchedule(readEvents())
  const item = requireItem(before, itemRef)

  const changed = []
  const events = []

  // ── 1. 普通字段（`updated` 事件）──
  const updateData = { item_id: item.item_id }
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key)

  if (has('title')) {
    const title = requireTitle(patch.title)
    if (title !== item.title) {
      updateData.title = title
      changed.push('title')
    }
  }
  // 日期与验收期窗口：同"时间两件套"，**先算改完之后的值、再判冲突、再决定写不写**。
  const nextDay = has('day') ? optionalDay(patch.day, '日期') : item.day
  let nextUntil = has('until') ? optionalDay(patch.until, '验收期的最后一天') : item.until
  // 没有起始日就没有窗口：把日期清掉（= 无限期推迟，进待办区）时，窗口跟着一起清。
  // 否则会留下"没有起点的窗口"——投影读不出来、界面也画不出来的状态。
  if (nextDay === null && nextUntil !== null) nextUntil = null
  if (nextUntil !== null && nextDay !== null && nextUntil < nextDay) {
    throw new Error(`改完之后验收期的最后一天（${nextUntil}）早于起始日（${nextDay}），没有写任何东西。`)
  }
  if (has('day') && nextDay !== item.day) {
    updateData.day = nextDay
    changed.push('day')
  }
  // ⚠ 这里判的是"值变了没有"，不是"调用方给没给 until"：
  //   上面那次自动清空也必须在日志里留下痕迹，否则重放时窗口会"自己消失"。
  if (nextUntil !== item.until) {
    updateData.until = nextUntil
    changed.push('until')
  }
  if (has('kind')) {
    const kind = requireKind(patch.kind)
    if (kind !== item.kind) {
      updateData.kind = kind
      changed.push('kind')
    }
  }
  // 时间两件套：**先把"改完之后的值"算出来，再判冲突、再决定写不写**。
  //
  // ⚠ 顺序很要紧，而且这里踩过一次：第一版先用 `updateData.start` 当"改完之后的值"，
  //   而只在**真的变了**时才写进 updateData——于是"只改 end、start 没变"这种调用
  //   算出来的 mergedStart 是 null，冲突检查被整段跳过，
  //   结果日志里留下 start=10:00 / end=09:00 这种自相矛盾的日程。
  //   所以改完之后的值一律从 `patch`（给了）或 `item`（没给）来，与"要不要写"无关。
  const nextStart = has('start') ? optionalTime(patch.start, '开始时间') : item.start
  const nextEnd = has('end') ? optionalTime(patch.end, '结束时间') : item.end
  if (nextStart !== null && nextEnd !== null && nextEnd <= nextStart) {
    throw new Error(`改完之后结束时间（${nextEnd}）不晚于开始时间（${nextStart}），没有写任何东西。`)
  }
  if (has('start') && nextStart !== item.start) {
    updateData.start = nextStart
    changed.push('start')
  }
  if (has('end') && nextEnd !== item.end) {
    updateData.end = nextEnd
    changed.push('end')
  }
  if (has('note')) {
    const note = optionalText(patch.note, MAX_NOTE, '备注')
    if (note !== item.note) {
      updateData.note = note
      changed.push('note')
    }
  }
  for (const [key, what] of [['minutes_planned', '预计时长'], ['minutes_actual', '实际时长']]) {
    if (!has(key)) continue
    const minutes = optionalMinutes(patch[key], what)
    if (minutes !== item[key]) {
      updateData[key] = minutes
      changed.push(key)
    }
  }

  // 状态：'done' 走**独立事件**（它是一个事实，不是一条补丁）；其余状态进 updated。
  const wantedStatus = has('status') ? String(patch.status ?? '').trim() : ''
  if (wantedStatus !== '' && !ITEM_STATUSES.includes(wantedStatus)) {
    throw new Error(
      `认不出状态 "${wantedStatus}"。可写：planned（计划中）/ done（已完成）/ skipped（跳过）。` +
        '要撤销一条日程请用 cancel_schedule。',
    )
  }
  if (wantedStatus === 'cancelled') {
    throw new Error('撤销请用 cancel_schedule（它会记下撤销原因，语义更清楚）。')
  }
  const markDone = wantedStatus === 'done' && item.status !== 'done'
  if (wantedStatus !== '' && wantedStatus !== 'done' && wantedStatus !== item.status) {
    updateData.status = wantedStatus
    changed.push('status')
  }

  // 归属：先把"改完之后的值"和"到底变了没有"算清楚，再决定写不写。
  //
  // ⚠ 这里的第一版有个诚实性问题：它用 `has('course_id')` 判断"要不要记进 changed"，
  //   于是"课程没变、只改了会话"也会把 `course_id` 报成改动过。
  //   `changed` 是 `update_schedule` 回给模型与人的那句话说"改了哪些字段"的依据，
  //   报错一个字段就会让人以为动过它。所以这里按**值比较**算 changed。
  const nextCourse = has('course_id') ? optionalText(patch.course_id, 200, '课程 id') : item.course_id
  const nextSession = has('session_id') ? optionalText(patch.session_id, 200, '会话 id') : item.session_id
  const courseChanged = nextCourse !== item.course_id
  const sessionChanged = nextSession !== item.session_id
  const wantsLinkChange = courseChanged || sessionChanged

  if (changed.length > 0) {
    store.append({
      actor,
      type: SCHEDULE_EVENT_TYPES.UPDATED,
      provenance: PROVENANCE,
      scope: scopeOf(item.item_id),
      sessionRef: item.session_id ?? undefined,
      data: updateData,
    })
    events.push(SCHEDULE_EVENT_TYPES.UPDATED)
  }

  // ── 2. 归属（`linked` 事件）──
  //
  // ⚠ `linked` 的 data 里**两个字段都要给**（缺字段按"清空"读，见 schedule.js）。
  //   所以这里必须把"本次没提到的那一个"用**当前值**补上，否则"只改课程"
  //   会顺手把会话绑定清掉——那是静默的数据损失。
  if (wantsLinkChange) {
    store.append({
      actor,
      type: SCHEDULE_EVENT_TYPES.LINKED,
      provenance: PROVENANCE,
      scope: scopeOf(item.item_id),
      sessionRef: nextSession ?? undefined,
      data: { item_id: item.item_id, course_id: nextCourse, session_id: nextSession },
    })
    events.push(SCHEDULE_EVENT_TYPES.LINKED)
    if (courseChanged) changed.push('course_id')
    if (sessionChanged) changed.push('session_id')
  }

  // ── 3. 完成（`done` 事件——一个**事实**，不是补丁）──
  if (markDone) {
    const actual = has('minutes_actual') ? optionalMinutes(patch.minutes_actual, '实际时长') : item.minutes_actual
    store.append({
      actor,
      type: SCHEDULE_EVENT_TYPES.DONE,
      provenance: PROVENANCE,
      scope: scopeOf(item.item_id),
      sessionRef: nextSession ?? undefined,
      data: { item_id: item.item_id, done_at: nowIso(), session_id: nextSession, minutes_actual: actual },
    })
    events.push(SCHEDULE_EVENT_TYPES.DONE)
    changed.push('done')
  }

  const after = buildSchedule(readEvents())
  return { item: after.byId[item.item_id] ?? item, events, changed }
}

/**
 * 撤销一条日程（追加 `cancelled` 事件，**不是删除**）。
 *
 * ═══ 为什么撤销也需要理由字段 ═══
 * "为什么这次没学"是学习诊断里最有信息量的一类数据（是时间没排开？是内容太难？
 * 还是计划本身不合理？）。而它只在撤销的**那一刻**知道，事后补不出来。
 *
 * 撤销之后这条日程仍然在日志里、仍在日历上（标成"已撤销"），
 * 也能用 `applySchedulePatch({status:'planned'})` 恢复——所以本操作**不需要**
 * 两段式确认（契约的白名单纪律针对的是**不可逆**的破坏性操作）。
 *
 * @param params.itemRef - 要撤销哪条。
 * @param params.reason - 撤销原因（可空，但强烈建议给）。
 * @param params.actor - 写入方。
 * @returns `{ item, reason }`。
 */
export function cancelScheduleItem({ itemRef, reason = null, actor = ACTOR_USER }) {
  const store = new LhEventStore()
  const before = buildSchedule(readEvents())
  const item = requireItem(before, itemRef)

  if (item.status === 'cancelled') {
    // 已经是撤销态：**不再写第二条**（重复写会让"撤销了几次"这种统计失真）。
    return { item, reason: item.cancel_reason, already: true }
  }

  const cleanReason = optionalText(reason, MAX_NOTE, '撤销原因')
  store.append({
    actor,
    type: SCHEDULE_EVENT_TYPES.CANCELLED,
    provenance: PROVENANCE,
    scope: scopeOf(item.item_id),
    sessionRef: item.session_id ?? undefined,
    data: { item_id: item.item_id, reason: cleanReason },
  })

  const after = buildSchedule(readEvents())
  return { item: after.byId[item.item_id] ?? item, reason: cleanReason, already: false }
}

/**
 * 解析出唯一一条日程，否则抛**能照做**的错（同 course-tree 的 requireNode）。
 * @param plan - 投影结果。
 * @param itemRef - id 或标题。
 * @returns 日程项。
 * @throws 找不到或有歧义时。
 */
export function requireItem(plan, itemRef) {
  const ref = typeof itemRef === 'string' ? itemRef.trim() : ''
  if (ref === '') throw new Error('没有说清要改哪条日程。给 item_id（schedule-xxxxxxxx）或它的标题。')

  const resolved = resolveItemRef(plan, ref)
  if (resolved.ambiguous !== undefined) {
    throw new Error(
      `"${ref}" 有歧义，匹配到 ${resolved.ambiguous.length} 条：` +
        resolved.ambiguous
          .map((it) => `「${it.title}」(${it.day ?? '未定日'} ${it.item_id})`)
          .join('、') +
        '。请改用 item_id 指定。',
    )
  }
  if (resolved.item === null) {
    throw new Error(`找不到日程 "${ref}"。先用 list_schedule 看看有哪些（也可以直接用 item_id 指）。`)
  }
  return resolved.item
}

/**
 * 读一次投影（`readEvents` 的薄封装，给调用方一个不需要知道存储的入口）。
 * @returns `buildSchedule` 的结果。
 */
export function readSchedule() {
  return buildSchedule(readEvents())
}

/**
 * 投影的**带缓存读取** —— 专给"每次模型步都要跑"的上下文注入用。
 *
 * ═══ 为什么缓存的是"日志的 stat"而不是时间 ═══
 * 按时间缓存会在"刚建完日程、下一次请求"这一格上给旧值，而那正是学习者最在意的一次；
 * 按 mtime+size 缓存则只要日志变了就一定重读。代价是每步一次 `statSync`（微秒级），
 * 换来的是"注入的永远是当前日程表"。（同 `@lh/course-tree/commands.js` 的 `cachedTree`。）
 *
 * @returns `{ plan, logPath }`；读失败时 plan 为 null（**不抛**：
 *   上下文注入失败不该让整轮模型调用崩掉，与装载期不抛错是同一条纪律）。
 */
export function cachedSchedule() {
  let logPath
  try {
    logPath = eventLogPath()
  } catch {
    return { plan: null, logPath: null }
  }

  let key = 'missing'
  try {
    const st = statSync(logPath)
    key = `${st.mtimeMs}:${st.size}`
  } catch {
    key = 'missing'
  }

  if (cache.key === key && cache.plan !== null) return { plan: cache.plan, logPath }
  try {
    const plan = buildSchedule(readEvents())
    cache.key = key
    cache.plan = plan
    return { plan, logPath }
  } catch {
    return { plan: null, logPath }
  }
}

/** 模块级缓存（单进程、单日志文件；`key` 是日志的 mtime+size）。 */
const cache = { key: null, plan: null }
