/**
 * 验证档位解析器：正常解析 + 三种降级。
 *
 * 作者的要求是"连降级策略也一并交给插件"，所以降级路径必须被验证，
 * 而不是只测"配对了能不能跑"。这里用假的可用性函数覆盖：
 *   1. 全部 provider 都在 → 取首选；
 *   2. 首选 provider 不在 → 跳到下一个候选并给出说明；
 *   3. 档位整个没配 → 退回 balance 并说明；
 *   4. 全部 provider 都不在 → 返回 undefined（让调用方决定跳过，而不是用错模型硬跑）。
 */
import {
  loadTierConfig,
  resolveTier,
  makeProviderCheck,
  DEFAULT_TIERS,
  TIERS,
} from '../plugins/lh-model-tier/tier.js'

console.log('=== 一、加载档位配置 ===')
const { tiers, notes } = loadTierConfig()
console.log(`  档位数：${Object.keys(tiers).join(', ')}`)
console.log(`  加载说明：${notes.length === 0 ? '（无）' : notes.join(' / ')}`)
for (const name of TIERS) {
  console.log(`  ${name}: ${tiers[name].map((c) => `${c.provider}/${c.model}`).join('  >  ')}`)
}

/** 造一个假的 provider 预检：只有列出的 provider 算已注册。 */
const providersIn = (...list) => (provider) => list.includes(provider)

console.log('\n=== 二、正常解析（三个 provider 都注册）===')
for (const name of TIERS) {
  const r = resolveTier({ tier: name, tiers, isProviderAvailable: providersIn('deepseek-official', 'xiaomi-token-plan-ams', 'kimi-coding') })
  console.log(`  ${name} → ${r.selection?.provider}/${r.selection?.model}${r.notes.length ? '  说明: ' + r.notes.join('; ') : ''}`)
}

console.log('\n=== 三、降级 1：首选的 provider 未注册 ===')
{
  const r = resolveTier({
    tier: 'flash',
    tiers,
    // 故意不注册 xiaomi，flash 的首选是它
    isProviderAvailable: providersIn('deepseek-official'),
  })
  console.log(`  结果 → ${r.selection?.provider}/${r.selection?.model}`)
  console.log(`  候选链 → ${r.candidates.map((c) => c.provider + '/' + c.model).join(' > ')}`)
  console.log(`  说明 → ${r.notes.join('; ')}`)
}

console.log('\n=== 四、降级 2：档位没配置 ===')
{
  const partial = { balance: DEFAULT_TIERS.balance }
  const r = resolveTier({ tier: 'max', tiers: partial, isProviderAvailable: providersIn('deepseek-official') })
  console.log(`  结果 → ${r.selection?.provider}/${r.selection?.model}`)
  console.log(`  说明 → ${r.notes.join('; ')}`)
}

console.log('\n=== 五、降级 3：候选的 provider 全都没注册 ===')
{
  const r = resolveTier({ tier: 'flash', tiers, isProviderAvailable: providersIn('kimi-coding') })
  console.log(`  结果 → ${r.selection === undefined ? 'undefined（交调用方决定跳过）' : r.selection.provider + '/' + r.selection.model}`)
  console.log(`  说明 → ${r.notes.join('; ')}`)
}

console.log('\n=== 六、真实宿主 llm 服务不可用时（插件在 profile 面、拿不到 llm）===')
{
  const check = makeProviderCheck(undefined)
  const r = resolveTier({ tier: 'balance', tiers, isProviderAvailable: check })
  console.log(`  provider 预检结果 → ${check('deepseek-official')}`)
  console.log(`  解析结果 → ${r.selection === undefined ? 'undefined（并说明原因）' : '有 selection'}`)
  console.log(`  说明 → ${r.notes.join('; ')}`)
}
