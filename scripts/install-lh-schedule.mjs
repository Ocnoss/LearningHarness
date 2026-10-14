/**
 * 把 `@lh/schedule`（日程 + 四个 agent 工具）+ `@lh/schedule-ui`（学习日历界面）
 * **原子地**装进 dsh 的各个"家"与 profile，并按既有结构接线。
 *
 * ═══ 为什么需要这个脚本 ═══
 * 新增一个 LH 插件包，正常流程是：
 *   ① 写包（plugins/lh-xxx/）；
 *   ② `pnpm install`（把包装进 `profiles/<名>/node_modules/@lh/`）；
 *   ③ 在组合文件里加行（profile 的 `cordis.patch.yml`，或 preset 的 `agent.cordis.yml`）；
 *   ④ 重启 dsh。
 * ② 与 ③ 的顺序**不能反**：先加行、后装包 = 宿主导入不到那个包 =
 * **整棵插件树加载失败 = dsh 完全起不来**（PLUGIN_CONTRACT §〇 形态①）。
 * 而 ② 在本项目的开发环境里跑不了（沙箱里进程起不来），且
 * `scripts/sync-lh-deps.mjs` **只更新已存在的副本**——它对新包直接跳过。
 * 所以本脚本把 ②③ 做成**一件事**，并把顺序纪律写成代码：
 *   **只有每个文件逐字节校验通过、插件真能 import、`apply()` 真不抛错、
 *     客户端 bundle 真能被解析，才会去改组合文件。** 任何一步失败 → 一个字都不改。
 *
 * ═══ 为什么它要扫"所有的家"（本脚本最容易做错、也最值钱的一段）═══
 * 实测的事实（2026-10-09）：
 *   · 本机 `DSH_HOME = C:\Users\Administrator\.dsh`，它下面有
 *     `profiles/desktop`、`profiles/web`、`profiles/dev`、`profiles/headless`；
 *   · 仓库里还有一个**自持的家** `D:\LearningHarnessv0.1\.dsh`（`lh-dev.mjs` 用的），
 *     它的 `profiles/web` 也装着一整套 LH 插件；
 *   · 而 **19387 端口是 `DeepSeek Harness.exe`（桌面应用）在监听**——
 *     也就是说**作者正在看的界面来自 `profiles/desktop`**。
 *
 * `ARCHITECTURE.md` §73 把这条写成了本项目**最贵的失败形状**：
 * "装进 `profiles/web` 的界面插件，在 desktop 应用里永远看不到——
 *  而这个症状与'忘了重启'一模一样。"
 * 所以本脚本不挑一个 profile，而是：**照着既有结构，把该有的行加到每一处**，
 * 并打印清楚"哪一处装了什么、哪一处是那个正在跑的界面"。
 *
 * ═══ 接线规则：镜像 `@lh/course-tree` 挂在哪一层 ═══
 * 两个家的既有结构**不一样**，这不是偶然：
 *   · `profiles/desktop`：`@lh/course-tree` 是**profile 行**（"让五个工具在所有会话里可用"）；
 *   · `profiles/web`（两个家都是）：`@lh/course-tree` 是**preset 行**，profile 只挂界面插件。
 * 所以本脚本不自己发明位置，而是**读既有组合文件**：
 *   - 哪个 profile 的行里已经有 `@lh/course-tree` → 把 `@lh/schedule` 与 `@lh/schedule-ui` 也加到那里；
 *   - 哪个家的 lh preset 里有 `lh-course-tree` → 把 `lh-schedule` 加到那里；
 *   - 界面那一半（`@lh/schedule-ui`）**永远加在 profile 层**——它 inject `webServer`，
 *     而 preset 是 agent 作用域，够不着 host 面服务（PLUGIN_CONTRACT §一.1 实测）。
 *
 * ═══ 它不做什么 ═══
 * · **不跑 pnpm**（理由见 sync-lh-deps.mjs 顶部：那是宿主的地基，副作用半径太大）；
 * · 不碰 profile 的 pnpm 记账文件（下次真跑 `pnpm install` 会自己对齐）；
 * · 不写死盘符：仓库根从本文件的位置推，家从 `DSH_HOME` 与仓库推。
 *
 * ═══ 用法 ═══
 *   node scripts/install-lh-schedule.mjs              # 装 + 接线（幂等）
 *   node scripts/install-lh-schedule.mjs --dry-run    # 只看会改什么（一个字节都不写）
 *   node scripts/install-lh-schedule.mjs --live       # 重启之后：联调（打路由 + 真写一条再撤掉）
 *   node scripts/install-lh-schedule.mjs --rollback    # 把组合文件恢复到本次安装前的备份
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PLUGINS_DIR = join(REPO_ROOT, 'plugins')

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const LIVE = args.includes('--live')
const ROLLBACK = args.includes('--rollback')

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const green = (s) => c('32', s)
const red = (s) => c('31', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

/** 要装的包。`tools` = 工具那一半（不需要 webServer）；`ui` = 界面那一半。 */
const PACKAGES = [
  { dir: 'lh-schedule', name: '@lh/schedule', role: 'tools' },
  { dir: 'lh-schedule-ui', name: '@lh/schedule-ui', role: 'ui' },
]

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

// ══════════════════════════════════════════════════════════════════════════
// 发现"家"与 profile
// ══════════════════════════════════════════════════════════════════════════

/** `DSH_HOME`（或默认 `~/.dsh`）—— 与 `@deepseek-ai/dsh-home-paths` 的口径一致。 */
function defaultHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { dir: resolve(fromEnv.trim()), source: 'DSH_HOME 环境变量' }
  return { dir: join(homedir(), '.dsh'), source: '~/.dsh（没有设 DSH_HOME）' }
}

/** 所有存在的"家"：DSH_HOME 那个 + 仓库自持的那个（去重）。 */
function findHomes() {
  const found = []
  const push = (entry) => {
    if (!existsSync(entry.dir)) return
    if (found.some((h) => h.dir === entry.dir)) return
    found.push(entry)
  }
  push(defaultHome())
  push({ dir: join(REPO_ROOT, '.dsh'), source: '仓库自持的家（scripts/lh-dev.mjs）' })
  return found
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 扫一个家：它有哪些 profile、每个 profile 装了 LH 插件没有、组合文件里挂了哪些行、
 * 以及它的 lh preset 把 `lh-course-tree` 挂在哪一层。
 *
 * @param home - `{ dir, source }`。
 * @returns 扩了 `profiles` / `preset` 的家对象。
 */
function scanHome(home) {
  const profilesDir = join(home.dir, 'profiles')
  const profiles = []
  if (existsSync(profilesDir)) {
    for (const name of readdirSync(profilesDir)) {
      const dir = join(profilesDir, name)
      if (!isDir(dir)) continue
      const lhDir = join(dir, 'node_modules', '@lh')
      const patchPath = join(dir, 'cordis.patch.yml')
      const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
      profiles.push({
        name,
        dir,
        hasLh: existsSync(lhDir),
        patchPath,
        patchText,
        // "这个 profile 自己挂了 course-tree 工具行"——接线时镜像它的位置。
        mountsCourseTree: /name:\s*'@lh\/course-tree'/.test(patchText),
        pkgPath: join(dir, 'package.json'),
      })
    }
  }
  const presetPath = join(home.dir, '.agent-presets', 'lh', 'agent.cordis.yml')
  const presetText = existsSync(presetPath) ? readFileSync(presetPath, 'utf8') : null
  return {
    ...home,
    profiles,
    presetPath: presetText === null ? null : presetPath,
    presetText,
    presetMountsCourseTree: presetText !== null && /id:\s*lh-course-tree/.test(presetText),
  }
}

const HOMES = findHomes().map(scanHome)

// ══════════════════════════════════════════════════════════════════════════
// 备份（改任何共享文件之前都先留一份；回滚靠清单，不靠猜路径）
// ══════════════════════════════════════════════════════════════════════════

const BACKUP_DIR = join(REPO_ROOT, '.lh-sync-backup', `schedule-install-${stamp}`)
const MANIFEST_PATH = join(BACKUP_DIR, 'manifest.json')
/** `[{ key, original }]`：key 是备份目录里的安全文件名。 */
const manifest = []

/**
 * 备份一个即将被改写的文件。
 *
 * ⚠ 第一版把备份按"相对仓库根的路径"摆放，而**有些文件根本不在仓库里**
 *   （`C:\Users\Administrator\.dsh\...`）——回滚时就会把它们还原到错误的路径上。
 *   所以改成"清单 + 顺序编号"：备份与还原都只认那份清单，与文件在哪儿无关。
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

/** 把清单落盘（每次备份后覆盖写；它很小）。 */
function flushManifest() {
  if (DRY_RUN || manifest.length === 0) return
  mkdirSync(BACKUP_DIR, { recursive: true })
  writeFileSync(MANIFEST_PATH, `${JSON.stringify({ stamp, files: manifest }, null, 2)}\n`, 'utf8')
}

/** 同步小睡（Node 里唯一干净的做法：`Atomics.wait` 阻塞在共享内存上）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 环境不支持就干脆不退避：重试本身还在 */
  }
}

/**
 * 原子替换，并**有界退避重试**。
 *
 * ═══ 为什么要重试（这是踩出来的，不是防御性代码）═══
 * 装完第一次跑经常报失败、紧接着第二次就过——两次之间的差别只有时间。
 * 根因是 Windows 上 `rename` 到一个**正被别的进程打开**的文件会失败（EPERM/EBUSY），
 * 而 dsh 在跑的时候，`client.js` / `index.js` 这些就是被它打开的
 * （客户端 bundle 会被按需读，服务端半更是启动时 import 过）。
 *
 * 宿主的 `writeFileAtomic` 对同一件事用的就是"有界指数退避"（它的注释里写着），
 * 这里照同一条做法：几次短退避之后仍然失败，才算真失败。
 * 不退避的代价不是"多跑一次"——而是**第一次的失败会被当成真失败**，
 * 于是人会开始怀疑改动本身，而不是怀疑文件锁。
 *
 * @param src - 源文件。
 * @param dst - 目标文件。
 * @param attempts - 最多试几次。
 */
function replaceWithRetry(src, dst, attempts = 6) {
  let lastError = null
  for (let i = 0; i < attempts; i += 1) {
    const tmp = `${dst}.lh-install-tmp`
    try {
      copyFileSync(src, tmp)
      renameSync(tmp, dst)
      return
    } catch (error) {
      lastError = error
      try {
        unlinkSync(tmp)
      } catch {
        /* 清理失败不掩盖主错误 */
      }
      sleepSync(40 * (i + 1))
    }
  }
  throw lastError ?? new Error(`替换 ${dst} 失败`)
}

/** 原子写：先写临时文件再改名（直接写会在中断时留下半截文件）。 */
function atomicWrite(file, text) {
  const tmp = `${file}.lh-install-tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

// ══════════════════════════════════════════════════════════════════════════
// --live：重启之后的一次真联调
// ══════════════════════════════════════════════════════════════════════════

if (LIVE) {
  const port = process.env.DSH_WEB_PORT ?? '19387'
  const base = `http://127.0.0.1:${port}/lh/schedule`
  console.log(`联调 ${base}\n`)
  for (const home of HOMES) {
    console.log(dim(`  家：${home.dir}（${home.source}） profile：${home.profiles.filter((p) => p.hasLh).map((p) => p.name).join(', ') || '无'}`))
  }
  console.log('')

  /**
   * 打一条路由。
   * @param path - 相对 /lh/schedule 的路径。
   * @param init - fetch 参数。
   * @returns `{ status, body }`。
   */
  async function hit(path, init) {
    const res = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' }, ...init })
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  }

  let failed = 0
  const check = (label, condition, detail) => {
    if (condition) {
      console.log(`  ${green('✓')} ${label}`)
      return
    }
    failed += 1
    console.log(`  ${red('✗')} ${label}${detail === undefined ? '' : `  ${dim(String(detail))}`}`)
  }

  const health = await hit('/health')
  check('GET /health 返回 200', health.status === 200, `HTTP ${health.status} ${JSON.stringify(health.body)?.slice(0, 200)}`)
  if (health.status === 200) {
    console.log(dim(`    事件 ${health.body.event_count} 条 · 日程 ${health.body.item_count} 条 · 今天 ${health.body.today}（${health.body.tz}）`))
  }

  const month = new Date().toISOString().slice(0, 7)
  const calendar = await hit(`/calendar?month=${month}`)
  check('GET /calendar 返回 200', calendar.status === 200, `HTTP ${calendar.status}`)
  if (calendar.status === 200) {
    console.log(dim(`    铺了 ${calendar.body.days?.length ?? 0} 天 · 课程 ${calendar.body.courses?.length ?? 0} 门`))
  }

  // ── 写路径的真联调：建一条 → 读回来 → 撤掉 ──
  //
  // 为什么必须走一遍写：读路由只证明"投影能跑"，写路由才证明
  // **事件真的落进日志、并且能立刻被按日期读回来**。
  const today = new Date().toISOString().slice(0, 10)
  const created = await hit('/create', {
    method: 'POST',
    body: JSON.stringify({
      title: `【自检】联调日程 ${stamp}`,
      day: today,
      kind: 'study',
      note: '由 scripts/install-lh-schedule.mjs --live 创建，随后被撤销',
      source: 'selftest',
    }),
  })
  check(
    'POST /create 返回 200 且带 item_id',
    created.status === 200 && typeof created.body?.item?.item_id === 'string',
    `HTTP ${created.status} ${JSON.stringify(created.body)?.slice(0, 200)}`,
  )

  const itemId = created.body?.item?.item_id ?? null
  if (itemId !== null) {
    const after = await hit(`/calendar?from=${today}&to=${today}`)
    const seen = (after.body?.days?.[0]?.items ?? []).some((it) => it.item_id === itemId)
    check('刚建的日程立刻能按日期读回来', seen)

    const cancelled = await hit('/cancel', { method: 'POST', body: JSON.stringify({ item_id: itemId, reason: '联调结束' }) })
    check('POST /cancel 返回 200', cancelled.status === 200, `HTTP ${cancelled.status}`)
    console.log(dim(`    （自检日程 ${itemId} 已撤销：它仍在日志与日历里标为"已撤销"——那是 append-only 的应有形状）`))
  }

  console.log('')
  console.log(failed === 0 ? green('联调全绿：日历与日程都在工作。') : red(`联调有 ${failed} 项不通过——看上面的 ✗ 行。`))
  if (failed !== 0) {
    console.log(dim('  排查：每个插件都往自己目录写 trace.log（plugins/lh-schedule/、plugins/lh-schedule-ui/，以及副本目录）。'))
  }
  process.exit(failed === 0 ? 0 : 1)
}

// ══════════════════════════════════════════════════════════════════════════
// --rollback：按清单把组合文件恢复到备份时的样子
// ══════════════════════════════════════════════════════════════════════════

if (ROLLBACK) {
  const base = join(REPO_ROOT, '.lh-sync-backup')
  const candidates = existsSync(base)
    ? readdirSync(base).filter((n) => n.startsWith('schedule-install-')).sort()
    : []
  if (candidates.length === 0) {
    console.log(red('没有找到本脚本留下的备份（.lh-sync-backup/schedule-install-*）。'))
    process.exit(1)
  }
  const latest = join(base, candidates[candidates.length - 1])
  const manifestPath = join(latest, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.log(red(`备份里没有清单：${manifestPath}`))
    process.exit(1)
  }
  const saved = JSON.parse(readFileSync(manifestPath, 'utf8'))
  console.log(`从备份恢复：${latest}（${saved.files.length} 个文件）`)
  console.log(dim('  注意：这只恢复**组合文件与 package.json**，不动事件日志，也不删已复制的包。\n'))

  let restored = 0
  for (const entry of saved.files) {
    if (!existsSync(join(latest, entry.key))) {
      console.log(`  ${yellow('跳过')} ${entry.original}（备份里没这个文件）`)
      continue
    }
    if (DRY_RUN) {
      console.log(`  ${dim('将恢复')} ${entry.original}`)
      continue
    }
    mkdirSync(dirname(entry.original), { recursive: true })
    copyFileSync(join(latest, entry.key), entry.original)
    restored += 1
    console.log(`  ${green('已恢复')} ${entry.original}`)
  }
  console.log('')
  console.log(DRY_RUN ? '（dry-run：什么都没改）' : `恢复了 ${restored} 个文件。**要重启 dsh 才生效。**`)
  console.log(dim('  若恢复之后仍起不来，问题不在本脚本改过的地方（那些文件已经回到原样）。'))
  process.exit(0)
}

// ══════════════════════════════════════════════════════════════════════════
// 正常安装
// ══════════════════════════════════════════════════════════════════════════

console.log(`${DRY_RUN ? '[dry-run] ' : ''}把学习日历与日程装进 dsh 并接线\n`)
for (const home of HOMES) {
  const lh = home.profiles.filter((p) => p.hasLh).map((p) => p.name)
  console.log(`  家 ${home.dir}  ${dim(`（${home.source}）`)}`)
  console.log(`    装了 LH 插件的 profile：${lh.length > 0 ? lh.join(', ') : dim('无')}`)
  console.log(`    lh preset：${home.presetPath === null ? dim('无') : dim(home.presetPath)}${home.presetMountsCourseTree ? dim('（里面有 lh-course-tree 行）') : ''}`)
}
const TARGETS = HOMES.flatMap((home) => home.profiles.filter((p) => p.hasLh).map((p) => ({ home, profile: p })))
if (TARGETS.length === 0) {
  console.log('')
  console.log(red('没有找到任何"装了 LH 插件的 profile"，无从安装。'))
  console.log(dim('  确认 dsh 的家在哪：看 DSH_HOME，或 <仓库>/.dsh/profiles/*/node_modules/@lh 是否存在。'))
  process.exit(1)
}
console.log('')

const failures = []
let copiesWritten = 0
let copiesVerified = 0

/** 读一个包的 package.json（缺 `files` 直接算失败——闸门与同步都靠它，契约 §五之三）。 */
function readPackage(dirName) {
  const pkgPath = join(PLUGINS_DIR, dirName, 'package.json')
  if (!existsSync(pkgPath)) {
    failures.push(`源码里没有 ${dirName}/package.json`)
    return null
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    failures.push(`${pkg.name ?? dirName} 的 package.json 缺 "files"（无法判定该装哪些文件）`)
    return null
  }
  return pkg
}

const PKG = Object.fromEntries(PACKAGES.map((entry) => [entry.name, readPackage(entry.dir)]).filter(([, p]) => p !== null))

// ── 第 1 步：复制到每一处副本位置，并逐字节校验 ──
console.log('第 1 步：复制到副本位置并逐字节校验')

for (const { home, profile } of TARGETS) {
  const targetRoot = join(profile.dir, 'node_modules', '@lh')
  for (const entry of PACKAGES) {
    const pkg = PKG[entry.name]
    if (pkg === undefined) continue
    const shortName = entry.name.replace(/^@[^/]+\//, '')
    const sourceDir = join(PLUGINS_DIR, entry.dir)
    const targetDir = join(targetRoot, shortName)
    const files = [...new Set(['package.json', ...pkg.files])].sort()

    const label = `${home.dir === join(REPO_ROOT, '.dsh') ? '仓库家' : 'DSH_HOME'}/${profile.name}`
    console.log(`  ${entry.name} → ${label}`)
    if (!DRY_RUN) mkdirSync(targetDir, { recursive: true })

    for (const rel of files) {
      const src = join(sourceDir, rel)
      const dst = join(targetDir, rel)
      if (!existsSync(src)) {
        failures.push(`${entry.name}: 声明了 ${rel} 但源码里没有`)
        continue
      }
      const srcHash = sha256(src)
      const dstExists = existsSync(dst)
      const dstHash = dstExists ? sha256(dst) : null

      if (dstHash === srcHash) {
        copiesVerified += 1
        console.log(`    ${dim('已是最新')} ${rel}`)
        continue
      }
      if (dstExists) backupFile(dst)
      if (!DRY_RUN) {
        // 带退避的原子替换：dsh 在跑的时候这些文件可能正被它打开（见 replaceWithRetry 的注释）。
        replaceWithRetry(src, dst)
        // 复制之后**读回来**再算一次哈希：不相信 copyFileSync 没出错。
        const backHash = sha256(dst)
        if (backHash !== srcHash) {
          failures.push(`${entry.name}/${rel}（${label}）: 复制后校验不一致（源码 ${srcHash.slice(0, 12)}… 副本 ${backHash.slice(0, 12)}…）`)
          continue
        }
      }
      copiesWritten += 1
      copiesVerified += 1
      console.log(`    ${green(dstExists ? '更新' : '补上')} ${rel}`)
    }

    // 清掉声明之外的残留**普通文件**（目录不碰：里面可能是 pnpm 的链接结构）。
    if (!DRY_RUN && existsSync(targetDir)) {
      const declared = new Set(files)
      for (const f of readdirSync(targetDir)) {
        const full = join(targetDir, f)
        if (!isDir(full) && !existsSync(full)) continue
        try {
          if (isDir(full)) continue
        } catch {
          continue
        }
        if (declared.has(f)) continue
        backupFile(full)
        unlinkSync(full)
        console.log(`    ${yellow('清掉未声明的残留')} ${f}`)
      }
    }
  }
}

// ── 第 2 步：从副本 import + 真跑 apply()（这就是"不会起不来"的证明）──
//
// 组合文件里加一行 = 宿主启动时 import 这个包。任何一条 import 失败或 apply() 抛错，
// 代价都是**整棵插件树加载失败、dsh 完全起不来**（契约 §〇）。
// 所以先在这里把同样的事做一遍：从**副本**（生产路径）import、用假 ctx 跑 apply。
console.log('')
console.log('第 2 步：从副本 import 并真跑一次 apply()（假 ctx）')

/**
 * 记账式假 ctx：只实现这些插件会用到的那几个成员，并把注册到的东西记下来。
 * @returns `{ ctx, log }`。
 */
function fakeContext() {
  const log = { tools: [], routes: [], contexts: [], effects: 0 }
  const ctx = {
    on() {},
    get() {
      return undefined
    },
    effect(fn) {
      log.effects += 1
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(_names, cb) {
      // 假装那个可选服务**在**：这样上下文注册那条路也会被真跑一遍。
      if (typeof cb === 'function') {
        cb({
          systemPrompt: {
            context(section) {
              log.contexts.push(section)
              return () => {}
            },
          },
        })
      }
      return () => {}
    },
    tools: {
      register(tool) {
        log.tools.push(tool)
      },
    },
    webServer: {
      register(options) {
        log.routes.push(options)
        return () => {}
      },
    },
  }
  return { ctx, log }
}

const applyReports = []

for (const { home, profile } of TARGETS) {
  const label = `${home.dir === join(REPO_ROOT, '.dsh') ? '仓库家' : 'DSH_HOME'}/${profile.name}`
  for (const entry of PACKAGES) {
    const shortName = entry.name.replace(/^@[^/]+\//, '')
    const target = join(profile.dir, 'node_modules', '@lh', shortName, 'index.js')
    if (DRY_RUN) {
      console.log(`  ${dim('(dry-run) 将 import')} ${entry.name} → ${label}`)
      continue
    }
    if (!existsSync(target)) {
      failures.push(`${entry.name}（${label}）: 副本位置没有 index.js（${target}）`)
      continue
    }

    try {
      // ⚠ import 的是**副本**（生产路径），不是源码——这是本项目第一次恶性事故的教训：
      //   测试跑源码、生产跑副本，两条路径的模块解析不同。
      const mod = await import(pathToFileURL(target).href)
      if (typeof mod.apply !== 'function') {
        failures.push(`${entry.name}（${label}）: 没有导出 apply()`)
        continue
      }
      if (typeof mod.name !== 'string' || mod.name === '') {
        failures.push(`${entry.name}（${label}）: 没有导出 name`)
        continue
      }
      const { ctx, log } = fakeContext()
      await mod.apply(ctx)
      applyReports.push({ label, pkg: entry.name, moduleName: mod.name, inject: mod.inject ?? [], log })
      const bits = []
      if (log.tools.length > 0) bits.push(`${log.tools.length} 个工具`)
      if (log.routes.length > 0) bits.push(`${log.routes.length} 条路由`)
      if (log.contexts.length > 0) bits.push(`${log.contexts.length} 段上下文`)
      console.log(`  ${green('✓')} ${entry.name}（${label}） apply() 不抛错，注册了 ${bits.join(' + ') || '（什么都没注册）'}`)
      if (log.tools.length > 0) console.log(dim(`      工具：${log.tools.map((t) => t.name).join(', ')}`))
      if (log.routes.length > 0) console.log(dim(`      路由：${log.routes.map((r) => `${r.kind} ${r.path}`).join(', ')}`))
      if (log.contexts.length > 0) console.log(dim(`      上下文：${log.contexts.map((s) => `${s.name}(order ${s.order})`).join(', ')}`))
    } catch (error) {
      failures.push(`${entry.name}（${label}）: import 或 apply() 失败 → ${error?.message ?? error}`)
    }
  }
}

// ── 第 2b 步：客户端 bundle 的语法与入口检查（唯一还能把界面弄坏的路径）──
//
// 第 2 步 import 的是**服务端半**；客户端 bundle 只被**浏览器**加载。它若有语法错，
// 宿主仍然起得来，但浏览器会卡在 `Failed to load plugins` 的启动屏（契约 §〇 形态③）。
// 手法：真去 `import()` 它，**只看抛的是不是 `SyntaxError`**——语法没错的话，
// 它一开始执行就会读 `window`，在 Node 里立刻抛 `ReferenceError`；
// 而浏览器里 `window` 是存在的，那条路径永远不会走到。
console.log('')
console.log('第 2b 步：客户端 bundle 能不能被解析（形态③的护栏）')

for (const { home, profile } of TARGETS) {
  const label = `${home.dir === join(REPO_ROOT, '.dsh') ? '仓库家' : 'DSH_HOME'}/${profile.name}`
  for (const entry of PACKAGES) {
    const pkg = PKG[entry.name]
    if (pkg === undefined) continue
    const clientRel = pkg.exports?.['./client']?.default
    if (typeof clientRel !== 'string') continue
    if (pkg.exports?.['./package.json'] === undefined) {
      failures.push(`${entry.name}: exports 缺 "./package.json"（客户端半不会被投放）`)
    }
    if (DRY_RUN) {
      console.log(`  ${dim('(dry-run) 将解析')} ${entry.name}/client.js → ${label}`)
      continue
    }
    const shortName = entry.name.replace(/^@[^/]+\//, '')
    const clientPath = join(profile.dir, 'node_modules', '@lh', shortName, clientRel.replace(/^\.\//, ''))
    if (!existsSync(clientPath)) {
      failures.push(`${entry.name}（${label}）: exports["./client"] 指向的 ${clientRel} 在副本里不存在`)
      continue
    }
    const source = readFileSync(clientPath, 'utf8')
    if (!source.includes('__ModuleLoader__.load')) {
      failures.push(`${entry.name}/client.js（${label}）: 没有 window.__ModuleLoader__.load(...)（宿主不会执行它）`)
    }
    if (!source.includes('exports.inject')) {
      failures.push(`${entry.name}/client.js（${label}）: 没有 exports.inject（契约 §2.1 实测：漏了它浏览器会卡在 Failed to load plugins）`)
    }
    try {
      await import(pathToFileURL(clientPath).href)
      console.log(`  ${yellow('·')} ${entry.name}/client.js（${label}）被解析且执行完毕（说明没走 ModuleLoader，看上面的静态断言）`)
    } catch (error) {
      if (error instanceof SyntaxError) {
        failures.push(`${entry.name}/client.js（${label}）: 语法错 → ${error.message}`)
      } else {
        console.log(`  ${green('✓')} ${entry.name}/client.js（${label}）语法通（执行时按预期在 window 上停下：${String(error?.name ?? 'Error')}）`)
      }
    }
  }
}

// ── 第 3 步：把 `lh` 自我描述与真跑出来的结果对照（契约 §五之七）──
console.log('')
console.log('第 3 步：核对 package.json 的 lh 自我描述与实现是否一致')

for (const report of applyReports) {
  const entry = PACKAGES.find((p) => p.name === report.pkg)
  const pkg = entry === undefined ? null : PKG[entry.name]
  if (pkg === null || pkg === undefined) continue

  const declared = Array.isArray(pkg.lh?.provides?.tools) ? [...pkg.lh.provides.tools].sort() : []
  const actual = report.log.tools.map((t) => t.name).sort()
  const missing = declared.filter((n) => !actual.includes(n))
  const extra = actual.filter((n) => !declared.includes(n))
  if (missing.length > 0 || extra.length > 0) {
    failures.push(
      `${report.pkg}: lh.provides.tools 与实现不一致（声明里多的：${missing.join(',') || '无'}；实现里多的：${extra.join(',') || '无'}）`,
    )
  } else if (declared.length + actual.length > 0) {
    console.log(`  ${green('✓')} ${report.pkg} 工具清单一致（${actual.join(', ')}）`)
  } else {
    console.log(`  ${dim('·')} ${report.pkg} 不注册工具（界面插件），跳过工具清单核对`)
  }

  const declaredInject = Array.isArray(pkg.lh?.inject) ? [...pkg.lh.inject].sort() : []
  const actualInject = [...report.inject].sort()
  if (JSON.stringify(declaredInject) !== JSON.stringify(actualInject)) {
    failures.push(`${report.pkg}: lh.inject=${JSON.stringify(declaredInject)} 与模块导出的 inject=${JSON.stringify(actualInject)} 不一致`)
  } else {
    console.log(`  ${green('✓')} ${report.pkg} inject 一致（${actualInject.join(', ') || '无'}）`)
  }
}

// ── 有失败就**一个字都不改**（这就是本脚本存在的理由）──
if (failures.length > 0) {
  console.log('')
  console.log(red(`第 1~3 步有 ${failures.length} 处不通过，**组合文件一个字都没改**：`))
  for (const line of failures) console.log(`  · ${line}`)
  console.log('')
  console.log(dim('  修法：先修源码/包声明，再重跑本脚本。'))
  console.log(dim('  （这正是 PLUGIN_CONTRACT §5.6.5 的顺序：先证明不会起不来，再加行。）'))
  process.exit(1)
}

console.log('')
console.log(green(`第 1~3 步（含 2b）全绿：写了 ${copiesWritten} 个文件、校验通过 ${copiesVerified} 处。加行是安全的。`))
console.log('')

// ── 第 4 步：接线 ──
console.log('第 4 步：接线（按既有结构镜像 course-tree 挂在哪一层）')

/** 界面那一半的行（profile 层；它 inject webServer）。 */
const UI_ROW = `
# ── LH 学习日历（@lh/schedule-ui）──
#
# 一个包、两半：
#   · 服务端半（index.js）在 /lh/schedule 前缀下注册五条路由：
#       GET  /lh/schedule/health       自检（日志读不读得到、有多少条日程、今天是哪天）
#       GET  /lh/schedule/calendar     月/周视图：计划（日程）+ 事实（哪段对话动过）+ 课程动作
#       POST /lh/schedule/create       新建日程
#       POST /lh/schedule/update       改期/改名/标记完成/绑课程/绑对话
#       POST /lh/schedule/cancel       撤销（可恢复，可改回 planned）
#   · 客户端半（client.js）往 main（key \`lh-calendar\`）与 sidebar.panellist（同名 id）注册日历面板。
#
# 为什么两半都要：宿主发现客户端插件的方式是"扫 Loader 的 entries，看哪个行的 name
# 对应一个声明了 dsh.client 的包"（同 @lh/theme / @lh/practice / @lh/workspace-ui）。
# 没有这一行，浏览器那半边根本不会被投放。
#
# 为什么写路由与 agent 工具是同一份代码：都调 @lh/schedule/commands ——
# "在日历上点的"和"模型建的"日程，在事件日志里字节级同形（ADR-035 的分工）。
#
# ⚠ 这一行必须先有包再有行（否则导入不到 = 整棵插件树加载失败）。
#   包由 scripts/install-lh-schedule.mjs 装好并逐字节校验过；
#   要撤掉就把本行改成 disabled: true，或跑 --rollback 恢复组合文件。
- insert:
    - id: lh-schedule-ui
      name: '@lh/schedule-ui'
`

/** 工具那一半的行（profile 层版：包名；因为该包就装在这个 profile 的 node_modules 里）。 */
const TOOLS_ROW_PROFILE = `
# ── LH 的学习日程（@lh/schedule，工具那一半）──
#
# 日程 = lh/schedule/* 事件的投影（唯一实现 schedule.js，写入 commands.js，
# 按日期索引的视图在 calendar.js）。注册四个模型可调用的工具：
#   create_schedule / list_schedule（按日期区间同时读计划、对话活动、课程动作）
#   / update_schedule（含标记完成、绑课程、绑当前这段对话）/ cancel_schedule（可恢复）。
# 另把"今天有哪些日程、欠了什么"注入运行时上下文 lh:agenda（order 118）。
#
# 为什么它也挂在 profile 层（而不只在 preset 里）：与上面 \`@lh/course-tree\` 同一理由——
# 这一层挂上，**所有会话**都能用日程工具，不只 LH 模式。
- insert:
    - id: lh-schedule
      name: '@lh/schedule'
`

/** 工具那一半的行（preset 层版：绝对路径；宿主会把绝对路径转成 file: URL）。 */
const TOOLS_ROW_PRESET = `
# LH 的学习日程（@lh/schedule）：
# 日程 = lh/schedule/* 事件的投影（唯一实现 schedule.js，写入 commands.js，
# 按日期索引的视图在 calendar.js）。注册四个模型可调用的工具：
#   create_schedule（新建日程）、list_schedule（**按日期区间读**：计划 + 这几天哪些对话动过
#   + 课程动作）、update_schedule（改期/改名/标记完成/绑课程/绑当前这段对话）、
#   cancel_schedule（撤销，可恢复，建议给它原因）。
# 并把"今天有哪些日程、欠了什么"注入运行时上下文 lh:agenda（order 118）——
# 不知道今天是哪天，模型就没法把"明天下午"翻译成一个日期。
#
# 它**只注册工具、不 provide root-realm 服务**，故不需要 isolate realm（同上面那批行）。
# 静态导入链只碰 @lh/event-store（它在仓库根的 node_modules 里），
# 刻意不碰 @lh/course-tree——理由见该包 package.json 的 "//dependencies"。
- id: lh-schedule
  name: '${join(PLUGINS_DIR, 'lh-schedule', 'index.js')}'
`

const wiredProfiles = []
const wiredPresets = []

for (const { home, profile } of TARGETS) {
  const label = `${home.dir === join(REPO_ROOT, '.dsh') ? '仓库家' : 'DSH_HOME'}/${profile.name}`
  const homeLabel = home.dir === join(REPO_ROOT, '.dsh') ? '仓库家' : 'DSH_HOME'

  // 4a. 该 profile 的 package.json：声明两个 file: 依赖（让下次 pnpm install 也一致）
  if (existsSync(profile.pkgPath)) {
    const pkg = JSON.parse(readFileSync(profile.pkgPath, 'utf8'))
    pkg.dependencies = pkg.dependencies ?? {}
    let added = 0
    for (const entry of PACKAGES) {
      // 相对 profile 目录的 file: 规格（理由同 install-lh-question-bank-ui：别写绝对盘符）
      const spec = `file:${relative(dirname(profile.pkgPath), join(PLUGINS_DIR, entry.dir)).replace(/\\/g, '/')}`
      if (pkg.dependencies[entry.name] !== spec) {
        pkg.dependencies[entry.name] = spec
        added += 1
      }
    }
    if (added === 0) {
      console.log(`  ${dim('已是最新')} ${label}/package.json 依赖`)
    } else {
      backupFile(profile.pkgPath)
      if (!DRY_RUN) atomicWrite(profile.pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
      console.log(`  ${green('已更新')} ${label}/package.json（+${added} 条依赖）`)
    }
  } else {
    failures.push(`${label}: package.json 不存在，无法声明依赖`)
  }

  // 4b. 该 profile 的 cordis.patch.yml
  if (!existsSync(profile.patchPath)) {
    failures.push(`${label}: cordis.patch.yml 不存在，无法加行`)
    continue
  }
  let text = readFileSync(profile.patchPath, 'utf8')
  const before = text
  // 它自己挂了 course-tree 工具行 → 工具那一半也加在这里（镜像既有位置）。
  if (profile.mountsCourseTree && !text.includes(`id: lh-schedule\n`)) {
    text = `${text.replace(/\s*$/, '')}\n${TOOLS_ROW_PROFILE}`
  }
  if (!text.includes('id: lh-schedule-ui')) {
    text = `${text.replace(/\s*$/, '')}\n${UI_ROW}`
  }
  if (text === before) {
    console.log(`  ${dim('已是最新')} ${label}/cordis.patch.yml`)
  } else {
    backupFile(profile.patchPath)
    if (!DRY_RUN) atomicWrite(profile.patchPath, text)
    const parts = []
    if (profile.mountsCourseTree) parts.push('lh-schedule')
    parts.push('lh-schedule-ui')
    console.log(`  ${green('已加行')} ${label}/cordis.patch.yml（${parts.join(' + ')}）`)
    wiredProfiles.push(label)
  }

  // 4c. 这个家的 lh preset：只有它里面本来就挂了 lh-course-tree 时才加工具行
  if (home.presetMountsCourseTree && home.presetPath !== null) {
    const presetText = readFileSync(home.presetPath, 'utf8')
    if (!presetText.includes('id: lh-schedule')) {
      backupFile(home.presetPath)
      if (!DRY_RUN) atomicWrite(home.presetPath, `${presetText.replace(/\s*$/, '')}\n${TOOLS_ROW_PRESET}`)
      console.log(`  ${green('已加行')} ${homeLabel}/.agent-presets/lh/agent.cordis.yml（lh-schedule）`)
      wiredPresets.push(homeLabel)
    } else {
      console.log(`  ${dim('已是最新')} ${homeLabel}/.agent-presets/lh/agent.cordis.yml`)
    }
  }
}

// 4d. 仓库根的 package.json：按契约 §3 第 3 条声明 workspace 依赖
const rootPkgPath = join(REPO_ROOT, 'package.json')
if (existsSync(rootPkgPath)) {
  const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
  pkg.dependencies = pkg.dependencies ?? {}
  let added = 0
  for (const entry of PACKAGES) {
    if (pkg.dependencies[entry.name] !== 'workspace:*') {
      pkg.dependencies[entry.name] = 'workspace:*'
      added += 1
    }
  }
  if (added === 0) {
    console.log(`  ${dim('已是最新')} package.json（仓库根）workspace 依赖`)
  } else {
    backupFile(rootPkgPath)
    if (!DRY_RUN) atomicWrite(rootPkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    console.log(`  ${green('已更新')} package.json（仓库根）（+${added} 条 workspace 依赖；下次 pnpm install 会建软链）`)
  }
}

flushManifest()

console.log('')
if (DRY_RUN) {
  console.log('（dry-run：什么都没改。去掉 --dry-run 才会真的装。）')
  process.exit(0)
}

// ── 收尾：说清下一步与"哪个家是活的" ──
const alive = HOMES.find((h) => h.dir === resolve(process.env.DSH_HOME ?? ''))
console.log(green('装好了。剩下两件事（都要在 dsh 进程之外做）：'))
console.log('  1. **重启 dsh**（插件是启动时加载的；不重启就还是旧进程）。')
console.log(`     你正在看的界面是**桌面应用**（19387 端口是 \`DeepSeek Harness.exe\`）——`)
console.log(`     它的家在 \`${alive?.dir ?? '(未知)'}\`、profile 是 \`desktop\`，本次已经装到那里。`)
console.log(`  2. 重启后跑一次联调：${green('node scripts/install-lh-schedule.mjs --live')}`)
console.log('')
if (wiredProfiles.length > 0) console.log(`  已加行的 profile：${wiredProfiles.join('、')}`)
if (wiredPresets.length > 0) console.log(`  已加行的 preset：${wiredPresets.join('、')}`)
if (wiredProfiles.length === 0 && wiredPresets.length === 0) {
  console.log(yellow('  ⚠ 没有加任何行（可能都已经在了）。'))
}
console.log('')
console.log(dim(`  备份与清单：${manifest.length > 0 ? BACKUP_DIR : '（本次没有覆盖任何文件，无需备份）'}`))
console.log(dim('  回滚：node scripts/install-lh-schedule.mjs --rollback（只恢复组合文件与 package.json，不动事件日志）'))
console.log(dim('  起不来时的第一反应：把加过的那行改 disabled: true，再重启。'))
console.log('')
console.log(dim('  装完之后，日常改源码只需：node scripts/sync-lh-deps.mjs（它管已存在的副本）。'))
