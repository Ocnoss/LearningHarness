/**
 * lh-question-bank-ui 的【服务端半】—— 给「题库管理」面板提供数据与两个可逆动作。
 *
 * ═══ 它做什么 ═══
 * 在 `/lh/bank` 前缀下注册这些路由：
 *   · `GET  /health`     自检：工作区与日志读不读得到、几库几题、几条件答对上号；
 *   · `GET  /banks`      题库清单（含已归档区）+ 全局合计；
 *   · `GET  /source`     选中题库的**来源**段（库级：出处文件、抽取方式与模型、覆盖面）；
 *   · `GET  /questions`  选中题库的**题目**段（分页 + 筛题干/知识点/题型/做过没做过/最近答错）；
 *   · `GET  /attempts`   **记录**段（时间 / 作答 / 三态对错 / 来源 / 用时 / 关联会话 / 属于哪库哪题）；
 *   · `POST /archive`    把一个题库移进 `lh-questions/.archived/`（可逆的机械动作）；
 *   · `POST /restore`    把它移回来。
 *
 * ═══ 数据来自两处，且都不写死盘符 ═══
 *   · **题库**：工作区 `lh-questions/*.json` —— 用 `workspaceDir()`（`lh-install.json` 的
 *     `workspace` 字段，或 `LH_WORKSPACE` 环境变量）；
 *   · **作答**：`data/events.jsonl` 里的 `lh/user/attempt` —— 用 `readEvents()`。
 * 两者刻意分开：题库是**资源**（文件，可带走、可手改），作答是**事件**（只追加的事实源）。
 * 面板把两处 join 起来，join 的**唯一依据**是 `question_id`（ADR-017 决定 6 / ADR-028）。
 *
 * ═══ 写权限：只有两个可逆的机械动作，且**一个事件都不写** ═══
 * 与 ADR-035/037 的分工一致（判断归 agent，机械动作归界面），但这里更窄：
 * "归档"只是**工作区文件的一次移动**——它不改题库内容、不改事件日志。
 *   · 题库的物理形态是文件（ADR-018 决定 2），文件系统就是这一层的事实源，
 *     所以一次移动是合法的状态变化，不需要（也不该）伪造成一条资源事件；
 *   · 移动是**可逆**的（`/restore` 移回来），所以不需要两段式确认——
 *     规则 4 的白名单纪律针对的是**不可逆**的破坏性操作；
 *   · **删除不在这里做**：那要走清理脚本（报告模式 + 备份 + 白名单），
 *     面板里放一个"删除题库"按钮，等于把一个不可逆操作放在最容易误点的地方。
 * ⚠ 已知缺口（如实记下）：归档/恢复不写事件，所以日志里**查不到"这个库什么时候被归档的"**。
 *   **失效信号**：一旦有人要问这个，那就是该开始写事件（或题库自身带版本号）的时候，
 *   而不是去翻文件系统时间戳——那个时间戳会被任何一次复制改动。
 *
 * ═══ 为什么走 HTTP 路由而不是 ctx.remote（与其它 LH 界面插件同一条）═══
 * `ctx.remote` 要求服务端导出**构建期生成**的 `./typert` 契约，而生成器没随发行版发布。
 *
 * ═══ 装载期不抛错（契约 §五之二）═══
 * `apply()` 里不解析数据目录、不读日志、不列题库目录——那些都会抛，
 * 而 profile 插件 apply 抛错会让**整棵插件树加载失败、dsh 起不来**（ADR-025）。
 * 读失败一律留到请求那一刻，返回 503 + 修法。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 跨包引用一律用**包名**（PLUGIN_CONTRACT §3）：本包会被装进 profiles/<名>/node_modules，
// 那时相对路径不再可达，而导入失败会让整棵插件树加载失败、dsh 起不来。
import { LhEventStore, readEvents } from '@lh/event-store/store'
import { workspaceDir } from '@lh/event-store/paths'
import { BANK_EXT, BANK_DIR_NAME, isBankFile, listQuestionBanks, loadBank, safeBankName } from '@lh/question-bank/bank'
import { recordNote } from '@lh/question-bank/note'
import { DEFAULT_LIMIT, buildAttempts, buildBankList, buildQuestions, buildSource, clampLimit, clampOffset, normalizeScope, parseAnswerers } from './view.js'

/** 插件名。 */
export const name = 'lh-question-bank-ui'

/** 声明依赖：`webServer` 用于注册 HTTP 路由。 */
export const inject = ['webServer']

/** 路由前缀。与 `/lh/workspace`、`/lh/schedule`、`/lh/course`、`/lh/practice` 都不撞。 */
export const ROUTE_PREFIX = '/lh/bank'

/** 归档目录名（在 `lh-questions/` 之下，`isBankFile` 天然不会把它当题库）。 */
export const ARCHIVE_DIR_NAME = '.archived'

/** 请求体上限。归档/恢复的载荷是一个题库名，16KB 已经宽得离谱。 */
const MAX_BODY_BYTES = 16 * 1024

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 记一条调试痕迹（与 LH 事件严格分开，同其它插件）。
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
 * 发一个 JSON 响应。
 * @param res - ServerResponse。
 * @param status - HTTP 状态码。
 * @param body - 要序列化的对象。
 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * 读并解析 JSON 请求体（带上限）。
 * @param req - IncomingMessage。
 * @returns 解析后的对象；空体返回 `{}`。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限。`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`))
      }
    })
  })
}

/**
 * 请求体/查询串里有没有**我们不认识的字段**。
 *
 * ═══ 为什么这道检查是硬的 ═══
 * ADR-037 §11.5 记过一次实测：调用方传了 `until`，而在线的旧插件 schema 里没有这个参数，
 * 宿主**静默丢弃**，工具正常返回——调用方以为自己设好了窗口，日志里却什么都没有。
 * 比报错更糟的形状。
 *
 * 这条在**工具那一侧做不到**（host 传给 execute 的 args 已经过 schema 过滤），
 * 但在 HTTP 这一侧收得到原始输入，所以能挡：不认识的字段一律 400 + 列出可用字段名。
 * 它同时是**界面与插件版本错配**（改了前端没重启服务端）的第一道探针。
 *
 * @param keys - 实际出现的字段名。
 * @param allowed - 该路由允许的字段名。
 * @returns 不认识的字段名数组。
 */
function unknownFields(keys, allowed) {
  const known = new Set(allowed)
  return keys.filter((key) => !known.has(key))
}

/** 数据目录/日志读不到时的统一说明（照其它面板的 503 + fix 形状）。 */
const NO_DATA = {
  error: '读不到 LH 事件日志，取不了作答记录。',
  fix: [
    '在 lh-install.json 里配好 repo_root / data_dir，或设环境变量 LH_DATA_DIR / LH_EVENT_LOG',
    '然后重启 dsh（数据目录是启动时定位的）',
  ],
  why: '作答是 lh/user/attempt 事件的投影；日志读不到就无从投影。刻意不在装载期抛错——那会让 dsh 起不来。',
}

/** 工作区没配好时的统一说明。 */
const NO_WORKSPACE = {
  error: '没配学习者的工作区，读不到题库。',
  fix: [
    '在 lh-install.json 里写 workspace（内含 lh-questions/ 的那个目录），或设环境变量 LH_WORKSPACE',
    '然后重启 dsh（工作区是启动时定位的）',
  ],
  why: '题库是工作区里的文件（ADR-018 决定 2）。定位不到时**刻意不猜一个目录**——猜错会去读别人的工作区，而症状只是"题库是空的"。',
}

/**
 * 读事件；日志读不到时返回 null（调用方转 503，而不是让请求崩掉）。
 * @returns 事件数组或 null。
 */
function safeReadEvents() {
  try {
    return readEvents()
  } catch (error) {
    trace(`READ_EVENTS_FAILED  ${error?.message ?? error}`)
    return null
  }
}

/** 取一个非空字符串（空/空白一律当"没有"）。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 定位工作区；没配好时返回 null。
 * @returns `{ dir, source }` 或 null。
 */
function safeWorkspace() {
  try {
    const ws = workspaceDir()
    return ws === null ? null : ws
  } catch (error) {
    // workspaceDir() 契约上不抛（"不确定就返回 null"），但真抛了也当成"没配好"处理。
    trace(`WORKSPACE_FAILED  ${error?.message ?? error}`)
    return null
  }
}

/**
 * 读出工作区里**全部**题库的完整内容（含 questions）。
 *
 * ═══ 为什么要重读一遍 ═══
 * `listQuestionBanks` 返回的是**目录条目**（name/path/ok/question_count/title），
 * 刻意不含 `questions`（`bank.js` 里那段 20 行注释记的就是"把条目当题库用"的坑）。
 * 而视图层要按题目 id 建 join 索引，所以必须逐库 `loadBank` 拿全文。
 *
 * ═══ 代价与失效信号 ═══
 * 每个请求都会把每个题库文件整份读一遍。当前是 2 库 88 题（几毫秒），
 * 而题库会长大（600 题级的库约 1MB）。
 * **失效信号**：面板打开明显变慢（>200ms）或库数上到两位数 → 那时加按 mtime 的缓存
 * 或让视图层"只读题目 id 与计数"，而不是继续整份读。
 *
 * @param workspaceRoot - 工作区绝对路径。
 * @returns `[{ name, path, ok, errors, bank }]`（`bank` 为 null = 读不出内容）。
 */
function readAllBanks(workspaceRoot) {
  const { banks } = listQuestionBanks({ workspaceRoot })
  return banks.map((entry) => {
    const { bank } = loadBank(entry.path)
    return { ...entry, bank }
  })
}

/**
 * 读出已归档的题库（`lh-questions/.archived/`）。
 *
 * 归档区**单独成区**而不是混进题库清单：它回答的是"我曾经有哪些库"，
 * 而清单回答的是"我现在有哪些库"——混在一起，"这个库还作数吗"就得靠猜。
 *
 * @param workspaceRoot - 工作区绝对路径。
 * @returns `[{ name, path, ok, errors, title, question_count }]`。
 */
function readArchivedBanks(workspaceRoot) {
  const dir = join(workspaceRoot, BANK_DIR_NAME, ARCHIVE_DIR_NAME)
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    if (!isBankFile(entry)) continue
    const path = join(dir, entry)
    const { bank, errors } = loadBank(path)
    const name = entry.slice(0, -BANK_EXT.length)
    out.push({
      name,
      path,
      ok: errors.length === 0,
      errors,
      title: bank?.title ?? name,
      question_count: Array.isArray(bank?.questions) ? bank.questions.length : 0,
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * 一个题库的落点（活跃区）。
 *
 * 用 `safeBankName` 把名字安全化 —— 与 agent 工具写题库时**同一份**规则，
 * 于是"面板点出来的路径"和"工具写的路径"必然一致。顺手把 `..` 这类穿越挡掉：
 * 题库名来自 HTTP 请求体，那是浏览器（可能被改）给的值。
 *
 * @param workspaceRoot - 工作区绝对路径。
 * @param bankName - 题库名。
 * @param archived - true = 归档区里的落点。
 * @returns 绝对路径。
 */
function bankPathOf({ workspaceRoot, bankName, archived = false }) {
  const dir = archived
    ? join(workspaceRoot, BANK_DIR_NAME, ARCHIVE_DIR_NAME)
    : join(workspaceRoot, BANK_DIR_NAME)
  return join(dir, `${safeBankName(bankName)}${BANK_EXT}`)
}

/**
 * 归档一个题库（移动文件，可逆）。
 *
 * @param params.workspaceRoot - 工作区绝对路径。
 * @param params.bankName - 题库名。
 * @returns `{ from, to, name }`。
 * @throws 题库不存在、或归档区已有同名文件时。
 */
export function archiveBank({ workspaceRoot, bankName }) {
  const from = bankPathOf({ workspaceRoot, bankName })
  if (!existsSync(from)) throw new Error(`题库「${bankName}」不在工作区里（找的是 ${from}）。`)
  const to = bankPathOf({ workspaceRoot, bankName, archived: true })
  if (existsSync(to)) {
    // **不覆盖**：归档区已有一份同名文件说明"曾经归档过一个同名库"，
    // 覆盖它就是静默销毁一份可能有价值的数据——最不该发生的失败方式。
    throw new Error(`归档区已有同名文件，拒绝覆盖：${to}（先把归档区那份恢复或改名）`)
  }
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
  return { from, to, name: safeBankName(bankName) }
}

/**
 * 恢复一个已归档的题库（移动回来，可逆）。
 *
 * @param params.workspaceRoot - 工作区绝对路径。
 * @param params.bankName - 题库名。
 * @returns `{ from, to, name }`。
 * @throws 归档区里没有、或活跃区已有同名文件时。
 */
export function restoreBank({ workspaceRoot, bankName }) {
  const from = bankPathOf({ workspaceRoot, bankName, archived: true })
  if (!existsSync(from)) throw new Error(`归档区里没有「${bankName}」（找的是 ${from}）。`)
  const to = bankPathOf({ workspaceRoot, bankName })
  if (existsSync(to)) {
    // 同理不覆盖：活跃区那一份才是正在被引用的对象（作答记录按题目 id 指过来）。
    throw new Error(`工作区已有同名题库，拒绝覆盖：${to}（先改名或先归档那一份）`)
  }
  renameSync(from, to)
  return { from, to, name: safeBankName(bankName) }
}

/**
 * 把命令层抛出的错误分类成 HTTP 状态。
 *
 * 两类必须分开，否则学习者看到的东西完全不同：
 *   · 数据目录/工作区没配好 → 503 + fix（"去改配置"是唯一出路，重试没有意义）；
 *   · 输入有问题（题库不存在、有歧义、名字非法）→ 400，把原话端出去。
 *
 * @param error - 捕获到的错误。
 * @returns `{ status, body }`。
 */
function classify(error) {
  const message = String(error?.message ?? error)
  if (message.includes('lh-paths') || message.includes('找不到 LH 的数据目录')) {
    return { status: 503, body: { ...NO_DATA, detail: message } }
  }
  return { status: 400, body: { error: message } }
}

/** `/questions` 允许的查询字段。 */
const QUESTIONS_PARAMS = ['name', 'q', 'topic', 'kind', 'state', 'offset', 'limit', 'scope', 'answerers']
/** `/attempts` 允许的查询字段。 */
const ATTEMPTS_PARAMS = ['bank', 'question', 'session', 'correct', 'verdict', 'source', 'offset', 'limit', 'scope', 'answerers']
/** 备注路由允许的字段。 */
const NOTE_FIELDS = ['attempt_event_id', 'question_id', 'text', 'note_kind', 'supersedes']

/** 两条写路由允许的字段。 */
const ACTION_FIELDS = ['bank']

/**
 * 插件体。
 * @param ctx - 插件上下文。
 */
/**
 * 备注用的**写入型**事件存储（惰性建，装载期一个字节都不碰）。
 *
 * 为什么单独一个而不是复用读路径：读用 `readEvents()`（纯函数），写必须走
 * `LhEventStore`（信封只由它构造——契约 §2.2 只允许一处拼信封）。
 * 惰性建的理由与其它插件一致：装载期 new 一个存储对象没问题，但不该在装载期读数或写盘。
 */
let noteStoreRef = null
function noteStore() {
  if (noteStoreRef === null) noteStoreRef = new LhEventStore()
  return noteStoreRef
}
export function apply(ctx) {
  trace('APPLY_CALLED')
  ctx.on('dispose', () => trace('DISPOSED'))

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'

        try {
          // ── GET /lh/bank/health ──
          //
          // 一条**不碰浏览器**的自检入口：作者用 curl / 浏览器直接打它，就能分清
          // "面板白屏"是"没有题库"、"工作区没配"还是"日志读不到"。
          if (route === '/health' && req.method === 'GET') {
            const unknown = unknownFields([...url.searchParams.keys()], ['scope', 'answerers'])
            if (unknown.length > 0) {
              sendJson(res, 400, { error: `不认识的查询参数：${unknown.join('、')}`, accepted: ['scope', 'answerers'] })
              return
            }
            const ws = safeWorkspace()
            const events = safeReadEvents()
            if (ws === null) {
              sendJson(res, 503, NO_WORKSPACE)
              return
            }
            if (events === null) {
              sendJson(res, 503, NO_DATA)
              return
            }
            const banks = readAllBanks(ws.dir)
            const archived = readArchivedBanks(ws.dir)
            const view = buildBankList({ banks, archived, events, scope: normalizeScope(nonEmptyString(url.searchParams.get('scope'))), answerers: parseAnswerers(url.searchParams.get('answerers')) })
            sendJson(res, 200, {
              ok: true,
              plugin: '@lh/question-bank-ui',
              route_prefix: ROUTE_PREFIX,
              workspace: { dir: ws.dir, source: ws.source },
              bank_dir: join(ws.dir, BANK_DIR_NAME),
              archive_dir: join(ws.dir, BANK_DIR_NAME, ARCHIVE_DIR_NAME),
              event_count: events.length,
              ...view.totals,
              notes: view.notes,
            })
            return
          }

          // ── GET /lh/bank/banks ──
          if (route === '/banks' && req.method === 'GET') {
            const unknown = unknownFields([...url.searchParams.keys()], ['scope', 'answerers'])
            if (unknown.length > 0) {
              sendJson(res, 400, { error: `不认识的查询参数：${unknown.join('、')}`, accepted: ['scope', 'answerers'] })
              return
            }
            const ws = safeWorkspace()
            const events = safeReadEvents()
            if (ws === null) {
              sendJson(res, 503, NO_WORKSPACE)
              return
            }
            if (events === null) {
              sendJson(res, 503, NO_DATA)
              return
            }
            const view = buildBankList({ banks: readAllBanks(ws.dir), archived: readArchivedBanks(ws.dir), events, scope: normalizeScope(url.searchParams.get('scope')), answerers: parseAnswerers(url.searchParams.get('answerers')) })
            trace(`GET /banks  banks=${view.totals.bank_count} questions=${view.totals.question_count} attempts=${view.totals.attempt_count}`)
            sendJson(res, 200, { ...view, workspace: { dir: ws.dir, source: ws.source } })
            return
          }

          // ── GET /lh/bank/source?name=… ──
          if (route === '/source' && req.method === 'GET') {
            const unknown = unknownFields([...url.searchParams.keys()], ['name'])
            if (unknown.length > 0) {
              sendJson(res, 400, { error: `不认识的查询参数：${unknown.join('、')}`, accepted: ['name'] })
              return
            }
            const ws = safeWorkspace()
            const events = safeReadEvents()
            if (ws === null) {
              sendJson(res, 503, NO_WORKSPACE)
              return
            }
            if (events === null) {
              sendJson(res, 503, NO_DATA)
              return
            }
            const name = nonEmptyString(url.searchParams.get('name'))
            if (name === null) {
              sendJson(res, 400, { error: '缺少 name（题库名）', accepted: ['name'], hint: '先用 GET /lh/bank/banks 看有哪些库' })
              return
            }
            const banks = readAllBanks(ws.dir)
            const target = banks.find((b) => b.name === name)
            if (target === undefined) {
              sendJson(res, 400, {
                error: `题库「${name}」不存在。`,
                available: banks.map((b) => b.name),
                hint: '题库名就是文件名（不含 .json），上面的 available 是精确值。',
              })
              return
            }
            // 导入事件按 bank_path / content_ref 的**文件名**匹配到该库：
            // 不能用全路径相等去比——同一份题库可能被别的工作区导入过（实测就有），
            // 而那种事件恰好是判断"这个库到底哪来的"的重要旁证。
            const importEvents = events.filter((e) => {
              if (e?.type !== 'lh/resource/questions-imported') return false
              const refs = [e?.data?.bank_path, e?.content_ref]
              return refs.some((r) => typeof r === 'string' && basename(r) === `${name}${BANK_EXT}`)
            })
            const view = buildSource({ bank: target.bank, importEvents, workspaceRoot: ws.dir })
            trace(`GET /source  bank=${name}  source_files=${view.source_files.length} imports=${view.import_events.length}`)
            sendJson(res, 200, { ...view, path: target.path })
            return
          }

          // ── GET /lh/bank/questions?name=…&… ──
          if (route === '/questions' && req.method === 'GET') {
            const unknown = unknownFields([...url.searchParams.keys()], QUESTIONS_PARAMS)
            if (unknown.length > 0) {
              sendJson(res, 400, { error: `不认识的查询参数：${unknown.join('、')}`, accepted: QUESTIONS_PARAMS })
              return
            }
            const ws = safeWorkspace()
            const events = safeReadEvents()
            if (ws === null) {
              sendJson(res, 503, NO_WORKSPACE)
              return
            }
            if (events === null) {
              sendJson(res, 503, NO_DATA)
              return
            }
            const name = nonEmptyString(url.searchParams.get('name'))
            if (name === null) {
              sendJson(res, 400, { error: '缺少 name（题库名）', accepted: QUESTIONS_PARAMS })
              return
            }
            const banks = readAllBanks(ws.dir)
            const target = banks.find((b) => b.name === name)
            if (target === undefined) {
              sendJson(res, 400, { error: `题库「${name}」不存在。`, available: banks.map((b) => b.name) })
              return
            }
            const view = buildQuestions({
              bank: target.bank,
              events,
              filters: {
                q: nonEmptyString(url.searchParams.get('q')),
                topic: nonEmptyString(url.searchParams.get('topic')),
                kind: nonEmptyString(url.searchParams.get('kind')),
                state: nonEmptyString(url.searchParams.get('state')) ?? 'all',
              },
              offset: clampOffset(url.searchParams.get('offset')),
              limit: clampLimit(url.searchParams.get('limit') ?? DEFAULT_LIMIT),
              // 口径：默认只算人的作答（模型答对了不是"我会了"，ADR-018 决定 6）
              scope: normalizeScope(nonEmptyString(url.searchParams.get('scope'))),
              answerers: parseAnswerers(url.searchParams.get('answerers')),
            })
            trace(`GET /questions  bank=${name}  total=${view.total}  slice=${view.items.length}  scope=${view.scope}`)
            sendJson(res, 200, { ...view, name, path: target.path })
            return
          }

          // ── GET /lh/bank/attempts?… ──
          if (route === '/attempts' && req.method === 'GET') {
            const unknown = unknownFields([...url.searchParams.keys()], ATTEMPTS_PARAMS)
            if (unknown.length > 0) {
              sendJson(res, 400, { error: `不认识的查询参数：${unknown.join('、')}`, accepted: ATTEMPTS_PARAMS })
              return
            }
            const ws = safeWorkspace()
            const events = safeReadEvents()
            if (ws === null) {
              sendJson(res, 503, NO_WORKSPACE)
              return
            }
            if (events === null) {
              sendJson(res, 503, NO_DATA)
              return
            }
            const view = buildAttempts({
              banks: readAllBanks(ws.dir),
              events,
              filters: {
                bank: nonEmptyString(url.searchParams.get('bank')),
                question: nonEmptyString(url.searchParams.get('question')),
                session: nonEmptyString(url.searchParams.get('session')),
                correct: nonEmptyString(url.searchParams.get('correct')) ?? 'all',
                // verdict 是四态判决（含 partial），correct 是三态原值。两个都留着：
                // 一个问「人话判决」，一个问「三态原值」，都正当。
                verdict: nonEmptyString(url.searchParams.get('verdict')) ?? 'all',
                source: nonEmptyString(url.searchParams.get('source')),
              },
              offset: clampOffset(url.searchParams.get('offset')),
              limit: clampLimit(url.searchParams.get('limit') ?? DEFAULT_LIMIT),
              scope: normalizeScope(nonEmptyString(url.searchParams.get('scope'))),
              answerers: parseAnswerers(url.searchParams.get('answerers')),
            })
            trace(`GET /attempts  total=${view.total} slice=${view.items.length} unmatched=${view.unmatched_attempt_count} scope=${view.scope}`)
            sendJson(res, 200, view)
            return
          }

          // ── POST /lh/bank/archive ──
          if (route === '/archive' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const unknown = unknownFields(Object.keys(body), ACTION_FIELDS)
            if (unknown.length > 0) {
              sendJson(res, 400, {
                error: `不认识的字段：${unknown.join('、')}。**没有动任何文件。**`,
                accepted: ACTION_FIELDS,
                fix: ['用 accepted 里列出的字段名重发一次'],
              })
              return
            }
            const ws = safeWorkspace()
            if (ws === null) {
              sendJson(res, 503, NO_WORKSPACE)
              return
            }
            const bankName = nonEmptyString(body.bank)
            if (bankName === null) {
              sendJson(res, 400, { error: 'bank 必填（题库名）', accepted: ACTION_FIELDS })
              return
            }
            const result = archiveBank({ workspaceRoot: ws.dir, bankName })
            const archived = readArchivedBanks(ws.dir)
            trace(`POST /archive  ${result.from} → ${result.to}`)
            sendJson(res, 200, {
              archived: true,
              moved: result,
              archived_list: archived.map((a) => ({ name: a.name, question_count: a.question_count })),
              note: '题库文件被移到归档区（内容与事件一个字都没动），用 /restore 可以移回来。',
            })
            return
          }

          // ── POST /lh/bank/restore ──
          if (route === '/restore' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const unknown = unknownFields(Object.keys(body), ACTION_FIELDS)
            if (unknown.length > 0) {
              sendJson(res, 400, {
                error: `不认识的字段：${unknown.join('、')}。**没有动任何文件。**`,
                accepted: ACTION_FIELDS,
              })
              return
            }
            const ws = safeWorkspace()
            if (ws === null) {
              sendJson(res, 503, NO_WORKSPACE)
              return
            }
            const bankName = nonEmptyString(body.bank)
            if (bankName === null) {
              sendJson(res, 400, { error: 'bank 必填（题库名）', accepted: ACTION_FIELDS })
              return
            }
            const result = restoreBank({ workspaceRoot: ws.dir, bankName })
            trace(`POST /restore  ${result.from} → ${result.to}`)
            sendJson(res, 200, {
              restored: true,
              moved: result,
              note: '题库已移回工作区，面板与 agent 的题库清单都会重新看到它。',
            })
            return
          }

          // ── POST /lh/bank/note ──
          //
          // 面板写备注走**与 agent 工具同一份代码**（`@lh/question-bank/note` 的 recordNote）——
          // 与归档/恢复同一条分工：判断归 agent，机械动作归界面。
          // 备注是**注解**（只追加）：编辑 = 再记一条并在 supersedes 里指向旧的。
          //
          // ⚠ `author` 在这里**固定为 user**：这一侧就是学习者在写。
          //   模型写的备注由 agent 工具带 `author: agent` 写（界面不代它署名）。
          if (route === '/note' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const unknown = unknownFields(Object.keys(body), NOTE_FIELDS)
            if (unknown.length > 0) {
              sendJson(res, 400, {
                error: `不认识的字段：${unknown.join('、')}。**没有写任何事件。**`,
                accepted: NOTE_FIELDS,
              })
              return
            }
            const attemptEventId =
              typeof body.attempt_event_id === 'string' && body.attempt_event_id.trim() !== '' ? body.attempt_event_id.trim() : null
            const questionId = typeof body.question_id === 'string' && body.question_id.trim() !== '' ? body.question_id.trim() : null
            if (attemptEventId === null && questionId === null) {
              sendJson(res, 400, { error: '至少要给 attempt_event_id 或 question_id 之一——备注必须锚在某次作答或某道题上' })
              return
            }
            try {
              const result = recordNote({
                store: noteStore(),
                sessionRef: undefined, // 面板来的备注没有会话坐标：如实留空，不猜
                provenance: { plugin: '@lh/question-bank-ui', version: '0.1.0' },
                targetKind: attemptEventId === null ? 'question' : 'attempt',
                targetId: attemptEventId ?? questionId,
                text: body.text,
                author: 'user',
                noteKind: typeof body.note_kind === 'string' ? body.note_kind : 'reflection',
                questionId,
                supersedes: body.supersedes,
              })
              trace(`POST /note  ${result.data.note_kind}  target=${result.data.target_kind}:${result.data.target_id}`)
              sendJson(res, 200, {
                noted: true,
                note_event_id: result.event.id,
                target_kind: result.data.target_kind,
                target_id: result.data.target_id,
                note_kind: result.data.note_kind,
                hint: '备注只追加：要改就再记一条并在 supersedes 里指向旧的（旧的原话仍在日志里）。',
              })
            } catch (error) {
              // 空正文 / 超长 / 非法 kind 都从这里出去：400 + 原话，不静默丢弃
              sendJson(res, 400, { error: String(error?.message ?? error) })
            }
            return
          }

          sendJson(res, 404, {
            error: `未知路由 ${route}（支持 GET /health|/banks|/source|/questions|/attempts 与 POST /archive|/restore|/note）`,
          })
        } catch (error) {
          const { status, body } = classify(error)
          trace(`ROUTE_ERROR ${req.method} ${route}  ${status}  ${error?.message ?? error}`)
          sendJson(res, status, body)
        }
      },
    })
    trace(`ROUTE_REGISTERED  ${ROUTE_PREFIX} (prefix)  GET /health|/banks|/source|/questions|/attempts + POST /archive|/restore`)
    return dispose
  })

  trace('APPLY_DONE')
}
