/**
 * 契约自查器：把 `docs/PLUGIN_CONTRACT.md` 的清单变成可执行的检查。
 *
 * ═══ 它与另外四道闸门的分工 ═══
 * 那四道闸门验的是"**能不能跑起来**"（导入、apply、声明、schema）。
 * 本脚本验的是"**像不像一份合规的插件**"——即契约里那些
 * "写错了不会立刻报错，但迟早出事"的形状问题，例如：
 *   · 客户端 bundle 的 `id` 与 package.json 的 `name` 不一致；
 *   · `exports` 缺 `"./client"`（宿主就发现不了客户端半）；
 *   · list 型插槽注册漏 `id`（会在**浏览器启动时**才报错）；
 *   · 跨插件引用用了相对路径（第一次恶性事故的根因）；
 *   · 环境变量被写成模块级常量（曾让测试污染真实学习史）。
 *
 * ═══ 为什么要有它（作者的判断）═══
 * *"这个 schema 是必须提到每个插件开发任务中的，无论是开始写之前还是 review 的时候，
 * 出现了问题再找这个 schema 来 debug 效率太低了。"*
 * 所以这份清单要在**写之前**和**review 时**都用得上——本脚本让 review 变成一条命令。
 *
 * 用法: node scripts/check-plugin-contract.mjs
 * 退出码 0 = 全部符合；1 = 有违例（每条都给出契约里的对应小节）
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGINS = join(ROOT, 'plugins')

/** 收集结果。 */
const problems = []
const notes = []

/**
 * 记一条违例。
 *
 * @param where - 哪个插件/文件。
 * @param rule - 契约里的规则编号（便于回查）。
 * @param detail - 具体说明。
 */
function violation(where, rule, detail) {
  problems.push({ where, rule, detail })
}

/**
 * 记一条提示（不一定是错的，但值得知道）。
 *
 * @param where - 哪个插件。
 * @param detail - 说明。
 */
function note(where, detail) {
  notes.push({ where, detail })
}

/** 剥掉注释与字符串（照抄 check-client-inject 的做法：正则会把注释里的 ctx.x 误当访问）。 */
function stripCommentsAndStrings(text, options = {}) {
  const blankStrings = options.blankStrings !== false
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && next === '*') {
      out += '  '; i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++ }
      out += '  '; i += 2
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += blankStrings ? ' ' : c; i++
      while (i < n && text[i] !== q) {
        if (text[i] === '\\') {
          out += blankStrings ? '  ' : text[i] + (text[i + 1] ?? '')
          i += 2
          continue
        }
        out += blankStrings ? (text[i] === '\n' ? '\n' : ' ') : text[i]
        i++
      }
      if (i < n) { out += blankStrings ? ' ' : q; i++ }
    } else {
      out += c; i++
    }
  }
  return out
}

/** 需要 `id` 的 list 型插槽（按宿主各包 slots.d.ts 里 `kind: 'list'` 的声明）。 */
const LIST_SLOTS = new Set([
  'sidebar.footer.action',
  'shell.overlay',
  'conversation.input.dock',
  'conversation.input.left',
  'conversation.input.right',
  'conversation.input.overlay',
  'conversation.composer.bar',
  'conversation.composer.dock',
  'conversation.session.header.actions',
  'conversation.chat.node',
  'conversation.chat.turnTail',
  'conversation.message.images',
  'settings.section',
  'settings.general.item',
  'settings.plugins.tab',
])

/** `ctx` 自带的成员 —— 访问它们**不需要** inject。 */
const CTX_MEMBERS = new Set([
  'effect', 'on', 'once', 'off', 'emit', 'waterfall', 'parallel', 'serial',
  'get', 'set', 'inject', 'plugin', 'extend', 'fork', 'dispose', 'logger',
  'collect', 'accept', 'provide', 'alias', 'scope', 'baseUrl', 'root',
  'reflect', 'runtime', 'fiber', 'events', 'config', 'uid', 'state',
  'context', 'source', 'status', 'isolate', 'shadow', 'intercept', 'entries',
])

const dirs = readdirSync(PLUGINS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
dirs.sort()

console.log(`按 docs/PLUGIN_CONTRACT.md 检查 ${dirs.length} 个插件\n`)

for (const dir of dirs) {
  const base = join(PLUGINS, dir)
  const serverPath = join(base, 'index.js')
  const clientPath = join(base, 'client.js')
  const pkgPath = join(base, 'package.json')
  const hasServer = existsSync(serverPath)
  const hasClient = existsSync(clientPath)
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null

  const label = dir

  // ── §1 服务端插件 ──
  if (hasServer) {
    const raw = readFileSync(serverPath, 'utf8')
    const src = stripCommentsAndStrings(raw, { blankStrings: true })
    if (!/export\s+function\s+apply\s*\(/.test(src) && !/export\s+const\s+apply\s*=/.test(src)) {
      violation(label, '§1', 'index.js 没有导出 apply()')
    }
    if (!/export\s+const\s+name\s*=/.test(src)) {
      violation(label, '§1', 'index.js 没有导出 name')
    }
  }

  // ── 跨插件引用必须是包名（§3）──
  for (const [what, path] of [['index.js', serverPath], ['client.js', clientPath]]) {
    if (!existsSync(path)) continue
    const src = stripCommentsAndStrings(readFileSync(path, 'utf8'), { blankStrings: true })
    // `from '../xxx/…'` 形如：from + 相对路径且指向别的插件目录
    const rel = [...src.matchAll(/from\s+'\.\.\/(lh-[a-z-]+)\//g)].map((m) => m[1])
    for (const target of new Set(rel)) {
      violation(label, '§3', `${what} 用相对路径引用了 ${target} —— 装进 profile 后必断；应改包名 + file: 依赖`)
    }
  }

  // ── §4 环境变量惰性求值 ──
  if (hasServer) {
    const src = stripCommentsAndStrings(readFileSync(serverPath, 'utf8'), { blankStrings: false })
    const frozen = [...src.matchAll(/export\s+const\s+(\w+)\s*=\s*process\.env\./g)].map((m) => m[1])
    for (const name of frozen) {
      violation(label, '§4', `index.js 把 process.env 固化进常量 ${name}（应在函数里读）`)
    }
  }

  // ── §2 客户端插件 ──
  if (hasClient) {
    const raw = readFileSync(clientPath, 'utf8')
    // 两个净化版本，用途不同，**不能混用**：
    //   · `src`        —— 字符串也抹掉：用于"扫 ctx.<服务> 访问"（注释/字符串里的 ctx.x 不是访问）
    //   · `noStrings`  —— 保留字符串内容：用于**读**插槽名、id 这类"值写在字符串里"的检查
    // 第一版只用了 `src`，于是读插槽名读到的是一串空格，**list 插槽缺 id 那条检查永远静默通过**。
    const src = stripCommentsAndStrings(raw, { blankStrings: true })
    const noStrings = stripCommentsAndStrings(raw, { blankStrings: false })

    if (!/window\.__ModuleLoader__\.load\(\{/.test(src)) {
      violation(label, '§2', 'client.js 没有用 window.__ModuleLoader__.load({...}) 注册')
    }
    const idMatch = noStrings.match(/id:\s*'([^']+)'/)
    if (!idMatch) {
      violation(label, '§2', 'client.js 的 load({...}) 缺 id')
    } else if (pkg && idMatch[1] !== pkg.name) {
      violation(label, '§2', `client.js 的 id "${idMatch[1]}" 与 package.json 的 name "${pkg.name}" 不一致`)
    }
    if (!/exports\.apply\s*=/.test(src)) {
      violation(label, '§2.1', 'client.js 没有导出 exports.apply')
    }
    if (!/exports\.inject\s*=/.test(src)) {
      // 只有在确实访问了非 cordis 成员的 ctx 服务时才算违例
      const used = [...new Set([...src.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))]
        .filter((n) => !CTX_MEMBERS.has(n))
      if (used.length > 0) {
        violation(label, '§2.1', `client.js 访问了 ctx.${used.join('/')} 但没有导出 exports.inject（启动屏会卡 Failed to load plugins）`)
      }
    }
    // list 型插槽必须给 id（§2.3）
    //
    // ⚠ 这里必须用 `noStrings`（**保留字符串内容**）而不是 `src`。
    //   `src` 是把字符串也抹成空格的版本——它适合"扫 ctx.<服务> 访问"，
    //   但插槽名**就写在字符串里**，用 `src` 的话名字读出来是一串空格，
    //   于是这条检查**永远静默通过**。
    //   实测踩到过：夹具里故意漏 `id`，闸门却没报。
    for (const m of noStrings.matchAll(/slots\.register\(\s*\{([\s\S]{0,240}?)\}\s*,/g)) {
      const opts = m[1]
      const nameMatch = opts.match(/name:\s*'([^']+)'/)
      if (!nameMatch) continue
      const slot = nameMatch[1]
      if (LIST_SLOTS.has(slot) && !/id:\s*'/.test(opts)) {
        violation(label, '§2.3', `list 型插槽 "${slot}" 的注册缺 id（浏览器启动时报 requires options.id）`)
      }
    }
    // 不用 JSX
    if (/return\s*<[A-Za-z]/.test(stripCommentsAndStrings(raw, { blankStrings: false }))) {
      violation(label, '§2.3', 'client.js 里出现 JSX —— 手工 bundle 没有转译步骤，会直接语法错')
    }
  }

  // ── package.json 的形状 ──
  if (hasClient) {
    if (!pkg) {
      violation(label, '§2.4', '有 client.js 但没有 package.json —— exports 无法声明')
    } else {
      const e = pkg.exports ?? {}
      if (!e['./client']) violation(label, '§2.4', 'package.json 的 exports 缺 "./client"（宿主发现不了客户端半）')
      if (!e['./package.json']) violation(label, '§2.4', 'package.json 的 exports 缺 "./package.json"')
    }
  }
  if (hasServer && pkg) {
    // 跨包依赖必须声明（§3）
    const rel = [...stripCommentsAndStrings(readFileSync(serverPath, 'utf8'), { blankStrings: false })
      .matchAll(/from\s+'(@lh\/[a-z-]+)/g)].map((m) => m[1])
    for (const dep of new Set(rel)) {
      if (!pkg.dependencies || !pkg.dependencies[dep]) {
        violation(label, '§3', `index.js 用包名引用了 ${dep}，但 package.json 没有把它声明成依赖`)
      }
    }

    // ═══ `lh` 自我描述：**声明必须与实现一致**（ADR-024 决定 3）═══
    //
    // 那段声明存在的理由是"给 agent 一个机械可枚举、不会过期的来源"。
    // 而它**天然会漂移**：加了工具忘了改声明、改了 inject 忘了改声明——
    // 两边不一致时 agent 读到的是错的，而且**看不出错**（声明本身看起来很正常）。
    // ADR-024 的失效信号写的正是这条：*"字段长期与实际不符 → 需要闸门校验"*。
    //
    // 本闸门用**记账式假 ctx 真跑一次 apply**，把注册到的工具名与声明对照。
    // 只比"工具"与"inject"两项：它们最容易漂移、也最影响 agent 的判断。
    const lh = pkg.lh
    if (lh === undefined || typeof lh !== 'object') {
      violation(label, 'ADR-024', 'package.json 缺 `lh` 自我描述（agent 靠它枚举生态；新增插件必须写）')
    } else {
      for (const field of ['kind', 'summary', 'inject', 'provides', 'depends_on', 'loads_at', 'verified']) {
        if (lh[field] === undefined) violation(label, 'ADR-024', `lh 缺字段 ${field}`)
      }
      if (lh.loads_at !== 'preset' && lh.loads_at !== 'profile') {
        violation(label, 'ADR-024', `lh.loads_at 必须是 preset 或 profile，实际 ${JSON.stringify(lh.loads_at)}`)
      }
      if (!Array.isArray(lh.inject)) {
        violation(label, 'ADR-024', 'lh.inject 必须是数组（可为空数组）')
      }
      if (!Array.isArray(lh.depends_on)) {
        violation(label, 'ADR-024', 'lh.depends_on 必须是数组（可为空数组）')
      }
      const declaredTools = Array.isArray(lh.provides?.tools) ? [...lh.provides.tools].sort() : null
      let mod = null
      try {
        mod = await import(pathToFileURL(serverPath).href)
      } catch (error) {
        note(label, `无法 import index.js，lh 声明未核对：${error?.message ?? error}`)
      }
      if (mod !== null) {
        // ① 声明的 inject 必须与模块导出的 inject 一致（服务名数组）
        const declaredInject = Array.isArray(lh.inject) ? [...lh.inject].sort() : null
        const actualInject = Array.isArray(mod.inject)
          ? [...mod.inject].sort()
          : mod.inject === undefined
            ? []
            : [String(mod.inject)]
        if (declaredInject !== null && JSON.stringify(declaredInject) !== JSON.stringify(actualInject)) {
          violation(label, 'ADR-024', `lh.inject 与模块导出的 inject 不一致：声明 [${declaredInject}] vs 实际 [${actualInject}]`)
        }
        // ② 声明的工具名必须与真跑 apply 注册到的工具一致
        if (declaredTools !== null && typeof mod.apply === 'function') {
          const registered = new Set()
          const fake = {
            on() {},
            inject(_services, cb) {
              if (typeof cb === 'function') cb({ systemPrompt: { context: () => () => {} } })
            },
            tools: { register: (def) => registered.add(def?.name) },
          }
          try {
            mod.apply(fake)
          } catch (error) {
            note(label, `apply 在闸门的假 ctx 下抛错（${error?.message ?? error}），lh.provides.tools 未核对`)
          }
          const actual = [...registered].sort()
          // 只在"这个插件确实注册工具"时才比：纯内核/纯界面插件不该被这条报错
          if (actual.length > 0 && JSON.stringify(declaredTools) !== JSON.stringify(actual)) {
            violation(
              label,
              'ADR-024',
              `lh.provides.tools 与实际注册的工具不一致：声明 [${declaredTools.join(', ')}] vs 实际 [${actual.join(', ')}]`,
            )
          }
        }
      }
    }

    // ═══ `files` 清单：写了就要在，导入的本地模块要在清单里 ═══
    //
    // ═══ 为什么加这一条（2026-09-19 实测，差点让 dsh 起不来）═══
    // 新增 `context.js` 时忘了登记进 `files`。而：
    //   · `check-installed-copies` 是**按清单**比对的 → 清单里没有它就没有"不一致" → **绿**；
    //   · `check-plugin-imports` 当时也绿（它 import 的是同步之前的副本）。
    // 真正抓到它的是 `check-profile-apply`（报 `Cannot find module '…/context.js'`）——
    // 也就是说它属于"**下一次重启才炸**"那一类，而本可以在 commit 前被形状检查拦下。
    //
    // 两条断言缺一不可：
    //   ① 清单里的文件都存在 —— 挡"写了不存在的文件名"；
    //   ② 源码里 import 的本地模块都在清单里 —— 挡"新增文件忘了登记"（这次真实发生的那种）。
    const filesList = Array.isArray(pkg.files) ? pkg.files : null
    if (filesList === null) {
      violation(label, '§5.3', 'package.json 没有 files 清单（运行时文件集必须显式声明）')
    } else {
      for (const f of filesList) {
        if (!existsSync(join(base, f))) violation(label, '§5.3', `files 里写了 ${f}，但文件不存在`)
      }
      const localImports = [
        ...stripCommentsAndStrings(readFileSync(serverPath, 'utf8'), { blankStrings: false })
          .matchAll(/from\s+'\.\/([A-Za-z0-9_./-]+\.js)'/g),
      ].map((m) => m[1])
      for (const local of new Set(localImports)) {
        if (existsSync(join(base, local)) && !filesList.includes(local)) {
          violation(
            label,
            '§5.3',
            `index.js import 了 ./${local}，但 package.json 的 files 里没有它 —— 装进 profile 后会以"找不到模块"在**下一次重启**炸`,
          )        }
      }
    }
  }

  const hasProblems = problems.some((x) => x.where === label)
  if (!hasProblems) {
    console.log(`  ✓ ${label}${hasClient ? '（含客户端半）' : ''}`)
  }
  for (const p of problems.filter((x) => x.where === label)) {
    console.log(`  ✗ ${label}  [${p.rule}]`)
    console.log(`      ${p.detail}`)
  }
}

console.log('')
if (problems.length > 0) {
  console.log(`══ ${problems.length} 处不符合契约（详见 docs/PLUGIN_CONTRACT.md 对应小节）。`)
  process.exit(1)
}
console.log(`══ ${dirs.length} 个插件全部符合契约。`)
console.log('')
console.log('注意：本脚本只查"形状"，不查"能不能跑"——那归另外四道闸门。')
console.log('     也不查"逻辑对不对"——那只归真启动与真使用。')