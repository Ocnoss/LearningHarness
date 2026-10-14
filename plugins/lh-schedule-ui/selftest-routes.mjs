/**
 * `@lh/schedule-ui` 的**路由自检** —— 用假 `req`/`res` 真跑一遍四条路由，不启服务器。
 *
 * ═══ 为什么需要它（`@lh/schedule` 的 selftest 覆盖不到这里）═══
 * 那个 selftest 测的是**纯函数**（投影、日期算术、倒计时）。而这一层要测的是
 * **接缝**：路由的字段白名单、`until` 能不能穿过 HTTP 真的落进事件、
 * 不认识的字段会不会被静默丢掉、返回的 payload 里有没有 `milestones`。
 * 这些只有"真调一次 handler"才看得见。
 *
 * ═══ 为什么跑的是**副本**而不是源码 ═══
 * 本包 import `@lh/schedule/commands`（跨包用包名，契约 §3）。源码目录里
 * `node_modules/@lh/schedule` **不存在**（只有根 package.json 声明过的包才有软链），
 * 所以从源码 import 必然失败——这不是缺陷，是"跑生产路径"的要求：
 * 本项目第一次恶性事故就是"测试跑源码、生产跑副本"。
 * 装过之后（`scripts/install-lh-schedule.mjs`）副本存在，本自检才真的跑；
 * 没装时**如实跳过**（退出码 0，但打印"跳过"而不是"通过"——不许假绿）。
 *
 * ═══ 它会往真实日志里写东西吗 ═══
 * 会：它建一条 `【路由自检】` 的日程（`source: 'selftest'`），验证完立刻撤销。
 * 这是刻意的——"写路径"只有在真写的时候才被测到。留在日志里的是一条**已撤销**的事件，
 * 那正是 append-only 的应有形状（作者可以从标题一眼认出它不是真实计划）。
 *
 * 运行：node plugins/lh-schedule-ui/selftest-routes.mjs
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ⚠⚠ 这一行是本文件最重要的三行：**让自检不碰真实的学习史**。
//
// 本项目早就把日志路径做成了**惰性求值**，理由写在 `lh-event-store/store.js` 里：
//   「任何想把它指到别处的调用方（测试、离线校验、换工作区）都必须在 import 之前
//     设好环境变量，否则设置被静默忽略——**静默的后果是测试把假数据写进了真实的学习史**。」
//
// 而第一版的我，正好踩了这条：每跑一次本自检，就在作者的真实日历里留下
// "【路由自检】…"两条条目（乘三份副本）。作者随后问"我担心存储浪费"——
// 这类"闸门自己在制造垃圾"的东西，比它想防的问题更该先修。
//
// 所以：把日志指到一个临时目录，自检全程（建/改/撤）都发生在那里，跑完删掉。
// 顺带的好处是断言更强：`scheduleEventCount()` 从 0 开始数，"400 时一个字都没写"
// 于是变成了一个**确定的**断言，而不是"前后差为 0"这种可能被巧合满足的形状。
const sandbox = mkdtempSync(join(tmpdir(), 'lh-schedule-selftest-'))
process.env.LH_EVENT_LOG = join(sandbox, 'events.jsonl')

/**
 * 收尾：删掉临时日志目录，再按给定退出码退出。
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

// 日志路径用**插件自己那份解析**（`@lh/event-store/store` 的 `eventLogPath`），
// 不自己拼路径。为什么这一条重要：第一版写的是
//   `process.env.LH_DATA_DIR ?? join(REPO_ROOT, 'data')`
// ——而 `??` **只对 null/undefined 兜底，空字符串会照原样用**。
// 于是 `LH_DATA_DIR=''`（check-all 会清掉 LH_* 变量，正是这个形状）时路径变成
// 相对路径 `events.jsonl`，读不到文件 → 计数恒为 0 → **"没有写任何事件"这条断言恒真**。
// 那是**假绿**：闸门绿着而它根本没在检查。用权威解析就没有这个形状。
import { eventLogPath } from '@lh/event-store/store'

const HERE = dirname(fileURLToPath(import.meta.url))

let passed = 0
const failures = []
const skipped = []

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

// ── 找到要测的那份副本 ───────────────────────────────────────────────────
//
// 与 install-lh-schedule.mjs 同一条纪律：**不写死盘符**。
// 家从 DSH_HOME / 仓库自持的 .dsh 推，profile 靠枚举。

const REPO_ROOT = resolve(HERE, '..', '..')
const DSH_HOME =
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? resolve(process.env.DSH_HOME.trim())
    : existsSync(join(REPO_ROOT, '.dsh', 'profiles'))
      ? join(REPO_ROOT, '.dsh')
      : join(homedir(), '.dsh')

/** 所有装了本包的副本入口（按家的顺序）。 */
function findEntries() {
  const homes = [...new Set([DSH_HOME, join(REPO_ROOT, '.dsh')])].filter((h) => existsSync(join(h, 'profiles')))
  const out = []
  for (const home of homes) {
    const profilesDir = join(home, 'profiles')
    for (const name of readdirSync(profilesDir)) {
      const entry = join(profilesDir, name, 'node_modules', '@lh', 'schedule-ui', 'index.js')
      if (existsSync(entry)) out.push({ home, profile: name, entry })
    }
  }
  return out
}

const entries = findEntries()
if (entries.length === 0) {
  console.log('⏭️  @lh/schedule-ui 路由自检**跳过**：还没装到任何 profile。')
  console.log('   先跑 node scripts/install-lh-schedule.mjs（装完再跑本自检才有意义）。')
  finish(0)
}

// ── 假 req / res ────────────────────────────────────────────────────────

/**
 * 造一个假请求。
 * @param method - HTTP 方法。
 * @param url - 路径（含 query）。
 * @param body - 请求体（会被 JSON 序列化）。
 * @returns 有 `.on` 的假 IncomingMessage。
 */
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

/**
 * 造一个假响应，记下状态码与 JSON 体。
 * @returns `{ res, read }`。
 */
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

/** 数一下日志里日程事件的条数（用来证明"400 时一个字都没写"）。 */
function scheduleEventCount() {
  let logPath
  try {
    logPath = eventLogPath()
  } catch {
    // 数据目录都定位不到时**不假装数过**：抛出去让断言看到真相。
    throw new Error('定位不到 LH 事件日志（lh-install.json / LH_DATA_DIR）——这条自检无法进行，不要当它通过了。')
  }
  if (!existsSync(logPath)) return 0
  const text = readFileSync(logPath, 'utf8').replace(/^\uFEFF/, '')
  let n = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    if (line.includes('"lh/schedule/')) n += 1
  }
  return n
}

// ── 主流程：对**每一份**副本各跑一遍 ────────────────────────────────────

for (const target of entries) {
  const label = `${target.home === DSH_HOME ? 'DSH_HOME' : '仓库家'}/${target.profile}`
  console.log(`\n── ${label}：${target.entry}`)

  const mod = await import(pathToFileURL(target.entry).href)
  ok(`${label}: 导出 apply()`, typeof mod.apply === 'function')
  ok(`${label}: 导出 name`, typeof mod.name === 'string' && mod.name !== '')
  ok(`${label}: inject 只声明 webServer`, JSON.stringify([...(mod.inject ?? [])].sort()) === JSON.stringify(['webServer']))

  const { ctx, registered } = fakeContext()
  await mod.apply(ctx)
  ok(`${label}: apply() 注册了一条 prefix 路由`, registered.length === 1 && registered[0].kind === 'prefix')
  const route = registered[0]
  if (route === undefined) continue
  ok(`${label}: 路由前缀是 /lh/schedule`, route.path === '/lh/schedule')

  /**
   * 打一条路由（拼出 req.url）。
   * @param method - 方法。
   * @param path - 前缀之后的路径（含 query）。
   * @param body - 请求体。
   * @returns `{ status, body }`。
   */
  async function hit(method, path, body) {
    const { res, read } = makeRes()
    await route.handler(makeReq(method, `/lh/schedule${path}`, body), res)
    return read()
  }

  // 1) 自检路由
  const health = await hit('GET', '/health')
  ok(`${label}: GET /health → 200`, health.status === 200, `HTTP ${health.status} ${JSON.stringify(health.body)?.slice(0, 120)}`)
  ok(`${label}: /health 报出今天`, typeof health.body?.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(health.body.today))

  // 2) 日历（含 milestones 与 courses）
  const calendar = await hit('GET', '/calendar?from=2026-10-01&to=2026-10-31&tz=Asia/Shanghai')
  ok(`${label}: GET /calendar → 200`, calendar.status === 200)
  ok(`${label}: payload 带 days`, Array.isArray(calendar.body?.days) && calendar.body.days.length > 0)
  ok(`${label}: payload 带 milestones（验收期）`, Array.isArray(calendar.body?.milestones))
  ok(`${label}: payload 带 courses（课程选择）`, Array.isArray(calendar.body?.courses))

  // 3) 不认识的字段：必须 400，且**一个字都不写**
  const before = scheduleEventCount()
  const bogus = await hit('POST', '/create', { title: '【路由自检】不该被写下去', day: '2026-10-09', nonsense: 1 })
  ok(`${label}: 不认识的字段 → 400`, bogus.status === 400, `HTTP ${bogus.status}`)
  ok(`${label}: 400 里列出了可用字段`, Array.isArray(bogus.body?.accepted) && bogus.body.accepted.includes('until'))
  ok(`${label}: 400 时没有写任何事件`, scheduleEventCount() === before, `${before} → ${scheduleEventCount()}`)

  // ⚠ 如果这一条**没被挡住**（副本是旧的、护栏还没同步过去），它已经往真实日志里写了一条垃圾。
  //   自检必须自己收拾：把那条撤销掉，并在报告里说清"是副本陈旧，不是护栏失效"。
  //   不这样做的话，每跑一次旧副本就往学习史里塞一条谁也不认识的日程。
  if (bogus.status !== 400 && typeof bogus.body?.item?.item_id === 'string') {
    await hit('POST', '/cancel', {
      item_id: bogus.body.item.item_id,
      reason: '这条路本不该写成；说明这份副本还没同步到带护栏的版本（跑 scripts/install-lh-schedule.mjs）',
    })
    skipped.push(`${label}: ⚠ 旧副本没挡住未知字段，已把它写下的 ${bogus.body.item.item_id} 撤销（请重跑安装脚本同步这一份）`)
  }

  // 4) 真建一条**验收期**（带窗口 until）：这是本次新加的那条路
  const created = await hit('POST', '/create', {
    title: '【路由自检】模拟考（含窗口）',
    day: '2026-11-01',
    until: '2026-11-03',
    kind: 'mock',
    course_id: null,
    note: '由 selftest-routes.mjs 创建，随后会被撤销',
    source: 'selftest',
  })
  ok(`${label}: POST /create（mock + until）→ 200`, created.status === 200, `HTTP ${created.status} ${JSON.stringify(created.body)?.slice(0, 160)}`)
  const itemId = created.body?.item?.item_id ?? null
  ok(`${label}: 返回了 item_id`, typeof itemId === 'string')
  ok(`${label}: **until 落进了事件**（不是静默丢弃）`, created.body?.item?.until === '2026-11-03', `item.until=${String(created.body?.item?.until)}`)
  ok(`${label}: kind 是 mock`, created.body?.item?.kind === 'mock')

  if (itemId !== null) {
    // 5) 它必须出现在 milestones 里，而且带倒计时
    const after = await hit('GET', '/calendar?from=2026-11-01&to=2026-11-01&tz=Asia/Shanghai')
    const mine = (after.body?.milestones ?? []).find((m) => m.item_id === itemId)
    ok(`${label}: 新建的验收期出现在 milestones`, mine !== undefined)
    ok(`${label}: milestones 带 countdown.phase`, mine !== undefined && typeof mine.countdown?.phase === 'string')
    ok(
      `${label}: 11-01 那天的日历里有它`,
      (after.body?.days?.[0]?.items ?? []).some((it) => it.item_id === itemId),
    )

    // 6) 改：把 until 清掉（空串 = 清空）
    const cleared = await hit('POST', '/update', { item_id: itemId, until: '' })
    ok(`${label}: POST /update 清空 until → 200`, cleared.status === 200, `HTTP ${cleared.status}`)
    ok(`${label}: changed 里报了 until`, Array.isArray(cleared.body?.changed) && cleared.body.changed.includes('until'), JSON.stringify(cleared.body?.changed))
    ok(`${label}: until 真的被清掉了`, cleared.body?.item?.until === null, `until=${String(cleared.body?.item?.until)}`)

    // 7) 撤销（可恢复）
    const cancelled = await hit('POST', '/cancel', { item_id: itemId, reason: '路由自检结束' })
    ok(`${label}: POST /cancel → 200`, cancelled.status === 200)
    ok(`${label}: 撤销后状态是 cancelled`, cancelled.body?.item?.status === 'cancelled')
    const revived = await hit('POST', '/update', { item_id: itemId, status: 'planned' })
    ok(`${label}: 撤销后能恢复（planned）`, revived.body?.item?.status === 'planned')
    await hit('POST', '/cancel', { item_id: itemId, reason: '路由自检结束（恢复验证完再撤一次）' })
  }

  // 8) 「待办区」与"无限期推迟"（2026-10-10 追加：作者要的编辑能力与第二个视图）
  const todo0 = await hit('GET', '/todo?tz=Asia/Shanghai')
  ok(`${label}: GET /todo → 200`, todo0.status === 200, `HTTP ${todo0.status}`)
  ok(`${label}: /todo 带 backlog 数组`, Array.isArray(todo0.body?.backlog))
  ok(`${label}: /todo 带 days 数组`, Array.isArray(todo0.body?.days))
  ok(
    `${label}: /todo 只列还没做的（决策视图不该混进做完/撤掉的）`,
    (todo0.body?.days ?? []).every((d) => d.items.every((it) => it.status === 'planned')),
  )

  const noDate = await hit('POST', '/create', { title: '【路由自检】没定日子的待办', source: 'selftest' })
  ok(
    `${label}: 不给日期也能建（进待办）`,
    noDate.status === 200 && noDate.body?.item?.day === null,
    `HTTP ${noDate.status} day=${String(noDate.body?.item?.day)}`,
  )
  const todoItemId = noDate.body?.item?.item_id ?? null
  if (todoItemId !== null) {
    const todo1 = await hit('GET', '/todo?tz=Asia/Shanghai')
    ok(`${label}: 无日期的条目出现在 backlog 里`, (todo1.body?.backlog ?? []).some((it) => it.item_id === todoItemId))

    // 给它定个日子 → 离开待办、进日历
    const scheduledDay = '2026-11-20'
    const scheduled = await hit('POST', '/update', { item_id: todoItemId, day: scheduledDay })
    ok(`${label}: 给待办定日子 → 200 且 day 落盘`, scheduled.status === 200 && scheduled.body?.item?.day === scheduledDay)
    const todo2 = await hit('GET', '/todo?tz=Asia/Shanghai')
    ok(`${label}: 定日子后它离开 backlog`, !(todo2.body?.backlog ?? []).some((it) => it.item_id === todoItemId))
    ok(
      `${label}: 它出现在那一天里`,
      (todo2.body?.days ?? []).some((d) => d.day === scheduledDay && d.items.some((it) => it.item_id === todoItemId)),
    )

    // 无限期推迟 → 回到待办（**不是**取消）
    const someday = await hit('POST', '/update', { item_id: todoItemId, day: '' })
    ok(
      `${label}: 空 day = 无限期推迟（日期被清掉）`,
      someday.status === 200 && someday.body?.item?.day === null,
      `day=${String(someday.body?.item?.day)}`,
    )
    ok(`${label}: changed 里如实报了 day`, (someday.body?.changed ?? []).includes('day'))

    // 撤销 → 不进待办区（待办区只列还没做的）
    await hit('POST', '/cancel', { item_id: todoItemId, reason: '路由自检结束' })
    const todo3 = await hit('GET', '/todo?tz=Asia/Shanghai')
    ok(`${label}: 已撤销的不进待办区`, !(todo3.body?.backlog ?? []).some((it) => it.item_id === todoItemId))
    skipped.push(`${label}: 待办自检条目 ${todoItemId} 已撤销（写在临时日志里，跑完即删）`)
  }

  // 9) 未知路由
  const unknown = await hit('GET', '/nope')
  ok(`${label}: 未知路由 → 404`, unknown.status === 404)

  // 9) 收尾：如实说明这次自检写了什么、写到了哪里
  skipped.push(
    itemId === null
      ? `${label}: 没建成自检条目`
      : `${label}: 自检条目 ${itemId} 已撤销（写在临时日志里，跑完即删）`,
  )
}

// ── 结果 ────────────────────────────────────────────────────────────────

console.log('')
for (const line of skipped) console.log(`  · ${line}`)

if (failures.length === 0) {
  console.log(`\n✅ @lh/schedule-ui 路由自检通过：${passed} 条断言全绿（副本 ${entries.length} 份）。`)
  console.log('   （全程写在临时日志里，跑完已删除——真实学习史一个字节都没动。）')
  finish(0)
}

console.error(`\n❌ @lh/schedule-ui 路由自检失败：${failures.length} 条不通过（通过 ${passed} 条）。\n`)
for (const line of failures) console.error(`  · ${line}`)
console.error('')
finish(1)
