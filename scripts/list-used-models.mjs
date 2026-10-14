/**
 * 列出会话日志里真实出现过的模型与提供方。
 *
 * 为什么要从日志取而不是照抄配置：配置里写的名字可能与实际用到的不一致
 * （拼错、别名、或某个 provider 的模型 id 与界面显示名不同）。
 * 而 LH 的 recommend_model 最终要落到**准确的 provider + model 字符串**上，
 * 拼错的表现是"调用失败"或"静默走到降级"——所以以事实为准。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = 'C:\\Users\\Administrator\\.dsh\\sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 递归找出所有会话日志。
 * @param dir - 起始目录。
 * @returns 路径与大小。
 */
function findLogs(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findLogs(full))
    else if (entry.name.startsWith('session.jsonl')) out.push({ file: full, size: statSync(full).size })
  }
  return out
}

/**
 * 逐帧解压。
 * @param buf - 文件内容。
 * @returns 解压文本。
 */
function decode(buf) {
  const parts = []
  let pos = 0
  while (pos < buf.length) {
    const next = buf.indexOf(MAGIC, pos + MAGIC.length)
    const end = next === -1 ? buf.length : next
    try {
      parts.push(zstdDecompressSync(buf.subarray(pos, end)).toString('utf8'))
    } catch {
      break
    }
    pos = end
  }
  return parts.join('')
}

/** provider → model 集合。 */
const byProvider = new Map()
/** 另一个可能的存放位置：request/header 里的 config。 */
const headerPairs = new Set()

for (const { file } of findLogs(SESSIONS)) {
  let text
  try {
    text = decode(readFileSync(file))
  } catch {
    continue
  }

  // assistant/message 的 message.source = { kind:'model', provider, model }
  for (const m of text.matchAll(/"kind":"model","provider":"([^"]+)","model":"([^"]+)"/g)) {
    const [, provider, model] = m
    if (!byProvider.has(provider)) byProvider.set(provider, new Set())
    byProvider.get(provider).add(model)
    void headerPairs
  }
}

console.log('=== 会话日志里真实使用过的 provider / model ===')
if (byProvider.size === 0) {
  console.log('  （没有找到 —— 可能是匹配模式与真实格式不符）')
} else {
  for (const [provider, models] of [...byProvider].sort()) {
    console.log(`  ${provider}:`)
    for (const model of [...models].sort()) console.log(`    ${model}`)
  }
}
