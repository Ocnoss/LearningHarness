/**
 * 探针：**浏览器实际拿到的是哪一份客户端 bundle？**
 *
 * ═══ 为什么需要这个（不是好奇，是被坑过）═══
 * 客户端半的改法有一个特别的坑：**改了源码 → 浏览器里没变化**。
 * 这条链上有三个可能断的地方，而它们从外面看完全一样：
 *
 *   1. 源码改了但没同步到 profile → 副本是旧的（`check-installed-copies.mjs` 管这个）
 *   2. 同步了，但宿主**按启动时算好的清单**投放 bundle，于是要重启 / 硬刷新
 *   3. 都对，但浏览器缓存了旧文件
 *
 * 出问题时人只会看到"界面没变化"，然后开始猜。
 * 这个探针直接回答"**服务端此刻端出来的是哪一份**"——
 * 把第 1、2 条从猜测变成读数，剩下的就只有浏览器缓存了。
 *
 * ⚠ 它**需要 dsh 正在运行**，所以刻意不叫 `check-*`：
 *   `scripts/check-all.mjs` 会自动收 `check-*` 的文件，
 *   混进去会让整套闸门在"dsh 没开"时整体变红——那是假红。
 *
 * 运行：node scripts/probe-served-client.mjs
 *       node scripts/probe-served-client.mjs --url http://127.0.0.1:3080/
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')

const urlIndex = process.argv.indexOf('--url')
const base = urlIndex === -1 ? 'http://127.0.0.1:3080/' : process.argv[urlIndex + 1]

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const green = (s) => c('32', s)
const red = (s) => c('31', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

const PLUGIN_ID = '@lh/practice'

/** 源码里的 client.js 的 hash —— 作为"应该是哪一份"的基准。 */
const sourcePath = join(repoRoot, 'plugins', 'lh-practice', 'client.js')
const sourceHash = existsSync(sourcePath)
  ? createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
  : null

console.log(`探针：向 ${base} 要客户端 bundle\n`)
if (sourceHash === null) {
  console.log(red(`✗ 源码不存在：${sourcePath}`))
  process.exit(1)
}
console.log(`源码 client.js  sha256=${sourceHash.slice(0, 12)}`)

// ── 1. 首页：宿主怎么投放客户端插件？ ─────────────────────────────────────
//
// 不看它的实现，只看它**端出来的 HTML**里提到了什么——那是浏览器真正看到的东西。

let html = ''
try {
  const res = await fetch(base, { headers: { accept: 'text/html' } })
  html = await res.text()
  console.log(`首页 HTTP ${res.status}，${html.length} 字节`)
} catch (error) {
  console.log(red(`✗ 取不到首页：${error?.message ?? error}`))
  console.log(dim('  dsh 在跑吗？这个探针需要宿主正在运行。'))
  process.exit(2)
}

const mentions = (needle) => html.includes(needle)
console.log('')
console.log('首页里是否提到我们的插件：')
console.log(`  ${mentions(PLUGIN_ID) ? green('有') : yellow('没有')}  ${PLUGIN_ID}`)
const bundleUrls = [...html.matchAll(/["'`]([^"'`]*client\.js[^"'`]*)["'`]/g)].map((m) => m[1])
const ourUrls = bundleUrls.filter((u) => u.includes('practice'))
console.log(`  页面里共 ${bundleUrls.length} 个 client.js 引用，其中与 practice 相关的 ${ourUrls.length} 个`)
for (const u of ourUrls) console.log(`    ${dim(u)}`)

// ── 2. 直接按约定路径取 bundle ────────────────────────────────────────────
//
// 宿主按 `<id>/client.js` 投放（见 ARCHITECTURE 的"客户端 bundle 投放是白拿的"）。
// 先试首页里出现的 URL；没有再按约定拼。

const candidates = new Set(ourUrls.map((u) => new URL(u, base).href))
for (const guess of [
  `plugins/${PLUGIN_ID}/client.js`,
  `plugins/${encodeURIComponent(PLUGIN_ID)}/client.js`,
]) {
  candidates.add(new URL(guess, base).href)
}

let found = null
for (const href of candidates) {
  try {
    const res = await fetch(href)
    const text = await res.text()
    const isJs = (res.headers.get('content-type') ?? '').includes('javascript') || text.includes('__ModuleLoader__')
    console.log('')
    console.log(`${res.status === 200 && isJs ? green('✓') : yellow('·')} ${href}`)
    console.log(`    HTTP ${res.status}  ${text.length} 字节  content-type=${res.headers.get('content-type') ?? '-'}`)
    if (res.status === 200 && text.includes('tool.call.toolview')) {
      found = { href, text }
      console.log(`    ${green('含 tool.call.toolview —— 这是我们改过的标记')}`)
      break
    } else if (res.status === 200 && isJs) {
      console.log(`    ${yellow('是 JS，但没有 tool.call.toolview —— 这多半是旧的那一份')}`)
      found = found ?? { href, text }
    }
  } catch (error) {
    console.log(`    ${red('取不到')} ${href} — ${error?.message ?? error}`)
  }
}

// ── 3. 结论 ───────────────────────────────────────────────────────────────

console.log('')
if (found === null) {
  console.log(red('✗ 没能取到客户端 bundle —— 无法判断浏览器拿到的是哪一份。'))
  console.log(dim('  可能：路由约定不是 <id>/client.js；或该插件没在 boot 清单里。'))
  process.exit(1)
}

const served = found.text
const servedHash = createHash('sha256').update(served).digest('hex')
console.log(`端出来的 bundle  sha256=${servedHash.slice(0, 12)}`)

if (servedHash === sourceHash) {
  console.log(green('✓ 端出来的就是源码那一份（逐字节一致）'))
} else if (served.includes('tool.call.toolview')) {
  console.log(yellow('⚠ 和源码不完全一致，但**含新标记** —— 通常是宿主包装过（如加了 sourcemap 注释）'))
} else {
  console.log(red('✗ 端出来的是**旧的那一份** —— 刷新浏览器不会看到卡片。'))
  console.log(dim('  修：node scripts/sync-lh-deps.mjs，然后重启 dsh；'))
  console.log(dim('      若宿主在启动时把 bundle 内容读进了内存，还需要一次重启才换得掉。'))
  process.exit(1)
}

console.log('')
console.log(dim('  若这份是对的、浏览器里却仍是旧行为：那是浏览器缓存 —— 硬刷新（Ctrl+Shift+R）。'))
