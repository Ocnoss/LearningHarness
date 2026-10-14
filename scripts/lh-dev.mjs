/**
 * LH 的开发启动器 —— **把 dsh 的家指到工作区里**，于是这个仓库自持。
 *
 * ═══ 它解决什么（作者 2026-09-20 的目标）═══
 * 原来开发 LH 要同时依赖两个地方：
 *   · `~/.dsh`（会话、缓存、agent preset、profile 里的插件副本）；
 *   · `D:\LearningHarnessv0.1`（项目文件）。
 * 于是"开发"这件事被绑在"频繁唤起 dsh"上，换个 IDE/CLI 打开工作区就做不全。
 *
 * 现在：**一个环境变量就够。** dsh 的家由 `DSH_HOME` 决定（`[宿主源码]`
 * `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome`：显式配置 > `$DSH_HOME` > `~/.dsh`），
 * 而 agent preset、profile、会话、凭据、技能**全都挂在那个根下面**。
 * 本脚本把 `DSH_HOME` 指到 `<仓库>/.dsh/`，于是：
 *   · 用任何 IDE/CLI 打开这个仓库，`node scripts/lh-dev.mjs` 就能起一套**属于这个项目**的 dsh；
 *   · 闸门与脚本走同一个家（`scripts/lib/dsh-home.mjs` 也是同一优先级）；
 *   · 换机器/换目录不用重新配，跟着仓库走。
 *
 * ═══ 两个家可以并存，而且必须能分辨 ═══
 * 老的 `~/.dsh` **不动**（它是备份，也是"万一新家坏了"的退路）。
 * 但"两个家并存"最危险的状态是**脚本 A 看新家、脚本 B 看旧家，而两边都给出结果**。
 * 所以：本脚本打印家的位置，各闸门也打印（见 `lib/dsh-home.mjs` 的 `describeHome`）。
 *
 * ═══ 它是「旧机制开发器」，不是 app 的等价物（2026-10-13 定位修正）═══
 * 本脚本解析的是 npm 全局 `@deepseek-ai/dsh`（旧机制：扫 `.agent-presets/` 目录）。
 * 而作者日常用的 app 是 `dsh-desktop-runtime` 0.2.0-rc.2（新机制：bundle +
 * declaration row，**不读 `.agent-presets/`**）——两者不是同一个实现。
 * **这里跑通 ≠ app 里也跑通**：2026-09-22 起 5 个插件在 app 里静默瘫痪时，
 * 这套开发器与它的闸门一路全绿。app 侧的等价检查是 `check-bundle.mjs`，
 * 功能复活走 bundle 安装（见 `bundle/README.md`）。别再拿它当 app 的等价物。
 *
 * ═══ 用法 ═══
 *   node scripts/lh-dev.mjs                     # 起 web（默认端口）
 *   node scripts/lh-dev.mjs --port 3099         # 换端口
 *   node scripts/lh-dev.mjs -- --no-open        # `--` 之后的参数原样交给 web 应用
 *   node scripts/lh-dev.mjs --print-home        # 只打印"家在哪儿"，不起进程
 *
 * ⚠ 启动器**只设环境变量、只转发参数**：它不解析 dsh 的 flag、不猜 profile 名、
 *   不改 dsh 的代码。所有"怎么启动"的判断仍在 dsh 自己那里（少一处会漂移的知识）。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/** 本项目自己的家：仓库里的 `.dsh/`。 */
const home = join(repoRoot, '.dsh')

if (argv.includes('--print-home')) {
  console.log(home)
  process.exit(0)
}

// ── `--doctor`：**检查这个家该有的东西在不在** ──────────────────────────────
//
// 为什么要有它：迁移之后的第一个问题永远是"新家里缺了什么"，
// 而缺东西的形态是"某次启动表现怪异"（比如没有 provider、没有默认模型），
// 不是一句明确的报错。与其让人记住要检查什么，不如让脚本自己说。
if (argv.includes('--doctor')) {
  const rows = [
    ['.agent-presets/lh/agent.cordis.yml', 'LH 的 preset（插件挂载点）'],
    ['profiles/web/package.json', 'web profile 的清单'],
    ['profiles/web/cordis.patch.yml', 'web profile 的 patch 层（LH 客户端插件行在这）'],
    ['profiles/web/lh-install.json', '插件定位数据目录的依据（sync 生成）'],
    ['profiles/web/node_modules/@lh', '插件安装副本（pnpm install 生成）'],
    ['settings.yaml', 'provider 与默认模型（缺则由 dsh 生成一份**默认的**）'],
    ['.credentials.yaml', '凭据（**刻意不随仓库**：密钥在环境变量里）'],
  ]
  console.log(`lh-dev doctor: DSH_HOME = ${home}\n`)
  console.log('⚠ 这是【旧机制】开发器：解析 npm 全局 @deepseek-ai/dsh，扫 .agent-presets/ 目录。')
  console.log('  不是 app（dsh-desktop-runtime 0.2.0-rc.2，bundle + declaration）的等价物：')
  console.log('  这里全绿不代表 app 里没问题。app 侧请跑 node scripts/check-bundle.mjs。\n')
  let missing = 0
  for (const [rel, why] of rows) {
    const p = join(home, rel)
    const ok = existsSync(p)
    const optional = rel === '.credentials.yaml'
    if (!ok && !optional) missing += 1
    const mark = ok ? '✓' : optional ? '·' : '✗'
    console.log(`  ${mark} ${rel.padEnd(44)} ${why}`)
  }
  console.log('')
  if (missing > 0) {
    console.log(`缺 ${missing} 项必需的东西。两种修法：`)
    console.log('  · 从旧家复制：把 ~/.dsh 的 .agent-presets/lh 与 profiles/web 的配置文件拷进来（session/attachments 不必）')
    console.log('  · 或重建：在 profiles/web 里 pnpm install，再跑 node scripts/sync-lh-deps.mjs')
    process.exit(1)
  }
  console.log('这个家该有的都在。（凭据刻意不在：密钥由启动 dsh 的进程经环境变量提供）')
  process.exit(0)
}

// ── `--` 之后的参数原样转发；之前的是启动器自己的参数 ──────────────────────
const sep = argv.indexOf('--')
const own = sep === -1 ? argv : argv.slice(0, sep)
const forwarded = sep === -1 ? [] : argv.slice(sep + 1)

const profileIndex = own.indexOf('--profile')
const profile = profileIndex === -1 ? 'web' : (own[profileIndex + 1] ?? 'web')

/**
 * 找 dsh 的可执行入口。
 *
 * 顺序：仓库自己的 node_modules（若将来把 dsh 装成本项目依赖）→ 全局 npm 根。
 * **找不到就明确报错并给修法**，不猜、不静默退回另一个家。
 *
 * @returns `{ command, args }`。
 */
function resolveDsh() {
  const require = createRequire(import.meta.url)
  try {
    // 全局装的是 `@deepseek-ai/dsh`，其 bin 在 lib/bin.js（实测）。
    const pkgJson = require.resolve('@deepseek-ai/dsh/package.json', {
      paths: [repoRoot, join(process.env.APPDATA ?? '', 'npm', 'node_modules')],
    })
    const entry = join(dirname(pkgJson), 'lib', 'bin.js')
    if (existsSync(entry)) return { command: process.execPath, args: [entry] }
  } catch {
    /* 落到下面的报错 */
  }
  return null
}

const dsh = resolveDsh()
if (dsh === null) {
  console.error('找不到 @deepseek-ai/dsh。三种修法：')
  console.error('  1. 全局安装：npm i -g @deepseek-ai/dsh')
  console.error('  2. 装到本项目：pnpm add -D @deepseek-ai/dsh')
  console.error('  3. 用 npx：npx @deepseek-ai/dsh --profile web')
  process.exit(2)
}

console.log(`lh-dev: DSH_HOME = ${home}`)
console.log(`lh-dev: profile = ${profile}${forwarded.length > 0 ? `，转发参数：${forwarded.join(' ')}` : ''}`)
console.log(`lh-dev: 没有的文件会由 dsh 自己按需初始化；凭据仍然来自环境变量（见 docs/decisions/031）`)

const child = spawn(dsh.command, [...dsh.args, '--profile', profile, ...own.filter((a) => !a.startsWith('--profile')), ...forwarded], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home },
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 0) : 1)
})
