/**
 * LH 开发守护：监听插件源码，变化后自动重启 dsh。
 *
 * ═══ 为什么需要它 ═══
 * 宿主 web profile 默认关掉了服务端 HMR（`dsh-web-app/cordis.patch.yml`:
 * "# TODO: Re-enable shared HMR for Web after its reload lifecycle is tested."）。
 * 我试过打开它并在 profile patch 里给出源码根，但**实测无效**：改插件文件后
 * 插件的 trace 里既没有 `DISPOSED` 也没有新的 `APPLY_CALLED`。
 * 对一个正在开发插件的项目，代价是每次改服务端代码都要手动重启——实测一天里十几次。
 *
 * 所以这里做一件**朴素但确定**的事：盯住源码，一变就重启。
 * 它比 HMR 慢几秒，但行为可预测——而"可预测"在开发循环里比"快"更重要，
 * 因为不可预测的重载会让我分不清"代码没生效"和"重载没发生"（这个坑已经踩过一次）。
 *
 * ═══ 用法 ═══
 *   node scripts/dev-watch.mjs            # 启动并守护（Ctrl+C 退出）
 *   node scripts/dev-watch.mjs --once     # 只启动，不监听（等同手动启动）
 *
 * 启动的是 **dev profile**（`$DSH_HOME/profiles/dev`），不是 web，
 * 这样它和你在 GUI 里用的那个实例互不干扰。dev profile 若不存在，本脚本会先创建。
 *
 * ═══ 为什么用 dev profile ═══
 * 自动重启会杀掉实例。若直接杀你在用的 web 实例，会话与前端连接都会断。
 * 用独立 profile 就没有这个冲突；代价是多占一个端口。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, watch } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = dirname(HERE)
const WATCH_DIR = join(WORKSPACE, 'plugins')
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const DEV_PROFILE = join(DSH_HOME, 'profiles', 'dev')
const PORT = process.env.LH_DEV_PORT ?? '3090'
const DSH_BIN = join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** 防抖：编辑器保存一个文件常触发多次事件。 */
const DEBOUNCE_MS = 700

/**
 * 确保 dev profile 存在，并把 LH 的插件行写进去。
 *
 * 它是 web profile 的副本思路：bundles 与 web 相同（这样界面行为一致），
 * 但插件行指向**工作区的插件源码**（相对 dev profile 目录用绝对路径）。
 *
 * @returns 无需返回值；目录与配置就位即可。
 */
function ensureDevProfile() {
  if (!existsSync(DEV_PROFILE)) mkdirSync(DEV_PROFILE, { recursive: true })

  const manifest = join(DEV_PROFILE, 'package.json')
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      `${JSON.stringify(
        {
          name: 'dsh-profile-dev',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  }

  // loader 需要一个 real include root 来锚定 baseUrl
  const root = join(DEV_PROFILE, 'cordis.yml')
  writeFileSync(root, '# dev profile root（由 dev-watch.mjs 维护，勿手改）\n[]\n', 'utf8')

  const patch = join(DEV_PROFILE, 'cordis.patch.yml')
  writeFileSync(
    patch,
    `# LH 开发 profile 的 patch 层（由 scripts/dev-watch.mjs 生成）
#
# 只加载**服务端**的 LH 插件行——开发后端逻辑时不需要客户端插件，
# 少一层依赖就少一处可能出错的地方（客户端插件要在 profile 里装包）。
# 需要在 dev profile 里看 LH 界面时，再按 web profile 的做法装上 @lh/theme。
#
# ⚠ 插件路径必须写成 file:// URL，不能写 Windows 绝对路径。
# 这是踩出来的：profile 的 cordis.patch.yml 与 preset 行**不是同一条解析路径**。
# preset 行里写绝对路径没问题（dsh-agent-presets 会转成 file: URL），
# 但 profile 行不会——写 'D:\\...' 会报
#   Only URLs with a scheme in: file, data, and node are supported...
#   Received protocol 'd:'
# 所以这里统一用 pathToFileURL() 生成。

- insert:
    - id: lh-event-store
      name: '${pathToFileURL(join(WORKSPACE, 'plugins', 'lh-event-store', 'index.js')).href}'

    - id: lh-recorder-trace
      name: '${pathToFileURL(join(WORKSPACE, 'plugins', 'lh-recorder-trace', 'index.js')).href}'

    - id: lh-resource-indexer
      name: '${pathToFileURL(join(WORKSPACE, 'plugins', 'lh-resource-indexer', 'index.js')).href}'

    - id: lh-model-tier
      name: '${pathToFileURL(join(WORKSPACE, 'plugins', 'lh-model-tier', 'index.js')).href}'
`,
    'utf8',
  )
}

/** 当前运行的子进程。 */
let child

/** 上次重启时间，用于防抖。 */
let lastRestart = 0

/**
 * 启动 dsh dev profile。
 *
 * @param reason - 记录到日志里的启动原因（首次启动 / 文件变化）。
 */
function start(reason) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 启动 dsh（${reason}）`)
  child = spawn(process.execPath, [DSH_BIN, '--profile', 'dev', '--port', PORT, '--no-open'], {
    stdio: 'inherit',
    env: process.env,
  })
  child.on('exit', (code, signal) => {
    // 被我们自己杀掉时不算意外；其余退出要报出来，否则守护会静默变成"什么都没在跑"
    if (signal === null && code !== 0) {
      console.log(`[dev-watch] dsh 退出，code=${code}`)
    }
  })
}

/**
 * 重启：先杀掉旧的，等它真的退出再起新的。
 *
 * 为什么等：不等就可能出现两个实例抢同一个端口，
 * 而"起了但没抢到端口"的表现是"改了代码没生效"——正是我们要避免的假象。
 *
 * @param reason - 原因描述。
 */
async function restart(reason) {
  if (child !== undefined && child.exitCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve)
      child.kill()
    })
  }
  start(reason)
}

ensureDevProfile()
console.log(`[dev-watch] 监听 ${WATCH_DIR}`)
console.log(`[dev-watch] dev profile：${DEV_PROFILE}`)
console.log(`[dev-watch] 端口 ${PORT}（与 GUI 用的 profile 分开，互不干扰）`)

if (process.argv.includes('--once')) {
  start('手动启动，未开启监听')
} else {
  start('首次启动')

  watch(WATCH_DIR, { recursive: true }, (_event, filename) => {
    if (filename !== null && !filename.endsWith('.js')) return
    const now = Date.now()
    if (now - lastRestart < DEBOUNCE_MS) return
    lastRestart = now
    void restart(`文件变化：${filename ?? '(未知)'}`)
  })

  console.log('[dev-watch] 已开启监听：改插件源码会自动重启（Ctrl+C 退出）')
}

// Ctrl+C：把子进程一起带走，不留孤儿占着端口
process.on('SIGINT', () => {
  if (child !== undefined && child.exitCode === null) child.kill()
  process.exit(0)
})
