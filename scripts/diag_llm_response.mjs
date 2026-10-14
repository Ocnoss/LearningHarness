/**
 * 诊断：为什么 API 回的是空内容？
 *
 * ═══ 为什么先诊断再改 ═══
 * 三次调用都是 HTTP 200 但 `choices[0].message.content` 为空。
 * 可能的原因差别很大：
 *   · 模型名不被接受（有些网关 200 但返回空）；
 *   · `response_format` 不被支持（被静默忽略或吞掉内容）；
 *   · `max_tokens` 与推理长度冲突（推理型模型把预算全用在思考上）；
 *   · 内容在 `reasoning_content` 而不是 `content`（DeepSeek 推理模型的已知形态）。
 *
 * 盲改会浪费调用次数与时间。所以这一步**把完整响应结构打印出来**，
 * 只看字段名与是否有内容，不看（也不打印）任何密钥。
 *
 * 用法: node scripts/diag_llm_response.mjs
 */

const BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const KEY = process.env.DEEPSEEK_API_KEY
const MODELS = ['deepseek-flash', 'deepseek-v4-pro']

if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY')
  process.exit(2)
}

/**
 * 描述一个值的结构（递归到一定深度），**不打印长文本内容**。
 *
 * @param value - 任意值。
 * @param depth - 当前深度。
 * @returns 结构描述字符串。
 */
function describe(value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[] (空数组)'
    return `[${value.length} 项] 首项: ${describe(value[0], depth + 1)}`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (depth > 2) return `{${keys.join(', ')}}`
    return `{ ${keys.map((k) => `${k}: ${describe(value[k], depth + 1)}`).join(', ')} }`
  }
  if (typeof value === 'string') {
    return `string(${value.length}字)${value.length ? ' 前40: ' + JSON.stringify(value.slice(0, 40)) : ' **空**'}`
  }
  return `${typeof value} = ${JSON.stringify(value)}`
}

/**
 * 试一次调用，打印结构与关键字段。
 *
 * @param params.model - 模型名。
 * @param params.useJsonFormat - 是否带 response_format。
 * @param params.maxTokens - 输出上限。
 */
async function tryCall({ model, useJsonFormat, maxTokens }) {
  const label = `model=${model} jsonFormat=${useJsonFormat} maxTokens=${maxTokens}`
  const body = {
    model,
    messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }],
    temperature: 0,
    max_tokens: maxTokens,
  }
  if (useJsonFormat) body.response_format = { type: 'json_object' }

  process.stdout.write(`\n── ${label}\n`)
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    console.log(`   HTTP ${res.status}`)
    if (!res.ok) {
      console.log(`   错误体: ${text.slice(0, 300)}`)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      console.log(`   非 JSON 响应: ${text.slice(0, 300)}`)
      return
    }
    console.log(`   顶层结构: ${describe(parsed)}`)
    console.log(`   model 字段: ${JSON.stringify(parsed.model)}`)
    console.log(`   usage: ${JSON.stringify(parsed.usage)}`)
    const choice = parsed.choices?.[0]
    if (choice) {
      console.log(`   choices[0].finish_reason: ${JSON.stringify(choice.finish_reason)}`)
      console.log(`   message 结构: ${describe(choice.message)}`)
      // 关键：内容可能在 content、也可能在 reasoning_content
      const c = choice.message?.content
      const rc = choice.message?.reasoning_content
      console.log(`   content 为空? ${!c || (typeof c === 'string' && c.trim() === '')}`)
      console.log(`   reasoning_content 存在? ${rc !== undefined && rc !== null}`)
    } else {
      console.log('   **没有 choices**，完整响应: ' + text.slice(0, 500))
    }
  } catch (error) {
    console.log(`   抛错: ${error.message}`)
  }
}

console.log(`base=${BASE}  密钥长度=${KEY.length}`)

for (const model of MODELS) {
  await tryCall({ model, useJsonFormat: false, maxTokens: 100 })
  await tryCall({ model, useJsonFormat: true, maxTokens: 100 })
}
