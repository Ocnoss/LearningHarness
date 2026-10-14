/**
 * 提取宿主主题插件里"浅色块"与"深色块"的静态调色板取值，用来对齐我们的刻度。
 *
 * 为什么要这么麻烦：宿主的 CSS 被压在一个大字符串里，
 * 而 --dsw-static-neutral-bluish-* 同时出现在两个块中（浅色 body{} 与深色 body[data-ds-dark-theme]{}），
 * 用正则直接全局搜会把两者混在一起（我第一次就因此得出"深色和浅色取值相同"的错误结论）。
 * 这里按标记位置切分再分别解析。
 */
import { readFileSync } from 'node:fs'

const FILE =
  'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-client-ui-theme\\lib\\client.js'

const src = readFileSync(FILE, 'utf8')

// 宿主的样式分成多对「浅色块 + 深色块」：
//   第 1 对：静态调色板（--dsw-static-*），两个块取值【相同】
//   第 2 对：别名映射（--dsw-alias-*），这才是模式差异真正所在
// 因此不能只找第一处 data-ds-dark-theme——那会与浅色块的调色板对上，得出"两模式相同"的错误结论。
const aliasLight = src.indexOf('body{--dsw-alias-')
const aliasDark = src.indexOf('body[data-ds-dark-theme]{--dsw-alias-')

if (aliasLight < 0 || aliasDark < 0) {
  console.error(`定位失败：aliasLight=${aliasLight} aliasDark=${aliasDark}`)
  process.exit(1)
}

/**
 * 从给定起点取出一个 CSS 块。
 * 宿主这些块内不含嵌套花括号，但**块很长**（别名块约 5KB），
 * 所以按配平花括号扫描而不是取第一个 '}'——否则会截断。
 * @param start - 块起点索引。
 * @returns 块内文本。
 */
function blockAt(start) {
  const open = src.indexOf('{', start)
  let depth = 1
  let i = open + 1
  while (i < src.length && depth > 0) {
    const ch = src[i]
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    i += 1
  }
  return src.slice(open + 1, i - 1)
}

/**
 * 解析块内的变量。
 * @param block - 块文本。
 * @param prefix - 变量前缀。
 * @returns 名称（去掉前缀）到取值的映射。
 */
function vars(block, prefix) {
  const out = {}
  for (const m of block.matchAll(new RegExp(`${prefix}([\\w-]+):([^;}]+)`, 'g'))) {
    out[m[1]] = m[2].trim()
  }
  return out
}

const lightAlias = vars(blockAt(aliasLight), '--dsw-alias-')
const darkAlias = vars(blockAt(aliasDark), '--dsw-alias-')

const aliasKeys = [...new Set([...Object.keys(lightAlias), ...Object.keys(darkAlias)])].sort()
console.log('=== 别名映射：浅色 vs 深色（只列两者不同的）===')
console.log('别名                                  浅色 ->                        深色 ->')
console.log('─'.repeat(110))
let diff = 0
for (const k of aliasKeys) {
  const l = lightAlias[k]
  const d = darkAlias[k]
  if (l === d) continue
  diff += 1
  console.log(`${k.padEnd(38)}${(l ?? '（未定义）').padEnd(31)}${d ?? '（未定义）'}`)
}
console.log(`\n共 ${aliasKeys.length} 个别名，其中 ${diff} 个在两模式下不同。`)


