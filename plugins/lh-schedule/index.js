/**
 * lh-schedule —— LH 的**学习日程**（preset 作用域的功能性插件）。
 *
 * ═══ 它做什么 ═══
 * 注册四个模型可调用的工具，让 agent 在对话里维护学习日程：
 *   · `create_schedule`  新建一条日程（哪天的什么时候、学什么、绑哪门课）；
 *   · `list_schedule`    **按日期区间读日程**，并附上"这几天哪些对话真的动过"
 *                        （事实来自 `lh/trace/observed`）与"课程结构什么时候变的"
 *                        （`lh/course/*`）——所以它同时回答"我排了什么"和"我做了什么"；
 *   · `update_schedule`  改期/改名/改备注/标记完成/绑课程/绑当前这段对话；
 *   · `cancel_schedule`  撤销（追加事件，可恢复）。
 * 另外把"今天有哪些日程、哪些过期没做"注入运行时上下文（`lh:agenda`，order 118）。
 *
 * ═══ 日程不是宿主的「自动化任务」═══
 * 宿主自带一套 Schedule 插件（工具名 `schedule_create/list/update/delete`），
 * 那是**会话绑定的定时提醒**（cron/每日/每周，到期以 user 消息投递）。
 * LH 的日程是**学习计划的对象**：有日期、有课程、有"完成"这个事实、可被投影与复盘。
 * 两者刻意不同名、不同族（`lh/schedule/*`）、不同用途：
 *   · 想"到点提醒我" → 用宿主的自动化任务（要用户在插件页启用那个 bundle）；
 *   · 想"我哪天学什么、学了没有" → 用这里的四个工具。
 *
 * ═══ 为什么挂 preset、inject 只要 tools ═══
 * 契约 §六五问之一"它挂在哪一层"：本插件要被模型在对话里调用 → preset（agent 作用域）。
 * 它写事件靠**直接构造** `LhEventStore`（同 lh-recorder-trace / lh-course-tree）——
 * preset 够不着 host 面发布的 root-realm 服务，所以不走 `inject: ['lhEvents']`
 * （那会让 preset 挂载失败）。
 * 读会话 id 靠工具执行上下文 `exec.agent.session.id`，不需要 inject `sessions`。
 *
 * ═══ 本插件的静态导入链只允许 `@lh/event-store/*`（加载安全）═══
 * preset 行按**绝对路径**从源码树加载本文件，而源码树的 `node_modules/@lh/`
 * 下只有根 package.json 声明过的包（实测没有 `@lh/course-tree`）。
 * 任何一条"解析不到"的静态导入都会让**整个 preset 的会话都建不起来**（契约 §〇 形态②）。
 * 所以这里的相对导入全在本包内、跨包只碰事件存储；课程清单由 profile 那一半提供。
 *
 * ═══ 装载期不抛错（契约 §五之二）═══
 * `apply()` 里不解析数据目录、不读事件日志——那些都可能因"没配好"而抛，
 * 而 preset 插件的 apply 抛错会让整棵插件树加载失败、dsh 起不来。
 * 一切读写都留到工具被真正调用的那一刻；上下文注入失败静默降级为"不注入"。
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readEvents } from '@lh/event-store/store'

import { ACTOR_AGENT, applySchedulePatch, cachedSchedule, cancelScheduleItem, createScheduleItem, readSchedule } from './commands.js'
import { KIND_LABELS, WEEKDAY_LABELS, countdownText, weekdayOf } from './schedule.js'
import { buildCalendarView, renderDayItems, todayAgenda } from './calendar.js'

/** 插件名。 */
export const name = 'lh-schedule'

/**
 * 声明依赖。
 *
 * `tools` 是**硬依赖**（没有它这个插件毫无意义）。
 * `systemPrompt` 刻意**不**在这里声明，理由与 `@lh/course-tree` 同：
 * `inject` 的语义是"两个服务都就绪才激活"，把可选的上下文注入写成硬依赖，
 * 会让"拿不到 systemPrompt"变成"整个插件不激活、四个工具一起消失"，而且一声不吭。
 * 所以用 `ctx.inject(['systemPrompt'], …)` 等它的声明，拿不到就只是不注入。
 */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 记一条调试痕迹（与 LH 事件严格分开，同其它插件）。
 * 「插件装载了但没有反应」这类问题，靠它才查得动。
 * @param line - 文本。
 */
function trace(line) {
  try {
    appendFileSync(join(HERE, 'trace.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 记不下来不该让插件崩掉 */
  }
}

/**
 * 从工具执行上下文里取当前会话 id（拿不到返回 null，**不猜**）。
 *
 * 两条取值路径都试：`session.id` 是工具执行上下文里的形状（契约约束 8 实测），
 * `session.header.id` 是宿主 Session 对象自己的形状。
 * 猜错会把"这段对话"绑到别的会话上，而那是静默的。
 *
 * @param exec - 工具执行的第二参数。
 * @returns 会话 id 或 null。
 */
function sessionIdOf(exec) {
  const direct = exec?.agent?.session?.id
  if (typeof direct === 'string' && direct !== '') return direct
  const header = exec?.agent?.session?.header?.id
  return typeof header === 'string' && header !== '' ? header : null
}

/** 可空字符串的 schema 片段（契约 §一.2：可能为 null 的字段必须写 oneOf）。 */
const nullableString = { oneOf: [{ type: 'string' }, { type: 'null' }] }
/** 可空整数的 schema 片段。 */
const nullableInteger = { oneOf: [{ type: 'integer' }, { type: 'null' }] }

/**
 * 日程项的**输出形状**（四个工具共用，所以只写一处）。
 *
 * ⚠ 必须内联到每个工具的 output schema 里（宿主支持的 JSON Schema 关键字是封闭子集，
 * `$ref` 不在其中），所以这里是一个**函数**，每次调用返回一份新的字面量。
 *
 * @returns JSON Schema 片段。
 */
function itemProperties() {
  return {
    item_id: { type: 'string', description: '日程 id（schedule-xxxxxxxx），后续改/撤都用它。' },
    title: { type: 'string' },
    // ⚠ day 必须是**可空**的：写入入口要求日期必填，但投影是"认不出当没有"——
    //   日志里若有一条 day 非法的 created（人手改过、或将来的旧版本写的），
    //   投影出来就是 day:null。schema 若写死 string，宿主会在**运行时**报
    //   `returned invalid output`（契约 §一.2 实测过的那类错）。
    day: { ...nullableString, description: '日期 YYYY-MM-DD；认不出时是 null（说明日志里那条事件的日期不合法）。' },
    until: {
      ...nullableString,
      description: '验收期的最后一天（YYYY-MM-DD）；不是窗口型验收期时是 null。`day` 是起点、它是终点。',
    },
    start: { ...nullableString, description: '开始时间 HH:MM；没排具体时间就是 null。' },
    end: { ...nullableString, description: '结束时间 HH:MM。' },
    kind: {
      type: 'string',
      description:
        '类型：study 学习 / review 复习 / class 上课 / exam 考试 / mock 模拟考 / final 最终大考 / rest 休息 / deadline 截止（DDL）。' +
        '后四个（exam/mock/final/deadline）是**验收期**，会带倒计时。',
    },
    status: { type: 'string', description: 'planned 计划中 / done 已完成 / cancelled 已撤销 / skipped 已跳过。' },
    course_id: { ...nullableString, description: '绑定的课程 node_id；没绑是 null。' },
    session_id: { ...nullableString, description: '绑定的对话 id；没绑是 null。' },
    note: { ...nullableString },
    minutes_planned: { ...nullableInteger, description: '预计时长（分钟）。' },
    minutes_actual: { ...nullableInteger, description: '实际时长（分钟）。' },
  }
}

/** 日程项输出的 `required`（与 `itemProperties` 对齐）。 */
const ITEM_REQUIRED = [
  'item_id',
  'title',
  'day',
  'until',
  'start',
  'end',
  'kind',
  'status',
  'course_id',
  'session_id',
  'note',
  'minutes_planned',
  'minutes_actual',
]

/**
 * 把一条投影出来的日程裁成工具输出形状（去掉 history 之类内部字段）。
 * @param item - 投影结果里的一条。
 * @returns 可序列化的对象。
 */
function itemOut(item) {
  return {
    item_id: item.item_id,
    title: item.title,
    day: item.day,
    until: item.until ?? null,
    start: item.start ?? null,
    end: item.end ?? null,
    kind: item.kind,
    status: item.status,
    course_id: item.course_id ?? null,
    session_id: item.session_id ?? null,
    note: item.note ?? null,
    minutes_planned: item.minutes_planned ?? null,
    minutes_actual: item.minutes_actual ?? null,
  }
}

/** 一条日程的单行文本（工具的 render 用；与日历的渲染共用口径）。 */
function itemLine(item) {
  return renderDayItems([item], { limit: 1 })[0]
}

/** 插件体。 */
export function apply(ctx) {
  trace('APPLY_CALLED')
  ctx.on('dispose', () => trace('DISPOSED'))

  // ── 工具 1：新建日程 ──
  ctx.tools.register({
    name: 'create_schedule',
    description:
      '新建一条**学习日程**（我打算哪天、什么时候学什么），或者建一个**验收期**。' +
      '\n\n和宿主的「自动化任务」不是一回事：这里是**计划的对象**（有日期、可绑课程与对话、可标记完成、可复盘），' +
      '不是"到点弹一条提醒"。' +
      '\n\n**验收期**就是一条日程，只是 `kind` 取 exam（考试）/ mock（模拟考）/ final（最终大考）/ deadline（截止，DDL）——' +
      '它会自动带**倒计时**（显示在日历下端，也会进你的运行时上下文），所以"离大考还有几天"你随时答得出。' +
      '验收期是窗口时（如"考试周 11-01 到 11-07"）用 `until` 给终点；是一次性事件（如"11-01 模拟考"）就不要给。' +
      '验收期几乎总该绑课程（`course_id`）——"哪门课的验收"是它的主要信息。' +
      '\n\n日期尽量给绝对日期 `YYYY-MM-DD`；`today`/`tomorrow` 这类相对写法也收，但它按进程时区折算。' +
      '\n\n**省略日期 = 进「待办区」**（想做、但还没定日子）。日程很可能是你替学习者安排的，他可能没细看、' +
      '或被打断——所以"先记下来、日子以后再说"是一个**正当状态**，不该硬塞一个假日期（那会让日历上多出一条假的）。' +
      '待办不占任何一天，只出现在待办区；在那里（或让模型调 `update_schedule`）可以给它定日子、也可以撤掉。' +
      '\n\n什么时候该建：学习者说"明天上午做两篇资料分析""考前一周每天一套模考""11 月 1 日模拟考"这类**安排**时。' +
      '只是随口提到的意愿（"有空看看"）不必建日程——建了会变成噪音，而噪音会让真正重要的那条也看不见。' +
      '但如果那确实是一件"要做、只是还没定日子"的事，就用**省略日期的待办**，而不是不记。' +
      '\n\n建完之后如果要把它绑到**当前这段对话**，用 `update_schedule` 的 `session_id: "current"`；' +
      '绑到某门课用 `course_id`（课程的 node_id，用 `list_courses` 取）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', description: '学什么（如"资料分析 · 速算专项"）；验收期就写它的名字（如"模拟考（行测）"）。' },
        day: {
          type: 'string',
          description:
            "日期：'YYYY-MM-DD'，或 today / tomorrow / yesterday。" +
            '**省略或给空字符串 = 不定日期**：它不进日历，而是进「待办区」。',
        },
        until: {
          type: 'string',
          description:
            "验收期的**最后一天**（'YYYY-MM-DD'）。只有当验收期是一个窗口时才给（如考试周的最后一天）；" +
            '一次性的模拟考/考试不要给。给了它，倒计时在窗口内会显示"进行中，还剩 N 天"。',
        },
        start: { type: 'string', description: "开始时间 'HH:MM'（24 小时制）。没定具体时间就省略。" },
        end: { type: 'string', description: "结束时间 'HH:MM'。写了 start 才谈得上 end。" },
        kind: {
          type: 'string',
          enum: ['study', 'review', 'class', 'exam', 'mock', 'final', 'rest', 'deadline'],
          description:
            'study 学习 / review 复习 / class 上课 / rest 休息（以上是日常安排）；' +
            'exam 考试 / mock 模拟考 / final 最终大考 / deadline 截止（以上是**验收期**，带倒计时）。默认 study。',
        },
        minutes: { type: 'integer', description: '预计时长（分钟），最多 1440。' },
        course_id: { type: 'string', description: '绑到哪门课：课程的 node_id（如 course-b6623731）。用 list_courses 取。' },
        note: { type: 'string', description: '备注：这次具体要做什么（如"只做速算，不做综合题"）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['created', 'item', 'events'],
        properties: {
          created: { type: 'boolean', description: '是否真的写了一条 lh/schedule/created。' },
          item: {
            type: 'object',
            additionalProperties: false,
            required: ITEM_REQUIRED,
            properties: itemProperties(),
          },
          events: { type: 'array', items: { type: 'string' }, description: '这次写了哪些日程事件。' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.created
            ? `已建日程：${value.item.day}（${WEEKDAY_LABELS[weekdayOf(value.item.day)] ?? '?'}）${itemLine(value.item)}\nitem_id: ${value.item.item_id}`
            : '没有写任何东西（create_schedule 没有产生事件）。',
        },
      ],
    },
    execute(args) {
      trace(`CREATE_SCHEDULE  day=${args?.day ?? ''} title=${args?.title ?? ''}`)
      // 建 → 立刻投影 → 回读：让返回值就是**日志里的那条**（含解析后的日期），
      // 而不是"调用方以为写进去的东西"。相对日期（today 等）的解析结果必须回显给模型。
      const created = createScheduleItem({
        title: args?.title,
        day: args?.day,
        until: args?.until ?? null,
        start: args?.start ?? null,
        end: args?.end ?? null,
        kind: args?.kind ?? 'study',
        note: args?.note ?? null,
        courseId: args?.course_id ?? null,
        minutes: args?.minutes ?? null,
        source: 'agent',
        actor: ACTOR_AGENT,
      })
      const plan = readSchedule()
      const item = plan.byId[created.item_id]
      return Promise.resolve({ created: true, item: itemOut(item), events: ['lh/schedule/created'] })
    },
  })

  // ── 工具 2：按日期读日程（同时读"事实"）──
  //
  // ═══ 为什么"读日程"要顺带把对话活动带出来 ═══
  // 只回日程的话，模型能回答"你排了什么"，回答不了"你做了没有、哪几天真的学了"。
  // 而后者才是有用的那个问题（也是复盘与调计划的前提）。
  // 数据早就在日志里（`lh/trace/observed` 一直在写），只是此前没有按日期读它的入口。
  ctx.tools.register({
    name: 'list_schedule',
    description:
      '**按日期区间读日程**：计划（日程项）+ 事实（这几天哪些对话有过学习活动）+ 课程动作（建课/绑会话）。' +
      '\n\n用它回答："今天/这周/这周之后有什么安排"、"上周我到底学了没有"、"这门课排了几次"、' +
      '"为什么这几天一条日程都没有"。' +
      '\n\n`from`/`to` 都省略 = 本月；只给 `from` = 从那天起两周。区间最多 62 天（超了会截断并如实标注）。' +
      '`overdue` 是"计划日已过、仍是 planned"的日程——回答"欠了什么"要用它，而不是自己按日期比。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        from: { type: 'string', description: "起始日期 'YYYY-MM-DD'（含）。省略=本月 1 号。" },
        to: { type: 'string', description: "结束日期 'YYYY-MM-DD'（含）。省略=from 之后 13 天。" },
        month: { type: 'string', description: "也可以直接给月份 'YYYY-MM'（给了它就忽略 from/to 的省略逻辑）。" },
        course_id: { type: 'string', description: '只看绑到这门课的日程（其它日程不列，但事实与课程动作照常）。' },
        status: {
          type: 'string',
          enum: ['planned', 'done', 'cancelled', 'skipped', 'all'],
          description: '只看某种状态，默认 all（全都要）。',
        },
        with_activity: { type: 'boolean', description: '是否附上"这几天哪些对话动过"（默认 true）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'from',
          'to',
          'today',
          'tz',
          'days',
          'milestones',
          'backlog',
          'overdue',
          'summary',
          'truncated',
          'notes',
        ],
        properties: {
          from: nullableString,
          to: nullableString,
          today: nullableString,          tz: { type: 'string' },
          tz_fallback: { type: 'boolean', description: 'true = 时区认不出，已按 UTC 折算（分组可能差一天）。' },
          truncated: { type: 'boolean', description: 'true = 区间超过 62 天被截断。' },
          days: {
            type: 'array',
            description: '按日期铺开。没有日程也没有活动的那天也会出现（**空也是一种数据**）。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['day', 'weekday', 'items', 'sessions', 'course_events'],
              properties: {
                day: { type: 'string' },
                weekday: { type: 'integer', description: '0=周日 … 6=周六。' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: [...ITEM_REQUIRED, 'appearances'],
                    properties: {
                      ...itemProperties(),
                      appearances: {
                        type: 'array',
                        items: { type: 'string' },
                        description: "这条日程为什么出现在这天：planned（排在这天）/ done（这天做完）/ cancelled（这天撤销）。",
                      },
                    },
                  },
                },
                sessions: {
                  type: 'array',
                  description: '这天有活动痕迹的对话（来自 lh/trace/observed）。',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['session_id', 'events', 'first_at', 'last_at'],
                    properties: {
                      session_id: { type: 'string' },
                      events: { type: 'integer', description: '这天发生的语义事件条数（不等于学习时长，是"动过多少下"）。' },
                      first_at: nullableString,
                      last_at: nullableString,
                    },
                  },
                },
                course_events: {
                  type: 'array',
                  description: '这天的课程结构动作（建课/改名/绑会话/删课）。',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type', 'node_id', 'title', 'session_id', 'at'],
                    properties: {
                      type: { type: 'string' },
                      node_id: nullableString,
                      title: nullableString,
                      session_id: nullableString,
                      at: nullableString,
                    },
                  },
                },
              },
            },
          },
          milestones: {
            type: 'array',
            description:
              '**验收期**（考试 / 模拟考 / 最终大考 / 截止）与它们到今天的倒计时，**全局**（不只本区间）——' +
              '回答"离大考还有几天""这学期有几次验收"用它。已撤销的不出现；未完成的排在前（按日期升序）。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [...ITEM_REQUIRED, 'countdown'],
              properties: {
                ...itemProperties(),
                countdown: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['phase', 'days_left', 'days_to_end'],
                  properties: {
                    phase: {
                      type: 'string',
                      description: 'before 还没到 / today 就是今天 / during 窗口进行中 / past 已经过去。',
                    },
                    days_left: { type: 'integer', description: '今天到 `day` 的天数（负数 = 已过）。' },
                    days_to_end: { ...nullableInteger, description: '落在窗口内时，今天到 `until` 还剩几天。' },
                  },
                },
              },
            },
          },
          backlog: {
            type: 'array',
            description:
              '**待办**：无日期、还没做的日程（"想做但没定日子" / "无限期推迟"的落点）。' +
              '它们不占任何一天，所以既不在 `days` 里、也不算 `overdue`——不单独列出来就永远看不见。' +
              '回答"我还有什么没安排"、"有没有被我搁下的计划"用它；在待办区里可以给它们定日子或撤掉。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ITEM_REQUIRED,
              properties: itemProperties(),
            },
          },
          overdue: {
            type: 'array',
            description: '计划日已过、仍是 planned 的日程（"欠了什么"）。',            items: {
              type: 'object',
              additionalProperties: false,
              required: ITEM_REQUIRED,
              properties: itemProperties(),
            },
          },
          summary: {
            type: 'object',
            additionalProperties: false,
            required: ['planned', 'done', 'cancelled', 'overdue', 'active_days', 'session_count'],
            properties: {
              planned: { type: 'integer' },
              done: { type: 'integer' },
              cancelled: { type: 'integer' },
              overdue: { type: 'integer', description: '**全局**欠账条数（计划日已过、仍是 planned；不只本区间）。' },
              active_days: { type: 'integer', description: '区间内有学习活动的天数。' },
              session_count: { type: 'integer', description: '区间内动过的对话数（去重）。' },
            },
          },
          notes: { type: 'array', items: { type: 'string' }, description: '截断/时区回退这类要如实说的事。' },
        },
      },
      render: (args, value) => {
        if (value.from === null || value.to === null) {
          return [{ type: 'text', text: '算不出日期（宿主时钟或时区不可用）。' }]
        }
        const lines = [
          `日程 ${value.from} ~ ${value.to}（今天 ${value.today}，时区 ${value.tz}）：` +
            `计划 ${value.summary.planned} 条 · 完成 ${value.summary.done} 条 · 有活动的日子 ${value.summary.active_days} 天 · 动过的对话 ${value.summary.session_count} 段`,
        ]
        const active = value.days.filter(
          (d) => d.items.length > 0 || d.sessions.length > 0 || d.course_events.length > 0,
        )
        if (active.length === 0) {
          lines.push('', '这段时间既没有日程，也没有任何学习活动记录。')
        } else {
          // 只铺有内容的日子：空日子在文本里是噪声（但结构化输出里保留，见 days 的说明）。
          for (const day of active) {
            const head = `${day.day}（${WEEKDAY_LABELS[day.weekday] ?? '?'}）`
            const marks = []
            if (day.items.length > 0) marks.push(`日程 ${day.items.length}`)
            if (day.sessions.length > 0) marks.push(`对话 ${day.sessions.length}`)
            if (day.course_events.length > 0) marks.push(`课程动作 ${day.course_events.length}`)
            lines.push('', `${head}  ${marks.join(' · ')}`)
            for (const line of renderDayItems(day.items, { limit: 6, emptyText: '' })) {
              if (line !== '') lines.push(`  ${line}`)
            }
            for (const s of day.sessions.slice(0, 4)) {
              lines.push(`  ○ 对话 ${String(s.session_id).slice(-6)}（${s.events} 条事件）`)
            }
            if (day.sessions.length > 4) lines.push(`  ○ …还有 ${day.sessions.length - 4} 段对话`)
          }
        }
        // 验收期放在最前面说：它是排其他一切计划的前提（"离大考还有几天"决定这周该排多密）。
        if (value.milestones.length > 0) {
          lines.push('', `**验收期（${value.milestones.length} 个，倒计时见下）**：`)
          for (const m of value.milestones) {
            const kind = KIND_LABELS[m.kind] ?? m.kind
            const span = m.until === null ? m.day : `${m.day}~${m.until}`
            const course = m.course_id === null ? '' : `　课程 ${m.course_id}`
            const done = m.status === 'done' ? '（已完成）' : m.status === 'skipped' ? '（已跳过）' : ''
            lines.push(`  ${span}　${kind}　${countdownText(m, m.countdown)}${course}${done}`)
          }
        }
        if (value.backlog.length > 0) {
          lines.push('', `**待办（无日期，${value.backlog.length} 条）**——它们不占任何一天，等着被安排或撤掉：`)
          for (const item of value.backlog.slice(0, 8)) lines.push(`  ${itemLine(item)}`)
          if (value.backlog.length > 8) lines.push(`  …还有 ${value.backlog.length - 8} 条`)
        }
        if (value.overdue.length > 0) {
          lines.push('', `**过期未完成（${value.summary.overdue} 条）**——要顺延、要做、还是撤掉，问学习者：`)
          for (const item of value.overdue.slice(0, 8)) lines.push(`  ${item.day} ${itemLine(item)}`)
        }
        for (const note of value.notes ?? []) lines.push('', `注意：${note}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args) {
      const events = readEvents()
      // 全量投影单独读一次：`overdue` 要说的是"**总共**欠了多少"，
      // 而区间视图里的 items 只有落在区间内那些——用它算 overdue，
      // 上个月欠下的日程就会凭空消失（那是"欠债看起来自己还了"的假象）。
      const plan = readSchedule()
      const view = buildCalendarView(events, {
        from: args?.from ?? null,
        to: args?.to ?? null,
        month: args?.month ?? null,
        // 时区：工具这一侧没有浏览器上下文，交给进程时区（`null` → UTC 且会如实标注）。
        tz: null,
        courses: [],
        includeActivity: args?.with_activity !== false,
      })

      const status = String(args?.status ?? 'all').trim() || 'all'
      const courseId = typeof args?.course_id === 'string' && args.course_id.trim() !== '' ? args.course_id.trim() : null
      const keep = (item) => {
        if (courseId !== null && item.course_id !== courseId) return false
        if (status !== 'all' && item.status !== status) return false
        return true
      }

      const today = view.today
      const days = view.days.map((day) => ({
        day: day.day,
        weekday: day.weekday,
        items: day.items.filter(keep).map((item) => ({
          ...itemOut(item),
          appearances: Array.isArray(item.appearances) ? item.appearances : [],
        })),
        sessions: day.sessions.map((s) => ({
          session_id: s.session_id,
          events: s.events,
          first_at: s.first_at ?? null,
          last_at: s.last_at ?? null,
        })),
        course_events: day.course_events.map((c) => ({
          type: c.type,
          node_id: c.node_id ?? null,
          title: c.title ?? null,
          session_id: c.session_id ?? null,
          at: c.at ?? null,
        })),
      }))

      // 过期与待办都**从视图取**（口径只有一处：`buildCalendarView` 里那份清单）。
      // 早先这里自己 filter 了一遍 `plan.items`——那等于同一件事两处实现，
      // 而"数"与"清单"一旦分叉，人只会相信其中一个。
      const overdue = view.overdue.filter(keep).map(itemOut)

      // 待办：无日期、还没做（"无限期推迟"的落点）。它**不占任何一天**，
      // 所以它既不在 days 里、也不算 overdue——不单独列出来，模型就永远看不见它。
      const backlog = view.backlog.filter(keep).map(itemOut)

      // 验收期：**全局 + 带倒计时**（同 overdue 的理由——12 月的大考在 3 月的查询里也必须在）。
      // `countdown` 是派生量，所以它不是事件、只是这一次读出来的东西。
      const milestones = view.milestones.map((m) => ({
        ...itemOut(m),
        countdown: {
          phase: m.countdown.phase,
          days_left: m.countdown.days_left,
          days_to_end: m.countdown.days_to_end ?? null,
        },
      }))

      trace(`LIST_SCHEDULE  ${view.from}~${view.to}  items=${view.summary.item_count} overdue=${overdue.length}`)
      return Promise.resolve({
        from: view.from,
        to: view.to,
        today,
        tz: view.tz,
        tz_fallback: view.tz_fallback,
        truncated: view.truncated,
        days,
        milestones,
        backlog,
        overdue,
        summary: {
          planned: view.summary.planned,
          done: view.summary.done,
          cancelled: view.summary.cancelled,
          overdue: overdue.length,
          active_days: view.summary.active_days,
          session_count: view.summary.session_count,
        },
        notes: view.notes,
      })
    },
  })

  // ── 工具 3：改一条日程 ──
  ctx.tools.register({
    name: 'update_schedule',
    description:
      '改一条已有日程：改期、改名、改类型/备注/时长、改验收期窗口、**标记完成**、绑课程或绑当前这段对话。' +
      '\n\n`item` 用 item_id（schedule-xxxxxxxx）或标题（能唯一匹配时）。' +
      '\n\n语义要点：' +
      '\n· 只给要改的字段，没给的**一律不动**；把某字段写成空字符串 `""` = **清空**它（如解绑课程、去掉验收期窗口）。' +
      '\n· `kind` 改成 exam/mock/final/deadline 就把它变成**验收期**（自动带倒计时）；改回 study 就不再是。' +
      '\n· `day: ""` = **无限期推迟**（把它从日历上拿下来、放进待办区，不是取消）：' +
      '日程很可能是你替学习者安排的，他可能没细看或被打断——所以"这条我还没想好什么时候做"必须能被表达，' +
      '而不是只能"约个假日期"或"撤掉"。' +
      '\n· `status: "done"` = 记一条**完成事实**（`lh/schedule/done`，带完成时刻）；' +
      '`status: "planned"` 能把撤销/跳过的日程改回计划中（撤销不是删除）。' +
      '\n· `session_id: "current"` = 绑到**当前这段对话**（"这条日程就是在这次对话里进行的"）。' +
      '\n· 撤销用 `cancel_schedule`，不要用 status 去凑——撤销要记原因。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['item'],
      properties: {
        item: { type: 'string', description: '要改哪条：item_id 或唯一匹配的标题。' },
        title: { type: 'string' },
        day: {
          type: 'string',
          description:
            "新日期：'YYYY-MM-DD' 或 today/tomorrow（顺延一天用 tomorrow 更好说）。" +
            '**给空字符串 = 无限期推迟**：日期被清掉，这条进「待办区」置顶等你再安排（不占日历上任何一天）。',
        },
        until: { type: 'string', description: "验收期的最后一天 'YYYY-MM-DD'；空字符串 = 去掉窗口（变回一次性事件）。" },
        start: { type: 'string', description: "新开始时间 'HH:MM'；给空字符串清掉时间。" },
        end: { type: 'string', description: "新结束时间 'HH:MM'；给空字符串清掉。" },
        kind: {
          type: 'string',
          enum: ['study', 'review', 'class', 'exam', 'mock', 'final', 'rest', 'deadline'],
          description:
            'exam/mock/final/deadline 是**验收期**（带倒计时）；study/review/class/rest 是日常安排。',
        },
        note: { type: 'string', description: '备注；空字符串 = 清掉备注。' },
        minutes_planned: { type: 'integer', description: '预计时长（分钟）。' },
        minutes_actual: { type: 'integer', description: '实际时长（分钟），常与 status:"done" 一起给。' },
        status: {
          type: 'string',
          enum: ['planned', 'done', 'skipped'],
          description: 'done = 标记已完成（写完成事实）；planned = 改回计划中（含恢复已撤销的）；skipped = 跳过（这次不做了，但计划还在）。',
        },
        course_id: { type: 'string', description: '绑到某门课的 node_id；空字符串 = 解绑。' },
        session_id: { type: 'string', description: "绑到某段对话：会话 id，或 'current' 表示当前这段对话；空字符串 = 解绑。" },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['changed', 'item', 'events'],
        properties: {
          changed: { type: 'array', items: { type: 'string' }, description: '真的改了的字段。空数组 = 一个字都没写。' },
          item: {
            type: 'object',
            additionalProperties: false,
            required: ITEM_REQUIRED,
            properties: itemProperties(),
          },
          events: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.changed.length === 0) {
          return [{ type: 'text', text: `没有改动（${value.item.title} 的这些字段本来就是你要的值）。` }]
        }
        return [
          {
            type: 'text',
            text:
              `已更新日程 ${itemLine(value.item)}\n` +
              `改了：${value.changed.join('、')}（写了 ${value.events.join('、')}）\n` +
              `item_id: ${value.item.item_id}`,
          },
        ]
      },
    },
    execute(args, exec) {
      // `session_id: "current"` 的翻译只在这一处发生——写进日志的永远是**真会话 id**
      // （`current` 这种相对说法一旦进日志就没法重放了）。
      let sessionPatch
      const rawSession = args?.session_id
      if (typeof rawSession === 'string' && rawSession.trim().toLowerCase() === 'current') {
        const sid = sessionIdOf(exec)
        if (sid === null) {
          throw new Error('拿不到当前会话身份，没法把日程绑到"当前这段对话"。请直接给会话 id，或稍后在界面里绑。')
        }
        sessionPatch = sid
      } else if (rawSession !== undefined) {
        sessionPatch = rawSession
      }

      const patch = {}
      for (const key of [
        'title',
        'day',
        'until',
        'kind',
        'start',
        'end',
        'note',
        'minutes_planned',
        'minutes_actual',
        'status',
        'course_id',
      ]) {
        if (Object.prototype.hasOwnProperty.call(args ?? {}, key)) patch[key] = args[key]
      }
      if (sessionPatch !== undefined) patch.session_id = sessionPatch

      trace(`UPDATE_SCHEDULE  item=${args?.item ?? ''} fields=${Object.keys(patch).join(',')}`)
      const result = applySchedulePatch({ itemRef: args?.item, patch, actor: ACTOR_AGENT })
      return Promise.resolve({ changed: result.changed, item: itemOut(result.item), events: result.events })
    },
  })

  // ── 工具 4：撤销一条日程 ──
  //
  // ═══ 为什么撤销不需要两段式确认 ═══
  // 契约的白名单纪律（项目规则 4）针对的是**不可逆**的破坏性操作（删课会连带子孙）。
  // 撤销是追加一条 `lh/schedule/cancelled`：日程仍在日志里、仍在日历上（标成已撤销），
  // 也能用 `update_schedule` 改回 planned。所以这里不做"先看影响面再确认"那一套——
  // 加了只会让模型多绕一圈，而它挡不住任何真实损失。
  // **要求给原因**才是这里真正该坚持的事：那是事后补不出来的信息。
  ctx.tools.register({
    name: 'cancel_schedule',
    description:
      '撤销一条日程（追加事件，**不是删除**：它仍在日历上标成"已撤销"，可以再用 update_schedule 改回 planned）。' +
      '\n\n请尽量给 `reason`——"为什么这次没做成"（时间没排开 / 内容太难 / 计划本身不合理 / 临时有事）' +
      '是学习诊断里信息量最大的一类数据，而它只在**撤销的这一刻**知道，事后补不出来。' +
      '\n\n如果只是"这次跳过了、计划还在"，用 `update_schedule` 的 `status: "skipped"`；' +
      '如果是"要顺延到别的时间"，用 `update_schedule` 改 `day`。撤销的语义是"这条计划不做了"。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['item'],
      properties: {
        item: { type: 'string', description: '要撤销哪条：item_id 或唯一匹配的标题。' },
        reason: { type: 'string', description: '为什么撤销（可空，但强烈建议给）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['cancelled', 'already', 'item', 'reason'],
        properties: {
          cancelled: { type: 'boolean', description: '这次调用有没有真的写一条撤销事件。' },
          already: { type: 'boolean', description: 'true = 它本来就是撤销态，没有再写第二条（避免"撤销了几次"统计失真）。' },
          item: {
            type: 'object',
            additionalProperties: false,
            required: ITEM_REQUIRED,
            properties: itemProperties(),
          },
          reason: nullableString,
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.already
            ? `这条日程本来就是撤销态，没有再写事件：${itemLine(value.item)}`
            : `已撤销日程：${itemLine(value.item)}${value.reason === null ? '' : `\n原因：${value.reason}`}\n` +
              '（它仍在日志与日历里，标为已撤销；要恢复就用 update_schedule 把 status 改回 planned。）',
        },
      ],
    },
    execute(args) {
      trace(`CANCEL_SCHEDULE  item=${args?.item ?? ''}`)
      const result = cancelScheduleItem({ itemRef: args?.item, reason: args?.reason ?? null, actor: ACTOR_AGENT })
      return Promise.resolve({
        cancelled: !result.already,
        already: result.already === true,
        item: itemOut(result.item),
        reason: result.reason ?? null,
      })
    },
  })

  // ── 把"今天有哪些日程"写进运行时上下文 ──
  //
  // ═══ 为什么放在这里、而不是塞进每个工具的描述 ═══
  // 本项目实测过：写在工具描述里的规则会被忽略两轮（规则写在了读不到的地方）。
  // 运行时上下文是**每次组装都会出现的位置**，所以"今天是哪天、今天排了什么、
  // 欠了什么"只有放这里才真的进了模型眼前的输入——而不知道今天是哪天，
  // 模型就没法把"明天下午"翻译成一个日期。
  //
  // ═══ 为什么 order 取 118 ═══
  // 宿主把档位可用性放在 116（lh-model-tier），课程归属在 117（lh-course-tree）。
  // 日程排在它们之后：它是**最具体的一层**（"今天要做什么"），
  // 而具体的东西放在最后，模型更容易把它当成本轮的行动依据。
  //
  // ═══ 失败一律静默为"不注入" ═══
  // 数据目录没配好、日志坏了、算不出今天——这些都不该让整轮模型调用崩掉。
  // 看不到日程是**降级**；把调用弄崩是**故障**，两者代价不对等。
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'lh:agenda',
      order: 118,
      text: () => {
        try {
          const { plan } = cachedAgenda()
          if (plan === null) return ''
          const agenda = todayAgenda(plan, { tz: null, limit: 6, overdueLimit: 3 })
          if (agenda.today === null) return ''

          const lines = [
            `今天是 ${agenda.today}（${WEEKDAY_LABELS[agenda.weekday] ?? '?'}）。`,
          ]
          // 倒计时紧跟日期：它决定"这周该排多密"，是排计划时第一个要看的东西。
          if (agenda.nearest_milestone !== null) {
            const m = agenda.nearest_milestone
            const kind = KIND_LABELS[m.kind] ?? m.kind
            const course = m.course_id === null ? '' : `（课程 ${m.course_id}）`
            lines.push(
              `最近的验收期：${countdownText(m, m.countdown)}${course}　[${m.day}${m.until === null ? '' : `~${m.until}`} ${kind}]` +
                (agenda.milestone_count > 1 ? `；另有 ${agenda.milestone_count - 1} 个在后面（用 list_schedule 看全部）` : ''),
            )
          }
          if (agenda.today_count === 0) {
            lines.push('今天没有排日程。')
          } else {
            lines.push(`今天的日程（${agenda.today_count} 条）：`)
            for (const item of agenda.today_items) {
              lines.push(`  ${itemLine(item)}${item.course_id === null ? '' : `　课程 ${item.course_id}`}`)
            }
            if (agenda.today_count > agenda.today_items.length) {
              lines.push(`  …还有 ${agenda.today_count - agenda.today_items.length} 条`)
            }
          }
          if (agenda.overdue_count > 0) {
            lines.push(`过期未完成 ${agenda.overdue_count} 条（最近几条）：`)
            for (const item of agenda.overdue_items) lines.push(`  ${itemLine(item)}`)
            lines.push('这些要么顺延、要么撤掉，先问学习者怎么处理，别自己决定。')
          }
          if (agenda.backlog_count > 0) {
            lines.push(`待办（无日期）${agenda.backlog_count} 条：`)
            for (const item of agenda.backlog_items) lines.push(`  ${itemLine(item)}`)
            lines.push('这些还没定日子——要安排到哪天、还是撤掉，问学习者。别因为它们不占日历就当没这回事。')
          }
          lines.push(
            '（日程用 create_schedule / list_schedule / update_schedule / cancel_schedule 维护；' +
              '日期用 YYYY-MM-DD。标记完成用 update_schedule 的 status:"done"，撤销用 cancel_schedule。）',
          )
          return lines.join('\n')
        } catch (error) {
          trace(`CONTEXT_TEXT_FAILED  ${error?.message ?? error}`)
          return ''
        }
      },
    })
    trace('CONTEXT_REGISTERED  name=lh:agenda  order=118')
  })

  trace('APPLY_DONE')
}

/**
 * 上下文注入专用的投影读取：带缓存地拿一次投影，**读失败返回 null**。
 *
 * 缓存由 `commands.js` 的 `cachedSchedule` 提供（按日志 mtime+size 失效）。
 * 这里只把"读失败"压成 null，让注入那一段的 try/catch 更短——
 * 注入失败是**降级**（模型看不到今天有什么），不是故障。
 *
 * @returns `{ plan }`；读失败时 plan 为 null。
 */
function cachedAgenda() {
  try {
    return cachedSchedule()
  } catch {
    return { plan: null, logPath: null }
  }
}
