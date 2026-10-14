/**
 * 课程树的**唯一投影实现** —— 树 = `lh/course/*` 事件的重放结果。
 *
 * ═══ 为什么单独成文件、且是"唯一实现" ═══
 * 与 `lh-event-store/store.js`、`lh-model-tier/model.js` 同构：
 * 课程树的形状（谁是根、谁是谁的父、某会话绑在哪个节点、某节点的层级）
 * 只应该有**一处**推导逻辑。断言器要按它向上传递、界面要按它递归渲染、
 * 工具要按它解析"用户说的是哪门课"——三处若各推一遍，迟早不一致，
 * 而"树长什么样"不一致会让断言传到错的父节点上（静默错误，审计时看不出来）。
 *
 * 所以本文件是纯函数集合：**输入事件数组，输出树**，不碰文件、不碰环境、不碰宿主。
 * 谁需要树，就 `import { buildTree } from '@lh/course-tree/tree'` 再把事件喂进来。
 *
 * ═══ 为什么是事件溯源而不是一个可变的 courses.json（ADR-032）═══
 * 契约 §1.2「一切状态是日志的投影」、§2.1「事件不动纪律：课程拆分/合并只改树的元数据，
 * 事件永远留在被写入的节点」。把树做成投影，于是：
 *   · 重组课程（改名、换父）是**追加一条新事件**，历史不丢、可回放；
 *   · 断言可重新投影（换断言器重放即翻新），而事件永不重写；
 *   · "某时刻树长什么样"可由事件时间戳重建，不需要额外快照。
 *
 * ═══ 数据结构约定 ═══
 * 全部用**普通对象/数组**（不用 Map/Set），这样 `buildTree` 的结果可以直接
 * JSON 序列化发给界面（Map 不可序列化，会成为界面路由里的一个隐藏坑）。
 */

import { randomUUID } from 'node:crypto'

/** 课程树相关的事件类型。只有这些参与树的投影，其余事件忽略。 */
export const COURSE_EVENT_TYPES = Object.freeze({
  CREATED: 'lh/course/created',
  RENAMED: 'lh/course/renamed',
  REPARENTED: 'lh/course/reparented',
  SESSION_BOUND: 'lh/course/session-bound',
  /**
   * 删除一个节点（连带其当前的全部后代）。
   *
   * ═══ 为什么"删除"也是一条追加事件 ═══
   * 这是 append-only 最反直觉的一处：**没有真正的删除**。
   * 删掉一门课的记录方式是"再写一条说它从此刻起不可见"，于是
   * 旧事件一条不动、树能重放出"删除之前长什么样"、删错了查得到是谁何时删的。
   * 代价是日志只增不减——本项目已接受它（ADR-012：日志一旦能改就不再是事实源）。
   *
   * ═══ 它删课程结构，**不删会话** ═══
   * 会话是宿主的东西，LH 无权删。原来绑在这些节点下的会话变成"未归课"：
   * 绑定事实仍在日志里，只是指向了不可见节点——**由目录视图如实分类，投影不替它决定**
   * （投影只回答"哪些节点不可见"，"某会话因此算未归课"是视图的判断）。
   */
  DELETED: 'lh/course/deleted',
})

/** 判断一条事件是否属于课程树词汇。 */
function isCourseEvent(event) {
  return typeof event?.type === 'string' && event.type.startsWith('lh/course/')
}

/**
 * 生成一个新课程节点 id。
 *
 * 用短 uuid 而不是"标题拼音"之类：标题会重复、会改，而 id 必须稳定且全局唯一
 * （契约 §2.2 信封 id 全局唯一的精神同样适用于节点 id——它是断言传递的坐标）。
 *
 * @returns 形如 `course-1a2b3c4d` 的节点 id。
 */
export function newNodeId() {
  return `course-${randomUUID().slice(0, 8)}`
}

/**
 * 课程节点的 scope 字符串（写进事件信封的 `scope` 字段）。
 *
 * 契约 §2.2 的 `scope` 是"节点路径（课程树作用域）"。这里用 `course/<node_id>`：
 * 它稳定、可反解出 node_id，且与 recorder-trace 现用的 `session/<id>` 同一形状
 * （前缀区分作用域种类）。
 *
 * @param nodeId - 节点 id。
 * @returns scope 字符串。
 */
export function scopeOf(nodeId) {
  return `course/${nodeId}`
}

/** 从 scope 字符串反解 node_id（不是 course scope 时返回 null）。 */
export function nodeIdOfScope(scope) {
  if (typeof scope !== 'string') return null
  return scope.startsWith('course/') ? scope.slice('course/'.length) : null
}

/**
 * 重放事件，得到课程树的当前形态。
 *
 * 逐条按顺序应用：created 建节点、renamed 改标题、reparented 换父、
 * session-bound 记"会话→节点"的最新绑定。后到的覆盖先到的（同一 node_id 的
 * rename 以最后一次为准；同一 session 的绑定以最后一次为准）。
 *
 * @param events - LH 事件数组（可含任意类型，内部只挑 `lh/course/*`）。
 * @returns
 *   `{ nodes, byId, childrenOf, roots, sessionBindings, order }`：
 *   - `nodes`: 节点数组（插入序），每个 `{ id, parentId, title, level, asserter, createdAt }`；
 *   - `byId`: `{ [id]: node }`；
 *   - `childrenOf`: `{ [parentId|'']: [childId,...] }`（根的键是空串 `''`）；
 *   - `roots`: 顶层节点 id 数组；
 *   - `sessionBindings`: `{ [sessionId]: nodeId }`（每会话取最新绑定，**含指向已删节点的**）；
 *   - `hidden`: 因删除而不可见的节点 id 数组（被删的 + 它们的后代）；
 *   - `order`: 与 nodes 同序的 id 数组（便于稳定遍历）。
 *
 *   ⚠ `byId` **含已删节点**（历史要能解析），而 `nodes`/`childrenOf`/`roots` 只含可见的。
 *   这个区分是刻意的：调用方要"渲染树"就用后者，要"按 id 追一段历史"就用前者。
 */
export function buildTree(events) {
  /** @type {Array<{id:string,parentId:string|null,title:string,level:number,asserter:string|null,createdAt:string|null}>} */
  const all = []
  const byId = Object.create(null)
  const sessionBindings = Object.create(null)
  /** 被显式删除的节点 id（不含因祖先被删而消失的）。 */
  const deletedIds = new Set()

  for (const event of Array.isArray(events) ? events : []) {
    if (!isCourseEvent(event)) continue
    const data = event.data ?? {}

    if (event.type === COURSE_EVENT_TYPES.CREATED) {
      const id = typeof data.node_id === 'string' && data.node_id !== '' ? data.node_id : null
      if (id === null || byId[id] !== undefined) continue // 无 id 或重复创建：忽略（幂等）
      const parentId = typeof data.parent_id === 'string' && data.parent_id !== '' ? data.parent_id : null
      const node = {
        id,
        parentId,
        title: typeof data.title === 'string' ? data.title : '(未命名课程)',
        // level 由父链推导（下面重算），这里先记声明值兜底
        level: Number.isInteger(data.level) ? data.level : 0,
        asserter: typeof data.asserter === 'string' && data.asserter !== '' ? data.asserter : null,
        createdAt: typeof event.timestamp === 'string' ? event.timestamp : null,
      }
      all.push(node)
      byId[id] = node
    } else if (event.type === COURSE_EVENT_TYPES.RENAMED) {
      const node = typeof data.node_id === 'string' ? byId[data.node_id] : undefined
      if (node !== undefined && typeof data.title === 'string') node.title = data.title
    } else if (event.type === COURSE_EVENT_TYPES.REPARENTED) {
      const node = typeof data.node_id === 'string' ? byId[data.node_id] : undefined
      // 防环：新父不能是自己或自己的后代（见 isDescendant）
      if (node !== undefined) {
        const newParent = typeof data.parent_id === 'string' && data.parent_id !== '' ? data.parent_id : null
        if (newParent !== node.id && !isDescendant(byId, node.id, newParent)) node.parentId = newParent
      }
    } else if (event.type === COURSE_EVENT_TYPES.SESSION_BOUND) {
      const sid = typeof data.session_id === 'string' ? data.session_id : null
      const nid = typeof data.node_id === 'string' ? data.node_id : null
      // ⚠ 这里**不检查节点是否已删**：绑定是一条历史事实，投影如实记下来，
      //    "它现在还算不算数"由视图判断（见 directory.js 的 unbound 分类）。
      if (sid !== null && nid !== null && byId[nid] !== undefined) sessionBindings[sid] = nid
    } else if (event.type === COURSE_EVENT_TYPES.DELETED) {
      const id = typeof data.node_id === 'string' ? data.node_id : null
      if (id !== null && byId[id] !== undefined) deletedIds.add(id)
    }
  }

  // ── 可见性：被删的节点 + 它们的全部后代都不可见 ──
  //
  // ═══ 为什么"后代也一起隐藏"要在最后算、而不是删除时写进事件 ═══
  // 如果删除事件里预先列出后代，那个列表在**写入那一刻**就冻住了；之后再加的子课程
  // 不会被列进去，于是会出现"父课已删、子课却还在树上"的鬼影。
  // 每次投影时按当前结构重算，语义是"**这个节点及其当下的一切后代不可见**"——
  // 一句话、无需解释残留情况。
  const hidden = new Set()
  {
    // 反复扫到不动点：删除可以嵌套（删 A 之后又删了 A 的子 B），
    // 一遍扫描在链长 > 1 时会漏（先遇到子、后遇到父）。
    let changed = true
    for (const id of deletedIds) hidden.add(id)
    let guard = 0
    while (changed && guard < 1000) {
      changed = false
      for (const node of all) {
        if (hidden.has(node.id)) continue
        if (node.parentId !== null && hidden.has(node.parentId)) {
          hidden.add(node.id)
          changed = true
        }
      }
      guard += 1
    }
  }

  const nodes = all.filter((node) => !hidden.has(node.id))

  // 父链稳定后重算 level（根 = 1），并建立 childrenOf / roots。
  const childrenOf = Object.create(null)
  const roots = []
  for (const node of nodes) {
    node.level = levelOf(byId, node.id)
    // 可见节点的父不可能是隐藏节点（隐藏会向下传染），但父**可能不存在**（孤儿事件）。
    if (node.parentId === null || byId[node.parentId] === undefined || hidden.has(node.parentId)) {
      // 孤儿（或父已删）也当作根，避免它在树里彻底消失——静默丢节点比丑更糟。
      node.parentId = null
      roots.push(node.id)
      ;(childrenOf[''] ??= []).push(node.id)
    } else {
      ;(childrenOf[node.parentId] ??= []).push(node.id)
    }
  }

  return {
    nodes,
    byId,
    childrenOf,
    roots,
    sessionBindings,
    hidden: [...hidden].sort(),
    order: nodes.map((n) => n.id),
  }
}

/**
 * 某节点是否因为删除而不可见。
 *
 * @param tree - `buildTree` 的结果。
 * @param nodeId - 节点 id。
 * @returns 不可见则 true（含"这个 id 根本不存在"）。
 */
export function isHidden(tree, nodeId) {
  return typeof nodeId === 'string' && Array.isArray(tree?.hidden) && tree.hidden.includes(nodeId)
}

/**
 * `candidate` 是否是 `nodeId` 的后代（用于 reparent 防环）。
 * @param byId - 节点表。
 * @param nodeId - 基准节点。
 * @param candidate - 待判定的新父。
 * @returns candidate 在 nodeId 的子树里则 true。
 */
function isDescendant(byId, nodeId, candidate) {
  if (candidate === null) return false
  let cur = byId[candidate]
  let guard = 0
  while (cur !== undefined && guard < 1000) {
    if (cur.id === nodeId) return true
    cur = cur.parentId === null ? undefined : byId[cur.parentId]
    guard += 1
  }
  return false
}

/**
 * 节点层级（根 = 1，逐层 +1）。父链断裂时按已有深度计。
 * @param byId - 节点表。
 * @param nodeId - 节点 id。
 * @returns 层级数字；节点不存在返回 0。
 */
export function levelOf(byId, nodeId) {
  let level = 0
  let cur = byId[nodeId]
  let guard = 0
  while (cur !== undefined && guard < 1000) {
    level += 1
    cur = cur.parentId === null ? undefined : byId[cur.parentId]
    guard += 1
  }
  return level
}

/**
 * 某节点的父节点 id（到根时为 null）。
 * @param tree - buildTree 的结果。
 * @param nodeId - 节点 id。
 * @returns 父 id 或 null。
 */
export function parentOf(tree, nodeId) {
  const node = tree.byId[nodeId]
  return node === undefined ? null : node.parentId
}

/**
 * 从根到某节点的链（含自身），用于面包屑与"传给第 N 层"的表述。
 * @param tree - buildTree 的结果。
 * @param nodeId - 节点 id。
 * @returns 节点数组（root..node）；节点不存在返回 []。
 */
export function nodeChain(tree, nodeId) {
  const chain = []
  let cur = tree.byId[nodeId]
  let guard = 0
  while (cur !== undefined && guard < 1000) {
    chain.unshift(cur)
    cur = cur.parentId === null ? undefined : tree.byId[cur.parentId]
    guard += 1
  }
  return chain
}

/** 某节点的直接子节点 id 数组（无子返回空数组）。 */
export function childrenOf(tree, nodeId) {
  return tree.childrenOf[nodeId] ?? []
}

/**
 * 某会话当前绑定的节点（取最新一次 session-bound）。
 *
 * @param tree - buildTree 的结果。
 * @param sessionId - 宿主会话 id。
 * @returns 节点对象；未绑定返回 null。
 */
export function resolveNodeOfSession(tree, sessionId) {
  if (typeof sessionId !== 'string') return null
  const nodeId = tree.sessionBindings[sessionId]
  return nodeId === undefined ? null : (tree.byId[nodeId] ?? null)
}

/**
 * 按"节点 id 或标题"解析出一个节点（工具与界面的入口都要它）。
 *
 * 先按 id 精确匹配；否则按标题精确匹配；再否则按去空格/忽略大小写匹配。
 * 多个标题命中视为**歧义**，返回 `ambiguous` 让调用方如实报错，而不是猜一个
 * （WORKFLOW §3：认不出的如实回报，不静默选择）。
 *
 * ⚠ **已删节点不参与解析**（`includeHidden: false` 时的默认行为）。
 * 这一条是必须的：`byId` 保留已删节点是为了让历史可追溯，
 * 但如果按 id 也能解析到它们，那么"删了一门课之后再用它的 id 建子课程"
 * 会成功——于是新子课程挂在一个不可见的父上，**当场变成鬼影**（谁也看不见它）。
 * 所以默认由**可见树**解析；要读历史的调用方显式传 `includeHidden: true`。
 *
 * @param tree - buildTree 的结果。
 * @param ref - 用户给的课程引用（id 或标题）。
 * @param options.includeHidden - 是否允许命中已删节点（默认 false）。
 * @returns `{ node }` 或 `{ ambiguous: [node,...] }` 或 `{ node: null }`（没找到）。
 */
export function resolveCourseRef(tree, ref, options = {}) {
  if (typeof ref !== 'string' || ref.trim() === '') return { node: null }
  const key = ref.trim()
  const allowHidden = options.includeHidden === true

  const byIdHit = tree.byId[key]
  if (byIdHit !== undefined && (allowHidden || !isHidden(tree, byIdHit.id))) return { node: byIdHit }

  const exact = tree.nodes.filter((n) => n.title === key)
  if (exact.length === 1) return { node: exact[0] }
  if (exact.length > 1) return { ambiguous: exact }

  const loose = tree.nodes.filter((n) => n.title.trim().toLowerCase() === key.toLowerCase())
  if (loose.length === 1) return { node: loose[0] }
  if (loose.length > 1) return { ambiguous: loose }

  return { node: null }
}

/**
 * 把树拍平成"带缩进的行"，供工具的文本 render 与界面兜底展示共用。
 *
 * @param tree - buildTree 的结果。
 * @param options.markNodeId - 是否在每行附上 node_id（默认 false，给人看更干净）。
 * @returns 行数组，每行 `{ id, title, level, text }`。
 */
export function flattenTreeLines(tree, options = {}) {
  const lines = []
  const walk = (parentId) => {
    for (const id of tree.childrenOf[parentId ?? ''] ?? []) {
      const node = tree.byId[id]
      if (node === undefined) continue
      const indent = '  '.repeat(Math.max(0, node.level - 1))
      const suffix = options.markNodeId === true ? `  [${node.id}]` : ''
      lines.push({ id: node.id, title: node.title, level: node.level, text: `${indent}· ${node.title}${suffix}` })
      walk(id)
    }
  }
  walk(null)
  return lines
}
