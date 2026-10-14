/**
 * `@lh/question-bank-ui` 的**路由自检** —— 用假 `req`/`res` 真跑七条路由，不启服务器。
 *
 * ═══ 为什么需要它（`selftest.mjs` 覆盖不到这里）═══
 * 那个自检测的是**纯函数**（视图组装）。这一层要测的是**接缝**：
 *   · 字段/查询参数白名单——不认识的参数会不会被静默忽略（ADR-037 §11.5 记过的形状）；
 *   · 归档/恢复**真的动了盘上的文件吗**、拒绝覆盖时**一个字都没动吗**；
 *   · 面板的每条路由返回的 payload 里，该有的段在不在（题库/来源/题目/记录）。
 * 这些只有"真调一次 handler"才看得见。
 *
 * ═══ 为什么跑源码**和**每一份已装副本 ═══
 * 副本是**快照不是软链**：改了源码不重装，生产跑的还是旧代码，而症状与"改了没生效"一模一样
 * （本项目最贵的失败形状，ADR-035 §7.1）。所以这里对**所有**存在的副本各跑一遍。
 * 源码那份也跑，是因为本包 import 的两个跨包依赖（`@lh/event-store`、`@lh/question-bank`）
 * 在仓库根 `node_modules/@lh/` 下**确实有软链**（根 package.json 用 `workspace:*` 声明过），
 * 所以源码路径也能解析——这比"没装就跳过"强：装之前就有闸门。
 *
 * ═══ 它会不会碰真实的题库与学习史 ═══
 * 不会。全程在临时沙盒里：
 *   · `LH_WORKSPACE` → 沙盒里的假工作区（两个真题库 + 一个坏库 + 一个伴生文件 + 一个归档库）；
 *   · `LH_EVENT_LOG` → 沙盒里的假日志。
 * 并且**显式断言仓库真实日志的字节数一个都没变**——闸门自己制造垃圾是修过一次的事（ADR-037 §11.8d）。
 *
 * 运行：node plugins/lh-question-bank-ui/selftest-routes.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

// ⚠ 真实学习史的字节数：跑之前先记下，跑完必须一致。放在**设置沙盒环境变量之前**取，
//   这样它读的确实是生产那份日志（路径是静态的，不依赖环境变量）。
const REAL_LOG = join(REPO_ROOT, 'data', 'events.jsonl')
const realLogBytesBefore = existsSync(REAL_LOG) ? statSync(REAL_LOG).size : 0

const sandbox = mkdtempSync(join(tmpdir(), 'lh-bank-selftest-'))
const WS = join(sandbox, 'ws')
const BANK_DIR = join(WS, 'lh-questions')
const ARCHIVE_DIR = join(BANK_DIR, '.archived')
mkdirSync(ARCHIVE_DIR, { recursive: true })
process.env.LH_WORKSPACE = WS
process.env.LH_EVENT_LOG = join(sandbox, 'events.jsonl')

/**
 * 收尾：删临时沙盒，再按给定退出码退出。
 * @param code - 退出码。
 */
function finish(code) {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 删不掉临时目录不该掩盖真正的结果 */
  }
  process.exit(code)
}

// ── 夹具 ────────────────────────────────────────────────────────────────

/** 夹具用的假来源根：只是题库 `source_root` 的字符串标签，不需要真实存在。 */
const FIXTURE_SOURCE_ROOT = 'D:\\考公资料' // lh-path-ok: 测试夹具；只是 source_root 的字符串标签，不读它

/** 造一个题库对象。 */
function bank(title, questions) {
  return {
    schema_version: 1,
    title,
    source_root: FIXTURE_SOURCE_ROOT,
    generated_at: '2026-09-17T15:00:00.000Z',
    provenance: { plugin: '@lh/extractor', version: '0.1.0', extraction: 'rule' },
    question_count: questions.length,
    duplicate_ids: [],
    questions,
  }
}

const qA1 = { id: 'q-a1', kind: 'single_choice', stem: '甲题：这段文字旨在说明？', options: ['一', '二'], answer: ['A'], accept: [], analysis: '甲解析', topics: ['片段阅读'], unmapped_topics: [], source: { path: 'f1.pdf', number: '1', page: 3 }, provenance: {} }
const qA2 = { id: 'q-a2', kind: 'fill_blank', stem: '乙题：横线处填什么？', options: [], answer: ['42'], accept: [], analysis: '', topics: [], unmapped_topics: [], source: { path: 'f2.pdf', number: '2' }, provenance: {} }
const qB1 = { id: 'q-b1', kind: 'single_choice', stem: '丙题？', options: ['A', 'B'], answer: ['B'], accept: [], analysis: '丙解析', topics: [], unmapped_topics: [], source: { path: 'g1.pdf', number: '9' }, provenance: {} }

writeFileSync(join(BANK_DIR, 'A库.json'), JSON.stringify(bank('A库', [qA1, qA2]), null, 2), 'utf8')
writeFileSync(join(BANK_DIR, 'B库.json'), JSON.stringify(bank('B库', [qB1]), null, 2), 'utf8')
// 伴生文件：**不是题库**，必须不出现在清单里（否则面板会列出名字很像的三个选项）
writeFileSync(join(BANK_DIR, 'A库.option-notes.json'), JSON.stringify({ notes: [] }), 'utf8')
// 坏库：JSON 都解析不出来。它必须**照样列出来并标注**——隐藏它会让"我的题库去哪了"变成谜
writeFileSync(join(BANK_DIR, '坏库.json'), '{ 这不是 JSON', 'utf8')
// 已归档的库：单独成区，不进题库清单
writeFileSync(join(ARCHIVE_DIR, '旧库.json'), JSON.stringify(bank('旧库', [qB1]), null, 2), 'utf8')

const T = { a1: '2026-09-17T15:10:51.557Z', a2: '2026-09-18T09:00:00.000Z', orphan: '2026-09-21T09:56:34.338Z' }
const S1 = 'session-1111-aaaa'

/** 造一条作答事件。 */
const attempt = (qid, response, correct, source, timestamp, sessionRef) => ({
  id: `e-${qid}-${timestamp}`,
  timestamp,
  actor: source,
  type: 'lh/user/attempt',
  provenance: { plugin: '@lh/question-bank', version: '0.0.1' },
  scope: 'root',
  session_ref: sessionRef ?? null,
  content_ref: null,
  data: { question_id: qid, response, correct, source, duration_ms: 1234, context: { session_ref: sessionRef ?? null, seq: null } },
})

writeFileSync(
  process.env.LH_EVENT_LOG,
  [
    JSON.stringify({ id: 'e-course', timestamp: T.a1, type: 'lh/course/created', data: {} }),
    JSON.stringify(attempt('q-a1', 'A', true, 'human', T.a1, S1)),
    JSON.stringify(attempt('q-a2', '42', false, 'human', T.a2, null)),
    JSON.stringify(attempt('q-orphan999', 'C', true, 'human', T.orphan, null)),
    // 一条**模型作答**：它必须默认被排除在人的统计之外（ADR-018 决定 6），
    // 但条数要如实报出来——这是"用模型模拟学习"那条路的安全前提。
    JSON.stringify(attempt('q-b1', 'B', true, 'llm', T.a1, null)),
    // 形状不合法：correct 不是三态。必须被报为 malformed，而**不是**当成答错
    JSON.stringify({ id: 'e-bad', timestamp: T.a2, type: 'lh/user/attempt', data: { question_id: 'q-x', correct: 'nope', source: 'human' } }),
  ].join('\n') + '\n',
  'utf8',
)
const sandboxLogBytes = statSync(process.env.LH_EVENT_LOG).size
const sandboxEventCount = readFileSync(process.env.LH_EVENT_LOG, 'utf8').split('\n').filter((l) => l.trim() !== '').length

// ── 断言工具 ────────────────────────────────────────────────────────────

let passed = 0
const failures = []

/**
 * 断言。
 * @param label - 这条在说什么。
 * @param condition - 真假。
 * @param detail - 失败时的上下文。
 */
function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${label}${detail === '' ? '' : `  →  ${detail}`}`)
}

// ── 假 req / res / ctx（照 @lh/schedule-ui/selftest-routes.mjs 的先例）──────

/** 造一个假请求。 */
function makeReq(method, url, body) {
  const listeners = new Map()
  const req = {
    method,
    url,
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return req
    },
    destroy() {},
  }
  // 下一个微任务再喂数据：让 handler 先把监听器挂上（真实网络也是这个顺序）。
  queueMicrotask(() => {
    if (body !== undefined) {
      for (const handler of listeners.get('data') ?? []) handler(Buffer.from(JSON.stringify(body), 'utf8'))
    }
    for (const handler of listeners.get('end') ?? []) handler()
  })
  return req
}

/** 造一个假响应，记下状态码与 JSON 体。 */
function makeRes() {
  let status = null
  let text = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      if (typeof chunk === 'string') text += chunk
    },
  }
  return {
    res,
    read() {
      let body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch {
        body = { __raw: text }
      }
      return { status, body }
    },
  }
}

/** 假 ctx：只实现这个插件会用到的那几个成员。 */
function fakeContext() {
  const registered = []
  const ctx = {
    on() {},
    get() {
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject() {
      return () => {}
    },
    webServer: {
      register(options) {
        registered.push(options)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

// ── 找到要测的每一份实现 ────────────────────────────────────────────────

/**
 * 所有可测入口：源码一份 + 每个家里每个 profile 的副本各一份。
 * @returns `[{ label, entry }]`。
 */
function findTargets() {
  const targets = [{ label: '源码', entry: join(HERE, 'index.js') }]
  const DSH_HOME =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? resolve(process.env.DSH_HOME.trim())
      : existsSync(join(REPO_ROOT, '.dsh', 'profiles'))
        ? join(REPO_ROOT, '.dsh')
        : join(homedir(), '.dsh')
  const homes = [...new Set([DSH_HOME, join(REPO_ROOT, '.dsh')])].filter((h) => existsSync(join(h, 'profiles')))
  for (const home of homes) {
    for (const profile of readdirSync(join(home, 'profiles'))) {
      const entry = join(home, 'profiles', profile, 'node_modules', '@lh', 'question-bank-ui', 'index.js')
      if (existsSync(entry)) {
        targets.push({ label: `${home === DSH_HOME ? 'DSH_HOME' : '仓库家'}/${profile}`, entry })
      }
    }
  }
  return targets
}

const targets = findTargets()
const installed = targets.filter((t) => t.label !== '源码').length

// ── 主流程 ──────────────────────────────────────────────────────────────

for (const target of targets) {
  console.log(`\n── ${target.label}：${target.entry}`)

  const mod = await import(pathToFileURL(target.entry).href)
  const L = target.label
  ok(`${L}: 导出 apply()`, typeof mod.apply === 'function')
  ok(`${L}: 导出 name`, mod.name === 'lh-question-bank-ui', String(mod.name))
  ok(`${L}: inject 只声明 webServer`, JSON.stringify([...(mod.inject ?? [])].sort()) === JSON.stringify(['webServer']))

  const { ctx, registered } = fakeContext()
  await mod.apply(ctx)
  ok(`${L}: apply() 注册了一条 prefix 路由`, registered.length === 1 && registered[0].kind === 'prefix')
  const route = registered[0]
  if (route === undefined) continue
  ok(`${L}: 路由前缀是 /lh/bank`, route.path === '/lh/bank', String(route.path))

  /** 打一条路由。 */
  async function hit(method, path, body) {
    const { res, read } = makeRes()
    await route.handler(makeReq(method, `/lh/bank${path}`, body), res)
    return read()
  }

  // 1) 自检
  const health = await hit('GET', '/health')
  ok(`${L}: GET /health → 200`, health.status === 200, `HTTP ${health.status} ${JSON.stringify(health.body)?.slice(0, 160)}`)
  ok(`${L}: /health 报出工作区路径（且就是沙盒那个）`, health.body?.workspace?.dir === WS, String(health.body?.workspace?.dir))
  ok(`${L}: /health 计数：2 个好库 + 1 个坏库`, health.body?.bank_count === 3 && health.body?.ok_bank_count === 2 && health.body?.broken_bank_count === 1, JSON.stringify({ c: health.body?.bank_count, ok: health.body?.ok_bank_count, bad: health.body?.broken_bank_count }))
  ok(`${L}: /health 计数：3 道题（坏库不贡献题）`, health.body?.question_count === 3, String(health.body?.question_count))
  ok(`${L}: /health 计数：3 次作答、2 条对上号、1 条孤儿`, health.body?.attempt_count === 3 && health.body?.matched_attempt_count === 2 && health.body?.unmatched_attempt_count === 1)
  ok(`${L}: /health 报出 malformed 条数`, health.body?.malformed_attempt_count === 1)
  ok(`${L}: /health 报出归档库数`, health.body?.archived_count === 1)
  // 人的口径：模型那条不计入；但**数量如实报出**（这就是"不混算、也不隐藏"）
  ok(`${L}: /health 默认只算人的作答（3 条），并如实报出 1 条非人作答`, health.body?.attempt_count === 3 && health.body?.non_human_attempt_count === 1, JSON.stringify({ n: health.body?.attempt_count, non: health.body?.non_human_attempt_count }))
  ok(`${L}: /health?scope=all 才把模型那条算进来（4 条）`, (await hit('GET', '/health?scope=all')).body?.attempt_count === 4)
  ok(`${L}: scope 传乱值 → 保守退回 human（宁少算不混算），并在返回里回显`, (await hit('GET', '/health?scope=%E4%B9%B1%E5%86%99')).body?.scope === 'human')

  // 2) 题库段
  const banks = await hit('GET', '/banks')
  ok(`${L}: GET /banks → 200`, banks.status === 200)
  ok(`${L}: 伴生文件（A库.option-notes.json）**没有**被当成题库`, !(banks.body?.banks ?? []).some((b) => String(b.name).includes('option-notes')), JSON.stringify((banks.body?.banks ?? []).map((b) => b.name)))
  ok(`${L}: 坏库照样列出并标注 ok=false`, (banks.body?.banks ?? []).some((b) => b.name === '坏库' && b.ok === false))
  ok(`${L}: 归档库单独成区、不进清单`, (banks.body?.archived ?? []).length === 1 && banks.body.archived[0].name === '旧库' && banks.body.banks.length === 3)
  ok(`${L}: 孤儿作答既不进列表也**不静默丢弃**（有计数 + 有说明）`, banks.body?.totals?.unmatched_attempt_count === 1 && (banks.body?.notes ?? []).some((n) => n.includes('未列入')))
  ok(`${L}: 不认识的查询参数 → 400 并列出可用参数（不许静默忽略）`, (await hit('GET', '/banks?foo=1')).status === 400)

  // 3) 来源段
  const src = await hit('GET', '/source?name=A%E5%BA%93')
  ok(`${L}: GET /source → 200`, src.status === 200, `HTTP ${src.status} ${JSON.stringify(src.body)?.slice(0, 160)}`)
  ok(`${L}: 来源段给出两个来源文件`, (src.body?.source_files ?? []).length === 2)
  ok(`${L}: 来源段给出库级覆盖面`, src.body?.coverage?.with_topics === 1 && src.body?.coverage?.without_analysis === 1)
  ok(`${L}: 来源段说明"没有导入事件"（这两个库是脚本落盘的）`, (src.body?.notes ?? []).some((n) => n.includes('没有这个库的导入事件')))
  ok(`${L}: /source 缺 name → 400`, (await hit('GET', '/source')).status === 400)
  const missing = await hit('GET', '/source?name=%E4%B8%8D%E5%AD%98%E5%9C%A8')
  ok(`${L}: /source 题库不存在 → 400 且带可选项`, missing.status === 400 && Array.isArray(missing.body?.available) && missing.body.available.includes('A库'))

  // 4) 题目段
  const q1 = await hit('GET', '/questions?name=A%E5%BA%93&limit=1')
  ok(`${L}: GET /questions → 200 且分页生效`, q1.status === 200 && q1.body?.items?.length === 1 && q1.body?.has_more === true, JSON.stringify({ s: q1.status, n: q1.body?.items?.length, more: q1.body?.has_more }))
  ok(`${L}: 题目段给看答案与解析（管理视角）`, Array.isArray(q1.body?.items?.[0]?.answer) && q1.body.items[0].answer.length > 0)
  const q2 = await hit('GET', '/questions?name=A%E5%BA%93&limit=1&offset=1')
  ok(`${L}: 第二页拿到剩下那题且 has_more=false`, q2.body?.items?.[0]?.id === 'q-a2' && q2.body?.has_more === false)
  const unseen = await hit('GET', '/questions?name=A%E5%BA%93&state=wrong')
  ok(`${L}: 按"最近答错"筛 → 只有乙题（夹具里乙题是答错那次）`, unseen.body?.total === 1 && unseen.body?.items?.[0]?.id === 'q-a2', JSON.stringify({ total: unseen.body?.total, ids: unseen.body?.items?.map((i) => i.id) }))
  ok(`${L}: 不认识的查询参数 → 400 并列出可用的`, (await hit('GET', '/questions?name=A%E5%BA%93&nope=1')).body?.accepted?.includes('state') === true)
  ok(`${L}: 超上限的 limit 被收住（不整库塞进浏览器）`, (await hit('GET', '/questions?name=A%E5%BA%93&limit=99999')).body?.limit === 200)

  // 5) 记录段
  const rec = await hit('GET', '/attempts')
  ok(`${L}: GET /attempts → 200`, rec.status === 200)
  ok(`${L}: 只列对得上号的：2 条进列表、1 条孤儿只计数`, rec.body?.total === 2 && rec.body?.items?.length === 2 && rec.body?.unmatched_attempt_count === 1)
  ok(`${L}: 记录按时间倒序（最近的在前）`, rec.body?.items?.[0]?.timestamp === T.a2, JSON.stringify(rec.body?.items?.map((i) => i.timestamp)))
  ok(`${L}: 每条带题库归属与题干预览`, rec.body?.items?.[0]?.bank === 'A库' && typeof rec.body?.items?.[0]?.question?.stem_preview === 'string')
  ok(`${L}: 关联会话原样带出、无坐标如实为 null`, rec.body?.items?.find((i) => i.timestamp === T.a1)?.session_ref === S1 && rec.body?.items?.find((i) => i.timestamp === T.a2)?.session_ref === null)
  const nulls = await hit('GET', '/attempts?correct=null')
  ok(`${L}: 三态过滤里 null 是独立一档`, nulls.body?.items?.length === 0 || nulls.body?.filters?.correct === 'null')
  ok(`${L}: 不认识的查询参数 → 400 并列出可用的`, (await hit('GET', '/attempts?zzz=1')).body?.accepted?.includes('correct') === true)
  ok(`${L}: accepted 里有新的 verdict（四态判决过滤）`, (await hit('GET', '/attempts?zzz=1')).body?.accepted?.includes('verdict') === true)
  ok(`${L}: accepted 里有 answerers（按作答者多选）`, (await hit('GET', '/attempts?zzz=1')).body?.accepted?.includes('answerers') === true)
  // 作答者多选（2026-10-13）：默认只看用户；勾上型号才看得到模型的作答
  const humanOnly = await hit('GET', '/attempts?answerers=human')
  ok(`${L}: answerers=human → 只有用户的作答`, humanOnly.body?.total === 2, String(humanOnly.body?.total))
  ok(`${L}: answerers 清单带条数与显示名（「用户」在最前）`, Array.isArray(rec.body?.answerers) && rec.body?.answerers?.[0]?.label === '用户', JSON.stringify(rec.body?.answerers))
  // 5b) 备注（2026-10-13：作答级注解，只追加）
  const noteAttempt = rec.body?.items?.[0]
  ok(`${L}: 每行带 notes 字段（当前有效的那几条）`, Array.isArray(noteAttempt?.notes), JSON.stringify(noteAttempt?.notes))
  const noted = await hit('POST', '/note', {
    attempt_event_id: noteAttempt?.event_id,
    question_id: noteAttempt?.question_id,
    text: '当时把主旨读成了细节',
    note_kind: 'reflection',
  })
  ok(`${L}: POST /note → 200 且返回 note_event_id`, noted.status === 200 && typeof noted.body?.note_event_id === 'string', `HTTP ${noted.status} ${JSON.stringify(noted.body)?.slice(0, 160)}`)
  const afterNote = await hit('GET', '/attempts')
  ok(`${L}: 备注真的挂到了**那一次作答**上（行上带出它）`, (afterNote.body?.items?.find((x) => x.event_id === noteAttempt?.event_id)?.notes ?? []).some((n) => n.text === '当时把主旨读成了细节'))
  ok(`${L}: 备注只追加：日志里多了一条 lh/resource/note-made`, readFileSync(process.env.LH_EVENT_LOG, 'utf8').includes('lh/resource/note-made'))
  ok(`${L}: POST /note 收到不认识的字段 → 400 且不写事件`, (await hit('POST', '/note', { text: 'x', question_id: 'q-a1', 乱传: 1 })).status === 400)
  ok(`${L}: POST /note 空正文 → 400（空备注不写：只会变成噪声）`, (await hit('POST', '/note', { question_id: 'q-a1', text: '   ' })).status === 400)
  ok(`${L}: POST /note 没有锚点 → 400`, (await hit('POST', '/note', { text: 'x' })).status === 400)
  // 四态判决（2026-10-13 新增）：正确 / 部分正确 / 错误 / 判不了
  const vCorrect = (await hit('GET', '/attempts?verdict=correct')).body?.total
  const vWrong = (await hit('GET', '/attempts?verdict=wrong')).body?.total
  const vPartial = (await hit('GET', '/attempts?verdict=partial')).body?.total
  ok(`${L}: verdict=correct / wrong / partial 各自筛得出`, vCorrect === 1 && vWrong === 1 && vPartial === 0, JSON.stringify({ vCorrect, vWrong, vPartial }))
  ok(`${L}: 判决分布随返回带出（verdict_counts）`, typeof rec.body?.verdict_counts?.correct === 'number', JSON.stringify(rec.body?.verdict_counts))
  // 新增的两列：正确答案（字符型）与作答者（型号）
  const rows = rec.body?.items ?? []
  ok(`${L}: 每行带出官方答案的字符型（正确答案列）`, rows.every((r) => typeof r.question?.answer_text === 'string') && rows.some((r) => r.question.answer_text === 'A') && rows.some((r) => r.question.answer_text === '42'), JSON.stringify(rows.map((r) => r.question?.answer_text)))
  ok(`${L}: 每行带出 verdict 与 model 字段（作答者列）`, rows.every((r) => typeof r.verdict === 'string' && 'model' in r), JSON.stringify(rows.map((r) => ({ v: r.verdict, m: r.model }))))

  // 6) 归档 / 恢复（真的动盘）
  const beforeArchive = readdirSync(BANK_DIR).sort()
  ok(`${L}: 归档前 B库.json 在活跃区`, beforeArchive.includes('B库.json'))
  const arch = await hit('POST', '/archive', { bank: 'B库' })
  ok(`${L}: POST /archive → 200`, arch.status === 200, `HTTP ${arch.status} ${JSON.stringify(arch.body)?.slice(0, 160)}`)
  ok(`${L}: 归档后文件真的到了 .archived/`, existsSync(join(ARCHIVE_DIR, 'B库.json')) && !existsSync(join(BANK_DIR, 'B库.json')))
  const afterArchive = await hit('GET', '/banks')
  ok(`${L}: 归档后题库清单少一个、归档区多一个`, afterArchive.body?.banks?.length === 2 && afterArchive.body?.archived?.length === 2)
  const twice = await hit('POST', '/archive', { bank: 'B库' })
  ok(`${L}: 重复归档同一名字 → 400（拒绝覆盖，如实报）`, twice.status === 400, `HTTP ${twice.status}`)
  const rest = await hit('POST', '/restore', { bank: 'B库' })
  ok(`${L}: POST /restore → 200 且文件回到活跃区`, rest.status === 200 && existsSync(join(BANK_DIR, 'B库.json')) && !existsSync(join(ARCHIVE_DIR, 'B库.json')))
  const afterRestore = await hit('GET', '/banks')
  ok(`${L}: 恢复后清单复原`, afterRestore.body?.banks?.length === 3 && afterRestore.body?.archived?.length === 1)
  ok(`${L}: 恢复一个不存在的归档 → 400`, (await hit('POST', '/restore', { bank: '不存在' })).status === 400)
  const badField = await hit('POST', '/archive', { bank: 'A库', reason: '乱传的' })
  const keptA = existsSync(join(BANK_DIR, 'A库.json'))
  ok(`${L}: 写路由收到不认识的字段 → 400 且**一个文件都没动**`, badField.status === 400 && keptA, `HTTP ${badField.status} kept=${keptA}`)
  ok(`${L}: 写路由缺 bank → 400`, (await hit('POST', '/archive', {})).status === 400)
  ok(`${L}: 未知路由 → 404`, (await hit('GET', '/nope')).status === 404)
}

// ── 收尾断言：闸门自己不许制造垃圾 ──────────────────────────────────────

const realLogBytesAfter = existsSync(REAL_LOG) ? statSync(REAL_LOG).size : 0
ok('真实学习史一个字节都没变', realLogBytesAfter === realLogBytesBefore, `before=${realLogBytesBefore} after=${realLogBytesAfter}`)
ok(
  '读路径一条都不写盘：日志**只**多了备注事件（本夹具每份实现各跑一遍，故条数 = 实现数）',
  (() => {
    const lines = readFileSync(process.env.LH_EVENT_LOG, 'utf8').split('\n').filter((l) => l.trim() !== '')
    const added = lines.length - sandboxEventCount
    const notes = lines.filter((l) => l.includes('lh/resource/note-made')).length
    return added >= 1 && added === notes
  })(),
  `before=${sandboxEventCount}`,
)
// ── 汇总 ────────────────────────────────────────────────────────────────

console.log('')
if (installed === 0) {
  console.log('⚠ 只跑了源码那一份：本包还没装到任何 profile（跑 scripts/install-lh-question-bank-ui.mjs 之后再跑一次，才有生产副本的覆盖）。')
}
console.log(`══ 结果：${passed} 通过 / ${failures.length} 失败（${targets.length} 份实现）══`)
if (failures.length > 0) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  finish(1)
}
console.log('全部通过。')
finish(0)
