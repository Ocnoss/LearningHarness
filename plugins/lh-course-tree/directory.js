/**
 * 课程目录的**唯一视图组装** —— 界面要的"课程树 + 每门课挂了哪些会话"。
 *
 * ═══ 为什么它不是第二份树实现 ═══
 * 树的形状（父子、层级、会话绑到哪个节点）仍然只有 `tree.js` 那一处推导；
 * 本文件只做**投影之上的分组**：把 `sessionBindings`（会话→节点）翻成
 * "每个节点下挂着哪些会话"（节点→会话）。这是方向相反的同一份事实，
 * 不是重新判断一次"谁是谁的父"。
 *
 * ═══ 为什么"没有绑课的会话"不在这里算 ═══
 * 服务端**根本不知道有哪些会话**——会话注册表在宿主/浏览器那一侧
 * （`ctx.sessions`）。所以这里只如实给出"有哪些会话绑到了哪门课"，
 * 由拿得到会话清单的那一半去求差集。硬在这里猜一个会话全集，
 * 就等于把"我不认识的东西"当成"不存在"（静默漏掉真实会话）。
 */

import { buildTree, isHidden } from './tree.js'

/**
 * 组装课程目录视图（可直接 JSON 序列化发给浏览器）。
 *
 * @param events - LH 全量事件。
 * @returns 形如
 *   `{ nodes, roots, children_of, session_bindings, orphan_bindings, unbound_sessions, node_count, session_count }`：
 *   - `nodes`: `[{ node_id, title, level, parent_id, asserter, created_at, sessions }]`（插入序）；
 *   - `children_of`: `{ [parentId|'']: [childId] }`，根的键是空串（**普通对象**，不是 Map）；
 *   - `orphan_bindings`: 绑到了已不存在节点的会话（防御性，正常为空）。
 */
export function buildDirectoryView(events) {
  const tree = buildTree(events)

  // 每个节点下挂了哪些会话（面板把会话列在课程下面）。
  //
  // ⚠ 只把**可见节点**的绑定算进去。绑到已删节点的会话不算"在这门课下"——
  //   删除之后那些绑定事实仍在日志里，但课程已经不存在了。
  //   它们不是被丢掉：下面 orphan_bindings 会如实把它们单列出来，
  //   界面据此把它们当"未归课"处理（而不是让它们凭空消失，或继续挂在鬼影课程下）。
  const sessionsByNode = Object.create(null)
  for (const [sessionId, nodeId] of Object.entries(tree.sessionBindings)) {
    if (isHidden(tree, nodeId)) continue
    ;(sessionsByNode[nodeId] ??= []).push(sessionId)
  }
  // 绑定顺序稳定：按会话 id 排序，避免每次刷新顺序抖动。
  const collator = new Intl.Collator('en')
  for (const list of Object.values(sessionsByNode)) list.sort((a, b) => collator.compare(a, b))

  const nodes = tree.nodes.map((n) => ({
    node_id: n.id,
    title: n.title,
    level: n.level,
    parent_id: n.parentId,
    asserter: n.asserter,
    created_at: n.createdAt,
    sessions: sessionsByNode[n.id] ?? [],
  }))

  // 绑定指向了一个**当前不可见**的节点（被删掉的课）。如实单列，不静默吞掉：
  // 界面要能让学习者看见"这几段对话原来归的课没了，现在算未归课"。
  const orphan = Object.entries(tree.sessionBindings)
    .filter(([, nodeId]) => tree.byId[nodeId] === undefined || isHidden(tree, nodeId))
    .map(([sessionId]) => sessionId)

  return {
    nodes,
    roots: tree.roots,
    children_of: tree.childrenOf,
    session_bindings: tree.sessionBindings,
    orphan_bindings: orphan,
    hidden_count: tree.hidden.length,
    node_count: nodes.length,
    session_count: Object.keys(tree.sessionBindings).length,
  }
}
