/**
 * lh-asserter 的离线自测 —— **不调真模型**，验传递路径解析与虚拟断言器产出形状。
 *
 * ═══ 为什么这两件事值得离线钉死 ═══
 * 1. `resolvePropagateTarget`（"这条断言传给谁"）是本次开发最容易错、也最难在真会话里
 *    肉眼发现的地方：传错父节点是**静默错误**。所以用合成树穷举四种声明：
 *    逐层(parent) / 跨层到根(node:root) / 跨层到某层(node:level) / 停止(stop)，外加默认与非法目标。
 * 2. 虚拟断言器用**假 call**（替换 callModel）验证：提示词里带上了节点标题/层级/输入摘要/目标层级，
 *    且产出形状正确（模型可用时取模型文本、confidence 中等；不可用时 fallback 到模板、confidence 低、model=null）。
 *    —— 这样"传递链路"永远可测，不因 flash 档没配好就测不了。
 *
 * 树用**手工构造的最小对象**（只需 byId + 每节点 {id,parentId,level,title}），
 * 因为 resolvePropagateTarget 只经由 @lh/course-tree/tree 的 parentOf/nodeChain 读这几个字段。
 *
 * 用法: node plugins/lh-asserter/selftest.mjs
 */

import { createRegistry, selectAsserter, resolvePropagateTarget, DEFAULT_ASSERTER_ID } from './asserters.js'
import { virtualAsserter } from './asserters/virtual.js'
import { scopeOf } from '@lh/course-tree/tree'

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
 * 手工构造一棵最小树。
 * @param spec - `[{ id, parentId, level, title, asserter? }]`。
 * @returns `{ nodes, byId }`（parentOf/nodeChain 够用）。
 */
function mkTree(spec) {
  const byId = Object.create(null)
  for (const n of spec) byId[n.id] = { asserter: null, ...n }
  return { nodes: spec.map((n) => byId[n.id]), byId }
}

// 行测(a,L1) ← 资料分析(b,L2) ← 增长率(c,L3)；另一根 申论(r,L1) ← 写作(d,L2)
const TREE = mkTree([
  { id: 'a', parentId: null, level: 1, title: '行测' },
  { id: 'b', parentId: 'a', level: 2, title: '资料分析' },
  { id: 'c', parentId: 'b', level: 3, title: '增长率' },
  { id: 'r', parentId: null, level: 1, title: '申论' },
  { id: 'd', parentId: 'r', level: 2, title: '写作' },
])

const parentD = { propagate: { mode: 'parent' } }
const stopD = { propagate: { mode: 'stop' } }
const rootD = { propagate: { mode: 'node', target: 'root' } }
const level2D = { propagate: { mode: 'node', target: 2 } }
const level1D = { propagate: { mode: 'node', target: 1 } }
const idD = { propagate: { mode: 'node', target: 'a' } }
const badD = { propagate: { mode: 'node', target: '不存在' } }

const targetOf = (nodeId, d) => resolvePropagateTarget(TREE, nodeId, d).targetNodeId

console.log('=== 1. 传递路径：逐层(parent) 与到根停止 ===')
{
  check('parent: 增长率(c) → 资料分析(b)', targetOf('c', parentD) === 'b', targetOf('c', parentD))
  check('parent: 资料分析(b) → 行测(a)', targetOf('b', parentD) === 'a')
  check('parent: 行测(a) 到根 → null', targetOf('a', parentD) === null)
  check('默认（无 propagate 字段）按 parent', targetOf('c', {}) === 'b')
  check('默认（descriptor 为 null）按 parent', targetOf('c', null) === 'b')
}

console.log('\n=== 2. 传递路径：停止(stop) ===')
{
  check('stop: 任何节点都不传', targetOf('c', stopD) === null && targetOf('b', stopD) === null)
}

console.log('\n=== 3. 传递路径：跨层(node) ===')
{
  check('node:root: 增长率(c) → 行测(a)', targetOf('c', rootD) === 'a')
  check('node:root: 行测(a) 本身是根 → null', targetOf('a', rootD) === null)
  check('node:level 2: 增长率(c) → 资料分析(b)', targetOf('c', level2D) === 'b')
  check('node:level 2: 资料分析(b) 自身就在 L2 → null', targetOf('b', level2D) === null)
  check('node:level 1: 增长率(c) → 行测(a)', targetOf('c', level1D) === 'a')
  check('node:id "a": 增长率(c) → 行测(a)', targetOf('c', idD) === 'a')
  check('node:id 指向自身 → null', resolvePropagateTarget(TREE, 'a', { propagate: { mode: 'node', target: 'a' } }).targetNodeId === null)
  check('node:非法目标 → null', targetOf('c', badD) === null)
  check('跨树不串：写作(d) node:root → 申论(r)', targetOf('d', rootD) === 'r')
}

console.log('\n=== 4. selectAsserter：默认 / 指名 / 退回 ===')
{
  const custom = { id: 'custom', propagate: { mode: 'stop' }, async assert() { return { statement: 'x' } } }
  const registry = createRegistry([custom])
  check('注册表内置虚拟断言器', registry.get(DEFAULT_ASSERTER_ID) === virtualAsserter)
  check('节点未声明 asserter → 虚拟', selectAsserter({ asserter: null }, registry).id === 'virtual')
  check('节点声明 virtual → 虚拟', selectAsserter({ asserter: 'virtual' }, registry).id === 'virtual')
  check('节点声明 custom → custom', selectAsserter({ asserter: 'custom' }, registry).id === 'custom')
  check('节点声明未注册的 id → 退回虚拟（不断链）', selectAsserter({ asserter: 'nope' }, registry).id === 'virtual')
}

console.log('\n=== 5. 虚拟断言器：模型可用时（假 call）===')
{
  let captured = null
  const fakeCall = async (args) => {
    captured = args
    return { ok: true, text: '模型产出的那句断言', provider: 'deepseek', model: 'flash-x', degradation: undefined }
  }
  const node = TREE.byId.c
  const target = TREE.byId.b
  const res = await virtualAsserter.assert({
    input: '刚做了这道增长率题，算错了',
    node,
    tree: TREE,
    target,
    evidence: ['session/s1#7'],
    time: '2026-01-01T00:00:00.000Z',
    llm: {},
    call: fakeCall,
  })

  check('取模型文本作 statement', res.statement === '模型产出的那句断言', res.statement)
  check('confidence 中等(0.5)', res.confidence === 0.5)
  check('propagate_to 指向目标节点 scope', res.propagate_to === scopeOf('b'), res.propagate_to)
  check('model 记录 provider/model', res.model?.provider === 'deepseek' && res.model?.model === 'flash-x')

  const prompt = captured?.messages?.[0]?.content?.[0]?.text ?? ''
  check('用 flash 档', captured?.tier === 'flash', captured?.tier)
  check('合成消息 role=user', captured?.messages?.[0]?.role === 'user')
  check('合成消息标记来源插件', captured?.messages?.[0]?.source?.plugin === '@lh/asserter')
  check('提示词含节点标题「增长率」', prompt.includes('增长率'), prompt)
  check('提示词含层级「第 3 级」', prompt.includes('第 3 级'), prompt)
  check('提示词含输入摘要', prompt.includes('刚做了这道增长率题'), prompt)
  check('提示词含目标层级「第 2 层」', prompt.includes('第 2 层'), prompt)
  check('提示词含路径（行测 / 资料分析 / 增长率）', prompt.includes('行测 / 资料分析 / 增长率'), prompt)
}

console.log('\n=== 6. 虚拟断言器：模型不可用时 fallback 到模板 ===')
{
  const fakeCall = async () => ({ ok: false, failure: { code: 'NO_TIER_AVAILABLE', message: '没配 flash' }, attempts: [] })
  const res = await virtualAsserter.assert({
    input: '又做了一道题',
    node: TREE.byId.c,
    tree: TREE,
    target: TREE.byId.b,
    time: '2026-01-01T00:00:00.000Z',
    llm: {},
    call: fakeCall,
  })
  check('fallback 产出模板文本', res.statement.startsWith('本次断言是在'), res.statement)
  check('fallback 文本含节点标题与层级', res.statement.includes('增长率') && res.statement.includes('第 3 级'))
  check('fallback 文本含"传递给第 2 层"', res.statement.includes('传递给第 2 层'), res.statement)
  check('fallback confidence 低(0.2)', res.confidence === 0.2)
  check('fallback model=null', res.model === null)
  check('fallback 仍给出 propagate_to', res.propagate_to === scopeOf('b'))
}

console.log('\n=== 7. 虚拟断言器：到根/停止时 propagate_to=null ===')
{
  const fakeCall = async () => ({ ok: false })
  const res = await virtualAsserter.assert({
    input: '顶层的一句话',
    node: TREE.byId.a,
    tree: TREE,
    target: null,
    time: '2026-01-01T00:00:00.000Z',
    llm: {},
    call: fakeCall,
  })
  check('target=null → propagate_to=null', res.propagate_to === null)
  check('文本说明"已到顶层，不再向上传递"', res.statement.includes('已到顶层，不再向上传递'), res.statement)
}

console.log('\n=== 8. 虚拟断言器：call 抛错也走 fallback（绝不崩）===')
{
  const throwingCall = async () => { throw new Error('boom') }
  const res = await virtualAsserter.assert({
    input: '抛错场景',
    node: TREE.byId.c,
    tree: TREE,
    target: TREE.byId.b,
    time: '2026-01-01T00:00:00.000Z',
    llm: {},
    call: throwingCall,
  })
  check('call 抛错 → 仍产出模板文本', typeof res.statement === 'string' && res.statement.startsWith('本次断言是在'))
  check('call 抛错 → confidence 低、model=null', res.confidence === 0.2 && res.model === null)
}

console.log('')
if (fail > 0) {
  console.log(`══ 结果：${pass} 通过 / ${fail} 失败 ══`)
  process.exit(1)
}
console.log(`══ 结果：${pass} 通过 / 0 失败 ══`)
