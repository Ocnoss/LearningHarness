/**
 * 两个 dsh 家的对照 —— 回答"改一处，谁会自动跟上"。
 *
 * ═══ 为什么要一个脚本，而不是手敲几条命令 ═══
 * 这问题是**迁移期的核心问题**，而它的答案要跨"两个家 × 三类文件（源码 / 配置 / 副本）"才能说清。
 * 手敲命令时我当天就绕了三次 shell（其中一次还把 BOM 写进了源文件，见 C21/E15 的同类），
 * 而**同一个 DSH_HOME 的检查要跑两遍**——这种"同一判据、两个取值"的事，最该固化成脚本。
 *
 * 它只读不写：不动源码、不动任何家、不跑同步。
 *
 * 用法: node scripts/compare-homes.mjs [老家路径] [新家路径]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(import.meta.dirname, '..')
const oldHome = resolve(process.argv[2] ?? join(homedir(), '.dsh'))
const newHome = resolve(process.argv[3] ?? join(repoRoot, '.dsh'))

/**
 * 文件的哈希（不存在返回 null）。
 *
 * @param p - 路径。
 * @returns 前 8 位哈希或 null。
 */
function hashOf(p) {
  if (!existsSync(p)) return null
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8)
}

/**
 * 某个家里的 profile 装了哪些 LH 包。
 *
 * @param home - 家目录。
 * @returns 包名数组。
 */
function lhPackages(home) {
  const dir = join(home, 'profiles', 'web', 'node_modules', '@lh')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

/**
 * 某个家的 profile 里各包 `index.js` 的哈希（用来判断"副本是不是同一份"）。
 *
 * @param home - 家目录。
 * @returns `{ 包名: 哈希 }`。
 */
function copyHashes(home) {
  const out = {}
  const dir = join(home, 'profiles', 'web', 'node_modules', '@lh')
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name, 'index.js')
    out[name] = hashOf(p)
  }
  return out
}

console.log('══ 两个家对照 ══\n')

for (const [label, home] of [['老家', oldHome], ['新家', newHome]]) {
  console.log(`${label}：${home}`)
  console.log(`  存在：${existsSync(home)}`)
  if (!existsSync(home)) {
    console.log('')
    continue
  }
  const preset = join(home, '.agent-presets', 'lh', 'agent.cordis.yml')
  const settings = join(home, 'settings.yaml')
  console.log(`  preset 行数：${existsSync(preset) ? (readFileSync(preset, 'utf8').match(/^- id:/gm) ?? []).length : '(没有)'}`)
  console.log(`  preset 哈希：${hashOf(preset) ?? '(没有)'}`)
  console.log(`  settings.yaml：${hashOf(settings) ?? '(没有)'}`)
  console.log(`  已装插件：${lhPackages(home).join(', ') || '(没有)'}`)
  const inst = join(home, 'profiles', 'web', 'lh-install.json')
  if (existsSync(inst)) {
    const j = JSON.parse(readFileSync(inst, 'utf8'))
    console.log(`  指向的工作区：${j.workspace}`)
  }
  console.log('')
}

// ── 插件副本是不是同一份（这是"两个家会不会跑不同代码"的判据）──
const a = copyHashes(oldHome)
const b = copyHashes(newHome)
const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
console.log('插件副本内容（index.js 哈希）：')
for (const n of names) {
  const same = a[n] !== undefined && a[n] === b[n]
  console.log(`  ${n.padEnd(16)} 老家 ${a[n] ?? '(无)'}   新家 ${b[n] ?? '(无)'}   ${same ? '一致' : '**不一致**'}`)
}

// ── 源码与两侧副本的三方对照 ──
console.log('\n源码 vs 两个家的副本：')
const pluginsDir = join(repoRoot, 'plugins')
for (const dir of existsSync(pluginsDir) ? readdirSync(pluginsDir) : []) {
  const pkg = join(pluginsDir, dir, 'package.json')
  // 只列真的被装进 profile 的那些（@lh/question-bank 这类目录名 vs 包名不同，用 index.js 比）
  const src = hashOf(join(pluginsDir, dir, 'index.js'))
  if (src === null || !existsSync(pkg)) continue
  const name = JSON.parse(readFileSync(pkg, 'utf8')).name?.replace('@lh/', '')
  if (name === undefined) continue
  const inOld = a[name]
  const inNew = b[name]
  if (inOld === undefined && inNew === undefined) continue
  console.log(
    `  ${dir.padEnd(22)} 源码 ${src}  ${inOld === src ? '老家=源码' : `老家 ${inOld ?? '(无)'}`}  ${inNew === src ? '新家=源码' : `新家 ${inNew ?? '(无)'}`}`,
  )
}

// ── 学习数据是共享的（两个家指向同一个 workspace）──
console.log('\n学习数据（事件日志 / 题库）落点：')
const ws = new Set()
for (const home of [oldHome, newHome]) {
  const inst = join(home, 'profiles', 'web', 'lh-install.json')
  if (existsSync(inst)) ws.add(JSON.parse(readFileSync(inst, 'utf8')).workspace)
}
console.log(`  ${[...ws].join(' 与 ')}${ws.size === 1 ? '（**两个家共用同一份**：换家不影响刷题历史）' : '（**两个家指向不同工作区**）'}`)

// ── 给一句结论 ──
console.log('\n══ 结论 ══')
console.log('  · 插件**源码**只有一份（仓库里），两个家都通过 file: 指向它 → 改源码两边都算"改过"')
console.log('  · 插件**副本**每个家各一份（pnpm 拷贝的快照）→ **必须分别同步**')
console.log('  · preset / settings 每个家各一份 → **不会自动互相同步**')
console.log('  · 学习数据按 workspace 走，两个家默认共用 → 换家不丢刷题历史')
console.log('\n  本次：' + (names.every((n) => a[n] === b[n]) ? '两个家的副本一致 ✅' : '**两个家的副本已经不一致**，请分别跑 sync'))
