/**
 * 闸门自测：证明 `check-installed-copies.mjs` 真的能红、也真的会绿。
 *
 * ═══ 为什么闸门也要有测试 ═══
 * 一条已经写进经验文档的规矩：**没见它红过的闸门只是希望，不是保障。**
 * 但"见它红过"如果只是当时手工碰出来的，下次改了闸门就没人再验；
 * 而且更容易漏的是**反方向**——闸门永远红（或对良性情形误报）同样没用，
 * 人会条件反射地忽略它，这时它连"希望"都不是，是噪声。
 *
 * ═══ 为什么在临时目录里造假的仓库，而不是去动真 profile ═══
 * 真 profile 是 dsh 自己的安装根，动它的代价是"插件树加载失败 → dsh 完全起不来"。
 * 为了验一道闸门去冒这个险，性价比是负的。
 * 所以这里造一个**完整的最小假仓库**（plugins/ + profiles/），
 * 用 `--root` 和 `DSH_HOME` 把闸门指过去——全程不碰宿主的任何文件。
 *
 * 运行：node scripts/selftest-installed-copies.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const gate = join(scriptDir, 'check-installed-copies.mjs')
const repoRoot = resolve(scriptDir, '..')

const useColor = process.stdout.isTTY
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const green = (s) => c('32', s)
const red = (s) => c('31', s)
const dim = (s) => c('90', s)

let passed = 0
let failed = 0

/**
 * 断言，但**带标签**。
 * 每条断言都先打印它在验什么，再打印结果——失败时不用回头猜是哪一条。
 */
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ${green('ok')}  ${label}`)
  } catch (err) {
    failed += 1
    console.log(`  ${red('FAIL')} ${label}`)
    console.log(`        ${red(err.message.split('\n').join('\n        '))}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ── 造假仓库 ──────────────────────────────────────────────────────────────

const fixtureRoot = join(tmpdir(), `lh-gate-selftest-${process.pid}-${Date.now()}`)

/** 假仓库里的插件与它们的运行时文件。故意造两种：有依赖的、纯注释的。 */
const FIXTURE_PLUGINS = [
  { dir: 'lh-alpha', name: '@lh/alpha', files: { 'index.js': 'export const name = "@lh/alpha"\n', 'lib.js': 'export const x = 1\n' } },
  { dir: 'lh-beta', name: '@lh/beta', files: { 'index.js': 'export const name = "@lh/beta"\n' } },
]

const profileNodeModules = join(fixtureRoot, '.dsh', 'profiles', 'fake', 'node_modules', '@lh')

function writePlugin(p, { withFilesField = true, extraDeclared = null } = {}) {
  const dir = join(fixtureRoot, 'plugins', p.dir)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(p.files)) {
    writeFileSync(join(dir, name), content, 'utf8')
  }
  const pkg = { name: p.name, version: '0.0.1', private: true, type: 'module', main: 'index.js' }
  if (withFilesField) pkg.files = [...Object.keys(p.files), ...(extraDeclared ?? [])]
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

/** 把插件"正确安装"到假 profile 里（源码 + package.json 逐字节拷过去）。 */
function installCopy(p) {
  const dst = join(profileNodeModules, p.name.replace(/^@[^/]+\//, ''))
  mkdirSync(dst, { recursive: true })
  for (const name of [...Object.keys(p.files), 'package.json']) {
    const from = name === 'package.json' ? join(fixtureRoot, 'plugins', p.dir, name) : join(fixtureRoot, 'plugins', p.dir, name)
    writeFileSync(join(dst, name), readFileSync(from))
  }
  return dst
}

/** 跑闸门，返回 {status, out}。 */
function runGate() {
  const r = spawnSync(process.execPath, [gate, '--root', fixtureRoot], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: join(fixtureRoot, '.dsh') },
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function resetFixture() {
  rmSync(fixtureRoot, { recursive: true, force: true })
  for (const p of FIXTURE_PLUGINS) writePlugin(p)
  for (const p of FIXTURE_PLUGINS) installCopy(p)
}

console.log(`闸门自测：造假仓库于 ${fixtureRoot}\n`)
console.log(dim('（全程只动临时目录；真 profile 一个字节都不碰）\n'))

try {
  // ── 1. 基线：一切正确时必须绿 ─────────────────────────────────────────
  console.log('══ 1. 基线：副本与源码一致 ══')
  resetFixture()
  let r = runGate()
  check('基准状态下闸门是绿的（否则后面所有"变红"都说明不了问题）', () => {
    assert(r.status === 0, `期望 exit 0，实际 ${r.status}\n${r.out}`)
    assert(/全部一致/.test(r.out), `期望输出含"全部一致"，实际：\n${r.out}`)
  })

  // ── 2. 副本缺文件（**paths.js 那次事故的形态**） ──────────────────────
  console.log('\n══ 2. 副本里少了声明中的文件 ══')
  resetFixture()
  rmSync(join(profileNodeModules, 'alpha', 'lib.js'))
  r = runGate()
  check('副本缺文件 → 红，且指出是"缺失"和哪个文件', () => {
    assert(r.status === 1, `期望 exit 1，实际 ${r.status}\n${r.out}`)
    assert(/lib\.js/.test(r.out), `失败信息里应出现 lib.js，实际：\n${r.out}`)
    assert(/缺失/.test(r.out), `失败信息里应出现"缺失"，实际：\n${r.out}`)
  })

  // ── 3. 副本内容陈旧 ───────────────────────────────────────────────────
  console.log('\n══ 3. 副本内容与源码不同 ══')
  resetFixture()
  writeFileSync(join(profileNodeModules, 'beta', 'index.js'), 'export const name = "@lh/beta" // 旧版\n', 'utf8')
  r = runGate()
  check('副本内容不同 → 红，且指出"内容不同"', () => {
    assert(r.status === 1, `期望 exit 1，实际 ${r.status}\n${r.out}`)
    assert(/内容不同/.test(r.out), `失败信息里应出现"内容不同"，实际：\n${r.out}`)
  })

  // ── 4. package.json 缺 files 字段 ─────────────────────────────────────
  console.log('\n══ 4. 插件没有声明 files ══')
  resetFixture()
  writePlugin(FIXTURE_PLUGINS[0], { withFilesField: false })
  r = runGate()
  check('缺 files → 红（拒绝猜运行时文件集）', () => {
    assert(r.status === 1, `期望 exit 1，实际 ${r.status}\n${r.out}`)
    assert(/没有声明 "files"/.test(r.out), `失败信息里应说明缺 files，实际：\n${r.out}`)
    assert(/无法判定/.test(r.out), `行内应显示"无法判定"，实际：\n${r.out}`)
  })

  // ── 5. files 声明了不存在的文件 ───────────────────────────────────────
  // 这条是"没有安装副本的包"唯一的保护：预设行加载的包没有副本可比，
  // 若把这条检查写在副本循环里，它们的 files 永远不会被验。
  console.log('\n══ 5. files 里声明了源码中不存在的文件 ══')
  resetFixture()
  writePlugin(FIXTURE_PLUGINS[0], { extraDeclared: ['ghost.js'] })
  // 并且**不给它任何副本**，验证"没有副本也要验声明"
  rmSync(join(profileNodeModules, 'alpha'), { recursive: true, force: true })
  r = runGate()
  check('声明了 ghost.js（无副本）→ 红，说明"没有副本也要验声明"', () => {
    assert(r.status === 1, `期望 exit 1，实际 ${r.status}\n${r.out}`)
    assert(/ghost\.js/.test(r.out), `失败信息里应出现 ghost.js，实际：\n${r.out}`)
    assert(/声明与事实不符/.test(r.out), `失败信息里应出现"声明与事实不符"，实际：\n${r.out}`)
  })

  // ── 6. 副本里有声明之外的残留 → 只警告，不红 ──────────────────────────
  // 反方向的误报同样要防：修 trace.log 这种噪声不该把整道闸门弄红。
  console.log('\n══ 6. 副本里有未声明的残留文件（良性） ══')
  resetFixture()
  writeFileSync(join(profileNodeModules, 'alpha', 'trace.log'), 'debug noise\n', 'utf8')
  r = runGate()
  check('残留文件 → 仍绿，但给出警告（不误报为失败）', () => {
    assert(r.status === 0, `期望 exit 0（残留不该让闸门红），实际 ${r.status}\n${r.out}`)
    assert(/警告/.test(r.out), `应给出警告，实际：\n${r.out}`)
    assert(/trace\.log/.test(r.out), `警告里应点名 trace.log，实际：\n${r.out}`)
  })

  // ── 7. 活链不该被当成"副本"比 ─────────────────────────────────────────
  console.log('\n══ 7. 安装位置是活链（软链回源码） ══')
  resetFixture()
  // 这一条需要真的软链；Windows 上建目录软链要开发者模式或管理员，
  // 建不了就**如实跳过**而不是伪装通过——跳过和通过必须能区分。
  const liveParent = join(fixtureRoot, '.dsh', 'profiles', 'fake', 'node_modules', '@lh')
  const livePath = join(liveParent, 'alpha')
  let linked = false
  try {
    rmSync(livePath, { recursive: true, force: true })
    const { symlinkSync } = await import('node:fs')
    symlinkSync(join(fixtureRoot, 'plugins', 'lh-alpha'), livePath, 'junction')
    linked = true
  } catch (err) {
    console.log(`  ${dim(`跳过：这台机器上建不了软链（${err.code ?? err.message}）`)}`)
  }
  if (linked) {
    r = runGate()
    check('活链 → 绿，且如实标注"活链"而不是假装比对过', () => {
      assert(r.status === 0, `期望 exit 0，实际 ${r.status}\n${r.out}`)
      assert(/活链/.test(r.out), `应标注"活链"，实际：\n${r.out}`)
    })
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}

console.log('')
if (failed) {
  console.log(red(`══ 结果：${passed} 通过 / ${failed} 失败 ══`))
  console.log('  闸门自身有问题 —— 在它绿之前，它报的绿都不算数。')
  process.exit(1)
}
console.log(green(`══ 结果：${passed} 通过 / 0 失败 ══`))
console.log(dim('  闸门能红、也会绿，且两种方向都验过了。'))
