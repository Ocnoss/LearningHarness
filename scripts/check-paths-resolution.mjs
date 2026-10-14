/**
 * 闸门：**同一个问题，从每个加载位置问，答案必须一样**。
 *
 * ═══ 为什么需要这道闸门（它补的是一个我自己刚制造出来的盲区）═══
 * 2026-09-18：`apply()` 里那句"没配好就抛错"被改成了"装载照常、用的时候拒绝"。
 * 那个改动是对的（装载期抛错会让整棵插件树加载失败、dsh 完全起不来），
 * 但它**顺手拆掉了一个警报器**：
 *
 *   以前"数据目录解析不出来"会让 apply() 失败 → 闸门红。
 *   现在它不失败了 → `check-profile-apply` 变绿 —— **而目录仍然可能是错的**。
 *
 * 这正是本项目反复踩的那一类：**闸门绿了不等于事情对了**。
 * 所以缺的是一道**直接问路径、不经过 apply()** 的闸门。
 *
 * ═══ 它验什么 ═══
 * 对**每一个**代码可能被加载的位置（源码树、profile 里的副本），
 * 分别导入 `@lh/event-store/paths` 并问三个问题：
 *
 *   1. 数据目录是哪？
 *   2. 工作区是哪？
 *   3. 这两个答案，和在**别的位置**问出来的，是不是同一个？
 *
 * 第 3 条是核心。这个 bug 的形态就是"在源码树里问是对的，在 profile 里问是错的"——
 * 而**在源码树里测**恰恰是当时唯一测过的地方。
 *
 * 运行：node scripts/check-paths-resolution.mjs
 */

import { existsSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const red = (s) => c('31', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const dim = (s) => c('90', s)

const failures = []

/**
 * 在一个**干净的子进程**里问路径。
 *
 * 为什么不用当前进程：`paths.js` 会在模块加载时固化 `HERE`（本模块位置），
 * 而同一进程里两个不同 URL 的副本会各算各的——能工作，但更容易把
 * "我到底问的是哪一份"搞混。子进程**环境也干净**（不带 LH_* 变量），
 * 这正是要验的场景：**没有环境变量时它能不能自己找到家**。
 *
 * @param entryPath - 要导入的 paths.js 的绝对路径。
 * @returns `{ dataDir, workspace, workspaceSource, error }`。
 */
function askInChild(entryPath) {
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(entryPath).href)})
    const out = { dataDir: null, workspace: null, workspaceSource: null, error: null }
    try { out.dataDir = m.dataDir() } catch (e) { out.error = 'dataDir: ' + e.message }
    try {
      const w = m.workspaceDir()
      if (w === null) out.error = (out.error ? out.error + ' | ' : '') + 'workspaceDir: 返回 null（没有配置）'
      else { out.workspace = w.dir; out.workspaceSource = w.source }
    } catch (e) { out.error = (out.error ? out.error + ' | ' : '') + 'workspaceDir: ' + e.message }
    process.stdout.write(JSON.stringify(out))
  `
  const env = { ...process.env }
  delete env.LH_DATA_DIR
  delete env.LH_WORKSPACE
  delete env.LH_EVENT_LOG
  delete env.LH_CONTENT_DIR

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env,
    cwd: repoRoot,
  })
  const raw = (r.stdout ?? '').trim()
  if (raw === '') {
    return { dataDir: null, workspace: null, workspaceSource: null, error: `子进程没有输出（stderr: ${(r.stderr ?? '').trim().slice(0, 400)}）` }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return { dataDir: null, workspace: null, workspaceSource: null, error: `子进程输出无法解析：${raw.slice(0, 300)}` }
  }
}

// ── 收集所有加载位置 ──────────────────────────────────────────────────────

/** @type {{label:string, entry:string}[]} */
const places = []

// 1. 源码树（也是仓库根 node_modules 活链指向的地方）
const srcPaths = join(repoRoot, 'plugins', 'lh-event-store', 'paths.js')
if (existsSync(srcPaths)) places.push({ label: '源码树', entry: srcPaths })

// 2. profile 里的每一个副本
const profilesDir = join(dshHome, 'profiles')
if (existsSync(profilesDir)) {
  for (const name of readdirSync(profilesDir)) {
    const entry = join(profilesDir, name, 'node_modules', '@lh', 'event-store', 'paths.js')
    if (existsSync(entry)) places.push({ label: `profile:${name}`, entry })
  }
}

console.log(`从 ${places.length} 个加载位置分别问"数据目录/工作区在哪"（子进程，无 LH_* 环境变量）\n`)

const answers = []
for (const p of places) {
  const a = askInChild(p.entry)
  answers.push({ ...p, ...a })
  const bad = a.error !== null
  const mark = bad ? red('无法回答') : green('答')
  console.log(`${p.label.padEnd(16)} ${mark}`)
  console.log(`  数据目录  ${a.dataDir === null ? dim('(未解析出)') : a.dataDir}`)
  console.log(`  工作区    ${a.workspace === null ? dim('(未解析出)') : a.workspace}  ${dim(a.workspaceSource ?? '')}`)
  if (bad) {
    console.log(`  ${red(a.error)}`)
    failures.push(`${p.label}: ${a.error}`)
  }
}

console.log('')

// ── 断言一：每个位置都必须能回答 ──────────────────────────────────────────

if (answers.every((a) => a.error === null)) {
  console.log(green('✓ 每个加载位置都能自己找到家（不靠环境变量）'))
} else {
  console.log(red('✗ 有加载位置答不出来 —— 它在生产里就是一个起不来/取不到题的插件'))
  console.log(dim('  典型原因：该位置上方没有 lh-install.json。跑 node scripts/sync-lh-deps.mjs 补上。'))
}

// ── 断言二：所有位置答案必须一致（**这道闸门的存在理由**） ────────────────

const ok = answers.filter((a) => a.error === null)
if (ok.length >= 2) {
  const first = ok[0]
  const mismatched = ok.filter((a) => a.dataDir !== first.dataDir || a.workspace !== first.workspace)
  if (mismatched.length === 0) {
    console.log(green(`✓ ${ok.length} 个位置的答案完全一致（数据目录 + 工作区）`))
  } else {
    console.log(red('✗ 不同位置给出的答案不一样 —— 这正是"在源码树里测是绿的、生产是错的"那个形态'))
    for (const m of mismatched) {
      console.log(`    ${m.label}: 数据目录=${m.dataDir} 工作区=${m.workspace}`)
      failures.push(`${m.label} 的答案与 ${first.label} 不一致（${m.dataDir} vs ${first.dataDir}）`)
    }
  }
} else if (ok.length === 1) {
  console.log(yellow('⚠ 只有一个位置能回答，无法比对"这里和那里是否一样"'))
  console.log(dim('  （profile 里没有装 @lh/event-store 时会是这种情况）'))
}

// ── 断言三：答案得指向真实存在、且看着像那么回事的目录 ────────────────────
//
// 这一条防的是"两处一致地错"。一致不等于对：如果配置文件里写错了路径，
// 所有位置会**一致地**给出那个错答案。

const canonical = ok[0]
if (canonical !== undefined) {
  if (canonical.dataDir !== null) {
    const dir = canonical.dataDir
    // 数据目录本身可能还没建（第一次运行），但父目录必须存在——
    // 否则说明这是"猜"出来的路径，不是"知道"的路径。
    const parent = dirname(dir)
    if (existsSync(dir)) {
      console.log(green(`✓ 数据目录存在：${dir}`))
    } else if (existsSync(parent)) {
      console.log(yellow(`⚠ 数据目录还不存在（父目录在，首次运行时会建）：${dir}`))
    } else {
      console.log(red(`✗ 数据目录的父目录都不存在，这个路径是猜的：${dir}`))
      failures.push(`数据目录 ${dir} 的父目录不存在（配置文件里的路径大概是错的）`)
    }
  }

  if (canonical.workspace !== null) {
    const ws = canonical.workspace
    if (!existsSync(ws)) {
      console.log(red(`✗ 工作区不存在：${ws}`))
      failures.push(`工作区 ${ws} 不存在（配置文件里的路径大概是错的）`)
    } else {
      const questions = readdirSync(ws).filter((n) => {
        try {
          return statSync(join(ws, n)).isDirectory() && n === 'lh-questions'
        } catch {
          return false
        }
      })
      if (questions.length > 0) {
        const banks = readdirSync(join(ws, 'lh-questions')).filter((f) => f.endsWith('.json'))
        console.log(green(`✓ 工作区存在且含 lh-questions/（${banks.length} 个 json）`))
        if (banks.length === 0) {
          console.log(yellow('⚠ lh-questions/ 里没有 json —— 面板会是空的（这是数据问题，不是路径问题）'))
        }
      } else {
        // 不是致命：空工作区也能刷题（只要导入过题库）。但要点出来。
        console.log(yellow(`⚠ 工作区存在，但里面没有 lh-questions/：${ws}`))
        console.log(dim('  面板会显示"没有题库"。若这是故意的（题库还没导入），忽略即可。'))
      }
    }
  }
}

console.log('')
if (failures.length) {
  console.log(red(`══ 失败 ${failures.length} 条 ══`))
  for (const f of failures) console.log(`  ${red('✗')} ${f}`)
  console.log('')
  console.log('  修：' + green('node scripts/sync-lh-deps.mjs') + dim('（并把仓库根的 lh-install.json 写对）'))
  process.exit(1)
}
console.log(green('══ 路径解析：每个加载位置都能自己找到家，且答案一致。 ══'))
