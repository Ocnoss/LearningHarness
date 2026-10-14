/**
 * lh-model-tier —— LH 的模型档位中间件。
 *
 * ═══ 它在链上的位置 ═══
 *
 *   用户 ──对话──> 导师 agent / 课程 subagent
 *                       │  ① 这次对话用哪个模型 → 宿主 adaptor（不在本插件管辖）
 *                       ↓
 *                  agent 调用插件
 *                       │  ② 插件声明它建议用哪个档位（recommend_model）
 *                       ↓
 *                 ┌── lh-model-tier ──┐
 *                 │  ③ 档位 → 具体模型；不可用则降级并留痕
 *                 ↓
 *                 dsh adaptor（渠道层，完全复用，不改）
 *
 * ═══ 三条设计约定（作者 2026-09-16 逐轮定下）═══
 * 1. **建议而非要求**：插件声明的是"建议档位"，不满足时给提示，**不阻断**。
 *    理由：插件只知道自己建议了强模型，"弱模型做不了"是它**不可能有的知识**；
 *    硬拒绝等于用拒绝惩罚用户（与契约 §3.1 的反奖惩立场同构）。
 * 2. **告知而非阻断**：档位可用性写进运行时上下文（几行字），
 *    让 agent **在计划时就知道**，于是它可以在**自然边界**问用户——
 *    而不是等计划 5 分钟、动工之后才发现，那时用户已被排除在上下文之外。
 * 3. **降级必须留痕**：每次调用的档位/实际模型/降级原因写进 LH 事件。
 *    不是惩罚，是**出处**——仪器降级会让"策略失败"被误判（契约 §5.3：
 *    测量仪器质量是策略评估的天花板）。
 *
 * ═══ 本插件绝不做什么 ═══
 * - **不弹框**、不调 `ctx.approval`：弹框时机由调用点决定，而调用点可能在
 *   工作流深处——那正是最差的时机。**问用户是 agent 的活**（agent 能同时给出
 *   "换拆解路径 / 去配模型 / 终止"这些选项，而不只是一个是/否）。
 * - **不隐藏工具**：那等于系统替用户判断"你做不到这件事"。
 * - **不改宿主 adaptor**：渠道层是宿主代码，动它就要跟着 dsh 版本重打补丁。
 *
 * ═══ 怎么被别的插件用 ═══
 * 直接 import（理由见 docs/archive/decisions/014 补充决定 6：preset 是 agent 作用域，
 * 够不着 host 面发布的服务）：
 *
 *   import { callModel } from '../lh-model-tier/model.js'
 *
 *   const { text, degradation } = await callModel({
 *     llm: ctx.llm, store, tier: 'flash', messages, provenance: { plugin: '...' },
 *   })
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTierConfig, resolveTier, makeProviderCheck, TIERS } from './tier.js'
import { callModel, textMessage } from './model.js'

/** 插件名。 */
export const name = 'lh-model-tier'

/**
 * 声明依赖的宿主服务。
 *
 * `llm` 用于解析 provider 与发起调用；它在 preset 作用域实测可得
 * （web profile 下 `listProviders()` 返回 3）。
 *
 * ⚠ `systemPrompt` **刻意不放进硬 inject**（2026-10-13，与 course-tree / schedule 对齐）：
 *   它只是可选增强（把档位可用性写进上下文）。硬依赖会让"这一层没有 systemPrompt"
 *   变成"整个插件不激活"——`tier()` 随之消失。上下文改用
 *   `ctx.inject(['systemPrompt'], …)` 等它（拿不到只是不注入）。
 */
export const inject = ['llm']

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 按量计费的 provider 清单。
 *
 * 只为一件事服务：档位提示词里把"这档跑一次花一次钱"显式标出来
 * （事故 B：agent 自传 deepseek-flash 跑按量计费抽取，真金白银损失——
 * 诱饵之一就是提示词没说清计费性质）。
 *
 * ⚠ 需随 provider 变动**人工更新**：新增按量计费渠道时把 id 加进来；
 * 包月/固定额度的渠道不进此清单。
 */
const PAYG_PROVIDERS = new Set(['deepseek-official'])

/**
 * 记一条调试痕迹（与 LH 事件严格分开）。
 * @param line - 文本。
 */
function trace(line) {
  try {
    appendFileSync(join(HERE, 'trace.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

/**
 * 渲染"档位可用性"那段上下文。
 *
 * 形态照宿主的政策类上下文（`dsh-sandbox-policy` 的 `sandbox:policy`、
 * `dsh-user-approval` 的 `approval:policy`）——它们就是在同一位置注入几句事实。
 * **只陈述事实与建议，不下命令**：agent 自有判断。
 * 唯一例外（2026-10-13，事故 B 后的降诱饵）：**计费模型的选择权**——
 * 档位建议必须显式声明"仅供使用者决策、agent 不得自行切换计费模型"，
 * 按量计费的档要标注"按量计费"。真金白银的损失是硬约束，不留给 agent 判断。
 *
 * @param params.tiers - 档位配置。
 * @param params.isProviderAvailable - provider 预检。
 * @returns 供模型读的文本；无可用档位时说明情况。
 */
export function renderTierContext({ tiers, isProviderAvailable }) {
  const lines = []
  for (const tier of TIERS) {
    const resolved = resolveTier({ tier, tiers, isProviderAvailable })
    if (resolved.selection === undefined) {
      // 不可用时只给原因，不重复"不可用"这句话——原因本身已经说明了
      const reason = resolved.notes.filter((n) => !n.includes('都未注册')).join('；')
      lines.push(`${tier}：当前无可用模型${reason === '' ? '' : `（${reason}）`}`)
      continue
    }
    const s = resolved.selection
    const payg = PAYG_PROVIDERS.has(s.provider) ? '（按量计费）' : ''
    const note = resolved.notes.length > 0 ? `（${resolved.notes.join('；')}）` : ''
    lines.push(`${tier}：${s.provider} / ${s.model}${payg}${note}`)
  }

  return [
    '模型档位（插件可按档位建议模型；这是建议，不满足时不阻断）：',
    ...lines.map((l) => `- ${l}`),
    '⚠ 档位建议仅供使用者决策、agent 不得自行切换计费模型：换档位/换模型必须由使用者改配置（如 data/model-tiers.json），agent 需要换模型时应在计划阶段向使用者说明并给出选项。',
    '若某任务建议的档位当前不可用，请在计划阶段告知用户并给出选择：照常执行（质量或成本可能受影响）、换一条插件组合路径、去配置对应模型、或终止。',
  ].join('\n')
}

/**
 * 插件体。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const { tiers, notes } = loadTierConfig()
  const isProviderAvailable = makeProviderCheck(ctx.llm)

  trace(`APPLY_CALLED  档位配置说明=${notes.length === 0 ? '(无)' : notes.join(' / ')}`)
  for (const tier of TIERS) {
    const r = resolveTier({ tier, tiers, isProviderAvailable })
    trace(`  ${tier} → ${r.selection === undefined ? '(不可用)' : r.selection.provider + '/' + r.selection.model}${r.notes.length ? '  ' + r.notes.join('; ') : ''}`)
  }

  // ── 把档位可用性写进运行时上下文 ──
  //
  // `text` 是每次组装时求值的函数，所以它反映的是**当刻**的可用性
  // （provider 注册情况可能随设置热重载变化）。
  // order 取 116：与宿主的政策类上下文（sandbox 110、approval 115）同带，
  // 排在它们之后——资源情况应当在策略之后陈述。
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'lh:model-tiers',
      order: 116,
      text: (context) => {
        // 没有 agent 就不注入（与宿主两个范例一致：诊断性组装不带 agent）
        if (context.agent === undefined) return ''
        return renderTierContext({ tiers, isProviderAvailable })
      },
    })
    trace('CONTEXT_REGISTERED  name=lh:model-tiers  order=116')
  })

  // ── 自检（默认关闭）──
  //
  // 为什么默认关闭：它每次 preset 挂载都会**真实调用一次模型**（消耗 token）。
  // 新建一个 LH 会话就白花一次调用是不可接受的，所以用环境变量显式打开：
  //   $env:LH_MODEL_TIER_SELFTEST = '1'   （启动 dsh 前设置）
  //
  // 为什么留在插件里而不是单独的探针：探针退役后，"这条链此刻通不通"
  // 仍然需要一个一眼可查的答案（provider 配置变动时尤其有用）。
  // 自检结果写进 trace.log，与插件本身的调试信息在一起。
  if (process.env.LH_MODEL_TIER_SELFTEST === '1') {
    void (async () => {
      trace('SELFTEST_BEGIN')
      for (const tier of TIERS) {
        const r = await callModel({
          llm: ctx.llm,
          tier,
          tiers,
          messages: [textMessage({ text: '请只回复两个字：收到', pluginId: name })],
          maxTokens: 32,
          temperature: 0,
        })
        if (r.ok) {
          trace(`  ${tier} → ✓ ${r.provider}/${r.model}  回复=${JSON.stringify(r.text.trim().slice(0, 40))}  usage=${JSON.stringify(r.usage)}${r.degradation ? '  降级：' + r.degradation : ''}`)
        } else {
          trace(`  ${tier} → ✗ ${r.failure?.code}  ${r.failure?.message}  试过：${r.attempts.join(' > ')}`)
        }
      }
      trace('SELFTEST_DONE')
    })()
  }

  trace('APPLY_DONE')
}
