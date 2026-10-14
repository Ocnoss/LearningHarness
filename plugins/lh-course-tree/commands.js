/**
 * 课程树的**唯一写入路径** —— 谁想把"课程结构变了"记下来，都经过这里。
 *
 * ═══ 为什么必须只有一处 ═══
 * 在这之前，唯一会写课程事件的地方是 `index.js` 里的三个工具，而它们各自
 * 拼了一遍 `store.append({...})`。界面上线后，浏览器那条路（`@lh/workspace-ui` 的
 * `POST` 路由）也要建课程、改名字、绑会话——如果它自己再拼一遍信封，就会出现
 * **同一种语义、两种字节**：scope 写法、provenance 版本、data 字段名稍有出入，
 * 投影就会其中一边认、另一边静默忽略（`buildTree` 对认不得的字段是**跳过**，
 * 不是报错——这正是本项目记录过的"静默失败"形状）。
 *
 * 所以本文件是课程事件的**唯一构造点**，工具与界面都调它，谁都不自己拼信封。
 *
 * ═══ 为什么读事件也在这里 ═══
 * 每次写之前都要先投影一次（要解析"用户说的是哪门课"、要算层级、要防环）。
 * 把"读 + 投影 + 写"合成一个函数，调用方就不可能忘了其中一步；
 * 而忘了投影正是最容易写出"建了一门重名课"或"绑到一个不存在的节点"的地方。
 *
 * ═══ 边界 ═══
 * 本文件会碰文件（读写事件日志），所以**绝不能在插件装载期调用**：
 * `apply()` 里调它 = 数据目录没配好就抛 = 整棵插件树加载失败 = dsh 起不来
 * （ADR-025）。所有调用都发生在"工具被执行"或"HTTP 请求到达"的那一刻。
 */

import { statSync } from 'node:fs'

import { LhEventStore, readEvents, eventLogPath } from '@lh/event-store/store'
import {
  COURSE_EVENT_TYPES,
  buildTree,
  isHidden,
  levelOf,
  newNodeId,
  nodeChain,
  resolveCourseRef,
  scopeOf,
} from './tree.js'

/**
 * 本插件的出处标识（契约 §1.4：重放正确性的前提，必填）。
 *
 * 版本**跟着包版本走**：provenance 是"这条事件由哪一版代码写出"的答案，
 * 两处不一致会让审计拿到错的时间线。
 */
export const PROVENANCE = Object.freeze({ plugin: '@lh/course-tree', version: '0.2.0' })

/** 写入方。工具走 'agent'；界面来的写走 'user'（是学习者按的按钮，不是模型决定的）。 */
export const ACTOR_AGENT = 'agent'
export const ACTOR_USER = 'user'

/**
 * 把"课程引用"（id 或标题）解析成唯一节点；有歧义或找不到都**如实抛错**。
 *
 * 歧义不猜（WORKFLOW §3 规则 5 的同一条纪律）：猜错会把断言挂到错的父节点上，
 * 而那种错在审计时看不出来（两条分支都"看起来对"）。
 *
 * @param tree - `buildTree` 的结果。
 * @param ref - 用户/模型给的引用。
 * @param what - 出错信息里的角色名（"父课程"/"课程"）。
 * @returns 节点对象。
 * @throws 当引用为空、有歧义或找不到时。
 */
function requireNode(tree, ref, what) {
  const resolved = resolveCourseRef(tree, ref)
  if (resolved.ambiguous !== undefined) {
    throw new Error(
      `${what} "${ref}" 有歧义，匹配到 ${resolved.ambiguous.length} 个：` +
        resolved.ambiguous.map((n) => `${n.title}[${n.id}]`).join('、') +
        '。请改用 node_id 指定。',
    )
  }
  if (resolved.node === null) {
    // 已删节点要**说清楚是"删了"而不是"没找到"**：两者的修法完全不同
    // （一个是"你记错了名字"，另一个是"它曾经存在、现在不在了，可能看错了一棵树"）。
    // `resolveCourseRef` 默认不命中已删节点，所以这里用 includeHidden 再问一次，
    // 只为把话说准——不改变"不能拿它当父"这个行为。
    const historical = resolveCourseRef(tree, ref, { includeHidden: true })
    if (historical.node !== null && isHidden(tree, historical.node.id)) {
      throw new Error(
        `${what}「${historical.node.title}」已被删除（node_id ${historical.node.id}），不能再引用它。` +
          '删除是追加事件、历史仍在日志里；要恢复它，用 create_course 重新建一个。',
      )
    }
    throw new Error(`找不到${what} "${ref}"。先用 list_courses 看看有哪些，或用 create_course 先建它。`)
  }
  return resolved.node
}

/**
 * 一个节点的展示路径（根到自身）与层级，供返回值与文本渲染共用。
 *
 * @param tree - 投影结果。
 * @param nodeId - 节点 id。
 * @returns `{ path, level }`。
 */
function whereOf(tree, nodeId) {
  const chain = nodeChain(tree, nodeId)
  return { path: chain.map((n) => n.title), level: chain.length }
}

/**
 * 建一个课程节点（给了 parentRef 就是子课程）。
 *
 * @param params.title - 课程名（不能为空）。
 * @param params.parentRef - 父课程的 id 或标题；省略/null = 建在顶层。
 * @param params.actor - 写入方。
 * @returns `{ node_id, title, level, parent_id, path }`。
 */
export function createCourse({ title, parentRef = null, actor = ACTOR_AGENT }) {
  const clean = typeof title === 'string' ? title.trim() : ''
  if (clean === '') throw new Error('课程名不能为空。')

  const store = new LhEventStore()
  const before = buildTree(readEvents())

  let parentId = null
  if (parentRef !== null && parentRef !== undefined && String(parentRef).trim() !== '') {
    parentId = requireNode(before, parentRef, '父课程').id
  }

  const nodeId = newNodeId()
  // 层级由"父链"决定，而不是由调用方声明：声明值一旦和父链不一致，
  // 树里就会出现两种 level（投影只信父链，界面却可能读声明值）。
  const level = parentId === null ? 1 : levelOf(before.byId, parentId) + 1

  store.append({
    actor,
    type: COURSE_EVENT_TYPES.CREATED,
    provenance: PROVENANCE,
    scope: scopeOf(nodeId),
    data: { node_id: nodeId, parent_id: parentId, title: clean, level, asserter: null },
  })

  // 重新投影一次拿 path：新建节点的父链在写之前还没含它自己。
  const after = buildTree(readEvents())
  const { path, level: realLevel } = whereOf(after, nodeId)
  return { node_id: nodeId, title: clean, level: realLevel, parent_id: parentId, path }
}

/**
 * 改一门课的名字（追加 `renamed` 事件，旧名字留在日志里）。
 *
 * @param params.nodeRef - 要改的课程（id 或标题）。
 * @param params.title - 新名字。
 * @param params.actor - 写入方。
 * @returns `{ node_id, title, level, parent_id, path }`。
 */
export function renameCourse({ nodeRef, title, actor = ACTOR_USER }) {
  const clean = typeof title === 'string' ? title.trim() : ''
  if (clean === '') throw new Error('新名字不能为空。')

  const store = new LhEventStore()
  const tree = buildTree(readEvents())
  const node = requireNode(tree, nodeRef, '课程')

  store.append({
    actor,
    type: COURSE_EVENT_TYPES.RENAMED,
    provenance: PROVENANCE,
    scope: scopeOf(node.id),
    data: { node_id: node.id, title: clean },
  })

  const after = buildTree(readEvents())
  const { path, level } = whereOf(after, node.id)
  return { node_id: node.id, title: clean, level, parent_id: after.byId[node.id]?.parentId ?? null, path }
}

/**
 * 把一个**宿主会话**绑到某门课（"这段对话属于哪门课"的落点）。
 *
 * ═══ 为什么不做成"删除绑定" ═══
 * 绑定是追加事件、取最新一条。`session-bound` 的语义是"这个会话**现在**在这门课下"，
 * 所以"解绑"= 再写一条指向别处，而不是删掉历史。
 * 这里刻意**不接受空 nodeRef**：解除归属应该由产品显式决定（绑到哪门"未分类"课，
 * 或以后加一个专门的 unbind 事件），而不是让一个 null 悄悄改变历史语义。
 *
 * @param params.nodeRef - 目标课程（id 或标题）。
 * @param params.sessionId - 宿主会话 id。
 * @param params.actor - 写入方。
 * @returns `{ node_id, title, level, session_id, path }`。
 */
export function bindSession({ nodeRef, sessionId, actor = ACTOR_USER }) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') throw new Error('会话 id 不能为空——拿不到会话坐标时不许编一个（坐标错比坐标缺更糟）。')

  const store = new LhEventStore()
  const tree = buildTree(readEvents())
  const node = requireNode(tree, nodeRef, '课程')

  store.append({
    actor,
    type: COURSE_EVENT_TYPES.SESSION_BOUND,
    provenance: PROVENANCE,
    scope: scopeOf(node.id),
    sessionRef: sid,
    data: { node_id: node.id, session_id: sid },
  })

  const { path, level } = whereOf(tree, node.id)
  return { node_id: node.id, title: node.title, level, session_id: sid, path }
}

/**
 * **算出删除一门课的后果**，但什么都不改。
 *
 * ═══ 为什么必须先有这一步（而不是直接删）═══
 * 本项目的规则 4 是"破坏性操作一律白名单"：只允许"明确列出要删什么"，
 * 不允许"删掉所有不匹配的"。这条规则是从一次真实事故里长出来的
 * （启发式判据"content_ref 不含冒号就删"删掉了作者两条真实测试记录）。
 * 所以删除的入口形状是**两步**：先问"会影响到什么"，看到清单之后再确认。
 *
 * 它是**纯函数**（只读事件、不写），所以可以随便调、可以反复调、界面可以实时刷新它。
 *
 * @param params.nodeRef - 要删的课程（id 或标题）。
 * @returns
 *   `{ node_id, title, level, path, sub_courses, session_ids, node_count }`：
 *   - `sub_courses`: 会一起消失的后代（全部层级，带 level 便于界面缩进展示）；
 *   - `session_ids`: 会因此变成"未归课"的会话（**会话本身不会被删**）。
 */
export function previewDelete({ nodeRef }) {
  const tree = buildTree(readEvents())
  const node = requireNode(tree, nodeRef, '课程')

  // 收集后代（可见树上的）。用显式栈，不用递归——树的深度不该由调用栈决定。
  const subCourses = []
  const stack = [...(tree.childrenOf[node.id] ?? [])]
  const scope = new Set([node.id])
  while (stack.length > 0) {
    const id = stack.pop()
    if (scope.has(id)) continue
    scope.add(id)
    const child = tree.byId[id]
    if (child === undefined) continue
    subCourses.push({ node_id: child.id, title: child.title, level: child.level })
    for (const grand of tree.childrenOf[id] ?? []) stack.push(grand)
  }
  subCourses.sort((a, b) => a.level - b.level || a.title.localeCompare(b.title))

  const sessionIds = Object.entries(tree.sessionBindings)
    .filter(([, nodeId]) => scope.has(nodeId))
    .map(([sessionId]) => sessionId)
    .sort()

  const { path, level } = whereOf(tree, node.id)
  return {
    node_id: node.id,
    title: node.title,
    level,
    path,
    sub_courses: subCourses,
    session_ids: sessionIds,
    node_count: 1 + subCourses.length,
  }
}

/**
 * 删掉一门课（连带它当前的全部后代）。**会话不会被删**，只是变成未归课。
 *
 * ═══ 为什么写成"追加一条 deleted 事件" ═══
 * 见 `tree.js` 里 `DELETED` 的注释：append-only 下没有真正的删除。
 * 这里额外做一件**只给审计用**的事：把**确认时的范围**记进事件
 * （`sub_course_ids` / `session_ids`）。
 *
 * ⚠ 投影**完全不读**这两个字段（可见性一律按当前结构重算）——
 * 所以它们不是"派生物进了日志"，而是一条关于**人的决定**的事实：
 * "删的那一刻，被列出来给人看过、并被确认的是这些东西"。
 * 派生范围会随之后的 reparent 变化，而"他当时确认了什么"不会变，
 * 那正是事故复盘时要问的问题。
 *
 * @param params.nodeRef - 要删的课程（id 或标题）。
 * @param params.actor - 写入方。
 * @returns `previewDelete` 的同一形状（影响面），供调用方回报。
 */
export function deleteCourse({ nodeRef, actor = ACTOR_USER }) {
  const impact = previewDelete({ nodeRef })
  const store = new LhEventStore()

  store.append({
    actor,
    type: COURSE_EVENT_TYPES.DELETED,
    provenance: PROVENANCE,
    scope: scopeOf(impact.node_id),
    data: {
      node_id: impact.node_id,
      // 以下两个字段**仅供审计**，投影不读（见上面的注释）。
      title: impact.title,
      sub_course_ids: impact.sub_courses.map((n) => n.node_id),
      session_ids: impact.session_ids,
    },
  })

  return impact
}

/**
 * 给一条会话算它的课程路径文本（R5：课程的级别与名字要进会话上下文）。
 *
 * 输出形如 `行测 / 资料分析（第 2 层，节点 course-1a2b3c4d）`；
 * 未绑定返回 null，由调用方决定"不注入"而不是硬编一句空话。
 *
 * ⚠ **绑到已删课程 = 没绑定。** 这条不能省：删除之后那些会话的绑定事实仍在日志里，
 * 若不判可见性，模型会继续被告知"你属于「资料分析」"，而那门课在界面上已经不存在了——
 * 上下文与实际所见不一致，是最难查的一类错。
 *
 * @param tree - 投影结果。
 * @param sessionId - 宿主会话 id。
 * @returns 路径文本或 null。
 */
export function coursePathText(tree, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const nodeId = tree.sessionBindings[sessionId]
  if (nodeId === undefined) return null
  if (isHidden(tree, nodeId)) return null
  const chain = nodeChain(tree, nodeId)
  if (chain.length === 0) return null
  // 只带 id 的短形态：完整 id 在上下文里是噪声，但又是"引用某门课"时唯一无歧义的东西，
  // 所以留短式（前 8 位已经是 newNodeId 的全部随机部分）。
  return `${chain.map((n) => n.title).join(' / ')}（第 ${chain.length} 层，节点 ${nodeId}）`
}

/**
 * 投影的**带缓存读取** —— 专给"每次模型步都要跑"的上下文注入用。
 *
 * ═══ 为什么缓存的是"日志的 stat"而不是时间 ═══
 * 按时间缓存会在"刚绑完课、下一次请求"这一格上给旧值，而那正是学习者最在意的一次；
 * 按 mtime+size 缓存则只要日志变了就一定重读，没变就一定复用。
 * 代价是每步一次 `statSync`（微秒级），换来的是"注入的永远是当前树"。
 *
 * @returns `{ tree, logPath }`；读失败时 tree 为 null（**不抛**：上下文注入失败不该
 *   让整轮模型调用崩掉，与加载期不抛错是同一条纪律）。
 */
export function cachedTree() {
  let logPath
  try {
    logPath = eventLogPath()
  } catch {
    return { tree: null, logPath: null }
  }

  let key = 'missing'
  try {
    const st = statSync(logPath)
    key = `${st.mtimeMs}:${st.size}`
  } catch {
    key = 'missing'
  }

  if (cache.key === key && cache.tree !== null) return { tree: cache.tree, logPath }
  try {
    const tree = buildTree(readEvents())
    cache.key = key
    cache.tree = tree
    return { tree, logPath }
  } catch {
    return { tree: null, logPath }
  }
}

/** 模块级缓存（单进程、单日志文件；`key` 是日志的 mtime+size）。 */
const cache = { key: null, tree: null }
