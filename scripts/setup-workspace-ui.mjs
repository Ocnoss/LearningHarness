/**
 * 把新建的 LH 界面插件装进 profile 并做离线自检。
 *
 * ═══ 为什么需要这个脚本（而不是"敲两条命令就行"）═══
 * 新增一个**此前不存在**的插件包，和"改一个已装的插件的源码"是两件不同的事：
 *
 *   1. **profile 的行挂的是 `file:` 依赖，但 `pnpm install` 不会"顺手"更新它们**
 *      （规格没变 → "Already up to date"）。所以必须先在 profile 的 `package.json`
 *      里声明，pnpm 才会把它放进来。本脚本负责**核对这一步已经做了**，而不是替它做——
 *      改 profile 的 `package.json` 是显式动作，不该藏在脚本里。
 *   2. **装完之后副本是"快照不是软链"**，源码改了副本不动 → 必须再跑一次
 *      `scripts/sync-lh-deps.mjs`，否则"测过的"和"要跑的"不是同一份代码。
 *   3. **最贵的失败形状是"改完没生效"**，而它和"改了但没重启"看起来一模一样。
 *      所以这里在装完后**立刻用 profile 的解析上下文 import 一次服务端半**——
 *      那才是"本应拦住 lh-practice 那次事故"的检查（见 cordis.patch.yml 里的记录）。
 *
 * ═══ 它不做什么 ═══
 * 不跑 pnpm、不动宿主的依赖树、不写 profile 的 package.json。
 * 它只**核对 + 报告 + 在 shell 可用时**给出（并可选执行）下一步命令。
 *
 * 用法：
 *   node scripts/setup-workspace-ui.mjs              # 只核对与自检，不改任何东西
 *   node scripts/setup-workspace-ui.mjs --install    # 核对通过后，执行 pnpm install + 同步 + 复验
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PKG_DIR = join(REPO, 'plugins', 'lh-workspace-ui')
const PKG_NAME = '@lh/workspace-ui'
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')

/**
 * 要核对/安装的 profile 名。
 *
 * ═══ 为什么它可以是 desktop（2026-10-01 改）═══
 * 原来这里写死 `profiles/web`。实测（`Get-CimInstance Win32_Process` 的 Electron 命令行）：
 * 作者日常用的那个 GUI 是 **desktop 宿主**，它的 profile 目录是
 * `C:\Users\Administrator\.dsh\profiles\desktop`。
 * 也就是说：装进 `profiles/web` 的界面插件，**作者在自己的应用里永远看不到**。
 * 这不是"装错了"，是"装到了一个没人在看的面上"——而它的症状恰好是
 * "改了没生效"，与"忘了重启"一模一样（本项目记为最贵的失败形状）。
 *
 * 所以 profile 变成参数：默认仍是 web（既有习惯），但可以点名 desktop。
 *   node scripts/setup-workspace-ui.mjs --profile desktop
 */
const profileArgIndex = process.argv.indexOf('--profile')
const PROFILE_NAME = profileArgIndex === -1 ? 'web' : (process.argv[profileArgIndex + 1] ?? 'web')
const PROFILE = join(DSH_HOME, 'profiles', PROFILE_NAME)

console.log(`profile = ${PROFILE}\n`)

const doInstall = process.argv.includes('--install')

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const red = (s) => c('31', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

let problems = 0
/**
 * 报告一条检查结果。
 * @param ok - 是否通过。
 * @param label - 检查项。
 * @param detail - 补充说明。
 * @param fatal - 不通过时是否算致命（默认算）。
 */
function check(ok, label, detail = '', fatal = true) {
  console.log(`  ${ok ? green('✓') : fatal ? red('✗') : yellow('!')} ${label}${detail === '' ? '' : `  ${dim(detail)}`}`)
  if (!ok && fatal) problems += 1
  return ok
}

console.log('══ 0. 源码侧（这些不依赖 shell）══\n')

check(existsSync(join(PKG_DIR, 'package.json')), 'plugins/lh-workspace-ui/package.json 存在')
check(existsSync(join(PKG_DIR, 'index.js')), '服务端半 index.js 存在')
check(existsSync(join(PKG_DIR, 'client.js')), '客户端半 client.js 存在')

let pkg = null
try {
  pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
} catch (error) {
  check(false, 'package.json 可解析', String(error?.message ?? error))
}

if (pkg !== null) {
  check(pkg.name === PKG_NAME, `包名是 ${PKG_NAME}`, `实际 ${JSON.stringify(pkg.name)}`)
  check(pkg.exports?.['./client'] !== undefined, 'exports 含 "./client"（缺了客户端半不被发现）')
  check(pkg.exports?.['./package.json'] !== undefined, 'exports 含 "./package.json"')
  check(pkg.dsh?.client !== undefined, '声明了 dsh.client')
  const files = Array.isArray(pkg.files) ? pkg.files : []
  for (const needed of ['index.js', 'client.js']) {
    check(files.includes(needed), `files 含 ${needed}（缺了副本里不会有它，下次重启才炸）`)
  }
  // 每个 files 里声明的文件都必须真实存在
  for (const f of files) {
    check(existsSync(join(PKG_DIR, f)), `files 声明的 ${f} 真实存在`)
  }
  check(Array.isArray(pkg.lh?.inject), 'lh.inject 是数组')
  check(Array.isArray(pkg.lh?.depends_on), 'lh.depends_on 是数组')
  check(pkg.lh?.loads_at === 'profile', 'lh.loads_at = profile')
}

console.log('\n══ 1. profile 侧（装载入口）══\n')

const profilePkgPath = join(PROFILE, 'package.json')
let profilePkg = null
try {
  profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
} catch (error) {
  check(false, 'profile 的 package.json 可读', `${profilePkgPath} — ${error?.message ?? error}`)
}

if (profilePkg !== null) {
  const deps = profilePkg.dependencies ?? {}
  check(deps[PKG_NAME] !== undefined, `profile 的 dependencies 已声明 ${PKG_NAME}`, String(deps[PKG_NAME] ?? '(缺失)'))
}

const patchPath = join(PROFILE, 'cordis.patch.yml')
try {
  const patch = readFileSync(patchPath, 'utf8')
  check(/id:\s*lh-workspace-ui/.test(patch), 'cordis.patch.yml 有 lh-workspace-ui 的 insert 行')
  check(/name:\s*'@lh\/workspace-ui'/.test(patch), "cordis.patch.yml 的行 name 是 '@lh/workspace-ui'")
} catch (error) {
  check(false, 'cordis.patch.yml 可读', String(error?.message ?? error))
}

const installedDir = join(PROFILE, 'node_modules', '@lh', 'workspace-ui')
const isInstalled = existsSync(installedDir)
check(isInstalled, `已装进 profile：${installedDir}`, isInstalled ? '' : '（首次安装前这是预期的）', false)

console.log('\n══ 2. 是否能在 profile 的解析上下文里 import ══\n')

if (!isInstalled) {
  console.log(`  ${yellow('!')} 还没装，跳过这步。它才是"本应拦住那次 dsh 起不来"的检查。`)
} else {
  const entry = join(installedDir, 'index.js')
  try {
    await import(pathToFileURL(entry).href)
    check(true, '服务端半可从 profile 解析并执行')
  } catch (error) {
    check(false, '服务端半可从 profile 解析并执行', String(error?.message ?? error))
  }
}

console.log('\n══ 3. 下一步 ══\n')

if (problems > 0) {
  console.log(red(`  ${problems} 项致命问题未通过，先修它们。`))
  process.exit(1)
}

if (!isInstalled) {
  console.log('  源码与装载入口都就位，缺的是**一次安装**（需要可用的 shell）：')
  console.log('')
  // 用 --dir 而不是 cd：profile 自带 pnpm-workspace.yaml（packages: ['.']，nodeLinker: hoisted），
  // 是它自己的 workspace 根，所以 --dir 指向它就等价于在它里面 install。
  console.log(`    pnpm --dir "${PROFILE}" install`)
  console.log('    node scripts/sync-lh-deps.mjs')
  console.log(`    node scripts/setup-workspace-ui.mjs        ${dim('# 复核：应变成"已装进 profile"')}`)
  console.log('')
  console.log('  然后重启 dsh，看侧栏是否多出一个 📚 图标。')
  console.log('')
  if (doInstall) {
    console.log(dim('  --install 已给出，正在执行……'))
    try {
      execFileSync('pnpm', ['--dir', PROFILE, 'install'], { stdio: 'inherit' })
      execFileSync(process.execPath, [join(REPO, 'scripts', 'sync-lh-deps.mjs')], { stdio: 'inherit' })
      console.log(green('\n  安装与同步完成。请重跑本脚本复核，然后重启 dsh。'))
    } catch (error) {
      console.log(red(`\n  执行失败：${error?.message ?? error}`))
      process.exit(1)
    }
  } else {
    console.log(dim('  （加 --install 可让本脚本代跑上面两条命令）'))
  }
} else {
  console.log(green('  已安装且可解析。'))
  console.log('  若刚改过源码，记得再跑一次：node scripts/sync-lh-deps.mjs')
  console.log('  然后重启 dsh 看生效。')
}
