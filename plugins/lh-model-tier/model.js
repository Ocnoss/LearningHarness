/**
 * lh-model-tier 的调用端 —— 插件用它来"按档位调模型"。
 *
 * ═══ 为什么单独成文件 ═══
 * 与 `lh-event-store/store.js` 同构：preset 是 agent 作用域，够不着 host 面发布的
 * 服务（docs/archive/decisions/014 补充决定 6），所以共享逻辑靠**直接 import**。
 * 别的插件这样用：
 *
 *   import { callModel } from '../lh-model-tier/model.js'
 *
 * ═══ 它保证的三件事 ═══
 * 1. **尽力而为**：按候选链逐个试，真实调用失败才换下一个
 *    （目录是"建议性"的——宿主明说 consumers must not turn absence into request rejection，
 *     所以只有真实调用才知道模型 id 是否被适配器接受）；
 * 2. **永不阻断**：任何情况下都返回结果或明确的失败，从不弹框、从不拒绝。
 *    唯一的例外是**模型白名单**（T4.1 堵漏，见下方“模型白名单”一节）：
 *    候选或入参指向白名单外的模型时**抛错拒绝**——计费保护优先于可用性。
 *    那是“拒绝一次调用”，不是“阻断学习”；
 * 3. **降级留痕**：把"用了哪个模型、为什么不是建议的那个"作为数据返回，
 *    由调用方写进 LH 事件（出处是审计性的，不是惩罚性的）。
 */

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { LhEventStore } from '@lh/event-store/store'
import { loadTierConfig, resolveTier, makeProviderCheck, tierConfigPath, DEFAULT_TIERS } from './tier.js'

/**
 * 造一条最小的用户消息。
 *
 * 手搓而不 import 宿主的 `createUserMessage`：宿主确实导出了
 * `@deepseek-ai/dsh-llm/message`，但**工作区解析不到任何 dsh 包**
 * （见 docs/archive/decisions/014 那张表）。`Message` 形状很简单，手搓零依赖更稳。
 *
 * source 用 `plugin` 分支——于是"这条不是人类输入"在消息本身就有标记，
 * 分类器正需要这个区分。
 *
 * @param params.text - 消息文本。
 * @param params.pluginId - 产生它的插件 id。
 * @param params.name - 该上下文的名字（写进 source.sections）。
 * @returns UserMessage 形状的对象。
 */
export function textMessage({ text, pluginId, name = pluginId }) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: pluginId,
      form: 'snapshot',
      sections: [{ name, text }],
    },
  }
}

/**
 * 从 chunk 流里收集文本、用量与失败。
 *
 * 为什么手拼而不用宿主的 assembler：我们要的只是"文本 + usage + 失败原因"，
 * 少一个依赖就少一处可能出错的地方。而且**必须把 finish 里的失败读出来**——
 * 第一版漏读它，导致失败被误读成"回复为空"（白追一轮）。
 *
 * @param stream - 宿主的 chunk 流。
 * @returns `{ text, usage, failure, chunkCount }`。
 */
export async function collectStream(stream) {
  let text = ''
  let usage
  let failure
  let chunkCount = 0

  for await (const chunk of stream) {
    chunkCount += 1
    const kind = chunk?.type
    if (kind === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (kind === 'usage') usage = chunk.usage
    else if (kind === 'finish') {
      const reason = chunk.reason
      if (reason?.kind === 'error') failure = reason.failure
    }
  }

  return { text, usage, failure, chunkCount }
}

// ═══════════════════════════════════════════════════════════════
// 模型白名单（T4.1 堵漏：防 agent 自主换计费模型）
// ═══════════════════════════════════════════════════════════════
//
// 事故背景：主会话 agent 自传 `provider:"deepseek-official", model:"deepseek-flash"`
// 给 import_questions_from_source，跑了按量计费模型，造成真实金钱损失。
// 档位目录是"建议性"的（见上方第 1 条），挡不住入参里的自选模型——
// 所以这里加一道**授权集**闸门：只有 `data/model-tiers.json` 里声明过的
// `{provider, model}` 组合才允许被工具入参/候选链选中。
// 不在白名单 → 抛错 + 记一条 `lh/security/rejected-model` 事件。

/**
 * 组合去重（provider+model 为键）。
 *
 * @param combos - `{provider, model}[]`。
 * @returns 去重后的组合列表。
 */
function dedupeCombos(combos) {
  const seen = new Set()
  const out = []
  for (const c of combos) {
    const key = `${c.provider}\u0000${c.model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/**
 * 白名单兜底组合（配置文件缺失/损坏时用）。
 *
 * = DEFAULT_TIERS 的全部组合 + `extract` 档默认值（xiaomi-token-plan-ams/mimo-v2.5）。
 * 必须含 extract 默认：否则配置一坏，from_source 的默认路径会被自己的闸门拒掉。
 */
export const FALLBACK_WHITELIST_COMBOS = Object.freeze(
  dedupeCombos([
    ...Object.values(DEFAULT_TIERS).flat(),
    { provider: 'xiaomi-token-plan-ams', model: 'mimo-v2.5' },
  ]).map((c) => Object.freeze({ ...c })),
)

/**
 * 读模型白名单（授权集）。
 *
 * 与 `loadTierConfig` 同源同文件（data/model-tiers.json），但语义不同：
 * 那边是"建议档位"（坏条目退默认），这边是"授权集"——
 * **有效文件里的坏条目只排除并留痕，不补默认**（补默认等于放松拒绝面）。
 * 只有整个文件不可读/不可解析时才退回兜底组合（并留 note）。
 * 读**全部键**（含 `extract`——它不在 TIERS 里，但 from_source 的默认模型用它）。
 *
 * @param path - 配置文件路径；省略时用 tierConfigPath()。
 * @returns `{ combos: {provider, model}[], notes: string[] }`。
 */
export function loadModelWhitelist(path = tierConfigPath()) {
  const notes = []
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { combos: [...FALLBACK_WHITELIST_COMBOS], notes: [`白名单配置不可读（${path}），已退回兜底组合`] }
  }
  let parsed
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch (error) {
    return {
      combos: [...FALLBACK_WHITELIST_COMBOS],
      notes: [`白名单配置不是合法 JSON（${String(error?.message ?? error).slice(0, 120)}），已退回兜底组合`],
    }
  }
  const combos = []
  for (const [tier, entries] of Object.entries(parsed ?? {})) {
    if (!Array.isArray(entries)) {
      notes.push(`档位 "${tier}" 不是数组，已从白名单排除`)
      continue
    }
    entries.forEach((entry, i) => {
      const provider = typeof entry?.provider === 'string' ? entry.provider.trim() : ''
      const model = typeof entry?.model === 'string' ? entry.model.trim() : ''
      if (provider === '' || model === '') {
        notes.push(`档位 "${tier}" 第 ${i + 1} 条不是合法的 {provider, model}，已从白名单排除`)
        return
      }
      combos.push({ provider, model })
    })
  }
  return { combos: dedupeCombos(combos), notes }
}

/**
 * 模型是否在白名单里。
 *
 * 两种校验强度：
 *   · 只给 model（provenance_model 这类"记账用"入参）→ 按 model 名单校验；
 *   · provider 与 model 都给 → **严格按组合**校验，拒绝跨档混搭
 *     （如 deepseek-official + mimo-v2.5 —— 事故 B 就是这类自选组合）。
 *
 * @param whitelist - loadModelWhitelist() 的结果。
 * @param params.model - 模型 id。
 * @param params.provider - provider id（可省略）。
 * @returns 是否放行。
 */
export function isWhitelistedModel(whitelist, { provider, model } = {}) {
  const m = typeof model === 'string' ? model.trim() : ''
  if (m === '') return false
  const combos = Array.isArray(whitelist?.combos) ? whitelist.combos : []
  const p = typeof provider === 'string' ? provider.trim() : ''
  if (p === '') return combos.some((c) => c.model === m)
  return combos.some((c) => c.provider === p && c.model === m)
}

/**
 * 白名单硬闸：不在授权集就记一条 `lh/security/rejected-model` 事件并抛错。
 *
 * 先记账再拒绝：拒绝必须留痕（审计靠它），但记账失败不掩盖拒绝本身。
 *
 * @param params.model - 模型 id。
 * @param params.provider - provider id（可省略，见 isWhitelistedModel）。
 * @param params.whitelist - 白名单；省略时从配置文件读。
 * @param params.tool - 触发闸门的工具名（写进事件）。
 * @param params.provenance - 事件出处；省略用本包。
 * @param params.sessionRef - 会话 id（可省略）。
 * @param params.store - LH 事件存储；省略时新建 LhEventStore。
 * @throws 模型不在白名单时抛错，错误信息含"须由使用者改配置，agent 不得自选计费模型"。
 */
export function assertWhitelistedModel({ provider, model, whitelist, tool, provenance, sessionRef, store } = {}) {
  const wl = whitelist ?? loadModelWhitelist()
  if (isWhitelistedModel(wl, { provider, model })) return

  const requestedProvider = typeof provider === 'string' && provider.trim() !== '' ? provider.trim() : null
  const requestedModel = typeof model === 'string' && model.trim() !== '' ? model.trim() : null

  let bookkeepingNote = ''
  try {
    const s = store ?? new LhEventStore()
    s.append({
      actor: 'agent',
      type: 'lh/security/rejected-model',
      provenance: provenance ?? { plugin: '@lh/model-tier', version: '0.0.2' },
      scope: 'root',
      sessionRef,
      data: {
        tool: typeof tool === 'string' && tool !== '' ? tool : 'unknown',
        requested_provider: requestedProvider,
        requested_model: requestedModel,
        reason: 'not-in-model-whitelist',
      },
    })
  } catch (error) {
    // 记账失败不能掩盖拒绝；但要把失败带进错误信息，免得审计线索静默丢失
    bookkeepingNote = `（且 lh/security/rejected-model 事件记账失败：${String(error?.message ?? error).slice(0, 120)}）`
  }

  const allowed = wl.combos.map((c) => `${c.provider}/${c.model}`).join('、')
  throw new Error(
    `模型不在白名单：${requestedProvider === null ? '' : `${requestedProvider}/`}${requestedModel ?? '(未给 model)'}` +
      `。只接受 data/model-tiers.json 声明的模型组合（当前允许：${allowed === '' ? '（空）' : allowed}）。` +
      '须由使用者改配置，agent 不得自选计费模型。' +
      bookkeepingNote,
  )
}

/**
 * 按档位发起一次模型调用。
 *
 * @param params.llm - 宿主的 `ctx.llm` 服务（从插件 ctx 上取）。
 * @param params.tier - 建议档位（flash / balance / max）。
 * @param params.messages - 消息数组（可用 textMessage 构造）。
 * @param params.system - 可选的 system 文本。
 * @param params.maxTokens - 输出上限。
 * @param params.temperature - 采样温度。
 * @param params.signal - 取消信号。
 * @param params.tiers - 档位配置；省略时从配置文件读。
 * @param params.whitelist - 模型白名单（loadModelWhitelist() 的结果）；省略时从配置文件读。
 * @param params.store - LH 事件存储（白名单拒绝时记账用）；省略时新建。
 * @returns
 *   `{ ok, text, usage, model, provider, tier, degradation, attempts }`
 *   - `ok: false` 时 `failure` 说明原因，`attempts` 列出试过的候选；
 *   - `degradation` 非空表示"实际用的不是首选"，其内容是给用户看的说明。
 */
export async function callModel({
  llm,
  tier,
  messages,
  system,
  maxTokens,
  temperature,
  signal,
  tiers,
  whitelist,
  store,
}) {
  const config = tiers ?? loadTierConfig().tiers
  const isProviderAvailable = makeProviderCheck(llm)

  // 第一级：预检 provider（便宜、无副作用）
  const resolved = resolveTier({ tier, tiers: config, isProviderAvailable })
  const notes = [...resolved.notes]

  if (resolved.selection === undefined) {
    return {
      ok: false,
      tier,
      failure: { code: 'NO_TIER_AVAILABLE', message: `档位 "${tier}" 没有可用候选：${notes.join('；')}` },
      degradation: notes.join('；'),
      attempts: [],
    }
  }

  // ── 模型白名单硬闸（T4.1）──
  // 候选链来自配置（tiers override / 配置文件 / DEFAULT_TIERS 兜底），任何一条都不许
  // 越过授权集：override 与"配置被改坏"都是事故 B 的注入面。
  // 这里**抛错**而不是降级换候选——计费保护优先于可用性（见头注释第 2 条例外）。
  for (const candidate of resolved.candidates) {
    assertWhitelistedModel({
      provider: candidate.provider,
      model: candidate.model,
      whitelist,
      tool: 'callModel',
      store,
    })
  }

  // 第二级：真实调用，失败就试下一个候选
  // （只有真实调用才能判定模型 id 是否被适配器接受——目录是建议性的）
  const attempts = []
  for (const candidate of resolved.candidates) {
    attempts.push(`${candidate.provider}/${candidate.model}`)
    try {
      const stream = llm.stream({
        provider: candidate.provider,
        model: candidate.model,
        messages,
        ...(system === undefined ? {} : { system }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(temperature === undefined ? {} : { temperature }),
        ...(signal === undefined ? {} : { signal }),
      })
      const { text, usage, failure, chunkCount } = await collectStream(stream)

      if (failure !== undefined) {
        // 适配器层面失败（NO_ADAPTER / AUTH / RATE_LIMIT ...）：换下一个候选
        notes.push(`${candidate.provider}/${candidate.model} 调用失败：${failure.code ?? '?'} ${String(failure.message ?? '').slice(0, 160)}`)
        continue
      }

      // 成功。判断是否有降级：实际用的不是解析结果的首选
      const degraded = attempts.length > 1
      if (degraded) {
        notes.push(`已降级到 ${candidate.provider}/${candidate.model}（建议档位 ${tier} 的首选不可用）`)
      }

      return {
        ok: true,
        tier,
        provider: candidate.provider,
        model: candidate.model,
        text,
        usage,
        chunkCount,
        // 只有真的发生了降级才给 degradation，避免调用方把"正常"也当异常记
        degradation: notes.length > 0 ? notes.join('；') : undefined,
        attempts,
        ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort }),
      }
    } catch (error) {
      notes.push(`${candidate.provider}/${candidate.model} 抛错：${error?.code ?? error?.name} ${String(error?.message).slice(0, 160)}`)
    }
  }

  return {
    ok: false,
    tier,
    failure: { code: 'ALL_CANDIDATES_FAILED', message: `档位 "${tier}" 的候选都失败了` },
    degradation: notes.join('；'),
    attempts,
  }
}
