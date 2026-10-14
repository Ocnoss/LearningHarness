/**
 * lh-asserter —— 断言的产生与向上传递（本次开发的核心）。
 *
 * ═══ 它做什么 ═══
 * 订阅宿主会话事件流，当**已绑定课程**的学习会话里出现学习者输入时：
 *   1. 定位这段会话绑定的课程节点（`@lh/course-tree` 的投影）；
 *   2. 按节点选断言器（默认虚拟断言器）；
 *   3. 断言器**真调模型**产出一句断言；
 *   4. 写一条 `lh/assertion/made` 事件（scope=该节点，evidence=触发坐标）；
 *   5. 按断言器的 `propagate` 声明求目标父/跨层节点，对目标节点**再跑一次**，
 *      其 `derived_from` 指向子断言事件 id —— 如此递归，直到到根或声明停止。
 *
 * 于是"用户在第 3 级课程说的一句话"，会在事件日志里留下一条 3 级断言，
 * 并沿树向上串出 2 级、1 级断言（`derived_from` 成链、`propagate_to` 逐级指父）。
 *
 * ═══ 三重护栏（自动触发 + 真调模型会花钱/产噪声，必须挡住）═══
 *   ① 仅学习会话（preset === 'lh'）——照抄 recorder-trace 的 isLearningSession，
 *      否则开发对话会被断言、被写进学习史（那是 recorder-trace 踩过的污染事故）；
 *   ② 会话**必须已 enter_course**（能 resolveNodeOfSession 到节点）——未绑定不断言，
 *      天然把"没有课程归属的闲聊"挡在外面；
 *   ③ 环境开关 `LH_ASSERTER=off` 时整条静默（惰性求值，见契约 §四）。
 *
 * ═══ 异步、绝不抛（契约 §五之二 + recorder-trace 的 append 失败处理）═══
 * 触发回调里 `void (async () => { … try/catch … })()`：模型调用、写事件、投影失败
 * 都只 trace，绝不冒泡进宿主的事件管线——断言是旁路观测，坏了也不能弄坏学习者的会话。
 *
 * ═══ 为什么直接构造 LhEventStore、直接 import tree/model（不走 inject 服务）═══
 * preset 是 agent 作用域，够不着 host 面 root realm 的服务（同 recorder-trace/model-tier）。
 * 所以共享逻辑一律靠**包名 import**：`@lh/event-store/store`、`@lh/course-tree/tree`、
 * `@lh/model-tier/model`。ctx 上只取宿主确实提供的 `llm`（调模型）与 `sessions`。
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LhEventStore, readEvents } from '@lh/event-store/store'
import { buildTree, resolveNodeOfSession, scopeOf, nodeIdOfScope } from '@lh/course-tree/tree'
import { callModel } from '@lh/model-tier/model'

import { createRegistry, selectAsserter, resolvePropagateTarget } from './asserters.js'

/** 插件名。 */
export const name = 'lh-asserter'

/** 需要宿主的消息服务（调模型）与会话服务（判定学习会话）。 */
export const inject = ['llm', 'sessions']

/** 本插件的出处标识（契约 §1.4：必填，重放正确性的前提）。 */
const PROVENANCE = Object.freeze({ plugin: '@lh/asserter', version: '0.0.1' })

/** 断言事件类型。 */
const ASSERTION_EVENT = 'lh/assertion/made'

/** LH 的 preset id：只有跑在它上面的会话才是学习会话。 */
const LH_PRESET_ID = 'lh'

/**
 * 触发断言的宿主事件类型。
 * `user/message` 是对话输入；`tool/result` 代表"做题"类输入（默认只纳入 submit 类，见 extractInput）。
 */
const TRIGGER_TYPES = new Set(['user/message', 'tool/result'])

/** 代表"提交作答"的工具名（tool/result 只在这些工具上触发，避免每个工具结果都断言）。 */
const SUBMIT_TOOLS = new Set(['submit_answer', 'record_attempt'])

/** 递归传递的最大跳数（防 descriptor 声明出环时把栈/日志打爆）。 */
const MAX_PROPAGATE_DEPTH = 32

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 记一条调试痕迹（与 LH 事件严格分开）。
 * @param line - 文本。
 */
function trace(line) {
  try {
    appendFileSync(join(HERE, 'trace.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 记不下来不该让插件崩掉 */
  }
}

// ── 会话 preset 判定（照抄 recorder-trace：不能只读 header）──────────────────
//
// header.agentPreset 是**创建时**的事实且被冻结；空白会话创建后可切换 preset，
// 切换写 `agent-preset/selected` 事件而 header 不变。所以取最后一条 selected，退回 header。
// 用 surface.replaceGeneration 作缓存失效锚，避免每条事件都反扫整段日志（可能几十万条）。
/** @type {WeakMap<object, { generation: number | undefined, preset: string | undefined }>} */
const presetCache = new WeakMap()

/**
 * 解析会话实际跑在哪个 preset 上。
 * @param session - 宿主会话。
 * @returns preset id，取不到则 undefined。
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
 * 是否是学习会话（读不到就不当学习会话：宁可漏，不可污染学习史）。
 * @param session - 宿主会话。
 * @returns bool。
 */
function isLearningSession(session) {
  return presetOfSession(session) === LH_PRESET_ID
}

/**
 * 从消息 content 里抽出纯文本。
 * @param content - 消息 content（数组或字符串）。
 * @returns 文本（无则空串）。
 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/**
 * 从触发事件里抽出"学习者输入"文本；抽不出（或不该触发）返回 null。
 *
 * @param event - 宿主会话事件。
 * @returns 输入文本或 null。
 */
function extractInput(event) {
  if (event.type === 'user/message') {
    // 合成的 user 消息（插件注入、目标轮续写）不是学习者行为，跳过——
    // 与 recorder-trace 用 source.kind 区分真人/合成同一判据。
    const kind = event.data?.source?.kind
    if (typeof kind === 'string' && kind !== 'user' && kind !== 'unknown') return null
    const text = textOfContent(event.data?.message?.content ?? event.data?.content)
    return text.trim() === '' ? null : text
  }

  if (event.type === 'tool/result') {
    // 只把"提交作答"类工具的结果当作可断言的学习行为（默认纳入 submit 类）。
    const toolName = event.data?.name ?? event.data?.tool ?? event.data?.toolName
    if (typeof toolName !== 'string' || !SUBMIT_TOOLS.has(toolName)) return null
    const text = textOfContent(event.data?.result?.content ?? event.data?.content)
    const summary = text.trim() === '' ? `（提交作答：${toolName}）` : text
    return summary
  }

  return null
}

/**
 * 插件体。
 * @param ctx - 插件上下文；注册的一切随插件卸载自动撤销。
 */
export function apply(ctx) {
  const store = new LhEventStore()
  const registry = createRegistry()

  // ctx.llm 在真 preset 下由宿主提供；在闸门的假 ctx 下为 undefined——
  // 但闸门不会触发会话事件，handler 里也会兜住（callModel 拿不到 llm 会失败→fallback）。
  const llm = ctx.llm

  trace('APPLY_CALLED')
  ctx.on('dispose', () => trace('DISPOSED'))

  /**
   * 递归产出并传递断言。
   *
   * @param params.tree - 当前课程树（一次触发内复用同一份投影，保证坐标一致）。
   * @param params.nodeId - 当前节点 id。
   * @param params.input - 学习者输入文本。
   * @param params.evidence - 触发坐标数组（叶子有值，派生跳为空）。
   * @param params.derivedFrom - 子断言事件 id 数组（叶子为空）。
   * @param params.sessionId - 触发会话 id（写进信封 sessionRef）。
   * @param params.depth - 当前跳数。
   * @param params.visited - 已断言过的节点 id 集合（防环）。
   * @returns Promise<void>。
   */
  async function propagate({ tree, nodeId, input, evidence, derivedFrom, sessionId, depth, visited }) {
    if (depth > MAX_PROPAGATE_DEPTH) {
      trace(`PROPAGATE_DEPTH_LIMIT  node=${nodeId} depth=${depth}`)
      return
    }
    if (visited.has(nodeId)) {
      trace(`PROPAGATE_CYCLE_GUARD  node=${nodeId}`)
      return
    }
    const node = tree.byId[nodeId]
    if (node === undefined) return
    visited.add(nodeId)

    const descriptor = selectAsserter(node, registry)
    if (descriptor === null) {
      trace(`NO_ASSERTER  node=${nodeId}`)
      return
    }

    // 先按声明求出目标，交给断言器（它要据此在文本里说"传给第 N 层"）。
    const declared = resolvePropagateTarget(tree, nodeId, descriptor)
    const targetNode = declared.targetNodeId !== null ? (tree.byId[declared.targetNodeId] ?? null) : null

    let result = null
    try {
      result = await descriptor.assert({
        input,
        node,
        tree,
        target: targetNode,
        evidence,
        time: new Date().toISOString(),
        llm,
        call: callModel,
      })
    } catch (error) {
      // 断言器抛错：不阻断、不污染宿主，留痕即可。
      trace(`ASSERT_FAILED  node=${nodeId} asserter=${descriptor.id}  ${error?.message ?? error}`)
      return
    }

    // 目标以断言器返回的 propagate_to 为准（它可覆盖声明）；缺省时用声明求出的目标。
    let propagateToNodeId = declared.targetNodeId
    if (result !== null && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'propagate_to')) {
      const pt = result.propagate_to
      propagateToNodeId = pt === null || pt === undefined ? null : (nodeIdOfScope(pt) ?? pt)
    }

    let envelope = null
    try {
      envelope = store.append({
        actor: 'agent',
        type: ASSERTION_EVENT,
        provenance: PROVENANCE,
        scope: scopeOf(nodeId),
        sessionRef: sessionId,
        data: {
          node_id: nodeId,
          asserter: descriptor.id,
          statement: typeof result?.statement === 'string' ? result.statement : '',
          evidence,
          derived_from: derivedFrom,
          propagate_to: propagateToNodeId !== null ? scopeOf(propagateToNodeId) : null,
          confidence: typeof result?.confidence === 'number' ? result.confidence : null,
          model: result?.model ?? null,
        },
      })
    } catch (error) {
      trace(`APPEND_FAILED  node=${nodeId}  ${error?.message ?? error}`)
      return
    }

    trace(`ASSERTION  node=${nodeId} level=${node.level} asserter=${descriptor.id} → ${propagateToNodeId ?? '(stop)'}  id=${envelope.id}`)

    // 向上传递：对目标节点再跑一次，derived_from 指向本条断言事件。
    if (propagateToNodeId !== null && tree.byId[propagateToNodeId] !== undefined) {
      await propagate({
        tree,
        nodeId: propagateToNodeId,
        input,
        evidence: [],
        derivedFrom: [envelope.id],
        sessionId,
        depth: depth + 1,
        visited,
      })
    }
  }

  /**
   * 处理一条宿主会话事件。
   * @param session - 事件所属会话。
   * @param event - 已提交的会话事件。
   */
  function onSessionEvent(session, event) {
    // 护栏③：环境开关（惰性求值，绝不写成模块级常量）。
    if (process.env.LH_ASSERTER === 'off') return
    if (event === null || typeof event !== 'object') return
    if (!TRIGGER_TYPES.has(event.type)) return
    // 护栏①：仅学习会话。
    if (!isLearningSession(session)) return

    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return

    // 异步旁路：绝不把异常冒泡进宿主事件管线。
    void (async () => {
      try {
        const input = extractInput(event)
        if (input === null) return

        const tree = buildTree(readEvents())
        // 护栏②：会话必须已绑定课程节点。
        const node = resolveNodeOfSession(tree, sessionId)
        if (node === null) {
          trace(`SKIP_NO_COURSE  session=${sessionId} type=${event.type}`)
          return
        }

        const evidence = [`session/${sessionId}#${typeof event.seq === 'number' ? event.seq : '?'}`, event.type]
        await propagate({
          tree,
          nodeId: node.id,
          input,
          evidence,
          derivedFrom: [],
          sessionId,
          depth: 0,
          visited: new Set(),
        })
      } catch (error) {
        trace(`ON_SESSION_EVENT_FAILED  session=${sessionId}  ${error?.message ?? error}`)
      }
    })()
  }

  // 用 { global: true } 订阅整棵树：这是唯一能确保不漏学习会话的方式（同 recorder-trace），
  // "只处理学习会话 + 已绑定课程"由 onSessionEvent 内的护栏负责。
  ctx.on('session/event', onSessionEvent, { global: true })

  trace('LISTENING  session/event（仅 lh 会话 + 已 enter_course；LH_ASSERTER=off 可整条静默）')
}
