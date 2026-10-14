/**
 * 一条命令跑完所有闸门与自测。
 *
 * ═══ 为什么需要它（不是"图方便"）═══
 * 这一天的实测：我手工跑了三轮"所有 check-* + 所有 selftest"，
 * 而每轮都要现打一段 PowerShell 循环。这有两个具体代价：
 *
 * 1. **会漏**。第三次跑的时候我只跑了 check-* 忘跑 selftest，
 *    直到下一轮才发现 —— 而"漏跑一道闸门"从结果上看和"那道闸门绿了"一样。
 * 2. **看不出该不该红**。有几道闸门**本来就该红**（如 check-restart：
 *    它红的意思是"需要重启 dsh"，那是学习者的动作，不是脚本出错）。
 *    手工跑的时候得靠人记住哪些红是正常的；记错一次就会去"修"一个正常状态。
 *
 * 所以这里做两件事：**固定清单** + **区分"该红"与"不该红"**。
 * 清单写在文件里，不在某个人的记忆里。
 *
 * 运行：node scripts/check-all.mjs
 *       node scripts/check-all.mjs --quiet     （只打印汇总）
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const quiet = process.argv.includes('--quiet')

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const red = (s) => c('31', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

/**
 * **预期会红**的闸门。
 *
 * 为什么要把这件事写进代码而不是靠人记：
 * `check-restart` 红 = "当前 dsh 进程启动于最新改动之前，需要重启"。
 * 那是**学习者的动作**，AI 修不了，也不该去"修"。
 * 若不写明，每次跑完都会有人（包括我）把它当成失败去追——
 * 而一次这样的追查就可能顺手改坏一个正常状态。
 */
const EXPECTED_RED = new Map([
  ['check-restart.mjs', '需要重启 dsh（学习者的动作，不是脚本出错）'],
])

/** 列出目录下匹配前缀的 .mjs（**递归**：自测散落在各插件目录里）。 */
function discover(dir, predicate, depth = 0) {
  if (!existsSync(dir) || depth > 3) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // 不往 node_modules 里走：那里是副本，跑它们的测试没有意义且会重复。
      if (entry.name === 'node_modules') continue
      out.push(...discover(full, predicate, depth + 1))
    } else if (entry.name.endsWith('.mjs') && predicate(entry.name, full)) {
      out.push(full)
    }
  }
  return out
}

const SELF = fileURLToPath(import.meta.url)

// ⚠⚠ 必须排除本文件自己，并且**再加一道递归闸**（2026-09-18 事故）⚠⚠
//
// 实测踩过，代价约 40 分钟整机卡死 + dsh 崩溃：
// `check-all.mjs` 以 `check-` 开头，于是它把自己也当成一道闸门去跑。
// 而它每跑一道闸门就 `spawnSync` 一次，于是：
//
//     每层扇出 ≈10 个子进程，其中一个是它自己 → **指数级**
//
// 两分钟内生出 752 个 node 进程，把 CPU / 内存 / 进程槽吃满；
// 更糟的是**第一层被超时杀掉之后，孤儿后代还在继续繁殖**——
// 超时杀掉的是父进程，不是那棵树。整机因此卡了约 40 分钟，
// 连 dsh 自己申请子进程输出缓冲都失败（ENOENT，临时目录取不到）而崩掉。
//
// 所以这里有两道防线，**不是一道**：
//   1. 清单里排除自己（按**路径**，不按名字）；
//   2. 环境变量标记：发现自己是在 `check-all` 里被调用的，就**直接拒绝运行**。
//      第 2 条才是真正兜住的那道——将来若有人改了命名规则，第 1 条会失效，
//      而第 2 条仍能让爆炸停在第一层（而不是 10^n 层）。
if (process.env.LH_CHECK_ALL_DEPTH !== undefined) {
  console.error(
    'check-all: 已经在 check-all 里运行了，拒绝嵌套执行。\n' +
      '  （防的是 2026-09-18 那次自我递归：每层扇出 10 个子进程，两分钟生出 752 个 node 进程，\n' +
      '    整机卡死约 40 分钟，dsh 因临时目录取不到而崩溃。）\n' +
      '  若是误报：用独立命令跑单个闸门，例如 node scripts/check-plugin-imports.mjs',
  )
  process.exit(2)
}

const gates = discover(scriptDir, (n, full) => n.startsWith('check-') && full !== SELF).sort()
const selftests = [
  ...discover(scriptDir, (n) => n.startsWith('selftest-')),
  ...discover(join(repoRoot, 'plugins'), (n) => n.startsWith('selftest')),
].sort()

/** 单道闸门/自测的超时上限。**必须有**，理由见下面 run() 的注释。 */
const CHILD_TIMEOUT_MS = 90_000

/** 跑一个脚本，返回 `{ ok, code, out, timedOut }`。 */
function run(file) {
  const r = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    cwd: repoRoot,
    // 硬超时：一道卡住的闸门最多是"这道没结果"，
    // **不能是"整台机器卡住"**（2026-09-18 那次就是被卡住的子进程拖垮的）。
    timeout: CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    // 刻意**清掉** LH_* 环境变量：闸门要验的正是"不靠环境变量也能工作"。
    // 若开发者的 shell 里恰好设了它们，闸门会假绿——那是最坏的一种绿。
    //
    // 但要**放回**递归标记：否则子进程里的 check-all 会以为自己是第一层，
    // 递归闸就形同虚设（这个细节很容易漏，因为它被上面那行"清掉"顺手清掉了）。
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LH_'))),
      LH_CHECK_ALL_DEPTH: String(Number(process.env.LH_CHECK_ALL_DEPTH ?? 0) + 1),
    },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return {
    ok: r.status === 0,
    code: r.status,
    out,
    timedOut: r.error?.code === 'ETIMEDOUT' || (r.signal === 'SIGKILL' && r.status === null),
  }
}

/** 从一个自测的输出里挑出它的结果行（各脚本格式不一，抓"结果"或最后一行非空）。 */
function resultLine(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const hit = lines.find((l) => /结果：|全部通过|全部一致|通过 \/ /.test(l))
  return hit ?? lines[lines.length - 1] ?? ''
}

const rows = []
let hardFailures = 0

// ── 验证对象横幅（2026-10-13 闸门失真修复）────────────────────────────────
//
// 为什么必须钉在每次输出的第一屏：这些闸门经 `lh-dev.mjs` 的 `resolveDsh()`
// 解析到 **npm 全局 `@deepseek-ai/dsh`**（旧机制：扫 `.agent-presets/` 目录），
// 而 app 实际跑的是 `dsh-desktop-runtime` 0.2.0-rc.2（新机制：bundle +
// declaration row，**不再读 `.agent-presets/`**）。两侧不是同一个实现。
//
// 2026-09-22 起 5 个插件静默瘫痪的那段时间，本闸门一路全绿——
// 因为它验的旧机制确实没问题，出问题的是没人验的新机制（假绿）。
// 横幅不能修复失真，但能让"绿"**带着对象标签**被读，不再被当成"app 没事"。
function describeDshTarget() {
  const require = createRequire(import.meta.url)
  try {
    const pkgJson = require.resolve('@deepseek-ai/dsh/package.json', {
      paths: [repoRoot, join(process.env.APPDATA ?? '', 'npm', 'node_modules')],
    })
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
    return { dir: dirname(pkgJson), version: pkg.version ?? '未知' }
  } catch {
    return null
  }
}

const dshTarget = describeDshTarget()
console.log(yellow('╔══ 验证对象 ════════════════════════════════════════════════════════'))
if (dshTarget !== null) {
  console.log(yellow('║ ') + `dsh 实现：npm 全局 @deepseek-ai/dsh ${dshTarget.version}`)
  console.log(yellow('║ ') + `路径：${dshTarget.dir}`)
} else {
  console.log(yellow('║ ') + '未解析到 @deepseek-ai/dsh（下面各闸门会逐项报错）')
}
console.log(yellow('║ ') + red('⚠ 本闸门只验证旧 .agent-presets/ preset 机制，不代表 app'))
console.log(yellow('║ ') + red('  （dsh-desktop-runtime 0.2.0-rc.2，bundle + declaration）的状态。'))
console.log(yellow('║ ') + '新机制的等价闸门：node scripts/check-bundle.mjs（也并入本清单）')
console.log(yellow('╚══════════════════════════════════════════════════════════════════'))
console.log('')

console.log(`跑 ${gates.length} 道闸门 + ${selftests.length} 个自测（已清掉 LH_* 环境变量）\n`)

for (const file of gates) {
  const r = run(file)
  const name = basename(file)
  const expectedRed = EXPECTED_RED.get(name)
  let verdict
  if (r.ok) verdict = 'PASS'
  else if (r.timedOut) { verdict = 'TIMEOUT'; hardFailures += 1 }
  else if (expectedRed !== undefined) verdict = 'RED(应然)'
  else { verdict = `FAIL(${r.code})`; hardFailures += 1 }

  rows.push({ kind: '闸门', name, verdict, note: r.ok ? '' : (r.timedOut ? `超过 ${CHILD_TIMEOUT_MS / 1000}s` : (expectedRed ?? '')) })
  if (!quiet) {
    const paint = r.ok ? green : (expectedRed !== undefined && !r.timedOut) ? yellow : red
    console.log(`${paint(verdict.padEnd(11))} ${name}`)
    if (r.timedOut) {
      console.log(`            ${red(`超过 ${CHILD_TIMEOUT_MS / 1000}s 被强杀 —— 卡住的闸门要单独查，`)}`)
      console.log(`            ${red('尤其看它有没有 spawn 出不受控的子进程（那是把整机拖垮的形态）')}`)
    }
    if (expectedRed !== undefined && !r.ok && !r.timedOut) console.log(`            ${dim(expectedRed)}`)
  }
}

for (const file of selftests) {
  const r = run(file)
  const name = file.replace(`${repoRoot}\\`, '')
  if (!r.ok) hardFailures += 1
  rows.push({ kind: '自测', name, verdict: r.ok ? 'PASS' : (r.timedOut ? 'TIMEOUT' : `FAIL(${r.code})`), note: '' })
  if (!quiet) {
    const paint = r.ok ? green : red
    console.log(`${paint((r.ok ? 'PASS' : (r.timedOut ? 'TIMEOUT' : 'FAIL')).padEnd(11))} ${name}  ${dim(resultLine(r.out))}`)
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────

const failed = rows.filter((r) => r.verdict.startsWith('FAIL'))
const expectedReds = rows.filter((r) => r.verdict === 'RED(应然)')

console.log('')
console.log(`共 ${rows.length} 项：${rows.length - failed.length - expectedReds.length} 绿，` +
  `${expectedReds.length} 项应然红，${failed.length} 项不该红`)

if (expectedReds.length) {
  console.log('')
  console.log(yellow('应然红（不是失败）：'))
  for (const r of expectedReds) console.log(`  ${yellow('·')} ${r.name} — ${r.note}`)
}

console.log('')
if (hardFailures > 0) {
  console.log(red(`══ ${hardFailures} 项失败 ══`))
  for (const r of failed) console.log(`  ${red('✗')} ${r.name}`)
  console.log('')
  console.log(dim('  逐项复跑：node ' + (failed[0]?.name ?? '<脚本>')))
  process.exit(1)
}

console.log(green('══ 全绿（应然红的那几项除外） ══'))
console.log(dim('  闸门证明的是"能加载 / 不抛错 / 声明齐全 / 副本是新的 / 路径一致"。'))
console.log(dim('  它不能证明宿主真的会这样调度，也不能证明逻辑对 —— 最终仍需要一次真启动。'))
