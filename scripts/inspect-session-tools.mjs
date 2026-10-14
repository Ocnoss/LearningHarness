/**
 * 从**宿主的会话日志**里找出这次 LH 会话实际拿到的工具清单。
 *
 * ═══ 为什么要这么做（而不是"看组合文件推断"）═══
 * 要回答"LH 会话里的 agent 能不能自己跑完题目入库全流程"，唯一可靠的答案是
 * **它手上真的有哪些工具**。而组合文件只能告诉我"我挂了哪几行"：
 * 基础工具（shell / 文件 / 网络）来自宿主自己的 bundle，不在我的 preset 里，
 * 所以我不能靠读 preset 得出结论——那会变成猜。
 *
 * 宿主会话日志里记着每次请求的 header（含工具清单），本脚本把它挖出来。
 * 这是"LH 记坐标而不是抄内容"那条路线的又一次应用：宿主日志可被独立读取。
 *
 * 用法: node scripts/inspect-session-tools.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = join(process.env.USERPROFILE ?? 'C:\\Users\\Administrator', '.dsh', 'sessions')
/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 递归找出所有会话日志。
 *
 * @param dir - 起始目录。
 * @returns `[{ path, mtime, size }]`。
 */
function findLogs(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findLogs(full))
    else if (entry.name.endsWith('.zstd')) {
      const st = statSync(full)
      out.push({ path: full, mtime: st.mtimeMs, size: st.size })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/**
 * 逐帧解压（多帧拼接的日志，`zstdDecompressSync` 只解第一帧）。
 *
 * @param buf - 文件内容。
 * @returns 解压后的文本。
 */
function decodeFrames(buf) {
  const parts = []
  let cursor = 0
  while (cursor < buf.length) {
    const next = buf.indexOf(MAGIC, cursor + 4)
    const end = next === -1 ? buf.length : next
    try {
      parts.push(zstdDecompressSync(buf.subarray(cursor, end)).toString('utf8'))
    } catch {
      /* 单帧解不开就跳过，不要让整次读取失败 */
    }
    if (next === -1) break
    cursor = next
  }
  return parts.join('')
}

const logs = findLogs(SESSIONS)
if (logs.length === 0) {
  console.error(`没有找到会话日志：${SESSIONS}`)
  process.exit(2)
}

// 取最近两个日志（最新的那个可能正是当前会话）
for (const log of logs.slice(0, 2)) {
  const text = decodeFrames(readFileSync(log.path))
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  console.log(`\n=== ${log.path}  (${lines.length} 条事件) ===`)

  const toolNames = new Set()
  let presetId = null
  let modelName = null
  for (const line of lines) {
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    // 工具定义：各种可能的位置都翻一遍（不假设形状）
    const candidates = [ev?.data?.tools, ev?.data?.header?.tools, ev?.tools, ev?.data?.request?.tools, ev?.data?.config?.tools]
    for (const c of candidates) {
      if (Array.isArray(c)) {
        for (const t of c) {
          const n = typeof t === 'string' ? t : (t?.name ?? t?.function?.name)
          if (typeof n === 'string') toolNames.add(n)
        }
      }
    }
    if (presetId === null && typeof ev?.data?.agentPreset === 'string') presetId = ev.data.agentPreset
    if (modelName === null && typeof ev?.data?.model === 'string') modelName = ev.data.model
  }

  if (toolNames.size === 0) {
    // 没找到就如实说"没找到"，并给出事件的类型分布，便于下一步查哪
    const types = new Map()
    for (const line of lines) {
      try {
        const ev = JSON.parse(line)
        const t = String(ev?.type ?? '(无 type)')
        types.set(t, (types.get(t) ?? 0) + 1)
      } catch {
        /* 忽略 */
      }
    }
    console.log('  没找到工具清单。事件类型分布（前 12）:')
    for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${t}  ×${n}`)
  } else {
    console.log(`  工具清单（${toolNames.size} 个）：`)
    console.log('    ' + [...toolNames].sort().join(', '))
    if (presetId !== null) console.log(`  agentPreset: ${presetId}`)
    if (modelName !== null) console.log(`  model: ${modelName}`)
  }
}
