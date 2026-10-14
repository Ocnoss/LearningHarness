/**
 * `check-text-encoding.mjs` 的自检 —— **先对坏状态红一次**。
 *
 * ═══ 为什么这个自检特别值得写 ═══
 * 这条规矩（别用 shell 改文本文件）我**犯过四次**，而每次的处置都是"记进经验文档"。
 * 经验文档拦不住手——所以现在有一条闸门；而按 `§E-12`，
 * **没在坏状态上验证过的闸门只是一个希望**。
 *
 * 它守三种状态：
 *   ① 干净文件 → 必须绿；
 *   ② 带 UTF-8 BOM 的文件 → 必须红，且点名那个文件；
 *   ③ 含 U+FFFD（编码转换丢字符的化石）的文件 → 必须红；
 *   ④ 一个"只在 test/ 里带 BOM"的文件 → 也要红（**不给自己开后门**）。
 *
 * 做法：把闸门脚本与夹具一起放进临时目录，让闸门以为那里是仓库根。
 * 只读真脚本、只写临时目录，跑完删掉。
 *
 * 用法: node scripts/selftest-text-encoding.mjs
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const gate = join(here, 'check-text-encoding.mjs')
const fakeRoot = join(repoRoot, 'data', 'text-encoding-selftest')

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
 * 重置夹具仓库（只留闸门脚本本身）。
 */
function resetFixture() {
  rmSync(fakeRoot, { recursive: true, force: true })
  mkdirSync(join(fakeRoot, 'scripts'), { recursive: true })
  copyFileSync(gate, join(fakeRoot, 'scripts', 'check-text-encoding.mjs'))
}

/**
 * 跑夹具里的闸门。
 *
 * @returns `{ code, out }`。
 */
function runGate() {
  const r = spawnSync(process.execPath, [join(fakeRoot, 'scripts', 'check-text-encoding.mjs')], {
    encoding: 'utf8',
    cwd: fakeRoot,
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

console.log('== 1. 干净文件：必须绿（否则这个闸门会恒红，等于没有）==')
{
  resetFixture()
  writeFileSync(join(fakeRoot, 'clean.mjs'), "export const a = '你好'\n", 'utf8')
  const { code, out } = runGate()
  check('闸门绿', code === 0, `退出码 ${code}\n${out.slice(-300)}`)
}

console.log('\n== 2. 带 UTF-8 BOM 的文件：必须红并点名 ==')
{
  resetFixture()
  writeFileSync(join(fakeRoot, 'with-bom.mjs'), '\uFEFFexport const a = 1\n', 'utf8')
  const { code, out } = runGate()
  check('闸门红', code !== 0, `退出码 ${code}`)
  check('点名了 with-bom.mjs', out.includes('with-bom.mjs'), out.slice(-300))
  check('说清了是什么问题（BOM）', out.includes('[BOM]'), out.slice(-300))
}

console.log('\n== 3. 含 U+FFFD 的文件：必须红（那是编码转换丢字符的化石）==')
{
  resetFixture()
  // 造一个"多字节字符被写坏"的化石：直接写替换字符本身
  writeFileSync(join(fakeRoot, 'broken.md'), '这一行有个坏字符：\uFFFDEND\n', 'utf8')
  const { code, out } = runGate()
  check('闸门红', code !== 0, `退出码 ${code}`)
  check('点名了 broken.md', out.includes('broken.md'), out.slice(-300))
  check('说清了是什么问题（U+FFFD）', out.includes('[U+FFFD]'), out.slice(-300))
}

console.log('\n== 4. 不给自己开后门：test/ 里的 BOM 也要红 ==')
{
  resetFixture()
  mkdirSync(join(fakeRoot, 'test'), { recursive: true })
  writeFileSync(join(fakeRoot, 'test', 'fixture.json'), '\uFEFF{"a":1}\n', 'utf8')
  const { code, out } = runGate()
  check('闸门红', code !== 0, `退出码 ${code}`)
  check('点名了 test/fixture.json', out.includes('test/fixture.json') || out.includes('fixture.json'), out.slice(-300))
}

rmSync(fakeRoot, { recursive: true, force: true })

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) process.exit(1)
console.log('闸门在"干净 / BOM / U+FFFD / 子目录里的 BOM"四种状态下都表现正确。\n')
