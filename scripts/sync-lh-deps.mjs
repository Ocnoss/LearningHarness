/**
 * 把插件的运行时文件同步到所有"副本型"安装位置。
 *
 * ═══ 为什么不用 pnpm install ═══
 * 三个理由，每个都是实测出来的：
 *
 * 1. **它不会更新。** `file:` 依赖的规格没变（还是同一个目录），pnpm 就认为
 *    "已是最新"，直接跳过——`pnpm add` 会打印 "Already up to date"，
 *    而副本里少的那个文件依然少。这是"改了没生效"的根源。
 *
 * 2. **它有副作用半径。** profile 目录是 dsh 自己的安装根。
 *    在里面跑 pnpm 等于让包管理器去动宿主的地基，而插件树加载失败会让
 *    **dsh 完全无法启动**。同步这件事不需要冒这个险。
 *
 * 3. **它的拷贝规则不是我们的规则。** 实测同一个包在仓库根和 profile 里
 *    拷出来的文件集**不一样**（一个多 trace.log，一个少 selftests）。
 *    靠它"顺手"同步，等于把"哪些文件是运行时必需的"交给它猜。
 *
 * ═══ 所以这里做什么 ═══
 * 以 `package.json` 的 `files` 为**唯一依据**（和闸门用的是同一份清单），
 * 逐文件从源码拷到副本：缺的补上、旧的覆盖、多余的清掉。
 * 纯文件操作、离线、幂等，不碰 pnpm，不碰宿主的任何依赖。
 *
 * 它写完就被闸门验（node scripts/check-installed-copies.mjs）——
 * 两个脚本共用同一份 `files` 清单，所以"同步过了"和"闸门绿了"不会互相矛盾。
 *
 * 运行：node scripts/sync-lh-deps.mjs            （同步）
 *       node scripts/sync-lh-deps.mjs --dry-run  （只看会改什么）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync, unlinkSync, realpathSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { INSTALL_CONFIG_FILENAME } from '../plugins/lh-event-store/paths.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = join(repoRoot, 'plugins')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')

const dryRun = process.argv.includes('--dry-run')

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')

/** 与闸门同源的推导：声明里没有 `files` 就拒绝同步（不猜）。 */
function declaredFiles(pkg) {
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) return null
  return [...new Set(['package.json', ...pkg.files])].sort()
}

/** 收集副本型安装位置（排除指向源码的活链）。 */
function copyTargets(sourceDir, shortName) {
  const out = []
  const candidates = [{ label: '仓库根', dir: join(repoRoot, 'node_modules', '@lh', shortName) }]

  // ═══ 扫**所有的家**，不只是 DSH_HOME 那个（2026-10-13 补）═══
  //
  // 原先只扫 `dshHome = DSH_HOME || ~/.dsh`，于是仓库自持的家（`<仓库>/.dsh/`，
  // `lh-dev.mjs` 用的那个）**永远同步不到**——ADR-037 §7.1 把这个缺口写成过一次"实测踩到"。
  // 为什么这次必须补：第一次咬人时受害者是 `@lh/schedule`，而它有一个专门跨家同步的
  // `install-lh-schedule.mjs` 兜着；`@lh/question-bank` 这类 **preset 包没有那个兜底**，
  // 于是"改了源码 → 仓库家副本是旧的 → `check-installed-copies` 红 / 真加载时导入失败"
  // 这条路上**没有任何工具能修**。同一个缺口第二次咬人，就该修缺口本身。
  //
  // ⚠ 顺序与去重：DSH_HOME 与仓库家可能是同一个目录（有人这么配），去重避免同一份被报两次。
  const homes = []
  const pushHome = (dir, label) => {
    if (!existsSync(join(dir, 'profiles'))) return
    if (homes.some((h) => h.dir === dir)) return
    homes.push({ dir, label })
  }
  pushHome(resolve(dshHome), 'DSH_HOME')
  pushHome(join(repoRoot, '.dsh'), '仓库家')

  for (const home of homes) {
    const profilesDir = join(home.dir, 'profiles')
    for (const entry of readdirSync(profilesDir)) {
      const prefix = home.label === 'DSH_HOME' ? 'profile' : '仓库家 profile'
      candidates.push({ label: `${prefix}:${entry}`, dir: join(profilesDir, entry, 'node_modules', '@lh', shortName) })
    }
  }

  for (const t of candidates) {
    if (!existsSync(t.dir)) continue
    let real
    try {
      real = realpathSync(t.dir)
    } catch {
      continue
    }
    // 活链（workspace 软链）：源码即本体，没有副本要同步。
    if (real === realpathSync(sourceDir)) {
      out.push({ ...t, live: true, real })
    } else {
      out.push({ ...t, live: false, real })
    }
  }
  return out
}

/**
 * 原子写：先写临时文件再改名。
 * 为什么必须这样：dsh 可能正在读这个文件（profile 里的插件是宿主启动时加载的），
 * 直接覆盖会让读到的内容处于"写了一半"的状态。
 */
function atomicCopy(src, dst) {
  const tmp = `${dst}.lh-sync-tmp`
  copyFileSync(src, tmp)
  try {
    renameSync(tmp, dst)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 清理失败不掩盖主错误 */ }
    throw err
  }
}

// ── 备份 ──────────────────────────────────────────────────────────────────
//
// ═══ 为什么每次覆盖都留备份 ═══
// 闸门只报"内容不同"，报不出**方向**。而"副本是旧的"与"有人在副本上直接改过"
// 是两件事：后者同步过去就等于**静默覆盖掉别人的修改**。
//
// 我先试过"发现副本独有代码行就拒绝同步"，但立刻否掉了：
// **删代码行正是重构的常态**，那样每次重构都要敲 --force，
// 而这种"总是被绕过"的闸门比没有闸门更坏（人会条件反射地加 --force）。
//
// 改成留备份：覆盖永远可回溯，于是不需要拦，也不会有摩擦。
// 备份是**廉价且不依赖判断力**的——判断力会累，备份不会。
const backupRoot = join(repoRoot, '.lh-sync-backup', new Date().toISOString().replace(/[:.]/g, '-'))
let backupCount = 0

/** 把即将被覆盖/删除的文件留一份。返回它在备份里的相对位置（给日志用）。 */
function backup(targetLabel, pkgName, rel, file) {
  if (dryRun) return
  const dest = join(backupRoot, targetLabel.replace(/[:\\/]/g, '_'), pkgName, rel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(file, dest)
  backupCount += 1
}

// ── 安装配置：让副本能自己找到家 ─────────────────────────────────────────
//
// ═══ 为什么这是同步的一部分，而不是"顺便" ═══
// 插件被装进 `profiles/<名>/node_modules/@lh/<包>/` 之后，**它的上方没有 LH 仓库**。
// 所以"从模块位置往上找仓库根"必然失败 → 数据目录解析不出来 →
// 插件 apply() 抛错 → **整棵插件树加载失败、dsh 起不来**。
//
// 这个缺口之前一直是**被写死的绝对路径挡住的**（profile 里的旧拷贝还写着
// `DEFAULT_DATA_DIR = 'D:\...'`）。也就是说：去掉写死路径的重构，
// 会在下一次重启时把 dsh 弄坏。同步这一步知道仓库在哪，就该顺手写下来，
// 而不是让运行时去猜、更不是要求使用者记得设环境变量。
//
// 写的位置是 **profile 根目录**（`node_modules` 的上一级）：
//   · 它不在任何包目录里，所以不会和 `files` 清单、闸门的"多余文件"检查打架；
//   · 从 `node_modules/@lh/<包>/` 往上走四级就到，`paths.js` 找得到。
function writeInstallConfig(profileDir) {
  const repoConfigPath = join(repoRoot, 'lh-install.json')
  if (!existsSync(repoConfigPath)) {
    return {
      written: false,
      reason: '仓库根没有 lh-install.json —— 先 `cp lh-install.json.example lh-install.json` 并填好 workspace（副本将退回环境变量）',
    }
  }
  const config = JSON.parse(readFileSync(repoConfigPath, 'utf8'))
  const repoConfigDir = dirname(repoConfigPath)
  // ⚠ 三个字段**都按当前机器重算**（2026-10-14 修：此前 workspace/data_dir 原样照抄
  //   仓库根那份的作者绝对路径——同步动作把错路径传播进每一个 profile，
  //   而 paths.js 会静默照用，表现为别人机器上"数据不见了/题库是空的"）。
  const payload = {}
  // repo_root：写成**相对本配置文件**的路径——跟着仓库走，搬机器/搬盘符都不坏；
  // （绝对路径写死才是那个静默错误的源头。）
  payload.repo_root = (relative(profileDir, repoRoot) || '.').replace(/\\/g, '/')
  const explicitData = typeof config.data_dir === 'string' && config.data_dir.trim() !== '' ? config.data_dir.trim() : null
  if (explicitData !== null) payload.data_dir = resolve(repoConfigDir, explicitData)
  const workspace = typeof config.workspace === 'string' && config.workspace.trim() !== '' ? config.workspace.trim() : null
  if (workspace !== null) {
    payload.workspace = resolve(repoConfigDir, workspace)
    if (!existsSync(payload.workspace)) {
      // 不静默：路径照写（用户可能马上建），但把"指到不存在的目录"说出来
      console.log(`  ⚠ workspace 指向的目录不存在：${payload.workspace}（改 lh-install.json 或设 LH_WORKSPACE）`)
    }
  }

  const dest = join(profileDir, INSTALL_CONFIG_FILENAME)
  const text = JSON.stringify(payload, null, 2) + '\n'

  if (existsSync(dest) && readFileSync(dest, 'utf8') === text) {
    return { written: false, reason: '已是最新' }
  }
  if (!dryRun) {
    const tmp = `${dest}.lh-sync-tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, dest)
  }
  return { written: true, reason: dryRun ? '将写入' : '已写入' }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

/**
 * 把仓库家配置里的「仓库根绝对路径」对齐到当前仓库根。
 *
 * ══ 为什么必须做 ══
 * `.dsh/.agent-presets/lh/` 下的 preset 行与 `profiles/<名>/cordis.patch.yml` 的
 * HMR root 写的是**绝对路径**（宿主的加载行只认绝对路径/包名）。
 * 把作者机器的 `D:\...` 原样推给别的机器 = 挂载行指向不存在的文件，
 * 而症状是"preset 不出现/工具没有"，不是报错。同步动作知道仓库在哪，
 * 就该顺手对齐（与 writeInstallConfig 的 repo_root 同一条纪律）。
 *
 * 判据：任何**引号里含 `plugins/` 或 `\plugins\`** 的绝对路径，
 * 都视为"仓库根/plugins 的旧写法"，把前缀换成本仓库根。
 */
function alignRepoPaths() {
  const files = []
  const presetDir = join(repoRoot, '.dsh', '.agent-presets', 'lh')
  if (existsSync(presetDir)) {
    for (const n of readdirSync(presetDir)) if (n.endsWith('.yml')) files.push(join(presetDir, n))
  }
  const profilesDir = join(repoRoot, '.dsh', 'profiles')
  if (existsSync(profilesDir)) {
    for (const p of readdirSync(profilesDir)) {
      const f = join(profilesDir, p, 'cordis.patch.yml')
      if (existsSync(f)) files.push(f)
    }
  }
  let rewritten = 0
  for (const file of files) {
    const before = readFileSync(file, 'utf8')
    const after = before.replace(/(['"])([^'"\s]*[\\/])(plugins(?:[\\/][^'"\s]*)?)\1/g, (_m, q, _head, tail) => {
      const abs = join(repoRoot, tail.replace(/\\/g, '/')).replace(/\\/g, '/')
      return `${q}${abs}${q}`
    })
    if (after === before) continue
    rewritten += 1
    if (!dryRun) writeFileSync(file, after, 'utf8')
    console.log(`  ${dryRun ? '将对齐' : '已对齐'}  ${relative(repoRoot, file)}（仓库根路径 → ${repoRoot}）`)
  }
  return rewritten
}

const pluginDirs = readdirSync(pluginsDir).filter((n) =>
  existsSync(join(pluginsDir, n, 'package.json')) && statSync(join(pluginsDir, n)).isDirectory(),
)

let written = 0
let removed = 0
let liveCount = 0
const skipped = []

console.log(`${dryRun ? '[dry-run] ' : ''}同步 ${pluginDirs.length} 个插件到副本型安装位置\n`)

for (const dirName of pluginDirs) {
  const sourceDir = join(pluginsDir, dirName)
  const pkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'))
  const label = pkg.name ?? dirName
  const shortName = String(label).replace(/^@[^/]+\//, '')

  const files = declaredFiles(pkg)
  if (files === null) {
    console.log(`${label.padEnd(24)} ${yellow('跳过')}  ${dim('package.json 缺 "files"，无法判定该同步什么')}`)
    skipped.push(label)
    continue
  }

  const targets = copyTargets(sourceDir, shortName)
  const copies = targets.filter((t) => !t.live)
  liveCount += targets.length - copies.length

  if (copies.length === 0) {
    console.log(`${label.padEnd(24)} ${dim('没有副本需要同步' + (targets.length ? '（是活链，源码即本体）' : ''))}`)
    continue
  }

  for (const t of copies) {
    const changes = []

    for (const rel of files) {
      const src = join(sourceDir, rel)
      const dst = join(t.real, rel)
      if (!existsSync(src)) {
        changes.push(`声明了但源码里没有: ${rel}`)
        continue
      }
      if (!existsSync(dst)) {
        changes.push(`补: ${rel}`)
        if (!dryRun) atomicCopy(src, dst)
        written += 1
        continue
      }
      if (sha256(src) !== sha256(dst)) {
        changes.push(`更新: ${rel}`)
        backup(t.label, shortName, rel, dst)
        if (!dryRun) atomicCopy(src, dst)
        written += 1
      }
    }

    // 清掉声明之外的残留文件（如旧安装留下的 trace.log）。
    // 只删**普通文件**，目录一律不碰——目录里可能是 pnpm 的链接结构。
    const declared = new Set(files)
    for (const f of readdirSync(t.real)) {
      const full = join(t.real, f)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isFile() && !declared.has(f)) {
        changes.push(`清: ${f}`)
        backup(t.label, shortName, `${f}.removed`, full)
        if (!dryRun) unlinkSync(full)
        removed += 1
      }
    }

    if (changes.length === 0) {
      console.log(`${label.padEnd(24)} ${t.label.padEnd(14)} ${green('已是最新')}`)
    } else {
      console.log(`${label.padEnd(24)} ${t.label.padEnd(14)} ${useColor ? '\u001b[36m' : ''}${changes.length} 处变更${useColor ? '\u001b[0m' : ''}`)
      for (const ch of changes) console.log(`    ${ch}`)
    }
  }
}

console.log('')

if (skipped.length) {
  console.log(yellow(`⚠ ${skipped.length} 个包因缺 "files" 未同步：${skipped.join(', ')}`))
  console.log(dim('  在 package.json 里补上 "files"，闸门与同步都靠它。'))
  console.log('')
}

// ── 仓库家配置里的仓库根绝对路径对齐 ──────────────────────────────────────
// preset 插件行与 HMR root 是绝对路径，不同步它 = 别的机器上挂载行指向不存在的文件。
alignRepoPaths()

// ── 每个 profile 根写一份安装配置 ─────────────────────────────────────────
// 放在最后做：即使上面一个包都没变，配置文件也可能需要补（它是**新加的**机制，
// 已有的 profile 里根本没有）。把它挂在"文件有没有变"上会漏掉这种情况。
// ⚠ 两个家的 profile 都要写（与 copyTargets 同一条：只写 DSH_HOME 那个家时，
//   仓库自持的家拿不到配置，全靠 paths.js 兜底才没炸）。
const homeProfiles = []
{
  const seen = new Set()
  for (const home of [resolve(dshHome), join(repoRoot, '.dsh')]) {
    if (seen.has(home) || !existsSync(join(home, 'profiles'))) continue
    seen.add(home)
    for (const name of readdirSync(join(home, 'profiles'))) {
      if (existsSync(join(home, 'profiles', name, 'node_modules', '@lh'))) {
        homeProfiles.push({ label: name, dir: join(home, 'profiles', name) })
      }
    }
  }
}

if (homeProfiles.length > 0) {
  console.log('安装配置：')
  for (const { label, dir } of homeProfiles) {
    const r = writeInstallConfig(dir)
    const mark = r.written ? (dryRun ? '将写入' : green('已写入')) : dim('已是最新')
    console.log(`  ${label.padEnd(14)} ${INSTALL_CONFIG_FILENAME}  ${mark}  ${dim(r.reason)}`)
  }
  console.log('')
  console.log(dim('  它让 profile 里的副本能自己找到数据目录与工作区——否则要靠环境变量，'))
  console.log(dim('  而"忘了设环境变量"的后果是插件装载失败、dsh 完全起不来。'))
  console.log('')
}

console.log(
  `${dryRun ? '将' : '已'}写入 ${written} 个文件、清理 ${removed} 个残留${liveCount ? `；${liveCount} 个位置是活链，无需同步` : ''}。`,
)
if (backupCount > 0) {
  console.log(dim(`  覆盖/删除前的原件已备份 ${backupCount} 份：${backupRoot}`))
}
console.log('')
console.log('  验：' + green('node scripts/check-installed-copies.mjs'))
console.log(dim('  副本生效要重启 dsh（插件是启动时加载的）。'))
