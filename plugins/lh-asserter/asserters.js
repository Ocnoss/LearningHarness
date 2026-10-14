/**
 * 断言器注册表 + 传递路径解析（**纯逻辑**，可离线自测）。
 *
 * ═══ 断言器描述符的形状（ADR-033）═══
 * 一个断言器就是一个描述符对象：
 *
 *   {
 *     id: 'virtual',                       // 唯一 id；节点的 `asserter` 字段按它选
 *     tier: 'flash',                       // 建议档位（可选，供引擎/审计参考）
 *     appliesTo(node) -> bool,             // 这个断言器是否适用于该节点（默认恒真）
 *     propagate: { mode, target? },        // **传递路径声明**（见下）
 *     assert({ input, node, tree, target, evidence, time, llm, call })
 *        -> { statement, confidence, propagate_to, model? }
 *   }
 *
 * `propagate.mode`：
 *   · `'parent'`（默认）—— 逐层向上，传给父节点；到根自然停止；
 *   · `'node'`  —— 跨层，`target` 可为 `'root'` / 层级数字 / 具体 node_id；
 *   · `'stop'`  —— 不传递（这条断言是终点）。
 *
 * ═══ 为什么注册表先用内置 Map，而不是 cordis 服务（临时答案，记入开放问题）═══
 * preset 是 agent 作用域，往 root realm 发布服务需要 isolate realm 组，未实测、风险高
 * （见 lh-recorder-trace 文件头对同一约束的记载）。所以本阶段：注册表就是本文件里的一张 Map，
 * 第一个条目是虚拟断言器。将来"断言器服务化注册表"（跨插件动态注册）列入 ADR-033 开放问题。
 *
 * ═══ 为什么传递路径解析是纯函数 ═══
 * 「传给谁」是本次开发最容易错、也最难在真会话里肉眼发现的地方（传错父节点是静默错误）。
 * 所以把它抽成不碰文件/环境/模型的纯函数 `resolvePropagateTarget`，
 * selftest.mjs 用合成树穷举「逐层 / 跨层到根 / 跨层到某层 / 到根停止」四种情形。
 */

import { parentOf, nodeChain } from '@lh/course-tree/tree'
import { virtualAsserter } from './asserters/virtual.js'

/** 节点没声明 `asserter` 时用的默认断言器 id。 */
export const DEFAULT_ASSERTER_ID = 'virtual'

/**
 * 造一张注册表（内置虚拟断言器 + 可选的额外描述符）。
 * @param extra - 额外断言器描述符数组。
 * @returns `Map<id, descriptor>`。
 */
export function createRegistry(extra = []) {
  const registry = new Map()
  registry.set(virtualAsserter.id, virtualAsserter)
  for (const d of Array.isArray(extra) ? extra : []) {
    if (d !== null && typeof d === 'object' && typeof d.id === 'string') registry.set(d.id, d)
  }
  return registry
}

/**
 * 为一个节点选断言器。
 *
 * 节点用 `asserter` 字段（buildTree 从 created 事件的 data.asserter 投影而来）指名要哪个；
 * 没指名或指了一个注册表里没有的，都退回默认（虚拟）——**退回而非报错**：
 * 断言链路不该因为一个写错的 asserter 名而整条断掉，退回默认至少还能观测到传递。
 *
 * @param node - 课程节点。
 * @param registry - 注册表。
 * @returns 描述符；注册表连默认都没有时返回 null。
 */
export function selectAsserter(node, registry) {
  const id = node !== null && typeof node === 'object' && typeof node.asserter === 'string' && node.asserter !== ''
    ? node.asserter
    : DEFAULT_ASSERTER_ID
  return registry.get(id) ?? registry.get(DEFAULT_ASSERTER_ID) ?? null
}

/**
 * 按描述符的 `propagate` 声明，求"这条断言产出后应传给谁"。
 *
 * 这是**传递路径的唯一裁决处**。引擎据它决定下一跳，selftest 据它验路径。
 *
 * @param tree - buildTree 的结果。
 * @param nodeId - 当前节点 id。
 * @param descriptor - 当前节点选中的断言器描述符。
 * @returns `{ targetNodeId: string|null, reason: string }`；targetNodeId 为 null 表示停止。
 */
export function resolvePropagateTarget(tree, nodeId, descriptor) {
  const spec = descriptor !== null && typeof descriptor === 'object' && descriptor.propagate !== undefined
    ? descriptor.propagate
    : { mode: 'parent' }
  const mode = typeof spec.mode === 'string' ? spec.mode : 'parent'

  if (mode === 'stop') return { targetNodeId: null, reason: '描述符声明停止传递（stop）' }

  if (mode === 'parent') {
    const p = parentOf(tree, nodeId)
    return p === null
      ? { targetNodeId: null, reason: '已到根节点，无处可传' }
      : { targetNodeId: p, reason: '逐层向上（parent）' }
  }

  if (mode === 'node') {
    const t = spec.target
    const chain = nodeChain(tree, nodeId) // root..node，level 1..n

    // 'root' / 省略 → 跨层直送根
    if (t === 'root' || t === undefined || t === null) {
      const root = chain[0]
      return root !== undefined && root.id !== nodeId
        ? { targetNodeId: root.id, reason: '跨层直送根（node:root）' }
        : { targetNodeId: null, reason: '本节点已是根' }
    }

    // 数字（或数字串）→ 找该层的祖先
    const asNumber = typeof t === 'number' ? t : (typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : null)
    if (asNumber !== null) {
      const ancestor = chain.find((n) => n.level === asNumber)
      return ancestor !== undefined && ancestor.id !== nodeId
        ? { targetNodeId: ancestor.id, reason: `跨层到第 ${asNumber} 层（node:level）` }
        : { targetNodeId: null, reason: `第 ${asNumber} 层没有有效祖先（或就是自身）` }
    }

    // 否则视作具体 node_id
    if (typeof t === 'string' && tree.byId[t] !== undefined && t !== nodeId) {
      return { targetNodeId: t, reason: '跨层到指定节点（node:id）' }
    }
    return { targetNodeId: null, reason: `指定目标 ${JSON.stringify(t)} 不存在或就是自身` }
  }

  return { targetNodeId: null, reason: `未知的 propagate.mode：${JSON.stringify(mode)}` }
}
