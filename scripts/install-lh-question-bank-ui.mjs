/**
 * 把 `@lh/question-bank-ui` 装进**所有该装的家**，并把"装 + 接线"做成一件事。
 *
 * ═══ 为什么需要一个脚本，而不是手敲几条 copy ═══
 * 契约 §5.6.5 的顺序是：**备份 → 闸门绿 → 加行 → 真会话验证 → 失败则回滚**。
 * 而这一类改动的失败形状是这个项目最贵的那一种（ADR-035 §7.1）：
 *   · 包没放对 / 组合文件写坏 → **应用直接起不来**；
 *   · 装进了 `profiles/web` 而作者用的是 `profiles/desktop` → **界面永远看不到**，
 *     而这个症状与"忘了重启"**一模一样**。
 * 所以这里按 `install-lh-schedule.mjs` 的老路把顺序写成代码，任何一步不过就**一个字都不改**。
 *
 * ═══ 它做的四件事（只有前三件全绿才做第四件）═══
 *   1. 逐文件复制到 `profiles/<名>/node_modules/@lh/question-bank-ui/`，**读回来算 sha256**；
 *   2. 从**副本**（生产路径，不是源码）`import()` 并用假 ctx 真跑一次 `apply()`，
 *      看它注册了什么、有没有抛；
 *   2b. 客户端 bundle 的**语法检查**（唯一还能把界面弄坏的路径）；
 *   3. 把 `package.json` 的 `lh` 自描述与真跑出来的结果对照；
 *   4. 组合文件：profile 的 `package.json`（+1 条 file: 依赖）与 `cordis.patch.yml`（+1 行），
 *      仓库根 `package.json`（+1 条 workspace 依赖）——改前一律备份，回滚只认清单。
 *
 * ═══ 它会装到哪些 profile ═══
 * **镜像既有的界面插件**：哪个 profile 已经装了 `@lh/schedule-ui` 或 `@lh/workspace-ui`，
 * 就装哪里——不自己发明位置。并且要求那个 profile 里**能解析到 `@lh/question-bank`**
 * （本插件的依赖）；解析不到就**跳过那个 profile 并说明**，而不是硬装出一个导入失败的包
 * （导入失败 = 整棵插件树加载失败 = dsh 起不来）。
 *
 * 用法：
 *   node scripts/install-lh-question-bank-ui.mjs              # 装 + 接线
 *   node scripts/install-lh-question-bank-ui.mjs --dry-run    # 只看会做什么，不写
 *   node scripts/install-lh-question-bank-ui.mjs --rollback   # 按最近一次的清单还原组合文件
 *   node scripts/install-lh-question-bank-ui.mjs --live       # 重启之后打真路由联调
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PLUGINS_DIR = join(REPO_ROOT, 'plugins')
const PKG_DIR = join(PLUGINS_DIR, 'lh-question-bank-ui')
const PKG_NAME = '@lh/question-bank-ui'
const SHORT_NAME = 'question-bank-ui'
/** 插件自己声明的 `name`（导出值，与包名不同：包名带 `@lh/`，插件名带 `lh-`）。 */
const PLUGIN_NAME = 'lh-question-bank-ui'
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')

const DRY_RUN = process.argv.includes('--dry-run')
const ROLLBACK = process.argv.includes('--rollback')
const LIVE = process.argv.includes('--live')

/** `--live` 打的是**正在跑的宿主**（桌面应用监听 19387）。 */
const BASE_URL = (process.env.LH_WEB_URL ?? 'http://127.0.0.1:19387').replace(/\/$/, '')

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const green = (s) => c('32', s)
const red = (s) => c('31', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

/** 全部失败原因；非空则退出码 1。 */
const failures = []

// ══════════════════════════════════════════════════════════════════════════
// 备份（改任何共享文件之前；回滚只认清单，不靠猜路径）
// ══════════════════════════════════════════════════════════════════════════

const BACKUP_ROOT = join(REPO_ROOT, '.lh-sync-backup')
const BACKUP_DIR = join(BACKUP_ROOT, `bank-ui-install-${STAMP}`)
/** `[{ key, original }]`：key 是备份目录里的安全文件名。 */
const manifest = []

/**
 * 备份一个即将被改写的文件。
 *
 * ⚠ 不能按"相对仓库根的路径"摆放——有些文件根本不在仓库里
 * （`C:\Users\Administrator\.dsh\...`），回滚会把它们还原到错误的路径上。
 * 所以：清单 + 顺序编号，备份与还原都只认清单。
 *
 * @param file - 绝对路径。
 * @returns 备份位置（dry-run 时是一句说明）。
 */
function backupFile(file) {
  if (!existsSync(file)) return null
  if (DRY_RUN) return '（dry-run：未真的备份）'
  const key = `f${String(manifest.length).padStart(3, '0')}-${file.replace(/[:\\/]/g, '_').slice(-60)}`
  const dest = join(BACKUP_DIR, key)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(file, dest)
  manifest.push({ key, original: file })
  return dest
}

/** 把清单落盘。 */
function flushManifest() {
  if (DRY_RUN || manifest.length === 0) return
  mkdirSync(BACKUP_DIR, { recursive: true })
  writeFileSync(join(BACKUP_DIR, 'manifest.json'), `${JSON.stringify({ stamp: STAMP, files: manifest }, null, 2)}\n`, 'utf8')
}

/** 同步小睡（Node 里唯一干净的做法）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 环境不支持就干脆不退避 */
  }
}

/**
 * 原子替换 + **有界退避重试**。
 *
 * Windows 上 `rename` 到一个**正被别的进程打开**的文件会失败（EPERM/EBUSY），
 * 而 dsh 在跑的时候 `client.js` / `index.js` 正是被它打开的。
 * 症状是"装完第一次跑报失败、紧接着第二次就过"——两次之间只差时间，
 * 于是人会开始怀疑改动本身。照宿主的 `writeFileAtomic` 加有界重试。
 *
 * @param file - 目标文件。
 * @param text - 新内容。
 */
function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  let lastError = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(tmp, file)
      return
    } catch (error) {
      lastError = error
      sleepSync(50 * 2 ** attempt)
    }
  }
  throw new Error(`写不进去（重试 6 次仍失败）：${file}\n  ${lastError?.message ?? lastError}`)
}

/** 算一个文件的 sha256。 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// ══════════════════════════════════════════════════════════════════════════
// 回滚
// ══════════════════════════════════════════════════════════════════════════

/**
 * 按最近一次的清单还原被改过的组合文件。
 *
 * 只还原组合文件与 package.json——**不动**任何插件副本、事件日志与题库文件。
 * （副本没有 Loader 行就不会被加载，留着无害；要清干净得连依赖一起删。）
 */
function rollback() {
  if (!existsSync(BACKUP_ROOT)) {
    console.log(red(`找不到备份根 ${BACKUP_ROOT}，无从回滚。`))
    process.exit(1)
  }
  const dirs = readdirSync(BACKUP_ROOT)
    .filter((n) => n.startsWith('bank-ui-install-'))
    .sort()
  const latest = dirs[dirs.length - 1]
  if (latest === undefined) {
    console.log(red('没有任何 bank-ui-install-* 备份。'))
    process.exit(1)
  }
  const dir = join(BACKUP_ROOT, latest)
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.log(red(`备份里没有清单：${manifestPath}`))
    process.exit(1)
  }
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  console.log(`从 ${dir} 还原 ${parsed.files.length} 个文件`)
  for (const entry of parsed.files) {
    const src = join(dir, entry.key)
    if (!existsSync(src)) {
      console.log(red(`  ✗ 备份里缺 ${entry.key}`))
      failures.push(`缺备份文件 ${entry.key}`)
      continue
    }
    atomicWrite(entry.original, readFileSync(src, 'utf8'))
    console.log(`  ${green('←')} ${entry.original}`)
  }
  console.log(`\n${failures.length === 0 ? green('回滚完成') : red('回滚有缺口')}（插件副本仍在 node_modules 里，不影响启动）`)
  process.exit(failures.length === 0 ? 0 : 1)
}

if (ROLLBACK) rollback()

// ══════════════════════════════════════════════════════════════════════════
// --live：打真路由
// ══════════════════════════════════════════════════════════════════════════

if (LIVE) {
  console.log(`联调对象：${BASE_URL}（正在跑的宿主）\n`)
  /**
   * 打一条路由。
   * @param method - 方法。
   * @param path - 前缀之后的路径。
   * @param body - 请求体。
   * @returns `{ status, body }`。
   */
  async function hit(method, path, body) {
    const res = await fetch(`${BASE_URL}/lh/bank${path}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { __raw: text.slice(0, 200) }
    }
    return { status: res.status, body: parsed }
  }
  const health = await hit('GET', '/health')
  if (health.status !== 200) {
    console.log(red(`✗ GET /health → ${health.status} ${JSON.stringify(health.body).slice(0, 200)}`))
    console.log(yellow('  常见原因：① 还没重启应用（插件是启动时加载的）② 该行没进 cordis.patch.yml ③ 包不在那个 profile 里'))
    process.exit(1)
  }
  console.log(green('✓ GET /health') + `  工作区 ${health.body.workspace?.dir} · 题库 ${health.body.bank_count} · 题 ${health.body.question_count} · 作答 ${health.body.attempt_count}（对上号 ${health.body.matched_attempt_count} / 未对上 ${health.body.unmatched_attempt_count}）`)
  const banks = await hit('GET', '/banks')
  console.log(`${banks.status === 200 ? green('✓') : red('✗')} GET /banks   ${banks.status}`)
  const first = banks.body?.banks?.[0]?.name
  if (typeof first === 'string') {
    const src = await hit('GET', `/source?name=${encodeURIComponent(first)}`)
    console.log(`${src.status === 200 ? green('✓') : red('✗')} GET /source?name=${first}   ${src.status}  来源文件 ${src.body?.source_files?.length ?? 0} 个`)
    const q = await hit('GET', `/questions?name=${encodeURIComponent(first)}&limit=5`)
    console.log(`${q.status === 200 ? green('✓') : red('✗')} GET /questions?name=${first}&limit=5   ${q.status}  共 ${q.body?.total ?? '?'} 题，返回 ${q.body?.items?.length ?? '?'} 条`)
    const rec = await hit('GET', `/attempts?bank=${encodeURIComponent(first)}&limit=5`)
    console.log(`${rec.status === 200 ? green('✓') : red('✗')} GET /attempts?bank=${first}&limit=5   ${rec.status}  共 ${rec.body?.total ?? '?'} 条`)
  }
  const bad = await hit('GET', '/banks?nope=1')
  console.log(`${bad.status === 400 ? green('✓') : red('✗')} 未知查询参数被挡（400）  ${bad.status}`)
  console.log(`\n面板请自己看一眼：侧栏 🗂️「题库」→ 中央面板三段（来源 / 题目 / 记录）。`)
  process.exit(health.status === 200 ? 0 : 1)
}

// ══════════════════════════════════════════════════════════════════════════
// 发现"家"与 profile
// ══════════════════════════════════════════════════════════════════════════

const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 所有存在的"家"：DSH_HOME 那个 + 仓库自持的那个（去重）。 */
function findHomes() {
  const found = []
  const push = (entry) => {
    if (!existsSync(entry.dir)) return
    if (found.some((h) => h.dir === entry.dir)) return
    found.push(entry)
  }
  const fromEnv = process.env.DSH_HOME
  push(
    typeof fromEnv === 'string' && fromEnv.trim() !== ''
      ? { dir: resolve(fromEnv.trim()), source: 'DSH_HOME 环境变量' }
      : { dir: join(homedir(), '.dsh'), source: '~/.dsh（没有设 DSH_HOME）' },
  )
  push({ dir: join(REPO_ROOT, '.dsh'), source: '仓库自持的家（scripts/lh-dev.mjs）' })
  return found
}

/**
 * 找出该装的那些 profile：**镜像既有的界面插件**。
 *
 * 判据是"这个 profile 里已经有 `@lh/schedule-ui` 或 `@lh/workspace-ui` 的**副本**"，
 * 因为那说明它就是一个装 LH 界面的家。同时要求它能解析到 `@lh/question-bank`。
 *
 * @returns `[{ label, dir, nodeModules, hasDep }]`。
 */
function findTargets() {
  const targets = []
  for (const home of findHomes()) {
    const profilesDir = join(home.dir, 'profiles')
    if (!existsSync(profilesDir)) continue
    const homeLabel = home.dir === join(REPO_ROOT, '.dsh') ? '仓库家' : 'DSH_HOME'
    for (const name of readdirSync(profilesDir)) {
      const dir = join(profilesDir, name)
      if (!isDir(dir)) continue
      const nm = join(dir, 'node_modules', '@lh')
      const hasUi = existsSync(join(nm, 'schedule-ui')) || existsSync(join(nm, 'workspace-ui'))
      if (!hasUi) continue
      targets.push({
        label: `${homeLabel}/${name}`,
        home,
        dir,
        nodeModules: nm,
        hasDep: existsSync(join(nm, 'question-bank')),
      })
    }
  }
  return targets
}

const TARGETS = findTargets()

console.log(`╔══ 装 ${PKG_NAME} ══════════════════════════════════════════════════`)
console.log(`║ 模式：${DRY_RUN ? 'DRY-RUN（不写任何东西）' : 'APPLY'}`)
console.log(`║ 源码：${PKG_DIR}`)
console.log(`║ 目标 profile：${TARGETS.length === 0 ? '(没找到——没有任何 profile 装过 LH 界面插件)' : TARGETS.map((t) => t.label).join('、')}`)
console.log('╚════════════════════════════════════════════════════════════════════')

if (TARGETS.length === 0) {
  console.log(red('\n没有任何 profile 装过 @lh/schedule-ui / @lh/workspace-ui，因此不知道该装到哪里。'))
  console.log(dim('  先确认那个家在跑（DSH_HOME），或先装 LH 的其它界面插件。'))
  process.exit(1)
}

// ── 源码文件清单：以 package.json 的 `files` 为准（它是"运行时真正会被加载的文件集"）──
const srcPkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
const FILES = [...new Set([...(srcPkg.files ?? []), 'package.json'])]
for (const f of FILES) {
  if (!existsSync(join(PKG_DIR, f))) failures.push(`源码缺文件：${f}`)
}
if (failures.length > 0) {
  console.log(red(`\n源码不完整：\n  ${failures.join('\n  ')}`))
  process.exit(1)
}

// ══════════════════════════════════════════════════════════════════════════
// 1~3. 复制 + 从副本真跑 + 自描述对照
// ══════════════════════════════════════════════════════════════════════════

/** 假 ctx：只实现服务端半会用到的那几个成员。 */
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

const wired = []

for (const target of TARGETS) {
  console.log(`\n── ${target.label}`)
  if (!target.hasDep) {
    console.log(`  ${yellow('跳过')}：这个 profile 里没有 @lh/question-bank（本插件的依赖）。`)
    console.log(dim('    硬装会得到一个导入失败的包，而导入失败 = 整棵插件树加载失败 = dsh 起不来。'))
    continue
  }

  const destDir = join(target.nodeModules, SHORT_NAME)
  if (DRY_RUN) {
    console.log(`  ${dim('(dry-run)')} 会写入 ${destDir}（${FILES.length} 个文件）`)
  } else {
    mkdirSync(destDir, { recursive: true })
    for (const f of FILES) {
      // ⚠ **不覆盖正在被 dsh 打开的文件**：先写临时名再原子替换（同 atomicWrite 的理由）
      const tmp = join(destDir, `${f}.tmp-${process.pid}`)
      copyFileSync(join(PKG_DIR, f), tmp)
      renameSync(tmp, join(destDir, f))
    }
    console.log(`  ${green('已复制')} ${FILES.length} 个文件 → ${destDir}`)
  }

  // 校验：逐文件 sha256 与源码一致（副本是快照不是软链，"改了没同步"是本项目最贵的失败形状）
  if (!DRY_RUN) {
    let mismatch = 0
    for (const f of FILES) {
      const a = sha256(join(PKG_DIR, f))
      const b = sha256(join(destDir, f))
      if (a !== b) {
        mismatch += 1
        failures.push(`${target.label}: ${f} 副本与源码 sha256 不一致`)
      }
    }
    console.log(mismatch === 0 ? `  ${green('sha256 一致')}（${FILES.length} 个文件）` : `  ${red(`${mismatch} 个文件不一致`)}`)
    if (mismatch > 0) continue
  }

  // 2. 从**副本**（生产路径）import 并真跑一次 apply()
  if (!DRY_RUN) {
    try {
      const mod = await import(pathToFileURL(join(destDir, 'index.js')).href)
      const { ctx, registered } = fakeContext()
      await mod.apply(ctx)
      const route = registered[0]
      const good =
        typeof mod.apply === 'function' &&
        mod.name === PLUGIN_NAME &&
        JSON.stringify([...(mod.inject ?? [])].sort()) === JSON.stringify(['webServer']) &&
        registered.length === 1 &&
        route?.kind === 'prefix' &&
        route?.path === '/lh/bank'
      console.log(good ? `  ${green('真跑 apply()')}：注册了 prefix 路由 /lh/bank` : `  ${red('真跑 apply() 结果不对')}`)
      if (!good) failures.push(`${target.label}: 副本真跑 apply() 的结果与声明不符（${JSON.stringify({ name: mod.name, inject: mod.inject, n: registered.length, path: route?.path })})`)

      // 2b. 客户端 bundle 的语法检查：唯一还能把界面弄坏的路径
      const clientPath = join(destDir, 'client.js')
      const clientText = readFileSync(clientPath, 'utf8')
      let syntaxOk = true
      try {
        await import(pathToFileURL(clientPath).href)
      } catch (error) {
        // 浏览器里 `window` 存在，所以读完 window 才停下的那条路径永远不会走到；
        // 于是"抛的不是 SyntaxError" = 至少能被解析。
        syntaxOk = !(error instanceof SyntaxError)
        if (error instanceof SyntaxError) console.log(`  ${red('客户端半语法错误')}：${error.message}`)
      }
      const declares = clientText.includes('__ModuleLoader__.load') && clientText.includes('exports.inject')
      console.log(syntaxOk && declares ? `  ${green('客户端半可解析')}（含 __ModuleLoader__.load 与 exports.inject）` : `  ${red('客户端半有问题')}`)
      if (!syntaxOk || !declares) failures.push(`${target.label}: 客户端 half 检查不过（syntaxOk=${syntaxOk} declares=${declares}）`)

      // 3. 自描述对照（契约 §五之七）：package.json 的 lh 段要与真跑出来的结果一致
      const lh = JSON.parse(readFileSync(join(destDir, 'package.json'), 'utf8')).lh ?? {}
      const slotKeys = lh.provides?.slots ?? []
      const consistent =
        (lh.provides?.routes ?? []).includes('/lh/bank/health') &&
        slotKeys.includes('main#lh-bank') &&
        slotKeys.includes('sidebar.panellist#lh-bank')
      console.log(consistent ? `  ${green('自描述一致')}（routes/slots 与实现同形）` : `  ${red('自描述与实现不符')}`)
      if (!consistent) failures.push(`${target.label}: package.json 的 lh.provides 与实现不符`)
    } catch (error) {
      console.log(`  ${red('从副本 import/apply 失败')}：${error?.message ?? error}`)
      failures.push(`${target.label}: 副本 import/apply 失败 — ${error?.message ?? error}`)
      continue
    }
  }

  wired.push(target)
}

// 任何一步不过 → **一个字都不改**（组合文件留到下面）
if (failures.length > 0) {
  console.log(`\n${red('检查未通过，组合文件一个字都没改：')}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}

// ══════════════════════════════════════════════════════════════════════════
// 4. 组合文件
// ══════════════════════════════════════════════════════════════════════════

/** 写进 profile `cordis.patch.yml` 的那一行（含注释：为什么它在 profile 层而不是 preset 层）。 */
const UI_ROW = `
# ─────────────────────────────────────────────────────────────────────────────
# LH 的题库管理（@lh/question-bank-ui）—— 学习界面
#
# 一个包、两半：
#   · 服务端半（index.js）在 /lh/bank 前缀下注册七条路由：
#       GET  /lh/bank/health      自检（工作区/日志读不读得到、几库几题、几条件答对上号）
#       GET  /lh/bank/banks       题库清单（含已归档区）+ 全局合计
#       GET  /lh/bank/source      选中库的「来源」段（库级：出处文件、抽取方式与模型、覆盖面）
#       GET  /lh/bank/questions   选中库的「题目」段（分页 + 筛题干/知识点/题型/做过没做过）
#       GET  /lh/bank/attempts    「记录」段（时间/作答/三态对错/来源/用时/关联会话）
#       POST /lh/bank/archive     把题库移进 lh-questions/.archived/（可逆）
#       POST /lh/bank/restore     把它移回来
#   · 客户端半（client.js）往 main（key \`lh-bank\`）与 sidebar.panellist（同名 id）注册面板。
#
# 为什么它在 **profile 层**：界面插件 inject \`webServer\`，而 preset 是 agent 作用域，
# 够不着 host 面服务（契约 §一.1）；而且宿主发现客户端插件的方式是"扫 Loader 的 entries，
# 看哪个行的 name 对应一个声明了 dsh.client 的包"——没有这一行，浏览器那半边根本不会被投放。
#
# 为什么它只读 + 两个可逆动作：判断归 agent、机械动作归界面（ADR-035/037）。
# 归档只是一次**文件移动**（题库的物理形态是文件，ADR-018 决定 2），
# 不写任何事件；**删除不在面板里做**——那要走清理脚本（报告模式 + 备份 + 白名单）。
#
# ⚠ 这一行必须先有包再有行（否则导入不到 = 整棵插件树加载失败）。
#   包由 scripts/install-lh-question-bank-ui.mjs 装好并逐字节校验过；
#   要撤掉就把本行改成 disabled: true，或跑该脚本 --rollback 恢复组合文件。
- insert:
    - id: lh-question-bank-ui
      name: '@lh/question-bank-ui'
`

const wiredProfiles = []

for (const target of wired) {
  // 4a. profile 的 package.json：+1 条 file: 依赖（让下次 pnpm install 也一致）
  const pkgPath = join(target.dir, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.dependencies = pkg.dependencies ?? {}
    // 相对 profile 目录的 file: 规格：写绝对路径会在别人机器上指错、也会把
    // 作者的盘符写进会被跟踪的仓库家配置（2026-10-14 审查后统一改成相对）。
    const spec = `file:${relative(target.dir, PKG_DIR).replace(/\\/g, '/')}`
    if (pkg.dependencies[PKG_NAME] === spec) {
      console.log(`  ${dim('已是最新')} ${target.label}/package.json 依赖`)
    } else {
      backupFile(pkgPath)
      pkg.dependencies[PKG_NAME] = spec
      if (!DRY_RUN) atomicWrite(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
      console.log(`  ${green('已更新')} ${target.label}/package.json（+1 条依赖）`)
    }
  } else {
    failures.push(`${target.label}: package.json 不存在，无法声明依赖`)
  }

  // 4b. profile 的 cordis.patch.yml：+1 行（幂等：已经有时不重复加）
  const patchPath = join(target.dir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    failures.push(`${target.label}: cordis.patch.yml 不存在，无法加行`)
    continue
  }
  const text = readFileSync(patchPath, 'utf8')
  if (text.includes('id: lh-question-bank-ui')) {
    console.log(`  ${dim('已是最新')} ${target.label}/cordis.patch.yml`)
  } else {
    backupFile(patchPath)
    if (!DRY_RUN) atomicWrite(patchPath, `${text.replace(/\s*$/, '')}\n${UI_ROW}`)
    console.log(`  ${green('已加行')} ${target.label}/cordis.patch.yml（lh-question-bank-ui）`)
    wiredProfiles.push(target.label)
  }
}

// 4c. 仓库根 package.json：+1 条 workspace 依赖（契约 §3：源码目录里的测试要能解析包名）
const rootPkgPath = join(REPO_ROOT, 'package.json')
if (existsSync(rootPkgPath)) {
  const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
  pkg.dependencies = pkg.dependencies ?? {}
  if (pkg.dependencies[PKG_NAME] === 'workspace:*') {
    console.log(`  ${dim('已是最新')} 仓库根 package.json 依赖`)
  } else {
    backupFile(rootPkgPath)
    pkg.dependencies[PKG_NAME] = 'workspace:*'
    if (!DRY_RUN) atomicWrite(rootPkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    console.log(`  ${green('已更新')} 仓库根 package.json（+1 条 workspace 依赖）`)
    console.log(dim('    ⚠ 需要跑一次 pnpm install 让那个软链就位（源码路径的自测依赖它）。'))
  }
}

flushManifest()

// ══════════════════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════════════════

console.log('')
if (failures.length > 0) {
  console.log(red(`══ ${failures.length} 项失败 ══`))
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}

console.log(green('══ 完成 ══'))
if (DRY_RUN) {
  console.log(dim('  这是 dry-run：什么都没有写。去掉 --dry-run 才真的装。'))
} else {
  console.log(`  备份清单：${join(BACKUP_DIR, 'manifest.json')}`)
  console.log(`  回滚：node scripts/install-lh-question-bank-ui.mjs --rollback`)
  if (wiredProfiles.length > 0) console.log(`  改了组合文件的 profile：${wiredProfiles.join('、')}`)
  console.log('')
  console.log(yellow('  下一步（顺序不能颠）'))
  console.log('    1) 重启 dsh（插件是启动时加载的；不重启看不到面板）')
  console.log('    2) node scripts/install-lh-question-bank-ui.mjs --live')
  console.log('    3) 侧栏 🗂️「题库」看一眼面板（我看不见界面，这一条只能由你来）')
}
