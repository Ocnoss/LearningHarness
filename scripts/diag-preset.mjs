/**
 * 诊断：确认 lh preset 的当前状态，以及插件文件本身能不能被加载。
 *
 * 为什么需要它：加了 inject 之后如果服务缺失，整行不会激活、apply() 不执行，
 * 表现就是"证据文件不存在"，看不出原因。这个脚本把可离线判断的部分先判掉：
 *   1. preset 是否被发现、是否被标 broken
 *   2. 组合文件里的行内容
 *   3. 插件文件能否被 Node 直接 import（语法、依赖、导出形状）
 *
 * 用系统自带的 dsh 安装路径与 DSH_HOME，尽量不依赖我手工拼的常量。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const npmRoot = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules')
const shippedRoot = join(npmRoot, '@deepseek-ai', 'dsh', 'config', 'agent-presets')
const homeRoot = join(dshHome, '.agent-presets')

// 注意：动态 import 必须用 file: URL。
// 直接传 Windows 绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
// （Node 把 "C:" 当成 URL scheme）。这条坑在文档里记过一次，我这次又踩了。
const presetsModule = pathToFileURL(
  join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'lib', 'index.js'),
).href
const { discoverPresets } = await import(presetsModule)

console.log('=== 1. preset 发现 ===')
const presets = await discoverPresets([
  { path: shippedRoot, trust: 'system' },
  { path: homeRoot, trust: 'user' },
])
for (const p of presets) {
  const bad = p.broken ? `  [broken] ${p.broken}` : ''
  console.log(`  id=${p.id}  trust=${p.trust}${bad}`)
}

const lh = presets.find((p) => p.id === 'lh')
if (lh === undefined) {
  console.log('\n结论：lh preset 没被发现')
  process.exit(1)
}
if (lh.broken) {
  console.log(`\n结论：lh preset 组合文件不可加载 —— ${lh.broken}`)
  process.exit(1)
}

console.log('\n=== 2. 组合文件内容 ===')
const composition = readFileSync(lh.path, 'utf8')
for (const line of composition.split('\n')) {
  if (line.trim() !== '' && !line.trim().startsWith('#')) console.log(`  ${line}`)
}

console.log('\n=== 3. 插件文件能否被加载 ===')
const pluginPath = 'D:\\LearningHarnessv0.1\\plugins\\lh-resource-indexer\\index.js'
try {
  const mod = await import(pathToFileURL(pluginPath).href)
  console.log('  导入成功')
  console.log(`  导出：${Object.keys(mod).join(', ')}`)
  console.log(`  name = ${mod.name}`)
  console.log(`  inject = ${JSON.stringify(mod.inject)}`)
  console.log(`  apply 是函数 = ${typeof mod.apply === 'function'}`)
} catch (error) {
  console.log(`  导入失败：${error.code ?? error.name}: ${error.message}`)
}
process.exit(0)
