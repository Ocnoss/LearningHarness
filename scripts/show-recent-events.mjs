/**
 * 看事件日志最近几条是什么、来自哪个会话。
 *
 * 为什么需要它：日志条数无声地从 27 涨到 30，而这段时间没有任何学习操作。
 * "多出来的记录"必须能解释——尤其当记录器本该只记学习会话时，
 * 多出来的记录可能意味着筛选失效（那就是"开发对话被写进学习史"那个老问题复发）。
 *
 * 用法: node scripts/show-recent-events.mjs [条数]
 */

import { readFileSync } from 'node:fs'

const n = Number(process.argv[2] ?? 6)
const path = process.env.LH_EVENT_LOG ?? 'data/events.jsonl'

const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
const events = raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

console.log(`共 ${events.length} 条事件，最后 ${n} 条：`)
console.log('')

for (const e of events.slice(-n)) {
  console.log(`[${e.timestamp}] ${e.type}`)
  console.log(`   actor=${e.actor}  scope=${e.scope}  session=${e.session_ref ?? '(无)'}`)
  console.log(`   provenance=${JSON.stringify(e.provenance)}`)
  const d = e.data ?? {}
  const keys = Object.keys(d)
  console.log(`   data keys: ${keys.join(', ')}`)
  if (keys.length) {
    const brief = {}
    for (const k of keys.slice(0, 6)) {
      const v = d[k]
      brief[k] = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '…' : v
    }
    console.log(`   data: ${JSON.stringify(brief)}`)
  }
  console.log('')
}

// 按类型与会话汇总，便于一眼看出有没有异常来源
const byType = {}
const bySession = {}
for (const e of events) {
  byType[e.type] = (byType[e.type] ?? 0) + 1
  const s = e.session_ref ?? '(无)'
  bySession[s] = (bySession[s] ?? 0) + 1
}
console.log('按类型:', JSON.stringify(byType))
console.log('按会话:', JSON.stringify(bySession, null, 2))
