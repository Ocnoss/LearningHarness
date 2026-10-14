/**
 * 虚拟断言器 —— 测试期的第一个断言器（ADR-034）。
 *
 * ═══ 它做什么 ═══
 * 接到一段学习者输入，**真调模型**（`@lh/model-tier` 的 flash 档），让模型产出一句
 * 固定格式的上下文断言，形如：
 *
 *   「本次断言是在 2026-…，位于第 3 级子课程「资料分析」（路径：行测 / 资料分析），
 *     依据「刚做的这道增长率题」做出的断言，传递给第 2 层断言器。」
 *
 * 它不评判对错、不做教学判断——它存在的唯一目的是**把传递链路跑通并可观测**：
 * 有了确定形状的产出，才能验证「叶子断言 → 逐层向上 → 到根停止」这条递归是对的。
 *
 * ═══ 为什么模型不可用时仍产出一句（fallback）═══
 * 断言器的天职是"产出断言"。真调模型是手段，不是目的。若 flash 档暂时不可用
 * （没配 provider、限流、离线自测），我们仍按同一模板本地拼出这句话——
 * 于是"传递链路"永远可测，不会因为模型档位没配好就整条静默（那会让人误判成逻辑坏了）。
 * fallback 的 confidence 更低，且 `model` 字段为 null，审计时一眼能分辨。
 *
 * ═══ 可测性：assert 接受一个可替换的 `call` ═══
 * 离线自测（selftest.mjs）传入一个**假 call**，它记录收到的 messages（用于校验提示词）
 * 并返回固定文本（用于校验产出形状），从而**不调真模型**也能测。见 asserters.js 的自测。
 */

import { textMessage, callModel } from '@lh/model-tier/model'
import { nodeChain, scopeOf } from '@lh/course-tree/tree'

/** 本插件 id（写进合成消息的 source.plugin，标明"这不是人类输入"）。 */
const PLUGIN_ID = '@lh/asserter'

/** 固定 system 提示：把模型约束成"只输出那一句"，避免它展开解释。 */
const SYSTEM =
  '你是学习系统里的「虚拟断言器」。你的唯一任务是按用户给定的模板，输出一句中文断言，' +
  '不得添加任何解释、前后缀或额外标点。只输出那一句话本身。'

/**
 * 把输入摘要成一小段（提示词里嵌原文要截断，避免超长与噪声）。
 * @param text - 原始输入。
 * @param max - 上限字符数。
 * @returns 摘要文本。
 */
function summarize(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 按模板拼出那句固定上下文文本。既用于提示词（让模型照抄），也用于 fallback。
 * @param params.input - 学习者输入。
 * @param params.node - 当前节点。
 * @param params.chain - 根到当前节点的链。
 * @param params.target - 传递目标节点（null = 到根/停止）。
 * @param params.time - 断言时间（ISO）。
 * @returns 模板句。
 */
function template({ input, node, chain, target, time }) {
  const path = chain.map((n) => n.title).join(' / ')
  const tail = target === null || target === undefined
    ? '已到顶层，不再向上传递'
    : `传递给第 ${target.level} 层断言器`
  return `本次断言是在 ${time}，位于第 ${node.level} 级子课程「${node.title}」（路径：${path}），` +
    `依据「${summarize(input)}」做出的断言，${tail}。`
}

/**
 * 构造发给模型的提示词。
 * @returns 提示词文本。
 */
function buildPrompt(args) {
  return `请把下面这句话原样输出（只输出这一句，不要改写、不要解释）：\n\n${template(args)}`
}

/** 虚拟断言器描述符。形状见 asserters.js 顶部的约定。 */
export const virtualAsserter = {
  id: 'virtual',

  /** 固定用便宜档：测试期只验链路，不需要强模型（ADR-034）。 */
  tier: 'flash',

  /** 虚拟断言器适用于任何节点（不按层级/科目挑）。 */
  appliesTo() {
    return true
  },

  /** 默认逐层向上传递；到根自然停止（引擎据此求目标）。 */
  propagate: { mode: 'parent' },

  /**
   * 产出断言。
   * @param params.input - 学习者输入文本。
   * @param params.node - 当前课程节点。
   * @param params.tree - 当前课程树（buildTree 结果）。
   * @param params.target - 引擎按 propagate 求出的传递目标节点（可为 null）。
   * @param params.time - 断言时间（ISO 字符串）。
   * @param params.llm - 宿主 ctx.llm。
   * @param params.call - 可选：替换 callModel（离线自测用假 call）。
   * @returns `{ statement, confidence, propagate_to, model }`。
   */
  async assert({ input, node, tree, target, time, llm, call }) {
    const chain = nodeChain(tree, node.id)
    const args = { input, node, chain, target: target ?? null, time }
    const messages = [textMessage({ text: buildPrompt(args), pluginId: PLUGIN_ID, name: 'lh-asserter:virtual' })]

    const invoke = typeof call === 'function' ? call : callModel
    let res = null
    try {
      res = await invoke({ llm, tier: 'flash', messages, system: SYSTEM, maxTokens: 200, temperature: 0 })
    } catch {
      res = null // 调用抛错也走 fallback：断言器的天职是产出，不是崩
    }

    const fromModel = res !== null && res.ok === true && typeof res.text === 'string' && res.text.trim() !== ''
    const statement = fromModel ? res.text.trim() : template(args)

    return {
      statement,
      // 模型真产出给中等置信；fallback 给低置信（审计时可辨"这句没经过模型"）。
      confidence: fromModel ? 0.5 : 0.2,
      // 传递目标以 scope 表达（引擎会反解）；到根/停止为 null。
      propagate_to: target ? scopeOf(target.id) : null,
      model: fromModel
        ? { provider: res.provider ?? null, model: res.model ?? null, degradation: res.degradation ?? null }
        : null,
    }
  },
}
