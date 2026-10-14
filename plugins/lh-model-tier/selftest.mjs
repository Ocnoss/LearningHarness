/**
 * lh-model-tier 的模型白名单自测（T4.1 堵漏）。
 *
 * ═══ 它测什么、不测什么 ═══
 * 它测 callModel 的**候选链白名单硬闸**：档位解析出来的候选（含 tiers override
 * 与配置文件里的）有一条越过授权集，就必须整次拒绝，而且**一次真实调用都不发生**。
 *
 * 这是事故 B（agent 自传 provider/model 跑了按量计费模型，真金白银损失）
 * 的最后一道闸：工具入参那道闸在 lh-question-bank，这道闸守的是
 * "配置被改坏/override 被塞进坏组合"的注入面。
 *
 * 不测真实模型调用——那要宿主的 llm 服务，这里用假的（只实现
 * listProviders/stream 两个插件真正用到的入口）。
 *
 * 第 3 节测 renderTierContext 的降诱饵措辞（T4.4）：提示词必须声明
 * "仅供使用者决策、agent 不得自行切换计费模型"，且按量计费的档要标出来。
 *
 * 运行：node plugins/lh-model-tier/selftest.mjs
 */

import assert from 'node:assert/strict'

import { callModel, assertWhitelistedModel } from './model.js'
import { renderTierContext } from './index.js'

let passed = 0
let failed = 0
const failures = []

/**
 * 跑一个用例。
 *
 * @param name - 用例名。
 * @param fn - 用例体（可 async）。
 */
async function check(name, fn) {
  try {
    // 必须 await：不 await 的话，异步断言会在 try 之外 reject，
    // 于是「代码正确拒绝了」被记成失败、而真正的失败被记成通过——测试变成随机噪声。
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, message: error?.message ?? String(error) })
    console.log(`  FAIL ${name}\n       ${error?.message ?? String(error)}`)
  }
}

/**
 * 造一个假的 `ctx.llm`。
 *
 * 只实现插件真正用到的两个入口：`listProviders()`（provider 预检）与
 * `stream()`（真实调用）。`failFor` 里的模型会在 finish 里报失败——
 * 用来验"白名单内的降级链仍然工作"。
 *
 * @param params.providers - 已注册的 provider id 列表。
 * @param params.failFor - 这些模型的调用以失败结束。
 * @returns `{ listProviders, stream, calls }`，`calls` 记录真实发起过的调用。
 */
function makeFakeLlm({ providers = ['xiaomi-token-plan-ams', 'deepseek-official'], failFor = [] } = {}) {
  const calls = []
  return {
    calls,
    listProviders: () => providers.map((id) => ({ id })),
    stream({ provider, model }) {
      calls.push({ provider, model })
      return (async function* () {
        if (failFor.includes(model)) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: '假的鉴权失败' } } }
          return
        }
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'usage', usage: { input: 1, output: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** 造一个假的事件存储，把 append 过的东西全记下来。 */
function makeFakeStore() {
  const captured = []
  return { captured, store: { append: (e) => { captured.push(e); return e } } }
}

const GOOD = { provider: 'xiaomi-token-plan-ams', model: 'mimo-v2.5-pro' }
const ALSO_GOOD = { provider: 'xiaomi-token-plan-ams', model: 'mimo-v2.5' }
const GOOD_WHITELIST = { combos: [GOOD, ALSO_GOOD], notes: [] }

console.log('\n══ 1. callModel 候选链白名单硬闸 ══')

await check('★ 候选链里有白名单外的组合 → 整次拒绝，且一次真实调用都不发生', async () => {
  const llm = makeFakeLlm()
  const { captured, store } = makeFakeStore()
  await assert.rejects(
    async () =>
      callModel({
        llm,
        tier: 'flash',
        messages: [],
        tiers: { flash: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] },
        whitelist: GOOD_WHITELIST,
        store,
      }),
    (e) => {
      assert.match(e.message, /模型不在白名单/)
      assert.match(e.message, /须由使用者改配置，agent 不得自选计费模型/)
      return true
    },
  )
  assert.equal(llm.calls.length, 0, `闸门必须在真实调用之前：实际发起了 ${llm.calls.length} 次调用`)
  const evs = captured.filter((e) => e.type === 'lh/security/rejected-model')
  assert.equal(evs.length, 1, '拒绝必须留审计事件')
  assert.equal(evs[0].data.tool, 'callModel')
  assert.equal(evs[0].data.requested_provider, 'deepseek-official')
  assert.equal(evs[0].data.requested_model, 'deepseek-flash')
})

await check('★ 第二个候选越界也整体拒绝（不许"先跑起来再说"）', async () => {
  // 候选链 = [合法, 非法]。哪怕首选合法，整条链里有一条越界就全拒——
  // 否则"配置里塞一条按量计费的降级候选"就成了绕过闸门的后门。
  const llm = makeFakeLlm()
  const { store } = makeFakeStore()
  await assert.rejects(
    async () =>
      callModel({
        llm,
        tier: 'flash',
        messages: [],
        tiers: { flash: [GOOD, { provider: 'deepseek-official', model: 'deepseek-flash' }] },
        whitelist: GOOD_WHITELIST,
        store,
      }),
    /模型不在白名单/,
  )
  assert.equal(llm.calls.length, 0, '一次真实调用都不该发生')
})

await check('白名单内候选正常放行并返回结果（闸门不误伤）', async () => {
  const llm = makeFakeLlm()
  const { captured, store } = makeFakeStore()
  const r = await callModel({
    llm,
    tier: 'flash',
    messages: [],
    tiers: { flash: [GOOD] },
    whitelist: GOOD_WHITELIST,
    store,
  })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'ok')
  assert.equal(r.model, GOOD.model)
  assert.equal(r.provider, GOOD.provider)
  assert.equal(llm.calls.length, 1)
  assert.equal(captured.filter((e) => e.type === 'lh/security/rejected-model').length, 0, '放行不该写拒绝事件')
})

await check('白名单内的降级链仍然工作（首选失败 → 次选接手）', async () => {
  const llm = makeFakeLlm({ failFor: [GOOD.model] })
  const { store } = makeFakeStore()
  const r = await callModel({
    llm,
    tier: 'flash',
    messages: [],
    tiers: { flash: [GOOD, ALSO_GOOD] },
    whitelist: GOOD_WHITELIST,
    store,
  })
  assert.equal(r.ok, true)
  assert.equal(r.model, ALSO_GOOD.model, '应当降级到第二个候选')
  assert.equal(r.attempts.length, 2)
})

await check('★ tiers override 塞进坏组合也照样拒（override 是注入面）', async () => {
  const llm = makeFakeLlm()
  const { store } = makeFakeStore()
  await assert.rejects(
    async () =>
      callModel({
        llm,
        tier: 'balance',
        messages: [],
        // 模拟"配置被改坏"：balance 档指向按量计费的 deepseek-flash
        tiers: { balance: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] },
        whitelist: { combos: [GOOD], notes: [] },
        store,
      }),
    /模型不在白名单/,
  )
  assert.equal(llm.calls.length, 0)
})

console.log('\n══ 2. assertWhitelistedModel 与 callModel 的记账一致性 ══')

await check('callModel 的拒绝事件带上 requested_provider/model（审计能重建事故）', async () => {
  const llm = makeFakeLlm()
  const { captured, store } = makeFakeStore()
  await assert.rejects(
    async () =>
      callModel({
        llm,
        tier: 'flash',
        messages: [],
        // provider 必须是已注册的——未注册的 provider 在预检层就被过滤，
        // 根本到不了白名单闸（也确实发不出计费调用）。事故 B 的形状是
        // “已注册的 provider + 自选的 model”，这里就照那个形状造。
        tiers: { flash: [{ provider: 'deepseek-official', model: 'gpt-4o' }] },
        whitelist: GOOD_WHITELIST,
        store,
      }),
    /模型不在白名单/,
  )
  const ev = captured.find((e) => e.type === 'lh/security/rejected-model')
  assert.ok(ev !== undefined)
  assert.equal(ev.data.requested_provider, 'deepseek-official')
  assert.equal(ev.data.requested_model, 'gpt-4o')
  assert.equal(ev.data.reason, 'not-in-model-whitelist')
})

await check('记账失败不掩盖拒绝（错误里要带出记账失败）', async () => {
  const brokenStore = { append: () => { throw new Error('磁盘满了') } }
  await assert.rejects(
    async () =>
      assertWhitelistedModel({ provider: 'evil-corp', model: 'gpt-4o', whitelist: GOOD_WHITELIST, store: brokenStore }),
    (e) => {
      assert.match(e.message, /须由使用者改配置/)
      assert.match(e.message, /记账失败/)
      return true
    },
  )
})

console.log('\n══ 3. renderTierContext 降诱饵措辞（T4.4）══')

const wordingTiers = {
  flash: [GOOD],
  balance: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
  max: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
}
const allProviders = () => true

await check('★ 提示词带显式约束：仅供使用者决策、agent 不得自行切换计费模型', () => {
  const text = renderTierContext({ tiers: wordingTiers, isProviderAvailable: allProviders })
  assert.match(text, /仅供使用者决策/)
  assert.match(text, /agent 不得自行切换计费模型/)
})

await check('★ balance/max 指向按量计费模型时显式标注"按量计费"', () => {
  const text = renderTierContext({ tiers: wordingTiers, isProviderAvailable: allProviders })
  const balanceLine = text.split('\n').find((l) => l.startsWith('- balance：'))
  const maxLine = text.split('\n').find((l) => l.startsWith('- max：'))
  assert.ok(balanceLine !== undefined, '缺 balance 行')
  assert.ok(maxLine !== undefined, '缺 max 行')
  assert.match(balanceLine, /按量计费/)
  assert.match(maxLine, /按量计费/)
})

await check('非按量计费的档不标"按量计费"（不误伤包月渠道）', () => {
  const text = renderTierContext({ tiers: wordingTiers, isProviderAvailable: allProviders })
  const flashLine = text.split('\n').find((l) => l.startsWith('- flash：'))
  assert.ok(flashLine !== undefined, '缺 flash 行')
  assert.doesNotMatch(flashLine, /按量计费/)
})

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
  process.exit(1)
}
console.log('全部通过。\n')
