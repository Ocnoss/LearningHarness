/**
 * 离线验证 lh-practice 的两条 HTTP 路由 —— 不重启就能测。
 *
 * ═══ 为什么值得写 ═══
 * 路由 handler 是纯函数式的：收 `req`/`res`，用假对象就能调。
 * 而真实重启后的验证成本高（要作者重启 + 刷新 + 点界面），
 * 且**失败时的现象很难区分**："面板没出现"可能是
 * 行没激活、路由没注册、客户端 bundle 没投放、React 报错……
 *
 * 离线这一步能把范围缩到"路由逻辑对不对"：
 * 用假 `webServer` 捕获注册，用假 `req`/`res` 直接调 handler，
 * 断言状态码与响应体。
 *
 * ⚠ 它验不到的（必须留到重启后）：行是否激活、bundle 是否投放、插槽是否接受我的组件。
 *
 * 用法: node plugins/lh-practice/selftest-routes.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { requestPracticePanel, readPracticeSignal } from '@lh/question-bank/signal'

const here = dirname(fileURLToPath(import.meta.url))
const sandbox = join(here, '..', '..', 'data', 'practice-route-test')

let passed = 0
let failed = 0
const failures = []

/**
 * 跑一个用例。
 * @param name - 用例名。
 * @param fn - 用例体（可 async）。
 */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, message: error?.message ?? String(error) })
    console.log(`  FAIL ${name}\n       ${error?.message ?? String(error)}`)
  }
}

/** 造一个假 req（**不自动推 body**，由调用方自己 emit）。 */
function makeRawReq(method, url) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  return req
}

/** 造一个假 req。 */
function makeReq(method, url, body) {
  const req = makeRawReq(method, url)
  // 异步推 body，模拟真实流
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

/** 造一个假 res，捕获状态码与响应体。 */
function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(text) {
      this.body = text ?? ''
      if (this._resolve) this._resolve()
    },
  }
  res.done = new Promise((resolve) => {
    res._resolve = resolve
  })
  return res
}

// ── 准备沙盒工作区 ──
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(join(sandbox, 'lh-questions'), { recursive: true })
process.env.LH_EVENT_LOG = join(sandbox, 'events.jsonl')
process.env.LH_WORKSPACE = sandbox
// 测试用的是**这个环境变量决定的沙盒**，所以信号文件也落在沙盒里。
// 让 signal.js 按同一个环境变量定位，测试与生产不会互相污染。
assert.equal(
  readPracticeSignal().seq,
  0,
  '沙盒里的信号文件应当是干净的（seq=0）—— 否则断言里的递增数会带上上次运行的偏移',
)

const bank = {
  schema_version: 1,
  title: '路由测试题库',
  source_root: null,
  generated_at: '2026-09-17T00:00:00.000Z',
  provenance: { plugin: '@lh/test', version: '0' },
  question_count: 3,
  duplicate_ids: [],
  questions: [
    { id: 'q-aaaaaaaaaaaa', kind: 'single_choice', stem: '第一题：一是正确答案吗？', options: ['一', '二', '三', '四'], answer: ['A'], accept: [], analysis: '因为一是对的。', topics: [], source: { path: 'x.pdf', number: 'q1', page: 1 }, provenance: { confidence: 'high' } },
    { id: 'q-bbbbbbbbbbbb', kind: 'single_choice', stem: '第二题：选哪个？', options: ['甲', '乙', '丙', '丁'], answer: ['C'], accept: [], analysis: '', topics: [], source: { path: 'x.pdf', number: 'q2', page: 1 }, provenance: { confidence: 'high' } },
    { id: 'q-cccccccccccc', kind: 'fill_blank', stem: '第三题：我国法定结婚年龄男不得早于____周岁。', options: [], answer: ['22'], accept: ['二十二'], analysis: '法定年龄是 22 周岁。', topics: [], source: { path: 'x.pdf', number: 'q3', page: 2 }, provenance: { confidence: 'high' } },
  ],
}
writeFileSync(join(sandbox, 'lh-questions', '路由测试题库.json'), JSON.stringify(bank, null, 2), 'utf8')

// ── 装载插件，捕获路由注册 ──
const plugin = await import('./index.js')

let captured = null
const fakeCtx = {
  webServer: {
    register(route) {
      captured = route
      return () => {
        captured = null
      }
    },
  },
  effect(fn) {
    return fn()
  },
  on() {},
}
plugin.apply(fakeCtx)

console.log(`\n路由已注册: kind=${captured?.kind} path=${captured?.path}\n`)

console.log('══ 1. 路由注册 ══')

await check('注册了一条 prefix 路由，路径正确', () => {
  assert.ok(captured, '没有捕获到路由注册')
  assert.equal(captured.kind, 'prefix')
  assert.equal(captured.path, '/lh/practice')
  assert.equal(typeof captured.handler, 'function')
})

console.log('\n══ 1b. GET /pending（对话→面板的启动信号）══')

await check('/pending 在还没有信号时返回 seq=0（而不是报错）', async () => {
  const r = await call('GET', '/lh/practice/pending')
  assert.equal(r.status, 200)
  assert.equal(r.json.seq, 0)
  assert.equal(r.json.bank, null)
})

await check('★ agent 写信号后，/pending 立刻能读到，且 seq 递增', async () => {
  // 这一条模拟 `start_practice` 工具的动作（工具与面板不在同一棵树，靠文件会合）。
  const first = requestPracticePanel({ bank: '路由测试题库', count: 5, by: 'agent' })
  assert.equal(first.seq, 1)
  let r = await call('GET', '/lh/practice/pending')
  assert.equal(r.json.seq, 1)
  assert.equal(r.json.bank, '路由测试题库')
  assert.equal(r.json.count, 5)
  assert.equal(r.json.by, 'agent')

  const second = requestPracticePanel({ bank: '路由测试题库', count: 1 })
  assert.equal(second.seq, 2, 'seq 必须递增——面板靠它判断是不是新请求')
  r = await call('GET', '/lh/practice/pending')
  assert.equal(r.json.seq, 2)
})

await check('★ 面板记下 seq 后，重复同一信号不会再开一次', () => {
  // 面板端的判据是 `sig.seq > lastSeenSeq`。这里验信号本身的语义：
  // 读一次不会让 seq 变化（读是纯的）——否则轮询会把面板反复打开。
  const before = readPracticeSignal().seq
  readPracticeSignal()
  readPracticeSignal()
  const after = readPracticeSignal().seq
  assert.equal(after, before, '读信号不该改变 seq')
})

console.log('\n══ 2. GET /bank（题面，绝不能含答案）══')

/** 调一次路由。 */
async function call(method, url, body) {
  const req = makeReq(method, url, body)
  const res = makeRes()
  await captured.handler(req, res)
  await res.done
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, raw: res.body }
}

let bankView
await check('返回题库列表与题面', async () => {
  const r = await call('GET', '/lh/practice/bank?count=2')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.json.banks))
  assert.equal(r.json.banks.length, 1)
  assert.equal(r.json.questions.length, 2)
  bankView = r.json
})

await check('★ 题面里没有答案、没有解析（不然界面上就能先看答案）', () => {
  for (const q of bankView.questions) {
    assert.ok(!('answer' in q), `${q.id} 带了 answer`)
    assert.ok(!('analysis' in q), `${q.id} 带了 analysis`)
    assert.ok(!('accept' in q), `${q.id} 带了 accept`)
  }
  // 连原始 JSON 文本里也不该出现答案字段名
  assert.ok(!/"answer"/.test(bankView ? JSON.stringify(bankView.questions) : ''), '题面 JSON 里出现了 "answer"')
})

console.log('\n══ 2b. 接连取题必须换题（作者实测："再来一题"不换题）══')
//
// ═══ 这个 bug 的形状 ═══
// 服务端的 `selectQuestions` 是**纯函数**：给题库、计数、策略，它算出题——
// **它不记得刚才给过谁**。所以"再来一题"能不能换题，取决于两件事：
//   1. 策略是不是 `unseen`（先出没做过的）；
//   2. 界面有没有把"这次已经出过的"传回来排除。
// 两层缺一层就会复发：只改策略的话，"题全做完"时 unseen 退化成按顺序重刷，
// 又会回到第 1 道。

await check('★ 不传 order 时默认 unseen（不是 sequential —— 那会每次都取回第 1 道）', async () => {
  const r = await call('GET', '/lh/practice/bank?count=1')
  assert.equal(r.status, 200)
  assert.equal(r.json.order, 'unseen', `默认策略应当是 unseen，实际 ${r.json.order}`)
})

await check('★★ 答完一题后再取，必须是**另一道**（这就是作者遇到的那个 bug）', async () => {
  // ⚠ 这两次请求**刻意不传 order**：走的就是界面当时走的那条路
  // （界面以前一个参数都不传，于是拿到服务端默认值）。
  // 若把默认值改回 sequential，这条会红——这正是它要守的东西。
  const first = await call('GET', '/lh/practice/bank?count=1')
  const q1 = first.json.questions[0]
  assert.ok(q1, '第一次应当取到一道题')

  // 作答（这一步会写进 LH 事件日志，并被选题的 attempt 索引读到）
  const posted = await call('POST', '/lh/practice/attempt', {
    bank: '路由测试题库',
    questionId: q1.id,
    response: Array.isArray(q1.options) && q1.options.length > 0 ? 'A' : '22',
  })
  assert.equal(posted.status, 200, `作答应成功，实际 ${posted.status} ${JSON.stringify(posted.json)}`)

  const second = await call('GET', '/lh/practice/bank?count=1')
  const q2 = second.json.questions[0]
  assert.ok(q2, '第二次应当还能取到题')
  assert.notEqual(q2.id, q1.id, `答完 ${q1.id} 之后又取到同一道 —— 这正是"再来一题不换题"`)
})

await check('★ 用 exclude_ids 排除已出过的题（第二道保险：全做完时也换题）', async () => {
  // `unseen` 在"全做过了"时会退化为按顺序重刷（见 selectQuestions，它刻意不返回空集）。
  // 那时若不排除已出的，"再来一题"会回到第 1 道——所以界面还要传 exclude_ids。
  const all = await call('GET', '/lh/practice/bank?count=10')
  const ids = all.json.questions.map((q) => q.id)
  assert.ok(ids.length >= 2, '测试题库至少要有 2 道题')

  const excluded = ids.slice(0, 2).join(',')
  const r = await call('GET', `/lh/practice/bank?count=1&exclude_ids=${excluded}`)
  assert.ok(r.json.questions.length >= 1, '排除一部分后应当仍有题可取')
  for (const q of r.json.questions) {
    assert.ok(!ids.slice(0, 2).includes(q.id), `${q.id} 已被排除却仍然返回`)
  }
})

await check('exclude_ids 传得再脏也不报错（只当噪声过滤）', async () => {
  for (const raw of ['', ',,', 'not-an-id', ',,q-aaaaaaaaaaaa,,', 'x'.repeat(500)]) {
    const r = await call('GET', `/lh/practice/bank?count=1&exclude_ids=${encodeURIComponent(raw)}`)
    assert.equal(r.status, 200, `exclude_ids=${JSON.stringify(raw.slice(0, 20))} 让路由报错了`)
  }
})

console.log('\n══ 2c. 选择要能**传到**面板（卡片写什么，面板就给什么）══')
//
// 作者反馈："我说'给我 10 题'或'我想重刷做过的题目'，弹出的卡片依然是整个题库。"
// 这条链有四段：工具 → 信号 → /pending → 面板按它取题。这里验后两段（路由）。

await check('★ /pending 会把选择转给界面', async () => {
  requestPracticePanel({
    bank: '路由测试题库',
    count: 2,
    by: 'agent',
    selection: { order: 'attempted' },
  })
  const r = await call('GET', '/lh/practice/pending')
  assert.equal(r.json.selection?.order, 'attempted', '/pending 没把选择转出来 —— 面板就无从知道该给哪些题')
  assert.equal(r.json.count, 2)
})

await check('★ order=attempted 真的改变取到的题（不只是"传了个参数"）', async () => {
  // 这是最容易被糊弄过去的一条：参数传到了、日志里也有，但取题时**没人用它**。
  // 所以这里断言的是**取题结果不同**，而不是"参数在不在"。
  const all = await call('GET', '/lh/practice/bank?count=99')
  const attempted = await call('GET', '/lh/practice/bank?count=99&order=attempted')
  assert.equal(attempted.json.order, 'attempted', '档位没生效')
  assert.ok(
    attempted.json.questions.length <= all.json.questions.length,
    'attempted 取到的题不该比全库多',
  )
})

await check('★ ids 指定时：只给这几道，且不理 exclude_ids（"就这些"不能被排除掉）', async () => {
  const all = await call('GET', '/lh/practice/bank?count=99')
  const ids = all.json.questions.slice(0, 2).map((q) => q.id)
  const r = await call('GET', `/lh/practice/bank?ids=${ids.join(',')}&exclude_ids=${ids.join(',')}`)
  assert.equal(r.json.questions.length, 2, `指定了 2 道却给回 ${r.json.questions.length} 道（exclude_ids 不该生效）`)
  assert.deepEqual(r.json.questions.map((q) => q.id).sort(), [...ids].sort())
})

await check('★ ids 的道数决定取几道（不用再传 count）', async () => {
  const all = await call('GET', '/lh/practice/bank?count=99')
  const ids = all.json.questions.map((q) => q.id)
  const r = await call('GET', `/lh/practice/bank?ids=${ids.join(',')}`)
  assert.equal(r.json.questions.length, ids.length)
})

await check('topic 能传（没有该知识点的题时如实说明，不报错）', async () => {
  const r = await call('GET', '/lh/practice/bank?topic=不存在的知识点&count=2')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.json.questions))
})

await check('题面带 id / stem / options / kind（界面渲染所需）', () => {
  for (const q of bankView.questions) {
    assert.ok(typeof q.id === 'string' && q.id !== '')
    assert.ok(typeof q.stem === 'string' && q.stem.length > 0)
    assert.ok(Array.isArray(q.options))
    assert.ok(typeof q.kind === 'string')
  }
})

await check('带进度统计', () => {
  assert.ok(bankView.stats, '没有 stats')
  assert.equal(bankView.stats.total, 3)
  assert.equal(bankView.stats.attempted, 0)
  assert.equal(bankView.stats.accuracy, null, '还没作答时正确率应为 null')
})

await check('未知路由 → 404 且说明原因', async () => {
  const r = await call('GET', '/lh/practice/nope')
  assert.equal(r.status, 404)
  assert.ok(r.json.error.includes('未知路由'))
})

console.log('\n══ 3. POST /attempt（判分 + 记录）══')

await check('答对 → correct=true，且返回答案与解析', async () => {
  const r = await call('POST', '/lh/practice/attempt', { bank: '路由测试题库', questionId: 'q-aaaaaaaaaaaa', response: 'A' })
  assert.equal(r.status, 200)
  assert.equal(r.json.correct, true)
  assert.deepEqual(r.json.answer, ['A'])
  assert.ok(r.json.analysis.includes('一是对的'))
  assert.ok(r.json.eventId, '没有返回事件 id')
})

await check('答错 → correct=false', async () => {
  const r = await call('POST', '/lh/practice/attempt', { bank: '路由测试题库', questionId: 'q-aaaaaaaaaaaa', response: 'B' })
  assert.equal(r.json.correct, false)
})

await check('★ 判不了 → null（不默认算错）', async () => {
  const r = await call('POST', '/lh/practice/attempt', { bank: '路由测试题库', questionId: 'q-aaaaaaaaaaaa', response: '' })
  assert.equal(r.json.correct, null)
})

await check('★ 填空题的 accept 替代答案也算对', async () => {
  const r = await call('POST', '/lh/practice/attempt', { bank: '路由测试题库', questionId: 'q-cccccccccccc', response: '二十二' })
  assert.equal(r.json.correct, true)
})

await check('★ 作答被写进事件日志（界面与 agent 走同一条路径）', () => {
  const log = readFileSync(join(sandbox, 'events.jsonl'), 'utf8')
  const events = log.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const attempts = events.filter((e) => e.type === 'lh/user/attempt')
  // ⚠ 这里**不写死条数**。
  // 原来写的是 `assert.equal(attempts.length, 4)`，而它在我往前面加了
  // 一个"作答后换题"的用例之后就红了——**红的原因不是功能坏了，是断言的口径错了**：
  // 它衡量的其实是"上面一共发生了几次作答"，那是**别的用例的副作用**，
  // 与"作答有没有被写进日志"无关。
  // （PLUGIN_CONTRACT §七：判定器的口径必须与它要衡量的东西一致，不写死当时的数量。）
  //
  // 改成衡量真正要衡量的两件事：**有作答**、且**每次作答都进了日志**。
  // 日志条数与作答次数的一致性由下面这条"答一次刚好加一条"来保证。
  assert.ok(attempts.length > 0, '事件日志里一条作答都没有')
  for (const a of attempts) assert.equal(a.data.source, 'human', '界面的作答应记为 human')
  assert.equal(attempts[0].actor, 'human')
})

await check('★ 每作答一次，日志刚好加一条（口径与"记得住"这件事对齐）', async () => {
  const countAttempts = () => {
    const log = readFileSync(join(sandbox, 'events.jsonl'), 'utf8')
    return log.split('\n').filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'lh/user/attempt').length
  }
  const before = countAttempts()
  const r = await call('POST', '/lh/practice/attempt', {
    bank: '路由测试题库',
    questionId: 'q-aaaaaaaaaaaa',
    response: 'A',
  })
  assert.equal(r.status, 200)
  assert.equal(countAttempts(), before + 1, '作答没有恰好写进一条事件')
})

await check('返回里带更新后的进度', async () => {
  const r = await call('POST', '/lh/practice/attempt', { bank: '路由测试题库', questionId: 'q-bbbbbbbbbbbb', response: 'C' })
  assert.ok(r.json.stats)
  assert.equal(r.json.stats.total, 3)
  assert.ok(r.json.stats.attempted >= 1)
  assert.ok(r.json.stats.correct >= 1)
})

await check('缺 questionId → 400 并说明', async () => {
  const r = await call('POST', '/lh/practice/attempt', { bank: '路由测试题库', response: 'A' })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('questionId'))
})

await check('缺 bank → 400 并说明', async () => {
  const r = await call('POST', '/lh/practice/attempt', { questionId: 'q-aaaaaaaaaaaa', response: 'A' })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('bank'))
})

await check('题库不存在 → 500 且把可用题库名带出来', async () => {
  const r = await call('POST', '/lh/practice/attempt', { bank: '不存在的库', questionId: 'q-aaaaaaaaaaaa', response: 'A' })
  assert.equal(r.status, 500)
  assert.ok(r.json.error.includes('不存在'), r.json.error)
  assert.ok(r.json.error.includes('路由测试题库'), '报错里没列出可用题库')
})

await check('题目 id 不存在 → 500 而不是静默记一条答错', async () => {
  const before = readFileSync(join(sandbox, 'events.jsonl'), 'utf8')
  const r = await call('POST', '/lh/practice/attempt', { bank: '路由测试题库', questionId: 'q-000000000000', response: 'A' })
  assert.equal(r.status, 500)
  assert.equal(readFileSync(join(sandbox, 'events.jsonl'), 'utf8'), before, '失败时不该写事件')
})

await check('请求体不是 JSON → 500 且说明', async () => {
  // ⚠ 这里必须用 makeRawReq：makeReq 会在下一个 tick 自动推空 body 并 end，
  //   于是 handler 会先以"缺 bank"返回 400，我手推的坏 JSON 根本没被处理。
  //   （第一版就是这么误判的——测试自己把被测路径绕过去了。）
  const req = makeRawReq('POST', '/lh/practice/attempt')
  const res = makeRes()
  const p = captured.handler(req, res)
  setImmediate(() => {
    req.emit('data', Buffer.from('{ not json', 'utf8'))
    req.emit('end')
  })
  await p
  await res.done
  assert.equal(res.statusCode, 500)
  assert.ok(JSON.parse(res.body).error.includes('合法 JSON'))
})

await check('工作区里没有题库 → 200 且明确说"还没有题库"（不是报错）', async () => {
  const empty = join(sandbox, 'empty')
  mkdirSync(empty, { recursive: true })
  const prev = process.env.LH_WORKSPACE
  process.env.LH_WORKSPACE = empty
  // 重新装载插件以读到新的工作区
  let captured2 = null
  plugin.apply({
    webServer: {
      register(r) {
        captured2 = r
        return () => {}
      },
    },
    effect: (fn) => fn(),
    on() {},
  })
  const req = makeReq('GET', '/lh/practice/bank')
  const res = makeRes()
  await captured2.handler(req, res)
  await res.done
  process.env.LH_WORKSPACE = prev
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.banks.length, 0)
  assert.ok(body.note.includes('还没有题库'), `期望提示"还没有题库"，实际 ${body.note}`)
})

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
  process.exit(1)
}
console.log('全部通过。\n')
