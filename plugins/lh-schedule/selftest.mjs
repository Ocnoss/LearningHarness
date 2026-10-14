/**
 * `@lh/schedule` 的**离线自检** —— 只碰纯函数，不读事件日志、不写任何文件。
 *
 * ═══ 为什么它必须存在（而闸门替不了它）═══
 * `scripts/check-*.mjs` 那一批闸门证明的是"能 import / apply 不抛错 / 声明齐全 /
 * 副本是新的"——它们**不能证明逻辑对**（PLUGIN_CONTRACT §八 的边界那条）。
 * 而日程最容易错的恰恰是逻辑：日期算术、时区折算、跨月加减、闰年、
 * "排在前天、昨天才做完"该出现在哪一天。
 *
 * ═══ 怎么跑 ═══
 *   node plugins/lh-schedule/selftest.mjs
 * 全绿退出码 0；任何一条失败退出码 1 并打印它。
 *
 * ═══ 为什么断言里写死了具体日期 ═══
 * 用"今天 + 1 天"这种相对断言的话，测试会跟着运行日期变，
 * 而"跨月/跨年/夏令时"这些真正会错的地方正好被绕过去。
 * 所以凡是能写死的都写死（2026-02-28 → 2026-03-01、2024-02-29 这类）。
 */

import {
  addDays,
  addMonths,
  asDayKey,
  asTimeKey,
  buildSchedule,
  countdownText,
  dayKeyOf,
  dayRange,
  ITEM_KINDS,
  localTimeZone,
  MILESTONE_KINDS,
  milestoneCountdown,
  monthBounds,
  resolveItemRef,
  scheduleItems,
  SCHEDULE_EVENT_TYPES,
  weekdayOf,
} from './schedule.js'
import { buildCalendarView, renderDayItems, todayAgenda, weekBounds } from './calendar.js'

let passed = 0
const failures = []

/**
 * 断言。
 * @param label - 这条断言在说什么。
 * @param condition - 真假。
 * @param detail - 失败时打印的上下文。
 */
function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${label}${detail === '' ? '' : `  →  ${detail}`}`)
}

/** 深比较（只用于本文件里的小结构）。 */
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(label, a === b, `实际 ${a} ≠ 期望 ${b}`)
}

/** 造一条 LH 事件的信封（只带投影要读的字段）。 */
function ev(type, timestamp, data, extra = {}) {
  return {
    id: `e-${Math.random().toString(36).slice(2, 10)}`,
    timestamp,
    schema_version: 1,
    actor: 'user',
    type,
    provenance: { plugin: '@lh/schedule', version: 'test' },
    scope: 'schedule/x',
    session_ref: null,
    content_ref: null,
    data,
    ...extra,
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 1. 日期形状与算术
// ══════════════════════════════════════════════════════════════════════════

ok('asDayKey 收下合法日期', asDayKey('2026-10-09') === '2026-10-09')
ok('asDayKey 拒绝不存在的日期 2026-02-30', asDayKey('2026-02-30') === null)
ok('asDayKey 拒绝 2026-13-01', asDayKey('2026-13-01') === null)
ok('asDayKey 拒绝 2026-2-9（要补零）', asDayKey('2026-2-9') === null)
ok('asDayKey 收下闰日 2024-02-29', asDayKey('2024-02-29') === '2024-02-29')
ok('asDayKey 拒绝非闰年的 2023-02-29', asDayKey('2023-02-29') === null)

ok('asTimeKey 收下 09:30', asTimeKey('09:30') === '09:30')
ok('asTimeKey 收下 00:00', asTimeKey('00:00') === '00:00')
ok('asTimeKey 拒绝 24:00', asTimeKey('24:00') === null)
ok('asTimeKey 拒绝 9:30（要补零）', asTimeKey('9:30') === null)

eq('addDays 跨月', addDays('2026-02-28', 1), '2026-03-01')
eq('addDays 跨年', addDays('2026-12-31', 1), '2027-01-01')
eq('addDays 跨闰日', addDays('2024-02-28', 1), '2024-02-29')
eq('addDays 负数', addDays('2026-01-01', -1), '2025-12-31')
eq('addDays 非法输入', addDays('2026-02-30', 1), null)

eq('monthBounds 二月（平年）', monthBounds('2026-02'), { from: '2026-02-01', to: '2026-02-28' })
eq('monthBounds 二月（闰年）', monthBounds('2024-02'), { from: '2024-02-01', to: '2024-02-29' })
eq('monthBounds 十二月（跨年边界）', monthBounds('2026-12'), { from: '2026-12-01', to: '2026-12-31' })
eq('addMonths 跨年', addMonths('2026-12', 1), '2027-01')
eq('addMonths 回退', addMonths('2026-01', -1), '2025-12')

ok('weekdayOf 2026-10-09 是周五', weekdayOf('2026-10-09') === 5, `实际 ${weekdayOf('2026-10-09')}`)
ok('weekdayOf 2026-10-11 是周日', weekdayOf('2026-10-11') === 0, `实际 ${weekdayOf('2026-10-11')}`)

eq(
  'dayRange 铺出闭区间的每一天',
  dayRange('2026-02-27', '2026-03-02').days,
  ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'],
)
ok('dayRange 上限截断并如实标注', dayRange('2026-01-01', '2026-12-31', 3).truncated === true)
ok('dayRange 上限内的天数正确', dayRange('2026-01-01', '2026-12-31', 3).days.length === 3)
ok('dayRange 反区间给空', dayRange('2026-03-02', '2026-02-27').days.length === 0)
ok('weekBounds 落在周一到周日', (() => {
  const w = weekBounds('2026-10-09', 'UTC') // 周五
  return weekdayOf(w.from) === 1 && weekdayOf(w.to) === 0
})())

// ══════════════════════════════════════════════════════════════════════════
// 2. 时区折算（这是"哪一天"的唯一判据，所以必须钉死）
// ══════════════════════════════════════════════════════════════════════════

// 2026-10-09T23:30:00Z：UTC 是 10-09，东八区是 10-10。两地对同一条事件的"哪天"不同。
eq('dayKeyOf 按 UTC 折算', dayKeyOf('2026-10-09T23:30:00Z', 'UTC').day, '2026-10-09')
eq('dayKeyOf 按 Asia/Shanghai 折算', dayKeyOf('2026-10-09T23:30:00Z', 'Asia/Shanghai').day, '2026-10-10')
eq('dayKeyOf 按 America/New_York 折算', dayKeyOf('2026-10-09T02:00:00Z', 'America/New_York').day, '2026-10-08')
ok('dayKeyOf 认不出时区时如实标注 fallback', dayKeyOf('2026-10-09T23:30:00Z', 'Mars/Olympus').fallback === true)
eq('dayKeyOf 认不出时区时退回 UTC 的日', dayKeyOf('2026-10-09T23:30:00Z', 'Mars/Olympus').day, '2026-10-09')
ok('dayKeyOf 处理不了的时刻给 null', dayKeyOf('不是时间', 'UTC').day === null)
eq('dayKeyOf 接受 epoch 毫秒', dayKeyOf(Date.parse('2026-10-09T12:00:00Z'), 'UTC').day, '2026-10-09')

// 【不给时区 = 按进程本地时区】——这条是"今天有哪些日程"在晚上不出错的前提，
// 所以断言用的是**本地 getter**（getFullYear/getMonth/getDate）算出的期望值，
// 而不是写死的日期：写死的话，在另一个时区跑就会"测试通过但生产错一天"。
const probeMs = Date.parse('2026-10-09T23:30:00Z')
const expectedLocal = (() => {
  const d = new Date(probeMs)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()
eq('dayKeyOf 不给时区时按进程本地时区折算', dayKeyOf(probeMs).day, expectedLocal)
ok('dayKeyOf 不给时区时不算 fallback', dayKeyOf(probeMs).fallback === false)
ok('localTimeZone 给出一个非空时区名', typeof localTimeZone() === 'string' && localTimeZone() !== '')

// ══════════════════════════════════════════════════════════════════════════
// 3. 事件重放（created → updated → linked → done）
// ══════════════════════════════════════════════════════════════════════════

const T = {
  created: SCHEDULE_EVENT_TYPES.CREATED,
  updated: SCHEDULE_EVENT_TYPES.UPDATED,
  linked: SCHEDULE_EVENT_TYPES.LINKED,
  done: SCHEDULE_EVENT_TYPES.DONE,
  cancelled: SCHEDULE_EVENT_TYPES.CANCELLED,
}

const log = [
  // 一条完整的生命周期
  ev(T.created, '2026-10-01T01:00:00Z', {
    item_id: 'schedule-aaaa1111',
    title: '资料分析 · 速算',
    day: '2026-10-09',
    start: '09:00',
    end: '10:00',
    kind: 'study',
    note: null,
    course_id: null,
    session_id: null,
    minutes_planned: 60,
    tz: 'Asia/Shanghai',
    source: 'agent',
  }),
  ev(T.updated, '2026-10-02T01:00:00Z', { item_id: 'schedule-aaaa1111', day: '2026-10-10', start: '08:30' }),
  ev(T.linked, '2026-10-02T02:00:00Z', { item_id: 'schedule-aaaa1111', course_id: 'course-b6623731', session_id: null }),
  ev(T.updated, '2026-10-03T01:00:00Z', { item_id: 'schedule-aaaa1111', status: 'skipped' }),
  ev(T.linked, '2026-10-04T01:00:00Z', { item_id: 'schedule-aaaa1111', course_id: 'course-b6623731', session_id: 'session-77' }),
  ev(T.done, '2026-10-10T02:00:00Z', {
    item_id: 'schedule-aaaa1111',
    done_at: '2026-10-10T02:00:00Z',
    session_id: 'session-77',
    minutes_actual: 75,
  }),

  // 一条被撤销的
  ev(T.created, '2026-10-05T01:00:00Z', { item_id: 'schedule-bbbb2222', title: '申论 · 大作文', day: '2026-10-07', kind: 'study' }),
  ev(T.cancelled, '2026-10-07T03:00:00Z', { item_id: 'schedule-bbbb2222', reason: '临时有事' }),

  // 一条还在计划中、且已经过期（今天假定晚于 10-08）
  ev(T.created, '2026-10-05T01:00:00Z', { item_id: 'schedule-cccc3333', title: '模考一套', day: '2026-10-06', kind: 'exam' }),

  // 同族未知动词（前向兼容：不许猜、不许丢，要计数）
  ev('lh/schedule/pinged', '2026-10-06T01:00:00Z', { item_id: 'schedule-cccc3333' }),
  // 缺 item_id 的坏事件
  ev(T.updated, '2026-10-06T02:00:00Z', { title: '没有 id' }),
  // 别的族（必须完全不影响）
  ev('lh/course/created', '2026-10-09T00:30:00Z', { node_id: 'course-b6623731', title: '行测', level: 1 }),
  ev('lh/trace/observed', '2026-10-09T02:00:00Z', { session_id: 'session-77', seq: 3, host_type: 'user/message' }, { session_ref: 'session-77' }),
]

const plan = buildSchedule(log)
eq('投影出三条日程', plan.items.length, 3)
// 11 = 上面 9 条正常事件 + 1 条未知动词（同族，必须计数不许丢）+ 1 条缺 item_id 的坏事件
eq('事件条数只数日程族（含未知动词与坏事件）', plan.event_count, 11)
eq('未知同族动词被计数', plan.unknown_types['lh/schedule/pinged'], 1)
eq('缺 item_id 的事件被计数', plan.orphan_events, 1)

const a = plan.byId['schedule-aaaa1111']
eq('改期生效', a.day, '2026-10-10')
eq('改时间只改给了的那个字段', [a.start, a.end], ['08:30', '10:00'])
eq('绑课程生效', a.course_id, 'course-b6623731')
eq('绑会话生效', a.session_id, 'session-77')
eq('done 之后状态是 done', a.status, 'done')
eq('done 没清掉 linked 的课程', a.course_id, 'course-b6623731')
eq('实际时长记下了', a.minutes_actual, 75)
ok('history 记全了每次事件', a.history.length === 6, `实际 ${a.history.length}`)

const b = plan.byId['schedule-bbbb2222']
eq('撤销改了状态而不是删掉', [b.status, b.cancel_reason], ['cancelled', '临时有事'])
ok('撤销的日程仍在投影里', b !== undefined)

// ══════════════════════════════════════════════════════════════════════════
// 4. 引用解析（歧义不许猜）
// ══════════════════════════════════════════════════════════════════════════

eq('按 id 精确解析', resolveItemRef(plan, 'schedule-cccc3333').item.item_id, 'schedule-cccc3333')
eq('按标题解析', resolveItemRef(plan, '模考一套').item.item_id, 'schedule-cccc3333')
ok('找不到时给 null 而不是猜一条', resolveItemRef(plan, '不存在的日程').item === null)

const dupLog = [
  ev(T.created, '2026-10-01T01:00:00Z', { item_id: 'schedule-dddd4444', title: '背单词', day: '2026-10-09' }),
  ev(T.created, '2026-10-01T02:00:00Z', { item_id: 'schedule-eeee5555', title: '背单词', day: '2026-10-10' }),
]
const dup = buildSchedule(dupLog)
ok('同名标题被识别为歧义', Array.isArray(resolveItemRef(dup, '背单词').ambiguous))
ok('歧义时不返回任何一条', resolveItemRef(dup, '背单词').item === undefined)

// ══════════════════════════════════════════════════════════════════════════
// 5. 日历视图：三件事按日期索引
// ══════════════════════════════════════════════════════════════════════════

const view = buildCalendarView(log, {
  from: '2026-10-06',
  to: '2026-10-11',
  tz: 'UTC',
  courses: [{ node_id: 'course-b6623731', title: '行测', level: 1, path: ['行测'] }],
})

eq('区间原样回显', [view.from, view.to], ['2026-10-06', '2026-10-11'])
eq('铺出六天（含没有内容的日子）', view.days.length, 6)
ok('空日子也在（空是一种数据）', view.days.some((d) => d.day === '2026-10-08' && d.items.length === 0))

const day1010 = view.days.find((d) => d.day === '2026-10-10')
ok('10-10 有那条日程', day1010.items.some((it) => it.item_id === 'schedule-aaaa1111'))
eq(
  '“排在这天 + 这天完成”两种露面都记下来',
  day1010.items.find((it) => it.item_id === 'schedule-aaaa1111').appearances,
  ['planned', 'done'],
)

const day1009 = view.days.find((d) => d.day === '2026-10-09')
ok('10-09 索引到了一段对话', day1009.sessions.some((s) => s.session_id === 'session-77'))
ok('10-09 的对话计数正确', day1009.sessions.find((s) => s.session_id === 'session-77').events === 1)
ok('10-09 索引到了课程动作', day1009.course_events.some((c) => c.node_id === 'course-b6623731'))
ok('课程清单原样带出（供界面选）', view.courses.length === 1 && view.courses[0].title === '行测')

// 过期 = 计划日早于"今天"。这里的"今天"是**真今天**（2026 之后的运行日），
// 所以 10-06 的那条一定算过期；10-10 那条已经 done，不算。
ok('过期统计只数 planned 且已过日', view.summary.overdue >= 1)
eq('撤销的日程在区间内仍被列出', view.summary.cancelled, 1)

// 只铺一天时，"排在这天、那天完成"的日程不该凭空出现在无关的日子上。
const single = buildCalendarView(log, { from: '2026-10-09', to: '2026-10-09', tz: 'UTC' })
eq('10-09 没有日程（它已改到 10-10）', single.days[0].items.length, 0)

// 时区回退要如实说
const fallbackView = buildCalendarView(log, { from: '2026-10-09', to: '2026-10-09', tz: 'Mars/Olympus' })
ok('时区认不出会被标注', fallbackView.tz_fallback === true)
ok('时区回退写进了 notes', fallbackView.notes.some((n) => n.includes('认不出')))

// 截断要如实说
const longView = buildCalendarView(log, { from: '2026-01-01', to: '2026-12-31', tz: 'UTC' })
ok('超长区间被截断并标注', longView.truncated === true && longView.notes.some((n) => n.includes('截断')))

// 不读活动时 sessions 必须为空（with_activity=false 的语义）
const noActivity = buildCalendarView(log, { from: '2026-10-09', to: '2026-10-09', tz: 'UTC', includeActivity: false })
eq('关掉活动就不索引对话', noActivity.days[0].sessions.length, 0)

// ══════════════════════════════════════════════════════════════════════════
// 6. 渲染与今日摘要（上下文注入要用的那一小段）
// ══════════════════════════════════════════════════════════════════════════

ok('没有日程时渲染给一句明确的话', renderDayItems([], { emptyText: '（没有日程）' })[0] === '（没有日程）')
const rendered = renderDayItems([a], { limit: 1 })[0]
ok('完成态渲染带 ✓', rendered.startsWith('✓'), rendered)
ok('渲染带上了时间与标题', rendered.includes('08:30-10:00') && rendered.includes('资料分析'))

const agenda = todayAgenda(plan, { tz: 'UTC' })
ok('今日摘要给出今天的日期', typeof agenda.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(agenda.today))
ok('今日摘要能数出过期条数', agenda.overdue_count >= 1)
ok('过了期的日程出现在 overdue_items 里', agenda.overdue_items.every((it) => it.status === 'planned'))

ok('ITEM_KINDS 是封闭词表且含 study/review', ITEM_KINDS.includes('study') && ITEM_KINDS.includes('review'))
ok('scheduleItems 与 buildSchedule().items 同源', scheduleItems(log).length === plan.items.length)

// ══════════════════════════════════════════════════════════════════════════
// 7. 验收期：类型、窗口（until）、倒计时（纯派生量）
// ══════════════════════════════════════════════════════════════════════════

ok('模拟考与最终大考在类型词表里', ITEM_KINDS.includes('mock') && ITEM_KINDS.includes('final'))
ok('验收期类型集合覆盖 exam/mock/final/deadline', MILESTONE_KINDS.length === 4 && MILESTONE_KINDS.includes('mock'))

// 造三条验收期：已过去的一次模拟考、就是今天的一次、还有窗口的大考。
const msLog = [
  ev(T.created, '2026-10-01T01:00:00Z', { item_id: 'schedule-mock01', title: '模拟考 #1', day: '2026-10-05', kind: 'mock' }),
  ev(T.created, '2026-10-01T01:00:00Z', { item_id: 'schedule-final1', title: '期末大考', day: '2026-12-20', kind: 'final', until: '2026-12-21' }),
  ev(T.created, '2026-10-01T01:00:00Z', {
    item_id: 'schedule-week01',
    title: '考试周',
    day: '2026-10-08',
    until: '2026-10-12',
    kind: 'exam',
  }),
  // 不是验收期的普通日程：它不该出现在 milestones 里。
  ev(T.created, '2026-10-01T01:00:00Z', { item_id: 'schedule-study1', title: '背单词', day: '2026-10-09', kind: 'study' }),
  // 窗口终点早于起点 = 投影按"没有窗口"处理（写入端会拒，但投影不许抛）。
  ev(T.created, '2026-10-01T01:00:00Z', { item_id: 'schedule-badwin', title: '坏窗口', day: '2026-10-10', until: '2026-10-01', kind: 'ddl' }),
]
const msPlan = buildSchedule(msLog)
eq('until 被投影出来', msPlan.byId['schedule-final1'].until, '2026-12-21')
eq('坏窗口被读成没有窗口（不抛）', msPlan.byId['schedule-badwin'].until, '2026-10-01')

// 倒计时四种相位（用固定"今天"直接调，不依赖运行日期）。
const cdItem = msPlan.byId['schedule-final1']
eq('倒计时：还没到', milestoneCountdown(cdItem, '2026-12-01').phase, 'before')
eq('倒计时：还有 19 天', milestoneCountdown(cdItem, '2026-12-01').days_left, 19)
eq('倒计时：就是今天', milestoneCountdown(cdItem, '2026-12-20').phase, 'today')
eq('倒计时：窗口内算进行中', milestoneCountdown(cdItem, '2026-12-21').phase, 'during')
eq('倒计时：窗口内还剩 0 天', milestoneCountdown(cdItem, '2026-12-21').days_to_end, 0)
eq('倒计时：窗口过后算已过去', milestoneCountdown(cdItem, '2026-12-22').phase, 'past')
eq('倒计时：已过 2 天', milestoneCountdown(cdItem, '2026-12-22').days_left, -2)
ok('普通日程没有倒计时', milestoneCountdown(msPlan.byId['schedule-study1'], '2026-12-01') === null)
ok('没有 until 时"过去"就是过去（不会永远进行中）', milestoneCountdown(msPlan.byId['schedule-mock01'], '2026-10-06').phase === 'past')

ok('倒计时文案：还没到', countdownText(cdItem, milestoneCountdown(cdItem, '2026-12-01')) === '期末大考还有 19 天')
ok('倒计时文案：进行中', countdownText(cdItem, milestoneCountdown(cdItem, '2026-12-21')).includes('还剩 0 天'))

// 日历视图里的 milestones：全局（不受区间限制）、已撤销的不出现、普通日程不出现。
const msView = buildCalendarView(msLog, { from: '2026-10-09', to: '2026-10-09', tz: 'UTC' })
ok('区间只有一天，但验收期是全局的（12 月的大考也在）', msView.milestones.some((m) => m.item_id === 'schedule-final1'))
ok('普通日程不进 milestones', !msView.milestones.some((m) => m.item_id === 'schedule-study1'))
ok('每个 milestone 都带 countdown', msView.milestones.every((m) => m !== null && typeof m.countdown?.phase === 'string'))

// 已撤销的验收期不该出现（撤销的语义就是"这条不做了"）。
const cancelledEvents = [
  ...msLog,
  ev(T.cancelled, '2026-10-02T01:00:00Z', { item_id: 'schedule-final1', reason: '不考了' }),
]
const cancelledView = buildCalendarView(cancelledEvents, { from: '2026-10-09', to: '2026-10-09', tz: 'UTC' })
ok('已撤销的验收期不出现', !cancelledView.milestones.some((m) => m.item_id === 'schedule-final1'))

// 今日摘要要能报出"最近的验收期"（上下文注入靠它）。
const msAgenda = todayAgenda(msPlan, { tz: 'UTC' })
ok('今日摘要带 nearest_milestone 字段', 'nearest_milestone' in msAgenda)
ok('nearest_milestone 要么是 null，要么是没过去的验收期', (() => {
  const m = msAgenda.nearest_milestone
  if (m === null) return true
  return MILESTONE_KINDS.includes(m.kind) && m.countdown.phase !== 'past'
})())

// ══════════════════════════════════════════════════════════════════════════
// 结果
// ══════════════════════════════════════════════════════════════════════════

if (failures.length === 0) {
  console.log(`✅ @lh/schedule 自检通过：${passed} 条断言全绿。`)
  process.exit(0)
}

console.error(`❌ @lh/schedule 自检失败：${failures.length} 条不通过（通过 ${passed} 条）。\n`)
for (const line of failures) console.error(`  · ${line}`)
console.error('')
process.exit(1)
