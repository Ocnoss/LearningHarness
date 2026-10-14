/**
 * `check-plugin-contract.mjs` 的自检 —— **先对着已知坏的状态红一次**。
 *
 * ═══ 为什么必须有 ═══
 * `COLLABORATOR_MODEL §E-12`：*"闸门必须先对着'已知坏的状态'红一次，
 * 再拿它去保证'以后不会坏'。没在坏状态上验证过的闸门只是一个希望。"*
 *
 * 本文件专测 2026-09-19 新加的那条规则（`files` 清单）：
 *   · 源码 import 了 `./context.js`，但 `files` 里没登记 → **必须红**
 *   · 登记齐全 → 必须绿
 * 两种状态都要跑，缺任何一半这个自检就没有意义：
 * 只跑坏的那种，无法区分"规则生效"与"脚本恒红"。
 *
 * ═══ 它怎么骗过 ROOT 推导 ═══
 * 那道闸门是用 `import.meta.url` 往上找仓库根的，所以不能对真仓库造假——
 * 那样会污染真插件、也会被真插件的其它违例干扰。
 * 做法：把**闸门脚本与夹具一起**放进临时目录，让它以为那个临时目录就是仓库根。
 * 全程只读真脚本、只写临时目录，跑完删掉。
 *
 * 用法: node scripts/selftest-plugin-contract.mjs
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const gate = join(here, 'check-plugin-contract.mjs')

/** 临时"仓库根"：一个假的 plugins/ 加一份闸门脚本的副本。 */
const fakeRoot = join(repoRoot, 'data', 'plugin-contract-selftest')

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
 * 在夹具仓库里写一个插件。
 *
 * @param name - 插件目录名。
 * @param filesField - package.json 的 files 数组。
 * @param extra - 额外要写的文件 `{ 文件名: 内容 }`。
 */
function writePlugin(name, filesField, extra = {}, lhOverride = undefined) {
  const dir = join(fakeRoot, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  // 夹具默认带一个**完整且正确**的 lh 段：闸门现在要求它存在（ADR-024），
  // 缺了会让"正常状态必须绿"那条用例红——而那不是被测对象的问题，是夹具过时了。
  const lh =
    lhOverride === null
      ? undefined
      : (lhOverride ?? {
          kind: 'capability',
          summary: '夹具插件',
          inject: [],
          provides: { tools: ['fixture_tool'] },
          depends_on: [],
          loads_at: 'preset',
          verified: { gates: true, live: false },
        })
  const pkg = { name: `@lh/${name}`, version: '0.0.1', type: 'module', main: 'index.js', files: filesField }
  if (lh !== undefined) pkg.lh = lh
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  // index.js：两条本地导入（测 files 清单）+ 注册一个工具（测 lh.provides.tools）
  writeFileSync(
    join(dir, 'index.js'),
    [
      "import { a } from './context.js'",
      "import { b } from './topics.js'",
      "export const name = 'x'",
      'export function apply(ctx) {',
      "  ctx.tools.register({ name: 'fixture_tool', execute: () => a + b })",
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  for (const [file, content] of Object.entries({ 'context.js': 'export const a = 1\n', 'topics.js': 'export const b = 2\n', ...extra })) {
    writeFileSync(join(dir, file), content, 'utf8')
  }
}

/**
 * 跑一次夹具仓库里的闸门。
 *
 * @returns `{ code, out }`。
 */
function runGate() {
  const r = spawnSync(process.execPath, [join(fakeRoot, 'scripts', 'check-plugin-contract.mjs')], {
    encoding: 'utf8',
    cwd: fakeRoot,
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

rmSync(fakeRoot, { recursive: true, force: true })
mkdirSync(join(fakeRoot, 'scripts'), { recursive: true })
copyFileSync(gate, join(fakeRoot, 'scripts', 'check-plugin-contract.mjs'))

console.log('== 1. 已知坏的状态：files 漏登记一个被 import 的本地模块 ==')
{
  writePlugin('bad-missing-entry', ['index.js', 'topics.js']) // 故意漏掉 context.js
  const { code, out } = runGate()
  check('闸门必须红（退出码非 0）', code !== 0, `退出码 ${code}`)
  check('报错要点名那个文件', out.includes('context.js'), out.slice(-400))
  check('报错要说清后果（下一次重启才炸）', out.includes('下一次重启'), out.slice(-400))
}

console.log('\n== 2. 已知坏的第二种：files 里写了一个不存在的文件 ==')
{
  rmSync(join(fakeRoot, 'plugins'), { recursive: true, force: true })
  writePlugin('bad-phantom-file', ['index.js', 'context.js', 'topics.js', '不存在.js'])
  const { code, out } = runGate()
  check('闸门必须红', code !== 0, `退出码 ${code}`)
  check('报错要点名那个不存在的文件', out.includes('不存在.js'), out.slice(-400))
}

console.log('\n== 3. 正常状态：必须绿（否则这个闸门会恒红，等于没有） ==')
{
  rmSync(join(fakeRoot, 'plugins'), { recursive: true, force: true })
  writePlugin('good', ['index.js', 'context.js', 'topics.js'])
  const { code, out } = runGate()
  check('闸门必须绿', code === 0, `退出码 ${code}\n${out.slice(-600)}`)
}

console.log('\n== 4. `lh` 声明与实现不一致：必须红（ADR-024 的失效信号） ==')
{
  // 声明了两个工具，实际只注册一个 → 这就是"声明漂移"的形状。
  // agent 会照声明以为多了一个工具，而它**看起来完全正常**。
  rmSync(join(fakeRoot, 'plugins'), { recursive: true, force: true })
  writePlugin('bad-lh-tools', ['index.js', 'context.js', 'topics.js'], {}, {
    kind: 'capability',
    summary: '声明多了',
    inject: [],
    provides: { tools: ['fixture_tool', 'ghost_tool'] },
    depends_on: [],
    loads_at: 'preset',
    verified: { gates: true, live: false },
  })
  const { code, out } = runGate()
  check('闸门必须红', code !== 0, `退出码 ${code}`)
  check('报错点名了不一致的工具名', out.includes('ghost_tool'), out.slice(-400))
}

console.log('\n== 5. 完全没有 `lh` 段：必须红 ==')
{
  rmSync(join(fakeRoot, 'plugins'), { recursive: true, force: true })
  writePlugin('no-lh', ['index.js', 'context.js', 'topics.js'], {}, null)
  const { code, out } = runGate()
  check('闸门必须红', code !== 0, `退出码 ${code}`)
  check('报错说的是"缺 lh 自我描述"', out.includes('缺 `lh` 自我描述'), out.slice(-300))
}

rmSync(fakeRoot, { recursive: true, force: true })

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) process.exit(1)
console.log('闸门在四种状态下都表现正确：files 漏登记 / 幽灵文件 / lh 声明漂移 / 缺 lh 段 / 正常。\n')
