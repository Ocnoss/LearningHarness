/**
 * 模型使用时间线审计：从 LH 事件日志拉出"每次对话实际用了哪个模型"，
 * 并标出**模型切换点**（相邻两条 model 不同的位置）。
 *
 * 它量化的是"agent 自主换模型"的损失面（事故 A/B）：
 * `audit-tool-args.mjs` 看的是**工具入参**里的 provider/model（agent 自传的），
 * 本脚本看的是**实际发生的调用**（assistant/message 的 meta）——
 * 两者交叉才能回答"哪次调用花了钱、什么时候开始花的"。
 *
 * 隐私声明：只输出时间、会话前缀、provider/model 与 token 计数，
 * 不含题干、答案等任何内容。
 *
 * 运行：node scripts/audit-model-timeline.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const eventsPath = join(HERE, '..', 'data', 'events.jsonl')

const lines = readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim() !== '')
const calls = []
const tally = {}
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e?.type !== 'lh/trace/observed') continue
  const d = e.data ?? {}
  const m = d.meta ?? {}
  if (d.host_type === 'assistant/message' && m.model) {
    calls.push({ t: e.timestamp, s: String(d.session_id ?? '').slice(0, 8), provider: m.provider, model: m.model, out: m.usage?.output ?? 0, inTok: m.usage?.input ?? 0, cache: m.usage?.cache_read ?? 0 })
    const k = `${m.provider} / ${m.model}`
    tally[k] ??= { calls: 0, inTok: 0, out: 0, cache: 0 }
    tally[k].calls += 1
    tally[k].inTok += m.usage?.input ?? 0
    tally[k].out += m.usage?.output ?? 0
    tally[k].cache += m.usage?.cache_read ?? 0
  }
}
console.log('=== model timeline (assistant/message) ===')
for (const c of calls) console.log(`${c.t}  ${c.s}  ${c.provider}/${c.model}  in=${c.inTok} out=${c.out} cache=${c.cache}`)
console.log('')
console.log('=== tally per provider/model ===')
for (const [k, v] of Object.entries(tally)) console.log(`${k}  calls=${v.calls}  in=${v.inTok}  out=${v.out}  cache_read=${v.cache}`)
// 模型切换点：相邻两条 model 不同
console.log('')
console.log('=== model switches ===')
let prev = null
for (const c of calls) {
  const cur = `${c.provider}/${c.model}`
  if (prev && prev !== cur) console.log(`${c.t}  ${c.s}  ${prev} -> ${cur}`)
  prev = cur
}
