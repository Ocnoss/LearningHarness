/**
 * 闸门：已安装副本 与 源码 是否一致（**防的是一整类静默失效**）。
 *
 * ═══ 为什么必须有这道闸门 ═══
 * pnpm 对 `file:` **目录**依赖的处理方式，和人的直觉相反：
 *
 *   - profile `node_modules/@lh/x` → **真实目录，是一份拷贝**（nodeLinker: hoisted）
 *   - 仓库根（改 workspace 之前）→ 软链到 `node_modules/.pnpm/@lh+x@file+.../…`，
 *     而**最后那一跳也是真实目录、也是拷贝**。看起来是软链，实际是快照。
 *
 * 于是"改了源码"之后有三种可能，而它们从外面看**一模一样**：
 *   1. 副本是旧的 → 离线测试跑的是旧代码（"测过了"是假的）
 *   2. 副本是旧的 → 生产跑的是旧代码（"改了没生效"）
 *   3. 副本是新的 → 真的生效了
 *
 * 这个坑已经咬过两次（FATAL #1 跨包导入；`paths.js` 新增后副本里根本没有这个文件，
 * 直接让 selftest-plugin 报 ERR_PACKAGE_PATH_NOT_EXPORTED）。
 * 两次都不是"写错了"，而是**改对了但没到位**——最难排查的一类。
 *
 * 2026-09-18 起仓库根改用 workspace 软链（`workspace:*` + pnpm-workspace.yaml），
 * 根这一层不再有副本；**profile 那一层仍然是拷贝，仍然是本闸门盯着的地方**。
 *
 * ═══ 它查什么 ═══
 * 每个插件的 `package.json` 必须声明 `files`（运行时会真正被加载的文件集）。
 * 然后：
 *   - 声明里的文件在**源码里**不存在 → 致命（声明与事实不符，同步会静默少拷）
 *   - 副本里**缺**声明中的文件 → 致命（`paths.js` 那次就是这种）
 *   - 内容**不同** → 致命（副本是旧版本）
 *   - 副本里多出声明之外的文件 → 警告（只是噪声，不会让人误判）
 *   - 目标是活链（软链回源码）→ 如实说"活链"并**不做比较**：
 *     拿源码跟它自己比永远是"一致"，报"一致"是假信号，比不报更坏。
 *
 * 为什么要求 `files` 而不能自动推断：推断不出来。`exports` 只列入口，
 * 真正被 import 的模块（如 `trace-reader.js`）不在里面；
 * 而"目录里所有文件"又会把测试和日志算进去。
 * **靠猜的闸门会漏，漏掉的闸门比没有闸门更坏。**
 * 顺带：`files` 正是 ADR-024 分发时要用的字段，所以这不是为闸门加的负担。
 *
 * 修法：`node scripts/sync-lh-deps.mjs`
 *
 * 运行：node scripts/check-installed-copies.mjs
 *       node scripts/check-installed-copies.mjs --root <目录>   （在别的目录上跑，供闸门自测用）
 *
 * ═══ 它自己怎么被验证 ═══
 * `node scripts/selftest-installed-copies.mjs` —— 在一个临时目录里造出
 * "副本缺文件 / 内容不同 / 缺 files 字段 / 声明了不存在的文件 / 有多余残留" 五种状态，
 * 逐条断言本闸门**红了**（或对良性情形**保持绿**）。
 * 一个从没见过红的闸门只是希望，不是保障；而"永远红的闸门"同样没用
 * （人会条件反射地忽略它），所以良性那一条也必须断言绿。
 */

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const scriptDir = dirname(fileURLToPath(import.meta.url))

/** `--root <目录>`：默认是仓库根；自测时指向一个临时造的假仓库。 */
const rootArgIndex = process.argv.indexOf('--root')
const repoRoot = rootArgIndex === -1
  ? resolve(scriptDir, '..')
  : resolve(process.argv[rootArgIndex + 1])

const pluginsDir = join(repoRoot, 'plugins')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')

/** 颜色的有无由终端决定；重定向到文件时不掺 ANSI 码（否则日志没法 grep）。 */
const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const red = (s) => c('31', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

const failures = []
const warnings = []

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 声明中的运行时文件集。
 *
 * 没有 `files` → 直接判致命。理由见文件头：
 * 与其猜一个可能漏的集合，不如要求把这件事写下来。
 */
function declaredRuntimeFiles(pkg, label) {
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    failures.push(`${label}: package.json 没有声明 "files" —— 无法判定"哪些文件是运行时必需的"，闸门拒绝猜。`)
    return null
  }
  const set = new Set(['package.json', ...pkg.files])
  return [...set].sort()
}

/** 收集已安装位置：仓库根 + 每个 profile。 */
function installTargets(shortName) {
  const out = []
  const rootCopy = join(repoRoot, 'node_modules', '@lh', shortName)
  if (existsSync(rootCopy)) out.push({ label: '仓库根', dir: rootCopy })

  const profilesDir = join(dshHome, 'profiles')
  if (existsSync(profilesDir)) {
    for (const entry of readdirSync(profilesDir)) {
      const dir = join(profilesDir, entry, 'node_modules', '@lh', shortName)
      if (existsSync(dir)) out.push({ label: `profile:${entry}`, dir })
    }
  }
  return out
}

// ── 主流程 ────────────────────────────────────────────────────────────────

const pluginDirs = readdirSync(pluginsDir).filter((n) => {
  const p = join(pluginsDir, n, 'package.json')
  return existsSync(p) && statSync(join(pluginsDir, n)).isDirectory()
})

let comparedPlaces = 0
let comparedFiles = 0

console.log(`比对 ${pluginDirs.length} 个插件 与 它们的已安装副本\n`)

for (const dirName of pluginDirs) {
  const srcDir = join(pluginsDir, dirName)
  const pkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'))
  const label = pkg.name ?? dirName
  const shortName = String(label).replace(/^@[^/]+\//, '')

  const runtimeFiles = declaredRuntimeFiles(pkg, label)
  if (!runtimeFiles) {
    // 必须**打印出来**：静默跳过会让"没声明 files"这件事只体现在最后的计数里，
    // 而计数对不上时人只会怀疑闸门坏了，不会想到是清单缺字段。
    console.log(`${label.padEnd(24)} ${red('无法判定')}  ${dim('package.json 缺 "files"，见下方失败项')}`)
    continue
  }

  // ── 检查 A：声明本身要成立（**与有没有安装位置无关**） ──
  //
  // 这一段必须放在"有没有副本"之前。原因：只按绝对路径加载的包（预设行那几个）
  // 根本没有副本，若把"声明文件是否存在"写在副本循环里，它们的 files 就**永远不会被验**——
  // 而 files 里写错一个文件名，后果是同步时静默地少拷一个文件。
  for (const rel of runtimeFiles) {
    if (!existsSync(join(srcDir, rel))) {
      console.log(`${label.padEnd(24)} ${red('声明与事实不符')}  files 里写了 ${rel}，但源码里没有`)
      failures.push(`${label}: package.json 的 files 声明了 ${rel}，但源码里不存在这个文件`)
    }
  }

  const targets = installTargets(shortName)
  if (targets.length === 0) {
    console.log(`${label.padEnd(24)} ${dim('没有已安装副本（只按绝对路径加载，不比对内容）')}`)
    continue
  }

  for (const t of targets) {
    comparedPlaces += 1

    // ── 活链：源码即本体 ──
    //
    // 仓库根现在是 workspace 软链（node_modules/@lh/x → plugins/lh-x）。
    // 这时**没有副本可比**：拿源码跟它自己比永远是"一致"，报"一致"是假信号；
    // 而把源码里本来就有的 selftest/trace.log 报成"副本残留"更是说反了。
    // 所以这里如实说"活链"，并且**不做比较**——不比较比假装比较过强。
    let isLive = false
    try {
      isLive = realpathSync(t.dir) === realpathSync(srcDir)
    } catch {
      isLive = false
    }
    if (isLive) {
      console.log(`${label.padEnd(24)} ${t.label.padEnd(14)} ${green('活链')}  ${dim('源码即本体，不存在陈旧问题')}`)
      continue
    }

    const problems = []

    for (const rel of runtimeFiles) {
      const src = join(srcDir, rel)
      const dst = join(t.dir, rel)
      comparedFiles += 1

      if (!existsSync(dst)) {
        problems.push(`致命  ${rel} —— 副本里缺失（源码 ${sha256(src).slice(0, 8)}）`)
        continue
      }
      const a = sha256(src)
      const b = sha256(dst)
      if (a !== b) problems.push(`致命  ${rel} —— 内容不同（源码 ${a.slice(0, 8)} / 副本 ${b.slice(0, 8)}）`)
    }

    // 噪声：副本里有、声明里没有的文件。不致失败，但要让人看见。
    const declared = new Set(runtimeFiles)
    const extras = readdirSync(t.dir).filter((f) => {
      try {
        return statSync(join(t.dir, f)).isFile() && !declared.has(f)
      } catch {
        return false
      }
    })
    if (extras.length) {
      warnings.push(`${label} @ ${t.label}: 副本里多出未声明的文件 ${extras.join(', ')}（多半是旧安装残留，重新同步即消失）`)
    }

    if (problems.length === 0) {
      console.log(`${label.padEnd(24)} ${t.label.padEnd(14)} ${green('一致')}  ${dim(`${runtimeFiles.length} 个文件`)}`)
    } else {
      console.log(`${label.padEnd(24)} ${t.label.padEnd(14)} ${red('不一致')}`)
      for (const p of problems) {
        console.log(`    ${red(p)}`)
        failures.push(`${label} @ ${t.label}: ${p.replace(/^致命\s+/, '')}`)
      }
    }
  }
}

console.log('')

if (warnings.length) {
  console.log(yellow(`══ 警告 ${warnings.length} 条 ══`))
  for (const w of warnings) console.log(`  ${yellow('!')} ${w}`)
  console.log('')
}

if (failures.length) {
  console.log(red(`══ 失败 ${failures.length} 条 ══`))
  console.log('')
  // 逐条重列。前面已经按行打印过，但那里是**按插件分组**的视角；
  // 这里给的是**可逐条勾掉**的清单——两处都打印，是因为排查时人找的是清单，不是表格。
  for (const f of failures) console.log(`  ${red('✗')} ${f}`)
  console.log('')
  console.log('  副本和源码不一致 —— 现在"测试跑过的"和"生产要跑的"不是同一份代码。')
  console.log('  修：' + green('node scripts/sync-lh-deps.mjs'))
  console.log('')
  process.exit(1)
}

console.log(green(`══ 全部一致。比对 ${comparedPlaces} 个安装位置、${comparedFiles} 个文件。 ══`))
console.log(dim('  仓库根是 workspace 活链；profile 是快照，改完源码要跑 node scripts/sync-lh-deps.mjs。'))
