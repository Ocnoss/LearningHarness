/**
 * lh-practice 的【服务端半】—— 给刷题界面提供数据与记录作答。
 *
 * ═══ 为什么需要它（而不是让界面直接调工具）═══
 * 界面是浏览器里的 React 组件，它**没有**调用服务端工具的通道：
 *   · `ctx.remote` 那条路要求服务端包导出**构建期生成**的 `./typert` 契约，
 *     而生成器 `@deepseek-ai/dsh-typert-generator` **没有随发行版发布**（实测不存在），
 *     手写一个生成文件去骗 loader 是在骗宿主，不做；
 *   · 所以改用**最朴素也最稳**的通道：自己注册 HTTP 路由。
 *
 * 宿主提供 `ctx.webServer.register({ kind, path, handler })`，
 * 而客户端 bundle 的投放是**宿主白拿的**（`dsh-client-modules` 扫描 Loader 里
 * 声明了 `dsh.client` 的包，自动 servce `/plugins/<id>/client.js` 并注入 boot 图）。
 * 所以我们只需要：服务端注册两个数据路由 + 客户端写一个面板。
 *
 * ═══ 为什么不直接读文件给界面 ═══
 * 界面要的三样东西里，只有两样是"数据"：
 *   ① 题库内容（可以读文件）；
 *   ② 进度与错题（要从**事件日志**算出来）；
 *   ③ **记录作答**（必须由服务端写事件）。
 * ②③ 都必须过服务端，所以统一走路由最省事：客户端只有一种取数方式。
 *
 * ═══ 职责边界 ═══
 * 本插件**不重复实现**题库逻辑：它 `import` lh-question-bank 的
 * `getQuestions` / `submitAnswer` / `listQuestionBanks` / `getPracticeStats`。
 * 于是判分规则、错题本口径、事件写入全部只有一处实现——
 * 界面只是另一个**调用者**，与 agent 用工具调用它没有区别。
 * 这一点很重要：**不能让界面成为第二套判分实现**，否则两者迟早不一致。
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ═══ 这里曾经是一个让 dsh 起不来的 bug，值得写清楚 ═══
//
// 原来是 `import … from '../lh-question-bank/index.js'`（相对路径）。
// 那个写法**只在源码目录成立**：`plugins/` 下都是兄弟目录，我离线测试也在那里跑，
// 所以一直没暴露。但 pnpm 把本包装进 `profiles/web/node_modules/@lh/practice` 之后，
// 兄弟目录不再相对可达，Node 按 ESM 规则把 `../lh-question-bank/index.js`
// 解析成 `@lh/lh-question-bank` 并抛 ERR_MODULE_NOT_FOUND ——
// 而插件的**导入失败会让整棵插件树加载失败，dsh 完全无法启动**。
//
// 为什么其他插件没这个毛病：`lh-question-bank` / `lh-event-store` / `lh-recorder-trace`
// 等全部由 **preset 行按绝对路径**加载（`D:\…\plugins\…\index.js`），
// 从不经过 `node_modules`。本包是**第一个通过 profile 包机制加载、又需要跨插件引用**的插件。
//
// 修法不是"让相对路径生效"，而是**让它成为一个真正可解析的依赖**：
//   · 给 `lh-question-bank` 加包清单（`@lh/question-bank`）；
//   · 在本包的 package.json 里声明 `"@lh/question-bank": "file:../lh-question-bank"`；
//   · 于是 pnpm 会把它**放在同级 node_modules 下**，包名导入稳定可解析。
//
// 判分口径仍然只有一处实现（`submitAnswer`），所以"界面"与"agent 工具"
// 走的是同一条路径——**不会出现第二套判分**。
import { listQuestionBanks, getQuestions, submitAnswer, getPracticeStats } from '@lh/question-bank'
// 启动信号：agent 的工具（在 agent preset 作用域）写它，本插件的路由（在 profile 作用域）读它。
// 用文件做会合点是因为两端**不在同一棵树里**——内存信号过不去。
import { readPracticeSignal } from '@lh/question-bank/signal'

// ⚠ 事件存储也是一个**真正的依赖**，用包名导入，而不是相对路径。
// 理由同上：相对路径只在源码目录成立，装进 node_modules 后就断了，
// 而"导入失败"的代价是**整棵插件树加载失败、dsh 起不来**。
//
// 关于"两份实例"的顾虑（preset 按绝对路径加载一份、这里按包名加载一份）：
// **不是问题**。`LhEventStore` 是围绕一个 append-only 文件的**无状态薄封装**
// （append 时构造信封 + 追加一行；读时每次重读文件），不持有内存状态，所以两份实例不会漂移。
// 这也是它当初被设计成不持状态的好处。
import { LhEventStore } from '@lh/event-store/store'
// 工作区的定位统一走 `@lh/event-store/paths`：它是**配置的唯一读口**
// （环境变量 → lh-install.json），别处不许再自己读一遍环境变量——
// 否则"哪份配置生效"又会变成要靠人记住的事。
import { workspaceDir } from '@lh/event-store/paths'

/** 插件名。 */
export const name = 'lh-practice'

/** 声明依赖：`webServer` 用于注册 HTTP 路由。 */
export const inject = ['webServer']

/** 路由前缀。用前缀注册一次，避免注册多条 exact 路由时的撞名风险。 */
export const ROUTE_PREFIX = '/lh/practice'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 记一条调试痕迹（与 LH 事件严格分开）。
 *
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
 * 决定界面用哪个工作区 —— 未配置时**抛错，不猜**。
 *
 * ═══ 为什么这里必须由调用方给 ═══
 * 工具调用有 `exec.agent.session.header.cwd` 可以拿工作区；
 * 而 **HTTP 请求没有会话上下文** —— 路由的 handler 只收到 `req`/`res`。
 * 所以工作区只能来自环境变量。
 *
 * ═══ 为什么不再留一个"默认值" ═══
 * 原来这里写的是 `return 'D:\\learning Harness test'`——**作者自己的工作区**。
 * 那在作者机器上"能用"，所以看起来没问题；但在别人机器上它会去读一个
 * 根本不存在（或是别人的）工作区，表现是"题库是空的""进度是 0"——
 * **静默错误，不是崩溃**。
 *
 * 更糟的是：这个项目里还有别处写死了 `D:\LearningHarnessv0.1`，
 * 于是**同一个项目里两套写死的工作区路径**，靠人记住哪个对。
 * 而作者改过文件夹名——其中一处跟着改了，另一处没有。
 *
 * 所以现在：**没有配置就不猜**。但这个"不猜"要表达成**用的时候明确拒绝**，
 * 而不是**装载的时候抛错**——见下。
 *
 * ═══ 为什么改成"装载时不抛、用的时候拒绝"（2026-09-18 改）═══
 * 原来 `resolveWorkspace()` 直接抛错，而它的调用点在 `apply()` 里，
 * 于是"忘了配工作区"的后果是：**插件装载失败 → 整棵插件树加载失败 → dsh 起不来**。
 *
 * 而事后看，这个代价完全没必要：本插件的 HTTP 路由本来就带着 try/catch，
 * 把错误变成响应体返回给面板是**现成的**。所以顺序应该是：
 * 装载照常完成（dsh 能起），面板请求时返回 503 + 一句"该配什么"。
 * 学习者看到的是**看得见的说明**，不是一扇锁上的门。
 *
 * ⚠ 一个已知的真实局限（记在这里而不是藏起来）：
 * 这让"多工作区"目前不可用——全局只有一个工作区配置。
 * 若将来要支持，界面必须把工作区带进请求（或宿主给出"当前活动工作区"的服务）。
 *
 * @returns `{ dir, source }`；无法确定时返回 null（**不抛错**）。
 */
function resolveWorkspace() {
  try {
    return workspaceDir()
  } catch {
    // workspaceDir 现在不抛错，这里只是不给未来留暗雷。
    return null
  }
}

/**
 * 读请求体（JSON）。
 *
 * @param req - IncomingMessage。
 * @param limit - 最大字节数（防止超大 body 拖垮进程）。
 * @returns 解析后的对象；解析失败抛错。
 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体过大（> ${limit} 字节）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 发一个 JSON 响应。
 *
 * @param res - ServerResponse。
 * @param status - HTTP 状态码。
 * @param body - 要序列化的对象。
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 组装"界面要的那一份题库视图"。
 *
 * ═══ 为什么不把整个题库文件丢给界面 ═══
 * 题库文件里有 `answer` 与 `analysis`。虽然界面最终要显示答案（判分后），
 * 但如果**一开始**就把答案发过去，界面里就存在一条"提前知道答案"的路径——
 * 而 ADR-019 决定 3 的立场是：答案只能在作答之后可见。
 * 所以：
 *   · `/bank` 只给题面（题干 + 选项 + id），**不给答案**；
 *   · 判分与答案由 `/attempt` 返回，与 agent 走 `submit_answer` 完全同一条路径。
 *
 * 这样界面上**结构上不可能**出现"先看答案再作答"。
 *
 * @param params.workspaceRoot - 工作区。
 * @param params.bankName - 题库名。
 * @param params.count - 取几道。
 * @param params.order - 顺序策略。
 * @param params.excludeIds - 本次界面里**已经出过**的题，别再出（默认 `unseen` 之外的第二道保险）。
 * @returns 界面用的视图对象。
 */
function buildPracticeView({ workspaceRoot, bankName, count, order, excludeIds, topic, ids }) {
  const banks = listQuestionBanks({ workspaceRoot }).banks
  if (banks.length === 0) {
    return { banks: [], bank: null, questions: [], stats: null, note: '工作区里还没有题库' }
  }
  const chosen = bankName ?? banks[0].name

  // ⚠ 指定了 ids 时**不要再传 exclude_ids / order**：选择是明确的，
  // 再排除或重排会让"就做这几道"变成"少做几道 / 换了题"。
  // （`selectQuestions` 里 ids 优先，但把另外两个显式清掉更不容易被将来的人误判。）
  const explicitIds = Array.isArray(ids) && ids.length > 0 ? ids : null

  const got = getQuestions({
    workspaceRoot,
    bankName: chosen,
    count: explicitIds === null ? (count ?? 1) : explicitIds.length,
    // ⚠ 默认**不能**是 `sequential`。
    //
    // 踩过一次，而且表现很迷惑：`sequential` 就是"按题库原顺序取前 N 道"，
    // 它**不记得刚才出过哪道**（选题是无状态的）。于是点了"再来一题"再取一次，
    // 拿回来的还是第 1 道 —— 学习者看到的是"点了没反应"。
    //
    // `unseen` 才是"继续练"的语义：先出没做过的；全做过了它会**自己退化为按顺序重刷**
    // （见 selectQuestions，它刻意不返回空集）。
    order: order ?? 'unseen',
    topic: typeof topic === 'string' && topic !== '' ? topic : undefined,
    ids: explicitIds ?? undefined,
    excludeIds: explicitIds === null && Array.isArray(excludeIds) ? excludeIds : [],
  })
  const stats = getPracticeStats({ workspaceRoot, bankName: chosen })
  return {
    banks: banks.map((b) => ({ name: b.name, question_count: b.question_count })),
    bank: { name: chosen, total: got.totalInBank, title: got.bankTitle },
    // 题面：**刻意不含 answer / analysis**（见函数注释）
    questions: got.questions.map((q) => ({
      id: q.id,
      kind: q.kind,
      stem: q.stem,
      options: q.options,
      topics: q.topics,
      // 题号（如 `set1-q7`）单独给出来。
      // 为什么界面需要它：作者要求"AI深解"发出去的消息里带**题号与本人的答案**——
      // 题号是学习者在纸质资料上能找到的那一个标识，`id`（q-xxxx 哈希）对他没有意义。
      // 这也让深解那条消息即使脱离界面也能被人读懂。
      number: q.source?.number ?? null,
      source_path: q.source?.path ?? null,
    })),
    order: got.order,
    note: got.note,
    stats: {
      total: stats.total_questions,
      attempted: stats.attempted_questions,
      coverage: stats.coverage,
      accuracy: stats.accuracy,
      correct: stats.human.correct,
      wrong: stats.human.wrong,
      unjudged: stats.human.unjudged,
      missed: stats.missed_recent.length,
    },
  }
}

/**
 * 插件体。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const store = new LhEventStore()

  // 装载期**不解析工作区**，也不碰事件日志路径。
  //
  // 两者都会在"没配好"时抛错，而这是 profile 插件——`apply()` 抛错会让
  // 整棵插件树加载失败、dsh 完全起不来。装载期只回答"装载能不能成功"，
  // 配置问题留给真正用到它的那次请求（面板会得到 503 + 该配什么的说明）。
  //
  // 但日志仍然要留痕：装载成功与配置就绪是两件事，事后排查时必须能区分。
  const ws = resolveWorkspace()
  trace(`APPLY_CALLED  workspace=${ws === null ? '(未配置)' : ws.dir}  source=${ws?.source ?? '-'}`)
  if (ws === null) {
    console.error(
      '\n[lh-practice] ⚠ 还没配置学习者的工作区，刷题面板会返回 503（但 dsh 能正常启动）。\n' +
        '  修法二选一：\n' +
        '    1. 在 lh-install.json 里加 "workspace": "<工作区的绝对路径>"（该目录下要有 lh-questions/）；\n' +
        '    2. 或设环境变量 LH_WORKSPACE，然后重启 dsh。\n' +
        '  （刻意不在 apply() 抛错：那会让整棵插件树加载失败、dsh 起不来。）\n',
    )
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'

        try {
          // ── GET /lh/practice/pending ──
          // 面板轻量轮询这个端点：agent 在对话里调 `start_practice` 后，
          // 会写一个递增的信号（信号文件是两端唯一的会合点——工具在 agent preset
          // 作用域、面板在 profile 作用域，不在同一棵树里，见 signal.js 的注释）。
          //
          // ⚠ 从第三版入口起，它**不再用来打开面板**（那是被否掉的设计）。
          // 它现在的用途是给卡片和面板提供"agent 这次请了什么"：
          // 题库、题数、以及**外观意图**。
          if (route === '/pending' && req.method === 'GET') {
            const sig = readPracticeSignal()
            sendJson(res, 200, {
              seq: sig.seq,
              at: sig.at,
              bank: sig.bank,
              count: sig.count,
              by: sig.by,
              // 外观意图一并转给界面。于是**校验只发生在服务端一处**
              // （`@lh/question-bank/style.js` 的 `sanitizeCardStyle`），
              // 客户端只负责把已经合法的值画出来——
              // 两处都校验就等于把同一套规则实现两次，迟早不一致。
              style: sig.style,
              // **这次要刷哪些题**也要转给界面：面板必须按**同一份选择**取题，
              // 否则卡片写着"只练错题"、面板却给全库的题（2026-09-19 反馈）。
              // 校验同样只在服务端一处（practice.js 的 sanitizeSelection）。
              selection: sig.selection,
            })
            return
          }

          // ── GET /lh/practice/bank?bank=&count=&order=&exclude_ids= ──
          if (route === '/bank' && req.method === 'GET') {
            // 工作区在这里解析，而不是在 apply() 里：解析可能失败（没配置），
            // 而 apply() 失败会让 dsh 起不来。请求失败只是这一个请求失败。
            const ws = resolveWorkspace()
            if (ws === null) {
              trace('GET /bank → 503 未配置工作区')
              sendJson(res, 503, {
                error: '没有配置学习者的工作区，取不了题。',
                fix: [
                  '在 lh-install.json 里加 "workspace": "<工作区的绝对路径>"（该目录下要有 lh-questions/）',
                  '或者设环境变量 LH_WORKSPACE，然后重启 dsh',
                ],
                why: '刷题面板的 HTTP 路由没有会话上下文，拿不到 session.header.cwd，所以只能显式配置；' +
                  '刻意不猜一个默认值——猜错会去读别人的工作区，而表现只是"题库是空的"。',
              })
              return
            }

            // 界面已经把"本次出过的题"记在客户端，用 exclude_ids 传回来。
            // 它是**第二道保险**：主保险是 `order=unseen`（先出没做过的），
            // 而 unseen 在全刷完之后会退化成按顺序重刷——那时若不排除已出的，
            // "再来一题"又会回到同一道。
            const rawExclude = url.searchParams.get('exclude_ids') ?? ''
            const excludeIds = rawExclude === ''
              ? []
              : rawExclude.split(',').map((s) => s.trim()).filter((s) => s !== '').slice(0, 200)

            const view = buildPracticeView({
              workspaceRoot: ws.dir,
              bankName: url.searchParams.get('bank') ?? undefined,
              count: Number(url.searchParams.get('count') ?? 1) || 1,
              order: url.searchParams.get('order') ?? undefined,
              excludeIds,
              // 知识点与"指定这几道"也转给选题层（面板按卡片的同一份选择取题）。
              topic: url.searchParams.get('topic') ?? undefined,
              ids: (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '').slice(0, 200),
            })
            trace(`GET /bank bank=${view.bank?.name ?? '-'} n=${view.questions.length} order=${view.order ?? '-'} excl=${excludeIds.length} ws=${ws.source}`)
            sendJson(res, 200, view)
            return
          }

          // ── POST /lh/practice/attempt ──
          // body: { bank, questionId, response, durationMs? }
          if (route === '/attempt' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const bankName = typeof body.bank === 'string' && body.bank !== '' ? body.bank : undefined
            if (!bankName) {
              sendJson(res, 400, { error: '缺 bank' })
              return
            }
            if (typeof body.questionId !== 'string' || body.questionId === '') {
              sendJson(res, 400, { error: '缺 questionId' })
              return
            }
            if (body.response === undefined) {
              sendJson(res, 400, { error: '缺 response' })
              return
            }

            // **复用** agent 工具走的同一条路径：判分规则只有一处实现
            const wsAttempt = resolveWorkspace()
            if (wsAttempt === null) {
              trace('POST /attempt → 503 未配置工作区')
              sendJson(res, 503, {
                error: '没有配置学习者的工作区，判不了分（也写不进作答记录）。',
                fix: ['在 lh-install.json 里加 "workspace"，或设环境变量 LH_WORKSPACE 后重启 dsh'],
              })
              return
            }

            const result = submitAnswer({
              store,
              workspaceRoot: wsAttempt.dir,
              bankName,
              questionId: body.questionId,
              response: body.response,
              // 界面来的作答**一定是人做的**（点按钮或打字）
              source: 'human',
              durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
              // 没有会话上下文；显式留空而不是编一个（坐标错比坐标缺更糟）
              sessionRef: undefined,
            })

            const revealed = result.revealed
            trace(`POST /attempt q=${body.questionId} correct=${result.data.correct}`)
            sendJson(res, 200, {
              correct: result.data.correct,
              questionId: revealed.id,
              response: Array.isArray(result.data.response) ? result.data.response.join('、') : String(result.data.response ?? ''),
              answer: revealed.answer,
              accept: revealed.accept,
              analysis: revealed.analysis,
              // 解析的来路与质量（原文 / 原文（OCR 可能串行）/ 选项标注拼成 / 无）。
              // 串行的那类读起来会跳，界面要如实标注，别让它看起来像一段干净讲义。
              analysis_kind: revealed.analysis_kind,
              // ── 作答历史：**只随判分结果返回** ──
              //
              // 刻意**不出现在 /bank（取题）的返回里**：那样"先看历史再作答"在结构上
              // 就不可能，不靠提醒谁别说。作者的要求也正是"让学习者知道这题做过、
              // 上次选了什么，**但在本次作答之后**"。
              history: result.history === null ? null : {
                attempts: result.history.attempts,
                last_response: result.history.last_response,
                last_correct: result.history.last_correct,
                last_at: result.history.last_at,
              },
              stem: revealed.stem,
              eventId: result.event.id,
              stats: (() => {
                const s = getPracticeStats({ workspaceRoot: wsAttempt.dir, bankName })
                return {
                  total: s.total_questions,
                  attempted: s.attempted_questions,
                  coverage: s.coverage,
                  accuracy: s.accuracy,
                  correct: s.human.correct,
                  wrong: s.human.wrong,
                  unjudged: s.human.unjudged,
                  missed: s.missed_recent.length,
                }
              })(),
            })
            return
          }

          sendJson(res, 404, { error: `未知路由 ${route}` })
        } catch (error) {
          trace(`ROUTE_ERROR ${route}  ${error?.message ?? error}`)
          sendJson(res, 500, { error: error?.message ?? String(error) })
        }
      },
    })
    trace(`ROUTE_REGISTERED  ${ROUTE_PREFIX} (prefix)`)
    return dispose
  })

  ctx.on('dispose', () => trace('DISPOSED'))
}
