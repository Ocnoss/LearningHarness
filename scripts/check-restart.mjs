/**
 * 重启检查器：判断"当前跑着的 dsh 是否已经加载了你最新的插件代码"。
 *
 * 为什么需要它（这次真的踩了）：
 *   1. 宿主的 web profile 把服务端 HMR 关了（`dsh-web-app/cordis.patch.yml` 里
 *      `- id: hmr / disabled: true`），所以**插件代码改动必须重启 dsh 才生效**。
 *   2. 我改完代码就让作者测，作者没重启 → 测的是旧代码 → 我据此得出错误结论，
 *      白排查了一轮。
 *
 * 判据很简单：**dsh 进程的启动时间 是否 晚于 插件文件与 preset 文件的修改时间。**
 * 早于 = 需要重启。
 *
 * 用法：node scripts/check-restart.mjs
 *
 * 退出码约定（**故意如此**，便于将来做前置检查）：
 *   0 = 已加载最新代码，可以直接测试
 *   1 = 需要重启 dsh（注意：这不是脚本出错）
 *   2 = 没有正在运行的 dsh
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// 以脚本自己的位置推仓库根——写死盘符的后果是别人 clone 后这道闸门看的是一个不存在的目录
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')
const PRESET_FILE = join(
  process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  '.agent-presets',
  'lh',
  'agent.cordis.yml',
)

/**
 * 找出所有 dsh 进程的启动时间。
 *
 * ═══ 这里曾经把整台机器拖垮（2026-09-18，代价约 40 分钟）═══
 * 原实现是：
 *
 *     Get-Process node | ForEach-Object { Get-CimInstance … -Filter "ProcessId=$($_.Id)" }
 *
 * 即**对每一个 node 进程各发一次 WMI 查询**。本机正常时只有几个 node 进程，
 * 所以"能用"；但当进程数涨到几百（见 check-all.mjs 的自我递归事故）时，
 * 这个循环变成几百次串行 WMI 查询，**每次都是几十到几百毫秒**——
 * 于是它不仅自己变成分钟级，还把整机的 WMI 拖住，
 * 连 dsh 自己申请子进程输出缓冲都失败并崩掉（ENOENT，临时目录取不到）。
 *
 * 两条修法，缺一不可：
 *   1. **一次查询拿到全部**（`-Filter "Name='node.exe'"`，CommandLine 与
 *      CreationDate 都在同一次结果里），命令行过滤放在**本地**做；
 *   2. **给子进程设硬超时**。闸门卡住最多是"这道闸门没结果"，
 *      绝不能是"整台机器卡住"。
 *
 * 注意：`Get-Process` 在 Windows PowerShell 5.1 里没有 CommandLine 属性，
 * 所以仍然走 CIM；但**只查一次**。
 *
 * @returns 启动时间的毫秒数组；查询失败或超时返回 `[]`（调用方会当作"不知道"）。
 */
function dshStartTimes() {
  const script = [
    // 一次查询：所有 node 进程的 CommandLine + CreationDate。
    '$all = Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" -ErrorAction SilentlyContinue',
    "$found = $all | Where-Object { $_.CommandLine -like '*dsh*' } | ForEach-Object { $_.CreationDate.ToString('o') }",
    'if ($found) { $found | ConvertTo-Json -Compress } else { "[]" }',
  ].join('\n')

  let out = ''
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }).trim()
  } catch {
    return []
  }
  if (out === '') return []
  try {
    const parsed = JSON.parse(out)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map((v) => Date.parse(v)).filter((n) => Number.isFinite(n))
  } catch {
    return []
  }
}

/**
 * 收集需要比对的文件修改时间。
 * @returns 每项含 path 与 mtime（毫秒）。
 */
function sourceTimes() {
  const result = []
  for (const entry of readdirSync(PLUGIN_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(PLUGIN_DIR, entry.name, 'index.js')
    try {
      result.push({ path: file, mtime: statSync(file).mtimeMs })
    } catch {
      /* 该目录下没有 index.js，跳过 */
    }
  }
  try {
    result.push({ path: PRESET_FILE, mtime: statSync(PRESET_FILE).mtimeMs })
  } catch {
    /* preset 文件不存在 */
  }
  return result
}

const starts = dshStartTimes()
const sources = sourceTimes()

const fmt = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
const newestSource = sources.reduce((a, b) => (b.mtime > a.mtime ? b : a), sources[0])

console.log('=== dsh 进程启动时间 ===')
if (starts.length === 0) {
  console.log('  （没有发现正在运行的 dsh 进程）')
} else {
  for (const t of starts) console.log(`  ${fmt(t)}`)
}

console.log('\n=== 源码最后修改时间 ===')
for (const s of sources) console.log(`  ${fmt(s.mtime)}  ${s.path}`)

console.log('\n=== 结论 ===')
if (starts.length === 0) {
  console.log('  dsh 未运行：现在启动它就会加载最新代码。')
} else if (Math.max(...starts) >= newestSource.mtime) {
  console.log('  ✓ 已加载最新代码，可以直接测试。')
} else {
  console.log('  ✗ 需要重启 dsh —— 当前进程启动于最新改动之前。')
  console.log(`    dsh 启动：${fmt(Math.max(...starts))}`)
  console.log(`    最后改动：${fmt(newestSource.mtime)}  (${newestSource.path})`)
}

// 顺带报告证据文件状态，避免再把"文件不存在"误读成"插件没激活"
const evidence = join(PLUGIN_DIR, 'lh-hello', 'evidence.log')
try {
  const st = statSync(evidence)
  console.log(`\n=== 证据文件 ===\n  最后写入：${fmt(st.mtimeMs)}  (${st.size} 字节)`)
  console.log('  注意：文件存在且是旧的，不代表本次会话没跑插件——')
  console.log('        同一进程内一个会话只写一次，旧时间戳属于上一个会话。')
} catch {
  console.log('\n=== 证据文件 ===\n  不存在（该插件在本进程内尚未激活过）')
}

// 顺便打印证据文件末尾几行，省得再单独打开
try {
  const lines = readFileSync(evidence, 'utf8').trim().split('\n')
  console.log('\n=== 证据文件末尾 6 行 ===')
  for (const line of lines.slice(-6)) console.log(`  ${line}`)
} catch {
  /* 已在上方报告 */
}

// 退出码：见文件头的约定。1 表示"需要重启"，不是脚本失败——
// 起初没写明这一点，我自己都把它误读成了崩溃，故补上显式说明。
console.log('')
if (starts.length === 0) {
  console.log('退出码 2 = 没有正在运行的 dsh')
  process.exit(2)
}
if (Math.max(...starts) >= newestSource.mtime) {
  console.log('退出码 0 = 已加载最新代码')
  process.exit(0)
}
console.log('退出码 1 = 需要重启 dsh（这不是脚本出错）')
process.exit(1)
