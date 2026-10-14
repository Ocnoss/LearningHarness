/**
 * `tree.js` 的离线自测 —— 合成事件喂进 buildTree，断言树形/层级/会话绑定/引用解析。
 *
 * ═══ 为什么是离线的 ═══
 * tree.js 是纯函数：输入事件数组、输出树，不碰文件/环境/宿主。所以这里**合成**一批
 * `lh/course/*` 事件（假数据），穷举投影的各种情形。跑起来零依赖、零副作用，
 * 不会读写真实学习史（这正是"环境变量惰性求值"纪律要保护的东西）。
 *
 * ═══ 判据都是动手前写下的期望 ═══
 * 树长错样是**静默错误**（断言会传到错的父节点，审计时看不出来），所以这里逐条钉死：
 *   1. 层级：根=1，逐层+1；
 *   2. nodeChain 给出 root..node 的标题链；
 *   3. session-bound 取**最新**一次绑定；
 *   4. resolveCourseRef：按 id / 标题命中，多命中报 ambiguous，查不到给 null；
 *   5. reparent 防环：把祖先挂到自己后代下必须被忽略；
 *   6. 孤儿（父不存在）当作根，不许在树里消失。
 *
 * 用法: node plugins/lh-course-tree/selftest.mjs
 */

import {
  buildTree,
  isHidden,
  levelOf,
  parentOf,
  nodeChain,
  childrenOf,
  resolveNodeOfSession,
  resolveCourseRef,
  scopeOf,
  nodeIdOfScope,
  flattenTreeLines,
  COURSE_EVENT_TYPES,
} from './tree.js'

let pass = 0
let fail = 0

/**
 * 断言一个条件。
 * @param label - 用例描述。
 * @param ok - 是否成立。
 * @param detail - 失败补充。
 */
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

/**
 * 造一条课程事件（假数据）。
 * @param type - 事件类型。
 * @param data - 负载。
 * @returns 事件对象。
 */
function ev(type, data) {
  return { id: `e-${Math.random().toString(36).slice(2)}`, type, data, timestamp: '2026-01-01T00:00:00.000Z' }
}

const created = (node_id, parent_id, title, asserter = null) =>
  ev(COURSE_EVENT_TYPES.CREATED, { node_id, parent_id, title, level: 0, asserter })
const renamed = (node_id, title) => ev(COURSE_EVENT_TYPES.RENAMED, { node_id, title })
const reparented = (node_id, parent_id) => ev(COURSE_EVENT_TYPES.REPARENTED, { node_id, parent_id })
const bound = (node_id, session_id) => ev(COURSE_EVENT_TYPES.SESSION_BOUND, { node_id, session_id })

console.log('=== 1. 三级树的投影：层级 / 父子 / 链 ===')
{
  const events = [
    created('course-a', null, '行测'),
    created('course-b', 'course-a', '资料分析'),
    created('course-c', 'course-b', '增长率'),
  ]
  const tree = buildTree(events)

  check('roots 只有顶层节点', JSON.stringify(tree.roots) === JSON.stringify(['course-a']), JSON.stringify(tree.roots))
  check('节点数 = 3', tree.nodes.length === 3)
  check('levelOf: 行测=1', levelOf(tree.byId, 'course-a') === 1)
  check('levelOf: 资料分析=2', levelOf(tree.byId, 'course-b') === 2)
  check('levelOf: 增长率=3', levelOf(tree.byId, 'course-c') === 3)
  check('parentOf: 增长率→资料分析', parentOf(tree, 'course-c') === 'course-b')
  check('parentOf: 行测→null', parentOf(tree, 'course-a') === null)
  check('childrenOf: 行测→[资料分析]', JSON.stringify(childrenOf(tree, 'course-a')) === JSON.stringify(['course-b']))
  check('nodeChain: 增长率 的标题链', JSON.stringify(nodeChain(tree, 'course-c').map((n) => n.title)) ===
    JSON.stringify(['行测', '资料分析', '增长率']))
  check('flattenTreeLines 产出 3 行', flattenTreeLines(tree).length === 3)
}

console.log('\n=== 2. session-bound：取最新一次绑定 ===')
{
  const events = [
    created('course-a', null, '行测'),
    created('course-b', 'course-a', '资料分析'),
    bound('course-b', 'sess-1'),
    bound('course-a', 'sess-1'), // 后到，应覆盖
  ]
  const tree = buildTree(events)
  const node = resolveNodeOfSession(tree, 'sess-1')
  check('会话 sess-1 绑到最新节点（行测）', node !== null && node.id === 'course-a', node?.id)
  check('未绑定的会话返回 null', resolveNodeOfSession(tree, 'sess-x') === null)
  check('非字符串 sessionId 返回 null', resolveNodeOfSession(tree, undefined) === null)
}

console.log('\n=== 3. resolveCourseRef：按 id / 标题 / 歧义 / 查不到 ===')
{
  const events = [
    created('course-a', null, '行测'),
    created('course-b', 'course-a', '资料分析'),
    created('course-dup1', null, '申论'),
    created('course-dup2', null, '申论'),
  ]
  const tree = buildTree(events)
  check('按 id 命中', resolveCourseRef(tree, 'course-b').node?.id === 'course-b')
  check('按标题命中', resolveCourseRef(tree, '资料分析').node?.id === 'course-b')
  check('忽略大小写/空格命中', resolveCourseRef(tree, '  行测 ').node?.id === 'course-a')
  const amb = resolveCourseRef(tree, '申论')
  check('多命中报 ambiguous（不猜）', Array.isArray(amb.ambiguous) && amb.ambiguous.length === 2, JSON.stringify(amb))
  check('查不到给 node:null', resolveCourseRef(tree, '不存在的课').node === null)
  check('空引用给 node:null', resolveCourseRef(tree, '  ').node === null)
}

console.log('\n=== 4. renamed：标题以最后一次为准 ===')
{
  const events = [
    created('course-a', null, '行测'),
    renamed('course-a', '行政职业能力测验'),
  ]
  const tree = buildTree(events)
  check('renamed 生效', tree.byId['course-a'].title === '行政职业能力测验')
}

console.log('\n=== 5. reparent 防环：把祖先挂到后代下必须被忽略 ===')
{
  const events = [
    created('course-a', null, '行测'),
    created('course-b', 'course-a', '资料分析'),
    created('course-c', 'course-b', '增长率'),
    reparented('course-a', 'course-c'), // 环：a 是 c 的祖先，必须被拒
  ]
  const tree = buildTree(events)
  check('防环：行测仍是根', tree.byId['course-a'].parentId === null, tree.byId['course-a'].parentId)
  check('防环：树仍有单一根', JSON.stringify(tree.roots) === JSON.stringify(['course-a']))
}

console.log('\n=== 6. 孤儿（父不存在）当作根，不消失 ===')
{
  const events = [created('course-x', 'course-不存在', '孤儿课')]
  const tree = buildTree(events)
  check('孤儿进 roots', tree.roots.includes('course-x'))
  check('孤儿 parentId 归 null', tree.byId['course-x'].parentId === null)
  check('孤儿 level=1', tree.byId['course-x'].level === 1)
}

console.log('\n=== 7. 幂等 / 健壮性：重复创建、非课程事件、空输入 ===')
{
  const events = [
    created('course-a', null, '行测'),
    created('course-a', null, '行测（重复 id）'), // 同 id 再建，应忽略
    { type: 'lh/trace/observed', data: {} },       // 非课程事件，忽略
    { type: 'lh/assertion/made', data: { node_id: 'course-a' } },
  ]
  const tree = buildTree(events)
  check('重复 id 只建一个节点', tree.nodes.length === 1, `实际 ${tree.nodes.length}`)
  check('非课程事件被忽略', tree.nodes.every((n) => n.id === 'course-a'))
  check('空数组不炸', buildTree([]).nodes.length === 0)
  check('非数组不炸', buildTree(null).nodes.length === 0)
}

console.log('\n=== 8. scope 编解码往返 ===')
{
  check('scopeOf/nodeIdOfScope 往返', nodeIdOfScope(scopeOf('course-a')) === 'course-a')
  check('非 course scope 反解为 null', nodeIdOfScope('session/s1') === null)
  check('非字符串 scope 反解为 null', nodeIdOfScope(undefined) === null)
}

// ══════════════════════════════════════════════════════════════════════════
// 删除（ADR-036）。这一组是**本轮新增词汇**的钉子：
// append-only 下的"删除"是"再写一条说它不可见"，而不可见会**向下传染**。
// 传染要在每次投影时按当前结构重算，所以嵌套删除、删完再挂、删了又删
// 这三种形状都得钉死——它们的错误形态都是"树上留个看不见的鬼影"。
// ══════════════════════════════════════════════════════════════════════════

const deleted = (node_id) => ev(COURSE_EVENT_TYPES.DELETED, { node_id })

console.log('\n=== 9. 删除：自身与后代一起不可见 ===')
{
  const events = [
    created('course-a', null, '行测'),
    created('course-b', 'course-a', '资料分析'),
    created('course-c', 'course-b', '增长率'),
    created('course-d', null, '申论'),
    deleted('course-b'),
  ]
  const tree = buildTree(events)
  check('可见节点 = 行测 + 申论', JSON.stringify(tree.nodes.map((n) => n.title).sort()) === JSON.stringify(['申论', '行测']), JSON.stringify(tree.nodes.map((n) => n.title)))
  check('hidden 含被删的与它的后代', JSON.stringify(tree.hidden) === JSON.stringify(['course-b', 'course-c']), JSON.stringify(tree.hidden))
  check('roots 只剩两个顶层', JSON.stringify(tree.roots.sort()) === JSON.stringify(['course-a', 'course-d']), JSON.stringify(tree.roots))
  check('byId 仍保留已删节点（历史可追）', tree.byId['course-c'] !== undefined)
  check('isHidden：被删后代为 true', isHidden(tree, 'course-c') === true)
  check('isHidden：无关节点为 false', isHidden(tree, 'course-d') === false)
  check('resolveCourseRef 不命中已删节点（按 id）', resolveCourseRef(tree, 'course-b').node === null)
  check('resolveCourseRef 不命中已删节点（按标题）', resolveCourseRef(tree, '增长率').node === null)
  check('includeHidden 才能按 id 命中', resolveCourseRef(tree, 'course-b', { includeHidden: true }).node?.id === 'course-b')
}

console.log('\n=== 10. 删除：链长 > 1 也要传染（先删子、再删父） ===')
{
  // ⚠ 这一例是"定点迭代"存在的理由：一遍扫描会先遇到子（父当时还没被删）→ 漏掉。
  const events = [
    created('course-a', null, 'A'),
    created('course-b', 'course-a', 'B'),
    created('course-c', 'course-b', 'C'),
    created('course-d', 'course-c', 'D'),
    deleted('course-d'),
    deleted('course-b'),
  ]
  const tree = buildTree(events)
  // ⚠ 期望是"A 还在、B/C/D 都没了"——**不是**整条链都没了。
  //   删的是 B，不是 A；把父也一起删掉会越权（那正是"删掉所有不匹配的"那种判据）。
  check('可见的只剩 A（B/C/D 都没了，A 不受牵连）',
    JSON.stringify(tree.nodes.map((n) => n.id)) === JSON.stringify(['course-a']),
    JSON.stringify(tree.nodes.map((n) => n.id)))
  check('hidden = B/C/D', JSON.stringify(tree.hidden) === JSON.stringify(['course-b', 'course-c', 'course-d']), JSON.stringify(tree.hidden))
  check('A 仍在 byId 里', tree.byId['course-a'] !== undefined)
  check('A 的 childrenOf 不含 B（键为空）', (tree.childrenOf['course-a'] ?? []).length === 0, JSON.stringify(tree.childrenOf['course-a']))
}

console.log('\n=== 11. 删除：删完再挂到它下面 vs 挂在可见节点下 ===')
{
  const events = [
    created('course-a', null, 'A'),
    created('course-x', null, 'X'),
    deleted('course-a'),
    // 父已删 → 新子课程会变成鬼影，所以 resolveCourseRef 不认它，建不出来。
    // 这里直接合成"有人硬写了这么一条事件"的形态，验证投影**不会**让新子课程凭空消失。
    created('course-y', 'course-a', 'Y（父已删）'),
  ]
  const tree = buildTree(events)
  check('挂在已删父下的新节点也跟着不可见（不是静默消失，是明确的规则）',
    isHidden(tree, 'course-y') === true, JSON.stringify(tree.hidden))
  check('可见的只剩 X', JSON.stringify(tree.nodes.map((n) => n.id)) === JSON.stringify(['course-x']))
}

console.log('\n=== 12. 删除：绑定事实仍在，但节点不可见 ===')
{
  const events = [
    created('course-a', null, '行测'),
    bound('course-a', 'sess-1'),
    deleted('course-a'),
  ]
  const tree = buildTree(events)
  check('binding 原始事实仍然保留', tree.sessionBindings['sess-1'] === 'course-a', JSON.stringify(tree.sessionBindings))
  check('resolveNodeOfSession 仍返回节点对象（投影不做"算不算数"的判断）',
    resolveNodeOfSession(tree, 'sess-1')?.id === 'course-a')
  check('该节点已被标记不可见', isHidden(tree, tree.sessionBindings['sess-1']) === true)
}

console.log('\n=== 13. 删除的幂等与健壮性 ===')
{
  const base = [created('course-a', null, 'A'), created('course-b', 'course-a', 'B')]
  const once = buildTree([...base, deleted('course-a')])
  const twice = buildTree([...base, deleted('course-a'), deleted('course-a')])
  check('删两次结果相同', JSON.stringify(once.hidden) === JSON.stringify(twice.hidden), `${JSON.stringify(once.hidden)} vs ${JSON.stringify(twice.hidden)}`)
  check('删不存在的 id 不炸', buildTree([...base, deleted('course-nope')]).nodes.length === 2)
  check('无 node_id 的删除事件被忽略', buildTree([...base, ev(COURSE_EVENT_TYPES.DELETED, {})]).nodes.length === 2)
}

console.log('')
if (fail > 0) {
  console.log(`══ 结果：${pass} 通过 / ${fail} 失败 ══`)
  process.exit(1)
}
console.log(`══ 结果：${pass} 通过 / 0 失败 ══`)
