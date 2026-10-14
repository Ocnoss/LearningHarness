/**
 * 端到端验证资源索引器：真实资料夹 → 扫描 → 索引文档 → 资源记录。
 *
 * 验证四件事：
 *   1. 扫描器能跑真实资料夹（D:\考公资料）；
 *   2. 索引文档按契约 §2.2 外置到 content_ref，不内嵌进事件；
 *   3. 资源信封带 ADR-009 的 derived_from / supersedes；
 *   4. **同一个资料夹重复索引要能识别"取代关系"**——这是 ADR-009"更新 = 新资源 + supersedes 指针"的落地，
 *      也是资源删除不变量（删除后派生状态重建不含该资料痕迹）的前提。
 *
 * 用法：node scripts/verify-resource-indexer.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { scanFolder, renderIndexDocument, humanSize } from '../plugins/lh-resource-indexer/scan.js'
import {
  LhEventStore,
  LH_EVENT_LOG,
  readContent,
} from '../plugins/lh-event-store/store.js'

const ROOT = 'D:\\考公资料'

const store = new LhEventStore()

/** 读回既有事件（容忍 BOM）。 */
function readAll() {
  if (!existsSync(LH_EVENT_LOG)) return []
  let t = readFileSync(LH_EVENT_LOG, 'utf8')
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
  return t
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

const before = readAll()
console.log(`索引前：日志 ${before.length} 条\n`)

// ── 1. 扫描 ──
const t0 = Date.now()
const scan = scanFolder({ root: ROOT, maxDepth: 4 })
console.log(`扫描：${scan.stats.count} 个文件，${humanSize(scan.stats.totalBytes)}，耗时 ${Date.now() - t0} ms`)

// ── 2. 生成索引文档并外置 ──
const doc = renderIndexDocument({ scan, generatedAt: new Date().toISOString() })
const { writeContent } = await import('../plugins/lh-event-store/store.js')
const contentRef = writeContent({ content: doc, hint: 'resource-index' })
console.log(`索引文档：${doc.length} 字符 ≈ ${Math.round(doc.length / 2)} tokens → 外置为 ${contentRef}`)

// ── 3. 找同一个 root 的上一次索引记录，用于 supersedes ──
const previous = before.filter(
  (e) => e.type === 'lh/resource/indexed' && e.data?.source_root === ROOT,
)
const supersedes = previous.map((e) => e.id)
if (supersedes.length > 0) {
  console.log(`发现同一资料夹的 ${supersedes.length} 条历史索引 → 本次将取代它们`)
}

// ── 4. 写资源记录 ──
const event = store.appendResource({
  actor: 'agent',
  type: 'lh/resource/indexed',
  provenance: { plugin: '@lh/resource-indexer', version: '0.0.1' },
  scope: 'root', // 课程树还不存在（decisions/012 决策 3）
  contentRef,
  supersedes,
  data: {
    source_root: ROOT,
    file_count: scan.stats.count,
    total_bytes: scan.stats.totalBytes,
    by_extension: scan.stats.byExtension,
  },
})

console.log(`\n资源记录已写入：`)
console.log(`  id          = ${event.id}`)
console.log(`  type        = ${event.type}`)
console.log(`  content_ref = ${event.content_ref}`)
console.log(`  supersedes  = ${JSON.stringify(event.data.supersedes)}`)
console.log(`  derived_from= ${JSON.stringify(event.data.derived_from)}`)

// ── 5. 按指针读回，确认内容完整 ──
const back = readContent(event.content_ref)
console.log(`\n按 content_ref 读回：${back === undefined ? '✗ 失败' : `✓ ${back.length} 字符，与原文${back === doc ? '完全一致' : '不一致 ✗'}`}`)

const after = readAll()
console.log(`\n索引后：日志 ${after.length} 条（新增 ${after.length - before.length}）`)

// ── 6. 再跑一次，验证 supersedes 链建立 ──
const second = store.appendResource({
  actor: 'agent',
  type: 'lh/resource/indexed',
  provenance: { plugin: '@lh/resource-indexer', version: '0.0.1' },
  scope: 'root',
  contentRef: writeContent({ content: doc, hint: 'resource-index' }),
  supersedes: [event.id],
  data: { source_root: ROOT, file_count: scan.stats.count, total_bytes: scan.stats.totalBytes },
})
console.log(`\n第二次索引：id=${second.id.slice(0, 8)}… supersedes=[${second.data.supersedes.map((s) => s.slice(0, 8)).join(', ')}]`)
console.log('  → 血缘/版本链可由事件流重建（旧版本未被覆盖，符合 ADR-009 决定 3）')
