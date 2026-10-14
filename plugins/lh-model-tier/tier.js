/**
 * LH 的模型档位（tier）与解析器。
 *
 * ═══ 为什么是"档位"而不是模型名 ═══
 * 插件不声明 `deepseek-flash` 这样的具体模型，而声明档位（`flash` / `balance` / `max`）。
 * 理由：**"哪个用途用哪个模型"是使用者的决策，不是插件的属性。**
 * 若插件写死模型名，换一次模型就要改所有插件；写档位则只改一处配置。
 *
 * ═══ 与 dsh 的关系 ═══
 * 渠道层完全复用宿主的 adaptor（`dsh-llm-deepseek` / `dsh-llm-pi-ai` 等），
 * 本文件**不碰渠道**，只做一件事：把档位翻译成宿主认识的 `{ provider, model, reasoningEffort }`。
 * 宿主里所有模型是同级无区别的，"档位"是 LH 加在它们之上的一层用户标记。
 *
 * ═══ 降级策略（作者要求：连降级也交给插件）═══
 * 三种情况必须**告知并降级**，不许静默：
 *   1. 档位没配（配置里没有这一档）→ 退回 fallback 档，并说明；
 *   2. 档位配的模型在宿主里不可用（provider 未注册 / 模型不在目录里）→ 逐个候选试，都不行则退回 fallback；
 *   3. 一切都不可用 → 返回 undefined，由调用方决定（通常是"这次调用跳过"，而不是"用错模型硬跑"）。
 * 降级的每一次都产出**可读的说明**，因为它们要进入 LH 事件（可审计）与开发者视野。
 */

import { readFileSync, existsSync } from 'node:fs'

// 数据目录的定位：不写死盘符，从本模块位置推仓库根（见 paths.js 的注释）。
// 用包名导入而不是相对路径——相对路径装进 profile 后就断了（ADR-023 的教训）。
import { dataFile } from '@lh/event-store/paths'

/** LH 的档位名。语义：flash=便宜量大，balance=日常，max=最强。 */
export const TIERS = ['flash', 'balance', 'max']

/**
 * 档位配置文件的**默认**位置。
 *
 * 为什么放在 LH 的 data/ 而不是 profile 或 preset：
 * 它是**使用者的决策**（换模型不该改插件、也不该改宿主配置），
 * 而且应当能被版本管理、被直接看见、被手工编辑。
 *
 * ⚠ 这里以前是写死的 `'D:\\LearningHarnessv0.1\\data\\model-tiers.json'`——
 * **那是作者机器上的路径**。写死不会让插件跑不起来，但会让它在别人的机器上
 * 指向不存在的文件（然后静默用默认档位，看起来"没配过"）。
 * 现在由 `dataDir()` 从本模块位置推仓库根。
 *
 * 保持成一个**函数**而不是常量：常量会在 import 时固化，
 * 于是调用方在 import 之后设 `LH_DATA_DIR` 会被静默忽略（同一个老坑）。
 *
 * @returns 档位配置文件的绝对路径。
 */
export function tierConfigPath() {
  return dataFile('model-tiers.json')
}

/**
 * 默认档位配置。
 *
 * 当前取值依据（2026-09-16 作者指定）：
 *   - 对话（导师）与插件开发 → DeepSeek-v4.1，即宿主的 `deepseek-official` / `deepseek-flash`；
 *   - 文档生成、分类、阅读 → MiMo v2.5 Pro，即 `xiaomi-token-plan-ams` / `mimo-v2.5-pro`。
 * 所以 `balance` 与 `max` 都指 DeepSeek（对话是主用途），`flash` 指 MiMo（量大、便宜的辅助活）。
 *
 * 每个档位给的是**候选列表**：解析时按顺序试第一个可用的。
 * 这样"某个 provider 没配 key"不会让整个档位失效。
 */
export const DEFAULT_TIERS = {
  flash: [
    { provider: 'xiaomi-token-plan-ams', model: 'mimo-v2.5-pro' },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  ],
  balance: [
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  ],
  max: [
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    { provider: 'deepseek-official', model: 'deepseek-flash' },
  ],
}

/**
 * 读取档位配置；文件不存在或损坏时退回默认值。
 *
 * 为什么容错而不是报错：这份配置是"使用者的偏好"，不是系统的关键状态。
 * 读不到就用默认值继续跑，并把这件事作为 note 报出来——比让插件挂载失败好得多
 * （挂载失败的代价是整个会话不可用，这个坑踩过一次）。
 *
 * @param path - 配置文件路径；省略时用 `tierConfigPath()` 推出来的默认位置。
 * @returns `{ tiers, notes }`。
 */
export function loadTierConfig(path = tierConfigPath()) {
  const notes = []
  if (!existsSync(path)) {
    notes.push(`档位配置不存在（${path}），使用内置默认档位`)
    return { tiers: DEFAULT_TIERS, notes }
  }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    const tiers = {}
    for (const name of TIERS) {
      const value = parsed?.[name]
      if (!Array.isArray(value) || value.length === 0) {
        notes.push(`档位 "${name}" 未配置或为空，将退回默认值`)
        tiers[name] = DEFAULT_TIERS[name]
        continue
      }
      const candidates = value.filter(
        (c) => typeof c?.provider === 'string' && typeof c?.model === 'string',
      )
      if (candidates.length === 0) {
        notes.push(`档位 "${name}" 的候选都不合法（需要 provider 与 model 字符串），将退回默认值`)
        tiers[name] = DEFAULT_TIERS[name]
        continue
      }
      tiers[name] = candidates.map((c) => ({
        provider: c.provider,
        model: c.model,
        ...(typeof c.reasoningEffort === 'string' ? { reasoningEffort: c.reasoningEffort } : {}),
      }))
    }
    return { tiers, notes }
  } catch (error) {
    notes.push(`档位配置解析失败（${error?.message}），使用内置默认档位`)
    return { tiers: DEFAULT_TIERS, notes }
  }
}

/**
 * 构造一个"廉价预检"：只看 provider 有没有注册。
 *
 * ═══ 为什么只查 provider、不查模型 ═══
 * 宿主明说模型目录是**建议性**的：
 *   "The result is advisory: an adapter may accept unlisted model ids,
 *    and consumers must not turn absence into request rejection."
 * 所以"模型不在目录里"**不能**判为不可用——那会把可用的模型误判掉。
 * 真正能判定"这个模型能不能用"的只有一次实际调用（见 resolveTier 的说明）。
 *
 * @param llm - 宿主的 `ctx.llm` 服务。
 * @returns `(provider) => boolean`。
 */
export function makeProviderCheck(llm) {
  return (provider) => {
    if (llm === undefined) return false
    try {
      const infos = llm.listProviders()
      return infos.some((info) => (info?.id ?? info?.provider ?? info?.name) === provider)
    } catch {
      return false
    }
  }
}

/**
 * 解析一个档位到具体模型。
 *
 * ═══ 两级解析（这是"降级也交给插件"的落地）═══
 * 1. **预检**：按候选顺序，跳过 provider 未注册的（便宜、无副作用）；
 * 2. **失败降级**：调用方拿 `selection` 去实际调用，**调用失败时**再回来试下一个候选。
 *    第二级是必须的，因为只有真实调用才知道模型 id 是否被适配器接受
 *    （目录是建议性的，写错模型名的表现是调用失败，不是预检失败）。
 *
 * 因此本函数返回 `candidates`（完整的候选顺序）而不只是单个 selection，
 * 让调用方能在失败后继续往下试。
 *
 * @param params.tier - 档位名（flash / balance / max）。
 * @param params.tiers - 档位配置。
 * @param params.isProviderAvailable - provider 预检函数。
 * @returns `{ tier, selection, candidates, notes }`；selection 能取到 undefined（表示一个都不行）。
 */
export function resolveTier({ tier, tiers, isProviderAvailable }) {
  const notes = []
  const configured = tiers?.[tier]

  if (!Array.isArray(configured) || configured.length === 0) {
    notes.push(`档位 "${tier}" 未配置`)
    const fallback = tiers?.balance ?? []
    const available = fallback.filter((c) => isProviderAvailable(c.provider))
    if (available.length === 0) {
      notes.push('fallback 档位也没有可用候选')
      return { tier, selection: undefined, candidates: [], notes }
    }
    notes.push(`已降级到 balance 档：${available[0].provider}/${available[0].model}`)
    return { tier, selection: available[0], candidates: available, notes }
  }

  const usable = configured.filter((c) => isProviderAvailable(c.provider))
  const skipped = configured.filter((c) => !isProviderAvailable(c.provider))
  for (const c of skipped) {
    notes.push(`跳过未注册的 provider：${c.provider}/${c.model}`)
  }

  if (usable.length === 0) {
    // 一个都没注册：这是配置与部署不匹配，必须说清楚，而不是静默用别的模型
    notes.push(`档位 "${tier}" 的候选所依赖的 provider 都未注册`)
    return { tier, selection: undefined, candidates: [], notes }
  }

  return { tier, selection: usable[0], candidates: usable, notes }
}
