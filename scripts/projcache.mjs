/**
 * LH 投影缓存维护工具。
 *
 * 背景（为什么要这个工具）：
 *   投影缓存文件（$DSH_HOME/storages/session_projcache.json）里存着每个会话的投影行。
 *   一旦某个插件的 schema 不合格被写进去，宿主读该会话的历史时就会崩
 *   （典型报错：registration.def.wire.viewSchema.parse is not a function）。
 *
 * 关键约束（踩过一次）：
 *   **必须在 dsh 停止时执行。** 运行中的 dsh 内存里持有那份坏注册，
 *   会在 turn/end 或会话销毁时用同一份坏 schema 把行重新写回去，
 *   于是"刚清完又出现"。web profile 关掉了服务端 HMR，
 *   插件代码改动本身也需要重启才生效——两件事都在同一次重启里解决。
 *
 * 用法：
 *   node scripts/projcache.mjs inspect            # 查看各单元的占用情况（只读）
 *   node scripts/projcache.mjs purge <key>        # 摘除指定单元（自动备份）
 *   node scripts/projcache.mjs purge lhHello      # 例如摘除 lh-hello 的单元
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'

const CACHE = 'C:\\Users\\Administrator\\.dsh\\storages\\session_projcache.json'
const [command, key] = process.argv.slice(2)

if (!existsSync(CACHE)) {
  console.error(`找不到投影缓存：${CACHE}`)
  process.exit(1)
}

/** 读取缓存文件。 */
function load() {
  return JSON.parse(readFileSync(CACHE, 'utf8'))
}

if (command === 'inspect') {
  const data = load()
  const sessions = Object.entries(data?.tables?.sessions ?? {})
  /** key -> 出现次数 */
  const counts = new Map()
  for (const [, record] of sessions) {
    for (const rowKey of Object.keys(record?.rows ?? {})) {
      counts.set(rowKey, (counts.get(rowKey) ?? 0) + 1)
    }
  }
  console.log(`缓存文件：${CACHE}`)
  console.log(`单元版本：${data?.unit?.version}   会话数：${sessions.length}`)
  console.log('\n各投影单元占用（key -> 会话数）：')
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`)
  }
  process.exit(0)
}

if (command === 'purge') {
  if (key === undefined || key === '') {
    console.error('用法：node scripts/projcache.mjs purge <key>')
    process.exit(1)
  }

  // 先提醒：这一步在 dsh 运行时做是无效的
  const { execSync } = await import('node:child_process')
  let running = ''
  try {
    running = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV', { encoding: 'utf8' })
  } catch {
    /* 查不到就当没在跑 */
  }
  if (running.includes('node.exe')) {
    console.log('提示：检测到 node.exe 正在运行。若其中包含 dsh，')
    console.log('      它内存里的旧注册会把行重新写回，本操作将无效——请先停止 dsh。\n')
  }

  const backup = `${CACHE}.bak-${Date.now()}`
  copyFileSync(CACHE, backup)
  const data = load()

  let removed = 0
  for (const [, record] of Object.entries(data?.tables?.sessions ?? {})) {
    if (record?.rows !== undefined && Object.hasOwn(record.rows, key)) {
      delete record.rows[key]
      removed += 1
    }
  }

  writeFileSync(CACHE, `${JSON.stringify(data, null, 2)}\n`, 'utf8')

  const after = readFileSync(CACHE, 'utf8')
  const left = (after.match(new RegExp(key, 'g')) ?? []).length
  console.log(`摘除 "${key}"：影响 ${removed} 个会话`)
  console.log(left === 0 ? '复核：无残留 ✓' : `复核：仍有 ${left} 处 ✗`)
  console.log(`备份：${backup}`)
  process.exit(0)
}

console.error('用法：node scripts/projcache.mjs inspect | purge <key>')
process.exit(1)
