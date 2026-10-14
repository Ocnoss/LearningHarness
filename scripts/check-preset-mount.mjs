/**
 * 离线模拟 preset 挂载 —— 在重启之前就发现"某一行不激活"。
 *
 * ═══ 为什么这个脚本值得存在 ═══
 * `preset row 不激活 → 该 preset 的所有会话都建不起来`（ARCHITECTURE §0.1 约束 6）。
 * 而 `discoverPresets()` 的 `broken` 字段**只检查 YAML 形状**，查不出
 * "这一行在等一个不存在的服务"——那正是这个坑的实际形态。
 *
 * 所以加行之前必须回答两个问题，而它们都能离线回答：
 *   1. 这一行的文件能不能 import？（拼错路径、语法错、依赖缺失）
 *   2. 它声明的 `inject` 在 preset 作用域下有没有人提供？
 *
 * 第 2 点是最容易出错的地方：`inject: ['sessions']` 在 agent 作用域下
 * **可能永远等不到那个服务**，于是 apply 永不执行、插件静默不工作
 * （lh-event-store 早期就踩过：`waiting for lhEvents`，见 docs/experience）。
 *
 * 本脚本给出的结论是**近似**的：它用一个记账式的假 ctx 记录"谁在等什么、谁提供了什么"，
 * 而不是真的跑宿主加载器。它能抓住"等一个没人给的服务"这类错误，
 * 抓不住"宿主内部真的会怎么调度"。所以它是**加行前的筛子，不是重启的替代品**。
 *
 * 运行：node scripts/check-preset-mount.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * 要检查的 preset 文件。
 *
 * ⚠ 不许写死用户名/盘符（2026-10-14 审查后清理）：写死的后果是别人 clone 后
 * 这道闸门永远红在"文件不存在"上，而不是告诉他 preset 有没有问题。
 * 解析顺序：LH_PRESET 显式指定 → DSH_HOME/家目录的 dsh → 仓库自持的家（clone 必有）。
 */
const PRESET = (() => {
  const explicit = process.env.LH_PRESET
  if (explicit) return explicit
  const candidates = [
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets', 'lh', 'agent.cordis.yml'),
    join(homedir(), '.dsh', '.agent-presets', 'lh', 'agent.cordis.yml'),
  ]
  for (const p of candidates) if (existsSync(p)) return p
  return candidates[0]
})()

/**
 * 极简 YAML 行解析。
 *
 * 为什么手写而不装 yaml 包：这个格式是我们自己写的（`- id:` + `name: '...'`），
 * 形状固定。为一个只读自己文件的脚本引入依赖不值当。
 *
 * @param text - YAML 文本。
 * @returns 行数组 `{ id, name }`。
 */
function parseRows(text) {
  const rows = []
  const re = /^- id: (\S+)\s*\n\s*name: '([^']+)'/gm
  let m
  while ((m = re.exec(text)) !== null) rows.push({ id: m[1], name: m[2] })
  return rows
}

/**
 * 造一个"记账式"假 ctx：记录每一次 inject 请求，并把它当作**已满足**继续跑 apply。
 *
 * 这里的权衡要说清楚：把 inject 当作已满足会**放过**"服务不存在"的错误
 * （那正是我们要抓的）。所以除此之外还单独做一次静态判断：
 * 把每个插件声明的 `inject` 与服务提供者清单对照。
 * 两部分互补：动态部分验"代码能不能跑通"，静态部分验"它等的东西有没有人来给"。
 *
 * @param provided - 本 preset 内可提供的服务名集合。
 * @param log - 记录用的数组。
 * @param pluginId - 当前插件 id。
 * @returns 假 ctx。
 */
function makeProbeCtx(provided, log, pluginId) {
  const handlers = []
  const ctx = {
    inject(names, cb) {
      const list = Array.isArray(names) ? names : [names]
      log.push({ plugin: pluginId, kind: 'inject', names: list })
      if (typeof cb === 'function') {
        // 只有当依赖"已由前序插件提供"时才真的调用回调——
        // 否则回调本身可能因为服务缺失而抛错，那会掩盖我们真正想看的结论。
        if (list.every((n) => provided.has(n))) {
          try {
            cb(makeProbeCtx(provided, log, pluginId))
          } catch (error) {
            log.push({ plugin: pluginId, kind: 'inject-callback-threw', names: list, message: error?.message ?? String(error) })
          }
        } else {
          log.push({ plugin: pluginId, kind: 'inject-unsatisfied', names: list })
        }
      }
      return ctx
    },
    on(event, handler) {
      handlers.push({ event, handler })
      return ctx
    },
    plugin(sub) {
      log.push({ plugin: pluginId, kind: 'plugin', value: typeof sub === 'function' ? sub.name || '(anonymous)' : String(sub) })
      return ctx
    },
    tools: {
      register(def) {
        log.push({ plugin: pluginId, kind: 'tool', name: def?.name })
        // 镜像真 ctx.tools.register 的硬校验（dsh-tools/lib/index.js:2762-2769）：
        // 缺 output{schema,render} 或占用保留名 run_code，会在真运行时抛 TypeError、
        // 拖垮整个 preset 挂载（症状：选该 preset 瞬间弹回可用模式）。
        // 假 ctx 原来只记名字、不校验 → 假绿放行（probe_spawn 缺 output 的事故就是这么漏过去的）。
        const out = def?.output
        if (out === undefined || typeof out !== 'object' || typeof out.render !== 'function' || out.schema === undefined) {
          log.push({ plugin: pluginId, kind: 'tool-missing-output', name: def?.name })
        }
        if (def?.name === 'run_code') log.push({ plugin: pluginId, kind: 'tool-reserved-name', name: def?.name })
      },
    },
    systemPrompt: {
      context(def) {
        log.push({ plugin: pluginId, kind: 'systemPrompt-context', name: def?.name })
      },
    },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    effect() {},
    set() {},
    get() {},
  }
  ctx.fork = () => ctx
  ctx.extend = () => ctx
  return ctx
}

console.log('\n══ 1. 读 preset ══')

if (!existsSync(PRESET)) {
  console.error(`找不到 preset：${PRESET}`)
  process.exit(1)
}
const raw = readFileSync(PRESET, 'utf8')
const rows = parseRows(raw)
console.log(`  解析出 ${rows.length} 行`)
for (const r of rows) console.log(`    ${r.id}`)

// ═══ 一行都没有 = **红灯**，不是"没事" ═══
// 这是自检（`selftest-preset-mount.mjs` 用例 4）逼出来的：
// 如果 YAML 被改坏（缩进错、引号错），解析器会安静地得到 0 行——
// 而"0 行"在挂载时的真实后果正是**该 preset 的所有会话都建不起来**。
// 原来的脚本会打印"加载失败 0 行"然后退出码 0，等于把最坏的形态报成通过。
if (rows.length === 0) {
  console.log('\n══ 结论 ══')
  console.log('  **解析出 0 行** —— 这不可能是"没事"：要么 preset 被清空，要么 YAML 被改坏到解析不出来。')
  console.log('  而它的真实后果是该 preset 的**所有会话都建不起来**。红灯。')
  process.exit(1)
}

console.log('\n══ 2. 文件可达性与导出形状 ══')

/**
 * 判断一行是不是"裸包名"（由**宿主**解析，而不是文件路径）。
 *
 * ═══ 为什么要区分（2026-09-20 实测的盲点）═══
 * 本闸门原来只认工作区里的文件路径。于是把 standard preset 的基础能力行
 * （`@deepseek-ai/dsh-tool-pwsh` 这类裸包名）加进 LH preset 后，它一律报
 * "文件不存在"——**那是闸门的盲点，不是配置的错**。
 * 而"闸门对正确的配置报错"比"闸门漏掉错误的配置"更糟：它会让人去改一个对的东西。
 *
 * 裸包名不能 import（本进程解析不到宿主的包），但**能找到它就说明宿主装得上**：
 * 在 dsh 自己的安装根里按 `node_modules/<包名>` 找。
 *
 * @param name - 行里的 name。
 * @returns 找到了返回安装路径，否则 null。
 */
function resolveHostPackage(name) {
  if (name.startsWith('.') || /^[A-Za-z]:/.test(name)) return null // 文件路径，交给原逻辑
  // 宿主包住在 dsh **安装根自己的** node_modules 里（实测：
  // `…npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-pwsh`），
  // 不是全局 npm 根那一层——第一版只查了全局根，于是 8 行全报"找不到"。
  // 基目录从**当前机器**推（npm 全局根 + node 安装目录），不写死用户名/盘符。
  const npmRoot = process.env.APPDATA ? `${process.env.APPDATA}/npm/node_modules` : join(homedir(), '.npm-global', 'node_modules')
  const bases = [`${npmRoot}/@deepseek-ai/dsh/node_modules`, npmRoot, join(dirname(process.execPath), 'node_modules')]
  for (const base of bases) {
    const p = join(base, name)
    if (existsSync(p)) return p
  }
  return { missing: true }
}

const loaded = []
let loadFailed = 0
let hostRows = 0

for (const row of rows) {
  const path = row.name.replace(/\\/g, '/')
  const host = resolveHostPackage(row.name)
  if (host !== null) {
    hostRows += 1
    if (host.missing === true) {
      console.log(`  FAIL  ${row.id}：宿主包找不到 ${row.name}（宿主装了才挂得上）`)
      loadFailed += 1
    } else {
      // 这类行的 `apply` 由宿主加载器调用，本进程 import 不了它的裸名——
      // 所以只核对"包在不在"，并**如实标注核对到哪一步**。
      console.log(`  ok    ${row.id}  ${row.name}（宿主包，已核对存在于 ${host}；无法在本进程 import 验证导出）`)
    }
    continue
  }
  if (!existsSync(path)) {
    console.log(`  FAIL  ${row.id}：文件不存在 ${row.name}`)
    loadFailed += 1
    continue
  }
  try {
    const mod = await import(pathToFileURL(path).href)
    if (typeof mod.apply !== 'function') {
      console.log(`  FAIL  ${row.id}：没有导出 apply 函数（宿主不会挂载它）`)
      loadFailed += 1
      continue
    }
    const inject = Array.isArray(mod.inject) ? mod.inject : mod.inject === undefined ? [] : [mod.inject]
    loaded.push({ row, mod, inject })
    console.log(`  ok    ${row.id}  name=${mod.name ?? '(未导出)'}  inject=[${inject.join(', ')}]`)
  } catch (error) {
    console.log(`  FAIL  ${row.id}：import 失败 —— ${error?.message ?? String(error)}`)
    loadFailed += 1
  }
}

console.log('\n══ 3. 服务供需对照（"等一个没人给的服务"是沉默失败的主要形态）══')

/**
 * 宿主提供的服务名白名单。
 *
 * ═══ 为什么必须区分"宿主给的"和"preset 该给的" ═══
 * 第一版没有这份清单，于是把 `tools` / `sessions` / `llm` / `systemPrompt`
 * 全报成了"没有提供者"——**六条全是误报**。
 * 一个满屏误报的检查器等于没有检查器：人会学会忽略它，于是真正的那条也被忽略。
 * 所以宁可这里写死一份可能过时的白名单，也不要输出噪声。
 *
 * 依据：ARCHITECTURE §0.1 约束 5 实测确认 preset 作用域能拿到
 * `ctx.llm` / `ctx.systemPrompt` / `ctx.tools` / `ctx.sessions`。
 */
const HOST_PROVIDED = new Set(['tools', 'sessions', 'llm', 'systemPrompt', 'sessionProjections', 'jobs', 'skills', 'commands', 'approval', 'fs', 'shell', 'subagents'])

// preset 内部提供的服务：目前没有一行用 ctx.plugin(ServiceClass) 提供服务。
// 注意 `lhEvents` 是 lh-event-store 通过 ctx.plugin 提供的**类名**，
// 但其它插件并不 inject 它（它们直接 import，见 ADR-014 补充决定 6），所以不在依赖里。
const presetProvided = new Set()

let pending = 0
for (const { row, inject } of loaded) {
  for (const svc of inject) {
    if (presetProvided.has(svc)) {
      console.log(`  ok    ${row.id} 等的 ${svc} 由本 preset 内提供`)
    } else if (HOST_PROVIDED.has(svc)) {
      console.log(`  ok    ${row.id} 等的 ${svc} 由宿主提供`)
    } else {
      // 这一条才是真正的危险信号：preset 内部没人给、宿主也不给
      console.log(`  ⚠ 危险  ${row.id} 声明 inject: ['${svc}']，但既非宿主提供、本 preset 内也没有提供者`)
      console.log(`          → 这一行会静默等待，apply 永不执行；若宿主判定为挂载失败，整个 preset 的会话都会不可用`)
      pending += 1
    }
  }
}

console.log('\n══ 4. 试跑 apply（记账式假 ctx）══')

const log = []
for (const { row, mod } of loaded) {
  const provided = new Set([...presetProvided, ...loaded.flatMap((l) => l.inject)])
  try {
    mod.apply(makeProbeCtx(provided, log, row.id))
    console.log(`  ok    ${row.id}.apply() 执行完毕`)
  } catch (error) {
    console.log(`  FAIL  ${row.id}.apply() 抛错 —— ${error?.message ?? String(error)}`)
    loadFailed += 1
  }
}

console.log('\n  注册动作：')
for (const entry of log.filter((l) => l.kind === 'tool')) console.log(`    工具 ${entry.name}（来自 ${entry.plugin}）`)
for (const entry of log.filter((l) => l.kind === 'systemPrompt-context')) console.log(`    上下文 ${entry.name}（来自 ${entry.plugin}）`)
for (const entry of log.filter((l) => l.kind === 'plugin')) console.log(`    子插件 ${entry.value}（来自 ${entry.plugin}）`)

// 工具契约违规：真运行时 ctx.tools.register 会招 TypeError → apply 抛错 → 整个 preset 挂载失败。
// 这是“选 preset 瞬间弹回”的一类真凶，而 discoverPresets 的 broken 只查 YAML 形状、查不出来。
const badTools = log.filter((l) => l.kind === 'tool-missing-output' || l.kind === 'tool-reserved-name')
if (badTools.length > 0) {
  console.log('\n  ✗ 工具契约违规（真运行时 register 会抛错 → 拖垮整个 preset 挂载 → 选该 preset 弹回）：')
  for (const b of badTools) {
    console.log(`    ${b.kind === 'tool-missing-output' ? '缺 output{schema,render}' : '占用保留名 run_code'}：工具 ${b.name}（来自 ${b.plugin}）`)
  }
  loadFailed += badTools.length
}

const unsatisfied = log.filter((l) => l.kind === 'inject-unsatisfied')
if (unsatisfied.length > 0) {
  console.log('\n  未被假 ctx 满足的 inject（不代表真实环境有问题）：')
  for (const e of unsatisfied) {
    const hostSide = e.names.every((n) => HOST_PROVIDED.has(n))
    console.log(`    ${e.plugin} 等 [${e.names.join(', ')}]${hostSide ? '  ← 宿主提供的服务，假 ctx 模拟不了，属正常' : '  ← 需要人工确认'}`)
  }
}

console.log('\n══ 结论 ══')
console.log(`  加载失败 ${loadFailed} 行（另有 ${hostRows} 行是宿主包：只核对了"包存在"，未验导出）；inject 无提供者 ${pending} 处；未满足 inject 回调 ${unsatisfied.length} 处`)
console.log('')
console.log('  提醒：本脚本是**加行前的筛子，不是重启的替代品**。')
console.log('  它证明的是"文件能加载、apply 不抛错"，不能证明宿主真的会这样调度。')
console.log('  新增行之后仍然必须在真实会话里验证一次（ARCHITECTURE §0.1 约束 6）。')

process.exit(loadFailed > 0 ? 1 : 0)
