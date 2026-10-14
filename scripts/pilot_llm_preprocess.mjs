/**
 * 试点：LLM 能不能"看到"空位，以及它自己的答案与官方答案一致吗？
 *
 * ═══ 这个试点要回答两个问题（都不是我能靠推理回答的）═══
 * 1. **空位识别**：把 OCR 出来的题干给模型，问它"这题的空位在哪"。
 *    作者主张用 LLM 替代我的几何启发式（ADR-021）。但"LLM 能不能看清"是**经验问题**——
 *    必须真跑一遍看它标的对不对。实测的三道题已知正确答案：
 *      q4  留白型，空位在"…因此"与"填入文中画横线部分…"之间
 *      q17 留白型，空位在"…为了优化教育生态，"与"填入文中画横线部分…"之间
 *      q18 下划线型，空位在"…固体燃料推进器。"与"。火箭是非常复杂的东西…"之间
 * 2. **独立作答**：让它自己做一遍，与官方答案比对。
 *    不一致的题就是**最该被人看的题**（ADR-021 决定 3）——
 *    这是免费的质量筛子，但也可能只是模型太弱。一致率是决定要不要用它的依据。
 *
 * ═══ 为什么直接调 HTTP 而不走宿主 ═══
 * 宿主链路（`ctx.llm` 从 preset 作用域可达）**已经验证过**，不必重复。
 * 本试点的对象是**提示词与思路**，所以直接调 API 最快，且不需要作者再重启一次。
 * 走宿主的版本由 `plugins/lh-model-tier` 的自检承担。
 *
 * 密钥从环境变量读，**不打印**。
 *
 * 用法:
 *   $env:DEEPSEEK_API_KEY = (从 .credentials.yaml 取)
 *   node scripts/pilot_llm_preprocess.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'

/**
 * 题库路径与目标题。用命令行参数覆盖，免得每次改常量。
 *
 * 用法：
 *   node scripts/pilot_llm_preprocess.mjs --bank "<题库路径>" --all
 *   node scripts/pilot_llm_preprocess.mjs            # 默认跑下面 3 道（快速回归）
 */
const argv = process.argv.slice(2)
const bankArg = argv.indexOf('--bank')
const BANK =
  bankArg >= 0 ? argv[bankArg + 1] : 'D:/learning Harness test/lh-questions/考公刷题-片段阅读与逻辑判断.json'
const TARGETS = ['set1-q4', 'set1-q17', 'set1-q18']
/** 给 `--all` 时跑题库全量；默认只跑上面那 3 道（快速回归）。 */
const RUN_ALL = argv.includes('--all')

/** 从题库里取待试点的题。 */
function loadQuestions() {
  const bank = JSON.parse(readFileSync(BANK, 'utf8'))
  if (RUN_ALL) return bank.questions
  return TARGETS.map((n) => bank.questions.find((q) => q.source.number === n)).filter(Boolean)
}

/**
 * 真值表：**只覆盖已知答案的少数题**。
 *
 * 为什么不全量给真值：全量的官方答案在题库里（`answer` 字段），
 * 直接用即可；而"空位在哪"我只人工核对过这 3 道。
 * 所以全量跑时，空位判定自动跳过（没有真值就无法判对错），
 * 但**答案一致率**仍可全量统计——那才是有统计意义的那个数。
 */
const BLANK_TRUTH = {
  'set1-q4': {
    kind: '留白型',
    blankAfterSentence: '尤其是不可能从根本上解决"冰冻三尺非一日之寒"的"过度城市化""城市空心化"等"城市病"，因此',
    blankBeforeHead: '填入文中画横线部分',
  },
  'set1-q17': {
    kind: '留白型',
    blankAfterSentence: '为了优化教育生态，',
    blankBeforeHead: '填入文中画横线部分',
  },
  'set1-q18': {
    kind: '下划线型',
    blankAfterSentence: '两侧的固体燃料推进器用的也是改进过的航天飞机的固体燃料推进器。',
    blankBeforeHead: '火箭是非常复杂的东西',
  },
}

/**
 * 预处理提示词。
 *
 * ═══ 设计要点 ═══
 * - **只让它做一次判断，不要它自由发挥**：输出是严格 JSON，字段固定。
 *   理由：产物要被程序消费（写进题库），自由文本没法可靠解析。
 * - **明确告诉它"要求填空但看不到空位"是可能的**，这正是 OCR 吃字的场景。
 *   如果不提示，模型会自己脑补一个位置——那比标"找不到"更糟。
 * - **要求它给出依据**（引文），这样人能核对它是不是真看到了，而不是猜的。
 * - **让它先自己作答、再给官方答案**：顺序很重要。
 *   先看到官方答案会让它的"独立意见"失去价值（变成附和）。
 *   所以这里**不把官方答案给它**——它必须独立作答。
 *
 * ⚠ 提示词里**不要用反引号**包字段名：本函数体是模板字符串，
 *   反引号会提前结束字符串（实测报了 `SyntaxError: Unexpected identifier`）。
 *   用中文引号「」既安全又更清楚。
 */
function buildPrompt(q) {
  const opts = q.options.map((t, i) => `${'ABCD'[i]}. ${t}`).join('\n')
  return `你是一位公考行测（言语理解）老师。下面是一道题，来自**扫描件 OCR**，因此可能有识别错误。

【题干与选项】
${q.stem}

${opts}

请完成三件事，只输出 JSON，不要任何解释文字。

1. blank —— 这题是否要求"填入文中画横线部分"（或填空）？
   - 如果是，指出空位**在题干里的哪个位置**：
     blank_after = 空位**前面紧邻的那一句完整的话**（从它这一句的开头抄到句末，不要只给几个字）；
     blank_before = 空位**后面紧接的那句话的开头 10 个字**。
   - **重要**：如果题目要求填空、但你在题干里找不到空位的任何痕迹（这是 OCR 丢了留白或下划线造成的），
     就把 blank_found 设为 false，blank_after / blank_before 设为 null。
     **不要猜位置**——报"找不到"比报一个错位置有用得多。
   - 线索提示：OCR 丢下划线时，常常留下一处**标点异常**（例如前一句末尾与后一句开头出现同一个标点、
     或句号孤立在行首）。若你是据此判断的，请在 blank_note 里说明。
   - 如果这题根本不需要填空，blank_required 设为 false。

2. meta —— 题目信息。question_type（如"语句填入类""中心理解题"）、
   topics（知识点数组，没有就给空数组）、difficulty_hint（"易"/"中"/"难"）。

3. my_answer —— **你自己做一遍**，给出选项字母。my_reasoning —— 一两句话说明为什么。

输出格式（严格遵守，字段齐全）：
{
  "blank_required": true | false,
  "blank_found": true | false | null,
  "blank_after": "…" | null,
  "blank_before": "…" | null,
  "blank_note": "一句话说明你判断的依据，或说明为什么找不到",
  "meta": { "question_type": "…", "topics": ["…"], "difficulty_hint": "易|中|难" },
  "my_answer": "A|B|C|D",
  "my_reasoning": "…"
}`
}

/**
 * 调一次 chat completions，**带一次自动扩容重试**。
 *
 * ═══ 为什么要重试：实测有一个真实的失败模式 ═══
 * 20 题实测里 q17 返回了空 content，`finish_reason=length` 且
 * `reasoning_tokens=5999`（等于预算）——**模型把全部预算用在推理上，没来得及输出**。
 *
 * 这不是"模型不行"，而是**预算不足**：同一道题在小样本试点时是能正常作答的
 * （那次只用了 3250 token）。也就是说它**偶发**地陷入长推理。
 *
 * 处置：扩容重试一次（预算翻倍）。如果仍然爆，才如实报失败。
 * **不要**一上来就给很大的预算：那会让每一道简单题也按大预算计费吗？
 * 不会——预算是上限不是用量。但**过大的预算会掩盖问题**：
 * 若某题稳定需要 12000 token 才答得出，那是题目或提示词有问题的信号，
 * 值得看见，而不是被一个大上限悄悄盖过去。
 *
 * @param params.baseUrl - API 根。
 * @param params.apiKey - 密钥。
 * @param params.model - 模型名。
 * @param params.prompt - 用户消息。
 * @returns `{ text, usage, ms, retried }`。
 */
async function callChat({ baseUrl, apiKey, model, prompt }) {
  const attempt = async (maxTokens) => {
    const t0 = Date.now()
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: maxTokens,
        // 注意：`response_format: json_object` 要求提示词里出现 "json" 这个词，
        // 否则 HTTP 400（Prompt must contain the word 'json'）。本提示词里有。
        response_format: { type: 'json_object' },
      }),
    })
    const ms = Date.now() - t0
    const bodyText = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 400)}`)
    const body = JSON.parse(bodyText)
    const choice = body.choices?.[0]
    const text = choice?.message?.content ?? ''
    return { text, usage: body.usage ?? null, ms, model: body.model ?? model, finish: choice?.finish_reason }
  }

  const first = await attempt(6000)
  if (first.text.trim() !== '') return { ...first, retried: false }

  // 空回复：扩容重试一次，并把原因带上（便于事后统计这种失败的比例）
  const usageNote = `finish=${first.finish} reasoning=${first.usage?.completion_tokens_details?.reasoning_tokens ?? '?'}`
  const second = await attempt(14000)
  if (second.text.trim() === '') {
    throw new Error(`两次都返回空回复（首次 ${usageNote}；扩容后 finish=${second.finish}）`)
  }
  return { ...second, retried: true, firstUsageNote: usageNote }
}

/** 从模型回复里抠出 JSON（它偶尔会包一层 markdown 围栏）。 */
function extractJson(text) {
  const t = text.trim()
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : t
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`回复里没有 JSON: ${t.slice(0, 200)}`)
  return JSON.parse(candidate.slice(start, end + 1))
}

/** 判断模型给的位置与真值是否吻合。 */
function judgeBlank(item, truth) {
  if (item.blank_found !== true) return { ok: false, why: '模型说找不到空位' }

  // ⚠ 这里我连错两次，所以把教训写清楚：
  //   第一次：真值只给"末尾 10 字"，而模型给的是更长的正确片段 → 字面不等，误判。
  //   第二次：修成双向包含后，模型给的是**更长的正确片段**，但它的**引号是全角**（“”），
  //          而 OCR 原文用的是另一种引号 → 字面不等，又误判。
  //   两次都是**判定器比被测对象更脆**。而误判的代价很实在：
  //   它会让"模型其实找到了空位"被记成"模型没找到"，从而**否掉一个可行的方案**。
  //
  //   所以归一化要足够狠：去空白、**去所有标点与引号**，再比"末尾锚点"。
  const norm = (s) =>
    String(s ?? '')
      .replace(/\s+/g, '')
      // 中英文标点、各种引号、括号全部去掉 —— 只留下实义字符
      .replace(/[，。、；：？！“”‘’（）《》【】…—·,.;:?!'"()\[\]<>-]/g, '')

  /** 双向包含：处理"模型给得更长/更短"两种情况。 */
  const looseIncludes = (a, b) => {
    if (a.length === 0 || b.length === 0) return false
    return a.includes(b) || b.includes(a)
  }

  const after = norm(item.blank_after)
  const before = norm(item.blank_before)
  const tAfter = norm(truth.blankAfterSentence)
  const tBefore = norm(truth.blankBeforeHead)

  // 主判据：双向包含。
  let afterOk = looseIncludes(after, tAfter)
  let beforeOk = looseIncludes(before, tBefore)

  // 兜底：若包含失败，再比"末尾锚点"——真值的最后 10 个字是否出现在模型答案里。
  // 为什么需要这个兜底：模型可能从句子中间开始抄（如只抄了后半句），
  // 那时双向包含会因为"前缀不同"而失败，但**末尾接得上就说明它找对了位置**——
  // 而"接得上"正是空位定位真正要求的东西。
  if (!afterOk && tAfter.length >= 10) {
    afterOk = after.includes(tAfter.slice(-10))
  }
  if (!beforeOk && tBefore.length >= 6) {
    beforeOk = before.includes(tBefore.slice(0, 6))
  }

  return { ok: afterOk && beforeOk, afterOk, beforeOk }
}

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    console.error('缺少 DEEPSEEK_API_KEY 环境变量')
    console.error('从 ~/.dsh/.credentials.yaml 取值后设为环境变量（不要写进文件）')
    return 2
  }
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

  const questions = loadQuestions()
  console.log(`试点 ${questions.length} 道题  模型 ${model}  base ${baseUrl}`)
  console.log('='.repeat(74))

  const results = []
  for (const q of questions) {
    const num = q.source.number
    // 官方答案从题库取（全量跑时这就是唯一来源）；空位真值只有少数题有
    const official = (q.answer ?? []).join('')
    const blankTruth = BLANK_TRUTH[num] ?? null
    process.stdout.write(`${num} … `)
    try {
      const r = await callChat({ baseUrl, apiKey, model, prompt: buildPrompt(q) })
      let parsed
      try {
        parsed = extractJson(r.text)
      } catch (error) {
        console.log(`解析失败: ${error.message}`)
        results.push({ num, official, error: error.message, raw: r.text.slice(0, 400) })
        continue
      }
      const blank = blankTruth ? judgeBlank(parsed, blankTruth) : null
      const agree = parsed.my_answer === official
      const blankMark = blank ? (blank.ok ? '空位✓' : '空位✗') : `空位=${parsed.blank_found === true ? '有' : parsed.blank_found === false ? '找不到' : String(parsed.blank_required)}`
      const retryMark = r.retried ? ' [重试]' : ''
      console.log(
        `${blankMark}  自己答=${parsed.my_answer} 官方=${official} ${agree ? '一致' : '**不一致**'}  ${r.ms}ms  tokens=${r.usage?.total_tokens ?? '?'}${retryMark}`,
      )
      results.push({ num, official, blankTruth, parsed, blank, agree, usage: r.usage, ms: r.ms, retried: r.retried === true, firstUsageNote: r.firstUsageNote ?? null, model: r.model ?? model })
    } catch (error) {
      console.log(`调用失败: ${error.message}`)
      results.push({ num, official, error: error.message })
    }
  }

  console.log('='.repeat(74))
  const withTruth = results.filter((r) => r.blank)
  const ok = withTruth.filter((r) => r.blank.ok).length
  const answered = results.filter((r) => r.parsed).length
  const agreed = results.filter((r) => r.agree).length
  const tokens = results.reduce((s, r) => s + (r.usage?.total_tokens ?? 0), 0)
  const reasoning = results.reduce(
    (s, r) => s + (r.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
    0,
  )
  if (withTruth.length > 0) console.log(`空位识别正确 ${ok}/${withTruth.length}（有真值的题）`)
  console.log(`自己作答与官方一致 ${agreed}/${answered}`)
  console.log(`总 token ${tokens}；其中推理 token ${reasoning}（占 ${tokens ? Math.round((reasoning / tokens) * 100) : 0}%）`)
  console.log(`平均每次 ~${Math.round(tokens / Math.max(1, questions.length))} tokens`)
  if (RUN_ALL) {
    console.log(`\n按此平均值推算：600 题约 ${Math.round((tokens / Math.max(1, questions.length)) * 600 / 1000)}k tokens`)
  }

  // 不一致的题：这是本次试点最有价值的产出（ADR-021 决定 3）
  const disagree = results.filter((r) => r.parsed && !r.agree)
  if (disagree.length > 0) {
    console.log(`\n★ 与官方答案不一致的 ${disagree.length} 道（最该被人看的题）：`)
    for (const r of disagree) {
      console.log(`  ${r.num}: 模型=${r.parsed.my_answer} 官方=${r.official}`)
      console.log(`     模型理由: ${r.parsed.my_reasoning}`)
    }
  }

  // 标出空位仍找不到的题（这些是仍需人工或几何法补的）
  const blankMissing = results.filter((r) => r.parsed?.blank_required === true && r.parsed?.blank_found !== true)
  if (blankMissing.length > 0) {
    console.log(`\n空位仍需补的 ${blankMissing.length} 道：`)
    for (const r of blankMissing) console.log(`  ${r.num}: ${r.parsed.blank_note}`)
  }

  console.log(`总 token ${tokens}（含提示词）；平均每次 ~${Math.round(tokens / Math.max(1, questions.length))}`)

  console.log('\n--- 明细 ---')
  for (const r of results) {
    console.log(`\n${r.num}  (官方 ${r.official}${r.blankTruth ? `, 空位真值: ${r.blankTruth.kind}` : ''})`)
    if (r.error) {
      console.log(`  错误: ${r.error}`)
      continue
    }
    console.log(`  blank_required=${r.parsed.blank_required} blank_found=${r.parsed.blank_found}`)
    if (r.blankTruth) {
      console.log(`  blank_after : ${JSON.stringify(r.parsed.blank_after)}   应为 ${JSON.stringify(r.blankTruth.blankAfterSentence)} ${r.blank.afterOk ? '✓' : '✗'}`)
      console.log(`  blank_before: ${JSON.stringify(r.parsed.blank_before)}   应为 ${JSON.stringify(r.blankTruth.blankBeforeHead)} ${r.blank.beforeOk ? '✓' : '✗'}`)
    } else {
      console.log(`  blank_after : ${JSON.stringify(r.parsed.blank_after)}`)
      console.log(`  blank_before: ${JSON.stringify(r.parsed.blank_before)}`)
    }
    console.log(`  note: ${r.parsed.blank_note}`)
    console.log(`  meta: ${JSON.stringify(r.parsed.meta)}`)
    console.log(`  答案: ${r.parsed.my_answer}（官方 ${r.official}）${r.agree ? '一致' : '不一致'}`)
    console.log(`  理由: ${r.parsed.my_reasoning}`)
  }

  // 把原始结果落盘，便于事后核对与复用（不必重跑就花一次钱）
  const outPath = 'data/pilot-llm-preprocess.json'
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        model,
        ranAt: new Date().toISOString(),
        total: questions.length,
        tokenTotal: tokens,
        reasoningTokens: reasoning,
        agreement: { agreed, answered },
        blankJudged: { ok, total: withTruth.length },
        results: results.map((r) => ({
          number: r.num,
          // ⚠ 每条都记模型（2026-09-19 补）：第一版只在顶层写了一次 `model`，
          // 而那个字段只能描述**最后写入文件的那一次运行**。
          // 实测两个不同模型的运行被合并进同一个文件，于是顶层的
          // `agreement: 42/49` 把两个模型算成了一个——数字没错，含义是错的。
          // 出处必须跟着**记录**走，不能只跟着文件走（契约 §1.4）。
          model: r.model ?? model,
          official: r.official,
          blankTruth: r.blankTruth ?? null,
          blankJudgedOk: r.blank ? r.blank.ok : null,
          agree: r.agree ?? null,
          parsed: r.parsed ?? null,
          usage: r.usage ?? null,
          ms: r.ms ?? null,
          retried: r.retried ?? false,
          firstUsageNote: r.firstUsageNote ?? null,
          error: r.error ?? null,
        })),
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`\n原始结果已落盘: ${outPath}`)

  return 0
}

process.exitCode = await main()
