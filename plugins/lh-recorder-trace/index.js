/**
 * lh-recorder-trace —— LH 的坐标记录器（第一个记录器插件）。
 *
 * ═══ 它做什么 ═══
 * 订阅宿主的会话事件流，把**语义事件**以坐标 `(sessionId, seq)` 的形式
 * 追加进 LH 自己的事件日志。**不抄内容。**
 *
 * ═══ 为什么只记坐标、不抄内容 ═══
 * 见 docs/archive/decisions/014：
 *   1. 宿主已持有权威副本，抄一份只会分叉；
 *   2. 宿主日志可被独立读取（实测：多帧 zstd 拼接，逐帧解 4.7MB 耗时 247ms）；
 *   3. LH 要存的是"发生了什么学习行为"，那是更高层的判断，不是原文。
 *
 * ═══ 为什么只索引语义事件、不索引流式 chunk ═══
 * 实测：一个 17,298 条的会话里 91% 是流式 chunk，真正有语义的只有几百条。
 * 而且**流式 chunk 上没有 seq**——所以"只索引语义事件"既是最省的，
 * 也恰好是唯一可寻址的选择。
 *
 * ═══ 为什么"记什么"是本插件的决定 ═══
 * 契约 §1.4：内核连"什么值得记"都不知道，记录器是插件。
 * 所以"只索引这四类事件"是一条**插件级判断**，将来可以并存一个"全量记录器"而互不冲突。
 *
 * ═══ 为什么直接 import 存储模块，而不是注入一个服务 ═══
 * 最初我让本插件 `inject: ['lhEvents']`，由 lh-event-store 提供一个服务。
 * 那会让 preset **挂载失败**——宿主的两条规则叠加堵死了这条路：
 *   1. preset 是 agent 作用域的，agent 作用域解析不到宿主 root realm 的服务
 *      （dsh-agent-presets 的 mount() 因此会拒绝"往 root realm 发布服务"的行：
 *       "preset's service must sit behind an isolate realm or move to the host composition"）；
 *   2. 而本行在 preset 里，它要用的存储由 profile 面的插件装载。
 * store.js 是纯 JS、只依赖 Node 内置模块，所以直接相对导入更简单，也不需要服务。
 *
 * 已知代价（记下来，别当成没发生）：profile 面与 preset 面各装载一份 store.js，
 * 于是有两个模块实例、但**写的是同一个文件**。同一文件以 append 模式打开并逐行写入，
 * 每次写入是一个 write 系统调用，因此不会交错。这对单机单用户场景成立；
 * 若将来出现并发写入需求，应改为单一写入者（例如把写入收进 profile 面的一个服务）。
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 直接 import LH 自己的存储模块（理由见上方"为什么直接 import"）。
// 注意必须走包名 `@lh/event-store/store`：安装到 profiles/<名>/node_modules 后
// 相对路径 `../lh-event-store/…` 不再可达（目录名是 `@lh/event-store`），
// 导入失败会让 dsh 起不来或 preset 声明激活失败——照 lh-question-bank 的修法。
import { LhEventStore, PROVENANCE as STORE_PROVENANCE } from '@lh/event-store/store'

/** 插件名。 */
export const name = 'lh-recorder-trace'

/** 本插件的出处标识。契约 §1.4：插件 id + 版本是重放正确性的前提，必填。 */
const PROVENANCE = Object.freeze({ plugin: '@lh/recorder-trace', version: '0.0.1' })

/**
 * 声明依赖的宿主服务。
 *
 * 刻意**不** inject 存储服务——理由见文件头。
 * 这里只声明宿主侧的 `sessions`，它确实可用（同 preset 里的其它插件已经证明）。
 */
export const inject = ['sessions']

/**
 * 索引哪些事件类型。
 *
 * 这四个是宿主的**语义事件**：承载"谁说了什么、调用了什么、得到了什么"，且**都带 seq**。
 * 宿主还有 `todo/write`、`request/header` 等事件，那是宿主自己的机制记录，
 * 对学习证据没有价值，故不索引。
 */
const SEMANTIC_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
])

const HERE = dirname(fileURLToPath(import.meta.url))

/** LH 事件存储。直接构造即可——它是纯逻辑类，不需要挂到宿主的服务表上。 */
const store = new LhEventStore()

/**
 * 记一条调试痕迹到插件同目录。
 * 与 LH 事件严格分开：日志是唯一事实源，调试噪声不许进去（decisions/014 决定 2）。
 * @param line - 要记录的文本。
 */
function trace(line) {
  try {
    appendFileSync(join(HERE, 'trace.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 记不下来不该让插件崩掉 */
  }
}

/**
 * 从宿主事件里抽出少量元数据，供后续分类器筛选时不必取回原文。
 *
 * 刻意保持"少"：这里每加一个字段，都是把内容抄进 LH 日志的开始。
 * 判据是"不取回原文时，这个字段是否真的用得上"。
 *
 * **字段位置必须查证，不能猜。** 本函数第一版按 `message.model` 取模型身份，
 * 实测取到空——真实位置是 `message.source.{provider,model}`。空字段不报错、只静默丢信息，
 * 所以每个字段都对着真实事件核过。
 *
 * @param event - 宿主会话事件。
 * @returns 元数据对象。
 */
function metaOf(event) {
  const meta = {}

  if (event.type === 'user/message') {
    // source.kind 区分真人输入与合成注入（插件注入、目标轮续写等）。
    // 这个区分是承重的：契约 §3.1 的四元组只对"学习者的生成性行为"计数，
    // 而合成的 user 消息不是学习者行为。分类器必须能机械地区分它们。
    const source = event.data?.source
    meta.source_kind = typeof source?.kind === 'string' ? source.kind : 'unknown'
    if (typeof source?.plugin === 'string') meta.source_plugin = source.plugin
  }

  if (event.type === 'tool/call') {
    meta.tool = event.data?.name
  }

  if (event.type === 'assistant/message') {
    // 模型身份在 message.source 上（实测），**不在 message 上**。
    // 第一版我按 `message.model` 取，取到空且不报错——空字段只会静默丢信息。
    // 策略归因要求知道"这个动作是哪个模型做的"（契约 §3.2）。
    const source = event.data?.message?.source
    if (source?.kind === 'model') {
      if (typeof source.provider === 'string') meta.provider = source.provider
      if (typeof source.model === 'string') meta.model = source.model
    }
    // token 计量：契约 §3.2 的"成本透明"（用户应当看得到 token 花在哪）。
    // 只取驱动成本的四个数；完整 usage 有更多字段，但不取回原文时用不上。
    const usage = event.data?.usage
    if (usage !== null && usage !== undefined) {
      meta.usage = {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cache_read: usage.cacheReadTokens ?? 0,
        reasoning: usage.reasoningTokens ?? 0,
      }
    }
  }

  return meta
}

/** LH 的 preset id。只有跑在这个 preset 上的会话才是学习会话。 */
const LH_PRESET_ID = 'lh'

/**
 * 每个会话的 preset 判定缓存。
 *
 * 为什么需要缓存：解析要反向扫事件日志，而这个开发会话实测有 27 万条事件——
 * 每条会话事件都扫一遍不可接受。`surface.replaceGeneration` 在每次提交时自增，
 * 用它作失效锚：世代没变就不必重扫。
 *
 * @type {WeakMap<object, { generation: number | undefined, preset: string | undefined }>}
 */
const presetCache = new WeakMap()

/**
 * 解析一个会话**实际**跑在哪个 preset 上。
 *
 * ═══ 为什么不能只读 header（踩出来的） ═══
 * `session.header.agentPreset` 是**创建时的事实**，被深冻结；而一个空白会话可以在
 * 创建后切换 preset——切换会写入 `agent-preset/selected` 事件，header 保持不变。
 * 实测：作者新建的会话 header 是 `cordis`（创建时的默认），而 `agent-preset/selected`
 * 是 `lh`——**用户选的确实是 LH，是我的读法错了**。
 *
 * 所以照抄宿主 `resolveSessionPreset` 的逻辑：
 * **取最后一条 `agent-preset/selected`，没有则退回 header。**
 *
 * @param session - 宿主会话。
 * @returns 实际生效的 preset id，取不到则 undefined。
 */
function presetOfSession(session) {
  try {
    const generation = session?.surface?.replaceGeneration
    const cached = presetCache.get(session)
    if (cached !== undefined && cached.generation === generation) return cached.preset

    let preset
    const events = session?.events
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i]?.type === 'agent-preset/selected') {
          preset = events[i].data?.agentPreset
          break
        }
      }
    }
    if (preset === undefined) preset = session?.header?.agentPreset

    presetCache.set(session, { generation, preset })
    return preset
  } catch {
    return undefined
  }
}

/**
 * 判断这个会话该不该被记进 LH 的学习史。
 *
 * ═══ 为什么需要这个判断（踩出来的） ═══
 * 第一版用 `ctx.on('session/event', fn, { global: true })` 订阅**整棵树**的事件，
 * 而 preset 在进程内只挂载一次并**长期驻留**（宿主 README：
 * "the standing mount... survives every agent"）。两条规则叠加的后果实测为：
 *   - 记录器被激活 5 次以上，每次注册一个 global 监听器；
 *   - 于是 LH 日志里出现了**整个进程所有会话**的记录——
 *     包括作者与 AI 的开发对话（一个 standard preset 的会话贡献了 47 条）。
 * 那不是"读起来复杂"的问题，而是**学习史被开发记录污染**。
 *
 * @param session - 宿主会话。
 * @returns 是否应当索引该会话的事件。
 */
function isLearningSession(session) {
  // 读不到就不记：宁可漏记，也不要把开发记录写进学习史。
  return presetOfSession(session) === LH_PRESET_ID
}

/**
 * 插件体。
 *
 * @param ctx - 插件上下文；注册的一切随插件卸载自动撤销。
 */
export function apply(ctx) {
  trace(`APPLY_CALLED  store_provenance=${JSON.stringify(STORE_PROVENANCE)}`)

  /** 已索引的条数，仅用于 trace 观测。 */
  let indexed = 0

  /** 跳过的会话 id，避免同一条被拒的会话反复写 trace。 */
  const skippedSessions = new Set()

  /**
   * 处理一条宿主会话事件。
   *
   * @param session - 事件所属会话。
   * @param event - 已提交的会话事件（其 seq 稳定不变）。
   */
  function onSessionEvent(session, event) {
    if (!SEMANTIC_TYPES.has(event.type)) return

    // 只记学习会话。见 isLearningSession 的注释：不加这一条，
    // 开发对话会被写进学习史。
    if (!isLearningSession(session)) {
      const id = String(session?.id)
      if (!skippedSessions.has(id)) {
        skippedSessions.add(id)
        trace(`SKIP_NOT_LEARNING_SESSION  id=${id}  preset=${session?.header?.agentPreset ?? '(无)'}`)
      }
      return
    }

    // seq 是坐标的核心：没有它指不回原文。语义事件理论上必有 seq，
    // 但按"没看到≠没发生"的教训，缺字段时显式跳过并留痕——
    // **写一个坏坐标比不写更糟**：它会指向错误的证据，而错误坐标在审计时看不出来。
    if (typeof event.seq !== 'number') {
      trace(`SKIP_NO_SEQ  type=${event.type}`)
      return
    }

    try {
      store.append({
        // 宿主事件由宿主产生，actor 取 agent；"这是不是学习者本人的行为"
        // 需要看 source_kind，那属于分类器的判断，不在记录器里裁决。
        actor: 'agent',
        type: 'lh/trace/observed',
        provenance: PROVENANCE,
        // scope 取会话级节点路径，而不是常量 'root'。
        // 理由：契约 §2.1 的课程树还不存在，但"归一到一个常量"会让按作用域筛选失效——
        // 而实测已经证明，读的时候必须能按会话把记录分开。
        // 将来课程树就位时，这里替换为课程节点路径即可，事件无需迁移。
        scope: `session/${String(session.id)}`,
        sessionRef: String(session.id),
        data: {
          // 坐标：这两个字段合起来唯一指向宿主的某一条事件
          session_id: String(session.id),
          seq: event.seq,
          // 冗余存类型与时间：分类器筛选时不必取回原文即可判断
          host_type: event.type,
          time: event.time,
          meta: metaOf(event),
        },
      })
      indexed += 1
      if (indexed % 50 === 0) trace(`INDEXED 累计=${indexed}`)
    } catch (error) {
      // 写不进去要留痕，但不抛：记录失败不该弄坏学习者的会话。
      // （事实源不可用那种系统级故障，由 lh-event-store 在启动时显式暴露。）
      trace(`APPEND_FAILED  type=${event.type} seq=${event.seq}  ${error?.message}`)
    }
  }

  // 仍然用 { global: true } 订阅整棵树：这是**唯一**能确保不漏掉学习会话的方式。
  // "只记学习会话"由 onSessionEvent 里的 isLearningSession 负责，
  // 而不是靠缩小订阅范围——后者取决于宿主的 scope 链怎么连，实测会漏。
  ctx.on('session/event', onSessionEvent, { global: true })

  trace('LISTENING  session/event（只索引 header.agentPreset === lh 的会话）')
}
