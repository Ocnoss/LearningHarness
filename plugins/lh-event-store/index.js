/**
 * lh-event-store —— LH 自己的事件日志（第一个内核级插件）。
 *
 * ─── 为什么 LH 必须自持事件日志 ───
 * 宿主 dsh 已有 append-only 会话日志，但它的词汇表对外部插件是封闭的：
 * Session.append 构造事件时只保留 sourceEventSeqs / surfaceOp，会丢掉 ignorable 标记，
 * 而持久化层重载时拒绝"未知类型且未标 ignorable"的事件
 * （dsh-session-persistence/lib/index.js:1119）。也就是说，往宿主日志里写 LH 事件，
 * 会让那个会话下次重载时打不开。
 * 这直接印证 docs/archive/decisions/011 的决定 2：LH 事件信封自持，dsh 会话事件只作 L1 来源。
 *
 * ─── 本插件的职责 ───
 *   1. 装载 LH 的事件存储服务（`ctx.lhEvents`，实现在 store.js），供其它 LH 插件写入；
 *   2. 把 LH 的事件计数投影给宿主界面（用宿主现成的投影机制，不自造一条）。
 *
 * **它自己不写任何事件。** 事件由记录器插件写——
 * 因为"什么值得记"是判断，而判断归插件（契约 §1.4）。
 *
 * ─── 三条已定的决策（详见 decisions/012）───
 * A. 物理形态 = 工作区下的 JSONL 文件（一行一条，append-only）。
 * B. 信封先只落能填满的字段；content_ref 与 session_ref 暂留 null。
 * C. scope 暂取常量 'root'（课程树还不存在）。
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  eventLogPath,
  LhEventStore,
  countByType,
  readEvents,
  SCHEMA_VERSION,
} from './store.js'

/** 插件名，加载器诊断与日志里显示的就是它。 */
export const name = 'lh-event-store'

/** 声明依赖的宿主服务：加载器等到服务可用后再调用 apply()。 */
export const inject = ['sessions']

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 记一条调试痕迹到插件同目录。
 *
 * 注意：这是开发期脚手架，**不是 LH 事件**——两者的去向必须分开。
 * 事件日志是唯一事实源，调试噪声一旦进去，投影与重放都要额外过滤，
 * 而且"能不能进日志"本身就是判断，判断属于记录器插件，不属于脚手架。
 * （这条原则落地时我犯过一次错：最早我把"插件已激活"当成第一条事件写进了日志，
 *   于是每次挂载都堆一条同一句话。见本文件下方 apply 的注释。）
 *
 * @param line - 要记录的文本。
 */
function trace(line) {
  try {
    appendFileSync(join(HERE, 'trace.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 记不下来不该让插件崩掉 */
  }
}

/** 投影单元的状态：各类型事件的计数。纯 JSON，投影缓存才能持久化它。 */
const eventCountsSchema = z.record(z.string(), z.number().int().min(0))

/**
 * 注册前自检：schema 必须同时具备 parse() 与 safeParse()。
 *
 * 宿主读投影快照时调用 `wire.viewSchema.parse(...)`。一个"看起来像 schema"
 * 但没有 parse 的对象会让该会话的**历史加载**失败，且错误发生在读取期、远离注册处。
 * 这个自检把失败提前到注册处。
 *
 * @param label - 出错时指明是哪个 schema。
 * @param schema - 待检查的 schema。
 * @throws 当 schema 不合格时。
 */
function assertSchemaUsable(label, schema) {
  const hasParse = typeof schema?.parse === 'function'
  const hasSafeParse = typeof schema?.safeParse === 'function'
  if (!hasParse || !hasSafeParse) {
    throw new Error(
      `lh-event-store: ${label} 不是可用的 schema（parse=${hasParse} safeParse=${hasSafeParse}）。`,
    )
  }
}

/**
 * 插件体。
 *
 * @param ctx - 插件上下文；注册的一切随插件卸载自动撤销。
 * @param _config - 来自 agent.cordis.yml 那一行的 config 字段（本插件目前不用）。
 */
export function apply(ctx, _config) {
  trace('APPLY_CALLED')

  // 生命周期钩子：验证"改代码是否触发重载"。
  // 宿主 web profile 默认关掉服务端 HMR，我们把它打开了（见 profiles/web/cordis.patch.yml），
  // 打开之后必须能**证明**重载真的发生——否则无法区分"代码没生效"与"重载没发生"。
  ctx.on('dispose', () => trace('DISPOSED（插件被卸载，通常意味着重载）'))

  // ── 一、装载 LH 的事件存储服务 ──
  // 用宿主的插件系统装载 LH 自己的服务：提供出去之后，其它 LH 插件通过
  // `ctx.lhEvents` 写入事件，而不必自己拼信封、自己碰文件。
  //
  // **服务本身是惰性的**：LhEventStore 的方法在每次调用时才解析路径，
  // 所以"能不能装载"与"数据目录在不在"是两件事。这一点很关键，见下面自检的注释。
  ctx.plugin(LhEventStore)

  // 只做一次可用性自检，结果记入 trace —— 不往事件日志里写。
  //
  // 上一版在这里写了一条 `lh/plugin/activated` 事件作为"存储能用"的自证，那是错的：
  //   1. 它每挂载一次就写一条，日志里堆满同一句话（实测出现过两条重复）；
  //   2. 它是开发期脚手架，不是学习事件——违反 decisions/012 决策 4
  //      "调试痕迹与 LH 事件严格分开"；
  //   3. 它把"插件是否被加载"这个开发者问题，塞进了用户的学习史里。
  //
  // ═══ 自检失败时为什么**不再抛错**（2026-09-18 改）═══
  // 原来这里 `throw`，理由是"存储不可用是系统级故障，必须显式暴露"。
  // 理由本身没错，但**位置**错了：这是 profile 插件，`apply()` 抛错会让
  // **整棵插件树加载失败 → dsh 完全起不来**。学习者看到的是一个加载失败的界面，
  // 而"该设哪个环境变量/该有哪个配置文件"这句话，恰恰在他最需要的时候看不到。
  //
  // 更糟的是：这个 throw 曾经被一份**陈旧副本**挡住了很久——profile 里的旧拷贝
  // 还写着 `DEFAULT_DATA_DIR = 'D:\...'`，所以"能跑"。也就是说，
  // 这个错误不是"从来没发生"，而是**一直在等一次重启**。
  //
  // 现在：自检失败 → **大声喊**（trace + stderr）+ 跳过依赖数据目录的投影注册，
  // 但**装载照常完成**。真正写入时仍会失败并带上原始错误——
  // 响亮发生"用的时候"，而不是"把门锁上的时候"。
  let storeError = null
  try {
    const logPath = eventLogPath()
    mkdirSync(dirname(logPath), { recursive: true })
    if (!existsSync(logPath)) appendFileSync(logPath, '', 'utf8')
    trace(`STORE_READY  log=${logPath}  schema_version=${SCHEMA_VERSION}  已有事件数=${readEvents().length}`)
  } catch (error) {
    storeError = error
    trace(`STORE_UNAVAILABLE  ${error?.message}`)
    // 不抛错，但**绝不能安静**：插件装载失败与存储不可用，看起来太像了。
    console.error(
      '\n[lh-event-store] ⚠ LH 事件日志不可用，插件会装载但每次写入都会失败：\n' +
        `  ${error?.message}\n` +
        '  修法见上面的提示；通常是在 lh-install.json 里补 repo_root，或设 LH_DATA_DIR。\n' +
        '  （刻意不在 apply() 抛错：那会让整棵插件树加载失败、dsh 起不来。）\n',
    )
  }

  // ── 二、把 LH 的事件计数投影给宿主界面 ──
  // 宿主已经做好了"日志→投影→界面"这条链（见 dsh-session-projection），
  // 我们只是把 LH 的统计接上去，不必自造一套。
  //
  // 存储不可用时**必须跳过**：这个投影的 `init` 会去读日志，而宿主在建立会话时
  // 调用它——在那里抛错就不再是"插件装载失败"，而是**会话打不开**，
  // 故障会蔓延到 LH 之外的地方。宁可少一个统计数字。
  if (storeError !== null) {
    trace('PROJECTION_SKIPPED  存储不可用，跳过 lhEvents 投影')
    return
  }

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    assertSchemaUsable('stateSchema', eventCountsSchema)

    projectionCtx.sessionProjections.register({
      key: 'lhEvents',
      stateSchema: eventCountsSchema,
      init: () => countByType(readEvents()),
      apply: (state, event) => {
        // 宿主会话事件不改变 LH 的统计：LH 的日志与宿主日志是两条独立的流。
        // 必须原样返回同一个引用，否则框架的 Object.is 变更门失效，
        // 每个宿主事件都会触发一次下游重算。
        void event
        return state
      },
      wire: {
        viewSchema: eventCountsSchema,
        view: (state) => state,
      },
      stateVersion: 1,
    })
    trace('PROJECTION_REGISTERED  key=lhEvents')
  })

  trace('APPLY_DONE')
}
