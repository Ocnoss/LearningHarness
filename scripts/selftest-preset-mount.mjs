/**
 * `check-preset-mount.mjs` 的自检 —— **先对着已知坏的状态红一次**。
 *
 * ═══ 为什么必须有（这次是被真实需求逼出来的）═══
 * `COLLABORATOR_MODEL §E-12`：*"闸门必须先对着'已知坏的状态'红一次，
 * 再拿它去保证'以后不会坏'。没在坏状态上验证过的闸门只是一个希望。"*
 *
 * 而这道闸门**刚刚就把正确的配置报成了错**：给 LH preset 加上 standard preset
 * 的基础能力行（`@deepseek-ai/dsh-tool-pwsh` 这类宿主包）之后，它对 8 行全报
 * "文件不存在"——因为原来只认工作区里的文件路径。**闸门对正确的配置报错，
 * 比漏掉错误的配置更糟**：它会让人去改一个对的东西（我差点就去改）。
 *
 * 所以本自检守三条：
 *   ① 正确的配置（真 preset）→ 必须绿；
 *   ② 宿主包名写错 → 必须红，且报错要点名是哪个包；
 *   ③ 工作区插件的路径写错 → 必须红，且报错要区分"文件不存在"与"宿主包找不到"。
 *
 * 做法：把闸门脚本**复制到临时目录**，连同一个小夹具 preset；
 * 闸门是从 `import.meta.url` 推仓库根的，所以复制到别处它就会去那里找 preset。
 * 全程只读真脚本、只写临时目录，跑完删掉。
 *
 * 用法: node scripts/selftest-preset-mount.mjs
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const gate = join(here, 'check-preset-mount.mjs')
const fakeRoot = join(repoRoot, 'data', 'preset-mount-selftest')

// 真 preset 取仓库自带的那份（跟着仓库走；闸门支持 LH_PRESET 显式指定，不写死机器路径）
const REAL_PRESET = join(repoRoot, '.dsh', '.agent-presets', 'lh', 'agent.cordis.yml')

let passed = 0
let failed = 0

/**
 * 断言。
 *
 * @param label - 用例名。
 * @param ok - 是否成立。
 * @param detail - 失败时的补充。
 */
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : `\n       ${detail}`}`)
  }
}

/**
 * 用给定 preset 内容跑一次闸门（LH_PRESET 显式指向夹具，不再改写闸门源码）。
 *
 * @param yaml - preset 内容。
 * @returns `{ code, out }`。
 */
function runWithPreset(yaml) {
  const presetPath = join(fakeRoot, 'preset', 'agent.cordis.yml')
  mkdirSync(join(fakeRoot, 'preset'), { recursive: true })
  writeFileSync(presetPath, yaml, 'utf8')
  const r = spawnSync(process.execPath, [gate], {
    encoding: 'utf8',
    cwd: fakeRoot,
    env: { ...process.env, LH_PRESET: presetPath },
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

rmSync(fakeRoot, { recursive: true, force: true })
mkdirSync(join(fakeRoot, 'scripts'), { recursive: true })

console.log('== 1. 真 preset：必须绿（否则闸门会把正确配置报成错，逼人去改对的东西）==')
{
  const yaml = readFileSync(REAL_PRESET, 'utf8')
  const { code, out } = runWithPreset(yaml)
  check('真 preset 通过', code === 0, `退出码 ${code}\n${out.slice(-500)}`)
  check('真 preset 没有"加载失败"', !/加载失败 [1-9]/.test(out), out.slice(-300))
}

console.log('\n== 2. 宿主包名写错：必须红，并点名是哪个包 ==')
{
  const { code, out } = runWithPreset(`- id: tool-typo\n  name: '@deepseek-ai/dsh-tool-pwshh'\n`)
  check('闸门红了', code !== 0, `退出码 ${code}`)
  check('报错点名了那个包名', out.includes('dsh-tool-pwshh'), out.slice(-300))
  check('报错说清了原因（宿主包找不到）', out.includes('宿主包找不到'), out.slice(-300))
}

console.log('\n== 3. 工作区插件路径写错：必须红，且与"宿主包找不到"区分开 ==')
{
  const { code, out } = runWithPreset(`- id: nope\n  name: 'D:\\\\no\\\\such\\\\plugin.js'\n`)
  check('闸门红了', code !== 0, `退出码 ${code}`)
  check('报错说的是"文件不存在"而不是"宿主包找不到"', out.includes('文件不存在') && !out.includes('宿主包找不到'), out.slice(-300))
}

console.log('\n== 4. 一行都没有：不能假装通过 ==')
{
  const { code, out } = runWithPreset('# 空 preset\n')
  check('空 preset 不算通过（没有行就没有可挂载的东西）', code !== 0, `退出码 ${code}\n${out.slice(-200)}`)
}

rmSync(fakeRoot, { recursive: true, force: true })

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) process.exit(1)
console.log('闸门在"正确配置 / 包名写错 / 路径写错 / 空配置"四种状态下表现正确。\n')
