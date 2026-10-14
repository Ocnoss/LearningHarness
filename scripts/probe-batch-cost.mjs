/**
 * 全量入库的成本探针 —— **量三件事，不猜**：token 消耗、墙钟时间、内存峰值。
 *
 * ═══ 为什么先量再跑 ═══
 * 2400 题的规模下，"大概要多久""大概多少钱"这种估计会决定方案选型
 * （并发度、要不要先修分块、要不要分批）。
 * 而 ADR-016 说花费要透明、选择权在作者——那就必须给真实数字，不是推算。
 *
 * ═══ 它刻意不做什么 ═══
 * - **不写任何产物到工作区**（只读 PDF、读已有的 pilot 产物、调模型）；
 * - **不改 data/events.jsonl**（探针不是学习事实）；
 * - **不在插件里**：这是"建"的阶段（ADR-015），归 scripts。
 *
 * 用法:
 *   # 1) OCR 成本：四个族各取若干页，量单页耗时与内存
 *   node scripts/probe-batch-cost.mjs ocr --pages=6
 *
 *   # 2) LLM 成本：拿真实题目量每题 token，并按 600 题推算
 *   $env:XIAOMI_TOKEN_PLAN_AMS_API_KEY = (从 ~/.dsh/.credentials.yaml 取)
 *   node scripts/probe-batch-cost.mjs llm --questions=20 --concurrency=4
 *
 *   # 3) 内存：做一件具体的事，报告进程的峰值工作集
 *   node scripts/probe-batch-cost.mjs mem
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const mode = argv[0] ?? 'ocr'

/**
 * 取 `--名字=值` 形式的参数。
 *
 * @param name - 参数名。
 * @param fallback - 缺省值。
 * @returns 值（字符串）。
 */
function arg(name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const PYTHON = 'D:\\miniconda\\python.exe'

/** 四族资料。`ocrPages` 是探针要抽查的页码（1 基，含两端）。 */
const MATERIALS = [
  {
    family: '片段阅读',
    note: '首页是横排 + /Rotate 270（渲染必须应用它，否则送进 OCR 的是躺倒的图）',
    files: [
      ['题本【上】', '片段阅读600题\\2025年花生片段阅读600题-题本【上】.pdf'],
      ['解析【上】', '片段阅读600题\\2025年花生片段阅读600题-解析【上】.pdf'],
    ],
  },
  { family: '逻辑判断', files: [['题本篇', '逻辑判断600 题\\逻辑判断600题题本篇.pdf'], ['解析篇', '逻辑判断600 题\\逻辑判断600题解析篇.pdf']] },
  { family: '数量关系', files: [['题本', '数量关系600题（26最新）\\花生十三数量600题（无遮挡水印版）【题本】.pdf'], ['解析', '数量关系600题（26最新）\\花生十三数量600题（无遮挡水印版）【解析】.pdf']] },
  { family: '资料分析', files: [['题本篇', '资料分析600题\\题本篇.pdf'], ['解析篇', '资料分析600题\\解析篇.pdf']] },
]

const MATERIAL_ROOT = 'D:\\考公资料\\刷题'

// ── 进程内存采样 ────────────────────────────────────────────────────────────
//
// 为什么这么量：要的是"跑这件事时进程峰值工作集"，
// 而它只能在**外部**观察（Node 自己的 memoryUsage 看不到 onnxruntime 的原生分配，
// 而 OCR 的分配几乎全在原生侧）。
// 采样用 tasklist（Windows 自带，无依赖），间隔 200ms——
// 比真实峰值略低，但足以区分"几百 MB"与"几 GB"这两档，而那正是要判断的事。

/**
 * 采样一个进程树的内存峰值。
 *
 * @param pid - 根进程 id。
 * @param ms - 采样间隔。
 * @returns `{ stop, peakMb, samples }`。
 */
function makeMemorySampler(pid, ms = 200) {
  let peakKb = 0
  let samples = 0
  const timer = setInterval(() => {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    // CSV 形如: "node.exe","1234","Console","1","1,234,567 K"
    const m = (r.stdout ?? '').match(/"([\d.,]+) K"/)
    if (m !== null) {
      const kb = Number(m[1].replace(/[.,]/g, ''))
      if (Number.isFinite(kb)) {
        peakKb = Math.max(peakKb, kb)
        samples += 1
      }
    }
  }, ms)
  return {
    stop: () => clearInterval(timer),
    get peakMb() {
      return Math.round(peakKb / 1024)
    },
    get samples() {
      return samples
    },
  }
}
/**
 * 跑一个子进程并同时量时间与内存峰值。
 *
 * @param cmd - 可执行文件。
 * @param args - 参数。
 * @param opts - `{ cwd, env }`。
 * @returns Promise<`{ code, out, ms, peakMb }`>。
 */
function runMeasured(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const t0 = Date.now()
    const child = spawn(cmd, args, { cwd: opts.cwd ?? repoRoot, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const sampler = makeMemorySampler(child.pid)
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (out += d.toString('utf8')))
    child.on('close', (code) => {
      sampler.stop()
      resolvePromise({ code, out, ms: Date.now() - t0, peakMb: sampler.peakMb, samples: sampler.samples })
    })
  })
}

// ── 模式 1：OCR ────────────────────────────────────────────────────────────

/**
 * 抽查若干页做 OCR，量单页耗时与内存。
 *
 * @param perFile - 每个文件抽查几页。
 */
async function probeOcr(perFile) {
  console.log(`OCR 探针：每个文件抽查 ${perFile} 页（长边 2000 降采样，与 ocr_pages.py 一致）\n`)
  console.log('族 / 文件                      页   秒/页   峰值内存   识别字符数')
  console.log('─'.repeat(78))

  const rows = []
  for (const group of MATERIALS) {
    for (const [label, rel] of group.files) {
      const pdf = join(MATERIAL_ROOT, rel)
      if (!existsSync(pdf)) {
        console.log(`${group.family}/${label}  ⚠ 文件不存在：${pdf}`)
        continue
      }
      // 页码取"靠中间"的连续页：首页/末页常是封面与目录，不代表正文密度
      const pageCount = Number(
        (spawnSync(PYTHON, ['-c', `import pymupdf,sys;print(pymupdf.open(sys.argv[1]).page_count)`, pdf], { encoding: 'utf8' }).stdout ?? '0').trim(),
      )
      const start = Math.max(1, Math.floor(pageCount / 3))
      const pages = Array.from({ length: perFile }, (_, i) => start + i).join(',')

      const script = [
        'import sys, io, json, time',
        'import pymupdf, numpy as np',
        'from PIL import Image',
        'from rapidocr import RapidOCR',
        'pdf, pages, max_side = sys.argv[1], sys.argv[2], int(sys.argv[3])',
        'engine = RapidOCR()',
        'doc = pymupdf.open(pdf)',
        'out = []',
        'for spec in pages.split(","):',
        '    pno = int(spec) - 1',
        '    if pno < 0 or pno >= doc.page_count: continue',
        '    page = doc[pno]',
        '    mat = pymupdf.Matrix(1, 1)',
        '    rot = page.rotation',
        '    if rot: mat = pymupdf.Matrix(1, 1).prerotate(rot)',
        '    pix = page.get_pixmap(matrix=mat)',
        '    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)',
        '    scale = min(1.0, max_side / max(img.size))',
        '    if scale < 1.0: img = img.resize((int(img.width*scale), int(img.height*scale)), Image.LANCZOS)',
        '    arr = np.array(img)',
        '    t0 = time.perf_counter()',
        '    res = engine(arr)',
        '    dt = time.perf_counter() - t0',
        '    txts = getattr(res, "txts", None)',
        '    chars = sum(len(t) for t in txts) if txts else 0',
        '    out.append({"page": pno+1, "seconds": round(dt,2), "chars": chars, "size": f"{img.width}x{img.height}", "rot": rot})',
        'print(json.dumps(out, ensure_ascii=False))',
      ].join('\n')

      const r = await runMeasured(PYTHON, ['-c', script, pdf, pages, '2000'], { cwd: repoRoot })
      const tail = r.out.trim().split('\n').pop() ?? ''
      let parsed = []
      try {
        parsed = JSON.parse(tail)
      } catch {
        console.log(`${group.family}/${label}  ⚠ 解析失败：${r.out.slice(-200)}`)
        continue
      }
      const per = parsed.length > 0 ? parsed.reduce((s, x) => s + x.seconds, 0) / parsed.length : 0
      const chars = parsed.reduce((s, x) => s + x.chars, 0)
      const first = parsed[0] ?? {}
      const pad = (s, n) => String(s).padEnd(n)
      console.log(
        `${pad(`${group.family}/${label}`, 28)}  ${String(parsed.length).padStart(2)}   ${per.toFixed(2).padStart(5)}   ${String(r.peakMb).padStart(6)} MB   ${String(chars).padStart(6)}  (${first.size ?? '?'} rot=${first.rot ?? '?'})`,
      )
      rows.push({ family: group.family, label, perPage: per, chars, pageCount, pages: parsed.length })
    }
  }

  // ── 全量推算 ──
  console.log('\n── 全量推算（按抽查的每页均速 × 实际页数）──')
  let totalPages = 0
  let totalSeconds = 0
  const byFamily = new Map()
  for (const r of rows) {
    const familyPages = r.pageCount * 1 // 每个文件各自算；下面按文件累加
    totalPages += r.pageCount
    totalSeconds += r.perPage * r.pageCount
    const cur = byFamily.get(r.family) ?? { pages: 0, seconds: 0 }
    cur.pages += r.pageCount
    cur.seconds += r.perPage * r.pageCount
    byFamily.set(r.family, cur)
    void familyPages
  }
  for (const [fam, v] of byFamily) {
    console.log(`  ${fam.padEnd(8)} ${String(v.pages).padStart(5)} 页   ≈ ${Math.round(v.seconds / 60)} 分钟`)
  }
  console.log(`  ${'合计'.padEnd(8)} ${String(totalPages).padStart(5)} 页   ≈ ${Math.round(totalSeconds / 60)} 分钟（单进程串行）`)
  console.log('  ⚠ 这是**串行**估算。OCR 是 CPU 密集，多进程能不能提速要看核数与内存带宽。')
  return rows
}

// ── 模式 2：LLM 每题 token ──────────────────────────────────────────────────

/**
 * 调真实模型量每题 token，并按 600/2400 题推算。
 *
 * @param params.count - 跑几道题。
 * @param params.concurrency - 并发数。
 */
async function probeLlm({ count, concurrency }) {
  const apiKey = process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY
  if (apiKey === undefined || apiKey === '') {
    console.error('缺少 XIAOMI_TOKEN_PLAN_AMS_API_KEY 环境变量')
    console.error('从 ~/.dsh/.credentials.yaml 取 refs.XIAOMI_TOKEN_PLAN_AMS_API_KEY，设成环境变量后重跑')
    process.exitCode = 2
    return
  }
  const baseUrl = 'https://token-plan-cn.xiaomimimo.com/v1'
  const model = 'mimo-v2.5-pro'

  // 题目来源：用**已经抽好的真实题目**（那 49 道），不编造
  const bankPath = join('D:', 'learning Harness test', 'lh-questions', '考公刷题-片段阅读与逻辑判断.json')
  if (!existsSync(bankPath)) {
    console.error(`找不到题库：${bankPath}`)
    process.exitCode = 2
    return
  }
  const bank = JSON.parse(readFileSync(bankPath, 'utf8'))
  const questions = bank.questions.slice(0, count)
  console.log(`LLM 探针：${questions.length} 道真实题，模型 ${model}，并发 ${concurrency}\n`)

  /** 与 pilot_llm_preprocess.mjs 的 buildPrompt 同构（同一任务、同一提示词）。 */
  const buildPrompt = (q) => {
    const opts = q.options.map((t, i) => `${'ABCD'[i]}. ${t}`).join('\n')
    return `你是一位公考行测（言语理解）老师。下面是一道题，来自**扫描件 OCR**，因此可能有识别错误。

【题干与选项】
${q.stem}

${opts}

请完成三件事，只输出 JSON，不要任何解释文字。
1. blank —— 这题是否要求"填入文中画横线部分"（或填空）？指出空位位置。
2. meta —— 题目信息：question_type、topics（知识点数组）、difficulty_hint。
3. my_answer —— 你自己做一遍，给出选项字母。my_reasoning —— 一两句话说明为什么。

输出格式（严格遵守，字段齐全）：
{"blank_required": true|false, "blank_found": true|false|null, "blank_after": "…"|null,
 "blank_before": "…"|null, "blank_note": "…",
 "meta": {"question_type": "…", "topics": ["…"], "difficulty_hint": "易|中|难"},
 "my_answer": "A|B|C|D", "my_reasoning": "…"}`
  }

  let done = 0
  let tokenIn = 0
  let tokenOut = 0
  let reasoning = 0
  let failures = 0
  const latencies = []
  const t0 = Date.now()

  /** 调一次。 */
  async function callOne(q) {
    const t = Date.now()
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: buildPrompt(q) }],
          temperature: 0,
          max_tokens: 6000,
          response_format: { type: 'json_object' },
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
      const u = body.usage ?? {}
      tokenIn += u.prompt_tokens ?? 0
      tokenOut += u.completion_tokens ?? 0
      reasoning += u.completion_tokens_details?.reasoning_tokens ?? 0
      latencies.push(Date.now() - t)
    } catch (error) {
      failures += 1
      console.log(`  ✗ ${q.id}: ${error.message}`)
    } finally {
      done += 1
      if (done % 5 === 0 || done === questions.length) {
        process.stdout.write(`  进度 ${done}/${questions.length}  用时 ${((Date.now() - t0) / 1000).toFixed(0)}s\r`)
      }
    }
  }

  // 简单的并发闸：切成 concurrency 条流水
  const queue = [...questions]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const q = queue.shift()
      if (q !== undefined) await callOne(q)
    }
  })
  await Promise.all(workers)

  const wallMs = Date.now() - t0
  const total = tokenIn + tokenOut
  const perQ = total / Math.max(1, questions.length)
  latencies.sort((a, b) => a - b)
  const median = latencies[Math.floor(latencies.length / 2)] ?? 0

  console.log(`\n\n── 结果 ──`)
  console.log(`  成功 ${questions.length - failures} / 失败 ${failures}`)
  console.log(`  墙钟 ${(wallMs / 1000).toFixed(1)}s（并发 ${concurrency}）`)
  console.log(`  单次延迟 中位 ${(median / 1000).toFixed(2)}s / 最大 ${((latencies[latencies.length - 1] ?? 0) / 1000).toFixed(2)}s`)
  console.log(`  token：输入 ${tokenIn} + 输出 ${tokenOut} = **${total}**（其中推理 ${reasoning}，占 ${total ? Math.round((reasoning / total) * 100) : 0}%）`)
  console.log(`  每题均 **${Math.round(perQ)} tokens**`)
  console.log(`\n  按此推算：`)
  console.log(`    600 题 ≈ ${Math.round((perQ * 600) / 1000)}k tokens，墙钟 ≈ ${Math.round(((wallMs / Math.max(1, questions.length)) * 600) / 1000 / 60)} 分钟`)
  console.log(`    2400 题 ≈ ${Math.round((perQ * 2400) / 1000)}k tokens，墙钟 ≈ ${Math.round(((wallMs / Math.max(1, questions.length)) * 2400) / 1000 / 60)} 分钟`)
  console.log('\n  注意：这是**每问一次的完整预处理**（分块校验 + 元信息 + 自己作答）。')
  console.log('  若把分块也交给模型（同一问里做），成本不变；分成两次问则会翻倍。')
}

// ── 模式 3：一个具体动作的内存峰值 ────────────────────────────────────────

/**
 * 量内存峰值：跑**真实的重活**，而不是自己造一个动作。
 *
 * ═══ 故意选 OCR 而不是"分配一个大数组" ═══
 * 要判断的是"跑这批资料会不会把内存吃满"，而 OCR 才是真正吃内存的那一步
 * （onnxruntime 的分配几乎全在原生侧，Node 自己的 memoryUsage 看不到）。
 * 用一个 `new Array(1e7)` 去测只会得到"V8 怎么分配"的结论，与本题无关。
 *
 * ⚠ 输出目录放在 `data/_probe-mem/`（**不碰 data/ocr/**）：
 * 探针的产物绝不能污染真产物目录——否则"哪些 OCR 跑过了"这个断点续跑的依据就被污染了。
 */
async function probeMem() {
  const pdf = 'D:\\考公资料\\刷题\\资料分析600题\\题本篇.pdf'
  const out = join(repoRoot, 'data', '_probe-mem')
  const args = [join(repoRoot, 'scripts', 'ocr_pages.py'), '--pdf', pdf, '--pages', '30-33', '--out', out, '--quiet']
  console.log('内存探针：用真实 OCR 跑 4 页（资料分析，页面最大的一族）\n')
  console.log(`  ${PYTHON} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`)

  const r = await runMeasured(PYTHON, args)
  const lines = r.out.trim().split('\n').filter((l) => l.trim() !== '')
  console.log(`  退出码 ${r.code}，用时 ${(r.ms / 1000).toFixed(1)}s`)
  if (r.samples === 0) {
    // ⚠ 关键：没采到样本时 peakMb 也是 0，而那是"没量到"，不是"占用为零"。
    // 不区分这两者会把一个空数字当成结论（E25：假验证比没验证更坏）。
    console.log('  ⚠ 没采到内存样本（进程太短或采样窗口错过）——**这个 0 是"没量到"，不是"占用小"**')
  } else {
    console.log(`  峰值工作集 **${r.peakMb} MB**（采样 ${r.samples} 次）`)
  }
  for (const l of lines.slice(-4)) console.log(`  ${l}`)
  console.log('\n  （产物在 data/_probe-mem/，可自行删除；它不属于任何真产物目录）')
}

// ── 模式 4：窗口切题 —— 量"重复输入"值多少钱 ──────────────────────────────
//
// ═══ 为什么单独量这个 ═══
// 作者定的方向是"以页为单位整体输入、让模型按语义辨题"（人也是这么读的），
// 那就有三个必须量清的账：
//   ① 一次读几页（窗口大小）；
//   ② 窗口之间要不要重叠（不重叠会切碎跨页的题，重叠会重复喂 token）；
//   ③ 按什么切（固定页数 vs 按印出来的"练习题NN套"先验）。
// 而"重复输入到底亏多少"是可以算准的：看每个物理页被喂了几次。

/**
 * 算一组窗口的重复输入倍数。
 *
 * @param pages - 总页数。
 * @param windowPages - 每个窗口几页。
 * @param stridePages - 步长几页（= 窗口大小 → 不重叠；< 窗口大小 → 重叠）。
 * @returns `{ windows, windowTokens, uniqueTokens, reuseFactor }`。
 */
export function windowOverlap({ pages, windowPages, stridePages, tokensPerPage = 360 }) {
  const windows = []
  for (let start = 1; start <= pages; start += stridePages) {
    const end = Math.min(pages, start + windowPages - 1)
    windows.push([start, end])
    if (end >= pages) break
  }
  const windowTokens = windows.reduce((s, [a, b]) => s + (b - a + 1) * tokensPerPage, 0)
  const uniqueTokens = pages * tokensPerPage
  return {
    windows: windows.length,
    windowTokens,
    uniqueTokens,
    // 1.0 = 每个页面只喂一次；2.0 = 平均喂了两次
    reuseFactor: uniqueTokens === 0 ? 0 : windowTokens / uniqueTokens,
  }
}

/**
 * 四种切分策略的账（纯计算，不调模型）。
 *
 * @param params.pages - 该册页数。
 * @param params.questions - 该册题数。
 * @param params.tokensPerPage - 每页正文字数换算成 token（实测约 360）。
 * @param params.promptTokens - 每次调用的提示词固定开销（实测约 400）。
 */
export function compareWindowStrategies({ pages, questions, tokensPerPage = 360, promptTokens = 400 }) {
  const rows = []
  const strategies = [
    { name: '一页一窗（无重叠）', windowPages: 1, stridePages: 1 },
    { name: '两页一窗（重叠 1 页/步长 1）', windowPages: 2, stridePages: 1 },
    { name: '两页一窗（步长 2，不重叠）', windowPages: 2, stridePages: 2 },
    { name: '四页一窗（步长 2，重叠 2 页）', windowPages: 4, stridePages: 2 },
  ]
  for (const s of strategies) {
    const w = windowOverlap({ pages, windowPages: s.windowPages, stridePages: s.stridePages, tokensPerPage })
    const inputTokens = w.windowTokens + w.windows * promptTokens
    rows.push({
      ...s,
      windows: w.windows,
      reuse: w.reuseFactor,
      inputTokens,
      inputPerQuestion: inputTokens / questions,
    })
  }
  return rows
}

/**
 * 真跑一次窗口切题，量 token / 墙钟 / 准确率 / 去重效果。
 *
 * @param params.book - '题本' 或 '解析'（决定用哪个 OCR 目录）。
 * @param params.windowPages - 窗口几页。
 * @param params.stride - 步长几页。
 * @param params.maxWindows - 最多跑几个窗口（省钱）。
 * @param params.concurrency - 并发。
 */
async function probeWindow({ book, windowPages, stride, maxWindows, concurrency, slim }) {
  const apiKey = process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY
  if (apiKey === undefined || apiKey === '') {
    console.error('缺少 XIAOMI_TOKEN_PLAN_AMS_API_KEY 环境变量')
    process.exitCode = 2
    return
  }
  const baseUrl = 'https://token-plan-cn.xiaomimimo.com/v1'
  const model = 'mimo-v2.5-pro'

  const dir = book === '题本' ? join(repoRoot, 'data', 'ocr', 'align题本上') : join(repoRoot, 'data', 'ocr', 'align解析上')
  const files = readdirSyncSafe(dir).filter((f) => /^page-\d+\.json$/.test(f)).sort()
  if (files.length === 0) {
    console.error(`没有可用 OCR 页：${dir}`)
    process.exitCode = 2
    return
  }
  const pages = files.map((f) => {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    return { page: p.page, text: p.text }
  })

  // ── 切窗（**不排序**，整页原样喂；这正是作者要的"像人一样整体读"）──
  const windows = []
  for (let i = 1; i <= pages.length; i += stride) {
    const slice = pages.filter((p) => p.page >= i && p.page <= i + windowPages - 1)
    if (slice.length === 0) continue
    windows.push({ from: i, to: i + windowPages - 1, pages: slice })
  }
  const use = windows.slice(0, maxWindows)

  const strategy = compareWindowStrategies({ pages: pages.length, questions: 20 })
  const reuse = windowOverlap({ pages: pages.length, windowPages, stridePages: stride })
  console.log(`窗口切题探针：${book}，共 ${pages.length} 页`)
  console.log(`  窗口 ${windowPages} 页 / 步长 ${stride} 页 → 该册共 ${windows.length} 个窗口，页面平均被喂 ${reuse.reuseFactor.toFixed(2)} 次`)
  console.log(`  本次只跑前 ${use.length} 个窗口（省钱）\n`)
  console.log('  四种策略的理论账（按该册页数推算，习题册 20 题）:')
  for (const r of strategy) {
    console.log(
      `    ${r.name.padEnd(34)} 窗口 ${String(r.windows).padStart(3)}  重复 ${r.reuse.toFixed(2)}×  输入 ${String(Math.round(r.inputTokens / 1000)).padStart(4)}k tokens  (${Math.round(r.inputPerQuestion)} / 题)`,
    )
  }
  console.log('')

  const promptOf = (slice) => {
    const body = slice.map((p) => `───── 第 ${p.page} 页 ─────\n${p.text}`).join('\n\n')
    if (slim) {
      // ═══ 精简输出：**不要它重打题目** ═══
      // 原文已经在输入里了。让模型再抄一遍题干与选项，既是白花的输出 token，
      // 又引入"抄错/改写"的风险——而我一点都不需要它抄：题干是从原文按边界取的。
      return `下面是一个公考行测题集的**连续若干页 OCR 文本**（扫描件，可能有识别错误；可能双栏排版，行序可能乱）。
请**像人一样整体阅读**，把这几页里出现的**每一道题的作答信息**抽出来。

${body}

要求：
1. **按语义辨题**，不要依赖行序；跨页或被排版切断的题要认出是同一道。
2. **不要抄题干与选项文字**（我要从原文取，你抄反而会抄错）。
3. 每道题给：页面上印的题号、所在页、你自己的一次作答、一句理由、必要的元信息。
4. 只输出 JSON，不要解释文字。

输出格式：
{"questions":[{"number":"12","page":3,"my_answer":"A|B|C|D","my_reasoning":"…","blank_required":true|false,"blank_note":"…","question_type":"…","topics":["…"],"difficulty_hint":"易|中|难"}]}`
    }
    return `下面是一个公考行测题集的**连续若干页 OCR 文本**（来自扫描件，可能有识别错误；页面可能是双栏排版，行序可能乱）。
请**像人一样整体阅读**，然后把这几页里出现的**每一道题**都抽出来。

${body}

要求：
1. **按语义辨题**，不要依赖行序——跨页或被排版切断的题也要认出是同一道。
2. 每道题给：题干、选项（按 A/B/C/D）、以及你自己的一次作答与理由。
3. 题号用页面上印的（形如「12.」）；认不出题号就填 null。
4. 只输出 JSON，不要解释文字。

输出格式：
{"questions":[{"number":"12","stem":"…","options":[{"label":"A","text":"…"}],"my_answer":"A|B|C|D","my_reasoning":"…","blank_required":true|false,"blank_note":"…","question_type":"…","topics":["…"],"difficulty_hint":"易|中|难"}]}`
  }

  let tokenIn = 0
  let tokenOut = 0
  let reasoning = 0
  let failures = 0
  const perWindow = []
  const seen = new Map()
  let duplicates = 0
  const t0 = Date.now()

  const queue = [...use]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const w = queue.shift()
      if (w === undefined) continue
      const t = Date.now()
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: promptOf(w.pages) }],
            temperature: 0,
            max_tokens: 8000,
            response_format: { type: 'json_object' },
          }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 160)}`)
        const u = body.usage ?? {}
        tokenIn += u.prompt_tokens ?? 0
        tokenOut += u.completion_tokens ?? 0
        reasoning += u.completion_tokens_details?.reasoning_tokens ?? 0
        const text = body.choices?.[0]?.message?.content ?? ''
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {
          /* 解析失败按 0 题记，不抛 */
        }
        const qs = Array.isArray(parsed?.questions) ? parsed.questions : []
        for (const q of qs) {
          const key = `${q.number ?? 'null'}|${String(q.stem ?? '').replace(/\s+/g, '').slice(0, 24)}`
          if (seen.has(key)) duplicates += 1
          else seen.set(key, q)
        }
        perWindow.push({ from: w.from, to: w.to, questions: qs.length, ms: Date.now() - t, out: u.completion_tokens ?? 0 })
        console.log(`  窗口 p${w.from}-${w.to}: 抽到 ${qs.length} 题，${((Date.now() - t) / 1000).toFixed(1)}s，输出 ${u.completion_tokens ?? 0} tokens`)
      } catch (error) {
        failures += 1
        console.log(`  窗口 p${w.from}-${w.to}: ✗ ${error.message}`)
      }
    }
  })
  await Promise.all(workers)

  const wallMs = Date.now() - t0
  const total = tokenIn + tokenOut
  const qTotal = perWindow.reduce((s, x) => s + x.questions, 0)
  console.log(`\n── 结果 ──`)
  console.log(`  窗口 ${use.length} 个（失败 ${failures}），墙钟 ${(wallMs / 1000).toFixed(1)}s（并发 ${concurrency}）`)
  console.log(`  抽到题目 ${qTotal} 题（去重后 ${seen.size}；**跨窗口重复 ${duplicates} 题**）`)
  console.log(`  token：输入 ${tokenIn} + 输出 ${tokenOut} = **${total}**（推理 ${reasoning}，占 ${total ? Math.round((reasoning / total) * 100) : 0}%）`)
  console.log(`  每个窗口：输入均 ${Math.round(tokenIn / use.length)}，输出均 ${Math.round(tokenOut / use.length)}`)
  console.log(`\n  按 ${windows.length} 个窗口推算该册：输入 ≈ ${Math.round((tokenIn / use.length) * windows.length / 1000)}k tokens，`)
  console.log(`    墙钟 ≈ ${Math.round(((wallMs / use.length) * windows.length) / 1000 / 60)} 分钟`)
  console.log(`\n  ⚠ 注意：跨窗口重复题数就是"重叠的代价"——它由步长决定，与模型无关。`)
}

/**
 * 安全的目录读取（不存在时返回空数组，不抛）。
 *
 * @param dir - 目录。
 * @returns 文件名数组。
 */
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────

if (mode === 'ocr') {
  await probeOcr(Number(arg('pages', '6')))
} else if (mode === 'llm') {
  await probeLlm({ count: Number(arg('questions', '20')), concurrency: Number(arg('concurrency', '4')) })
} else if (mode === 'window') {
  await probeWindow({
    book: arg('book', '解析'),
    windowPages: Number(arg('window', '2')),
    stride: Number(arg('stride', '1')),
    maxWindows: Number(arg('max-windows', '8')),
    concurrency: Number(arg('concurrency', '4')),
    // `--slim`：不要求模型重打题干与选项，只产出作答与元信息
    slim: argv.includes('--slim'),
  })
} else if (mode === 'mem') {
  await probeMem()
} else {
  console.error(`未知模式：${mode}（可用：ocr / llm / window / mem）`)
  process.exitCode = 2
}
