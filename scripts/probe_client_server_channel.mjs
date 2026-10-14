/**
 * 查：客户端插件怎么调用服务端能力？
 *
 * ═══ 为什么必须查清这一条 ═══
 * 要做的刷题界面需要两个服务端动作：**取题**与**提交作答**。
 * 探针已经查明客户端 `require` 能拿到的东西里**没有"调用服务端工具"的 API**：
 *   · `dsh-client-runtime` 的 36 项导出里没有；
 *   · `dsh-api-remotes` 的客户端半只导出 `apply`/`inject`（它是插件，不是 API 面）。
 *
 * 而现状是：刷题完全靠 agent 调工具。界面要么也走这条通道，
 * 要么找到客户端到服务端的 RPC 面。**这个答案决定界面怎么做**，所以不能猜。
 *
 * 用法: node scripts/probe_client_server_channel.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PKG = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

/**
 * 递归列出文件。
 *
 * @param dir - 目录。
 * @param ext - 后缀过滤。
 * @param out - 累积数组。
 * @returns 文件路径数组。
 */
function walk(dir, ext, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, ext, out)
    else if (name.endsWith(ext)) out.push(full)
  }
  return out
}

console.log('=== 1. 哪些客户端插件注入( inject )了什么服务 ===')
// 客户端插件的 package.json 里 dsh.client.inject 列出它依赖的**其他客户端插件 id**；
// 而它自身 apply(ctx) 里用到的服务（如 slots / sessions）则是另一回事。
const pkgs = readdirSync(PKG).filter((n) => n.startsWith('dsh-client-') || n.startsWith('dsh-api-'))
for (const name of pkgs) {
  const pj = join(PKG, name, 'package.json')
  try {
    const j = JSON.parse(readFileSync(pj, 'utf8'))
    const c = j.dsh?.client
    if (c) {
      console.log(`  ${name.padEnd(44)} inject=[${(c.inject ?? []).join(', ')}] platform=${c.platform ?? '-'}`)
    }
  } catch {
    /* 没有 package.json 就跳过 */
  }
}

console.log('\n=== 2. 客户端 bundle 里出现过的服务访问（ctx.<name>）===')
// 统计各客户端 bundle 里 ctx.xxx 的用法，看它们都依赖哪些服务
const clientFiles = walk(PKG, 'client.js')
const svcUse = new Map()
for (const f of clientFiles) {
  let s
  try {
    s = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  for (const m of s.matchAll(/\bctx\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
    const key = m[1]
    if (!svcUse.has(key)) svcUse.set(key, new Set())
    svcUse.get(key).add(f.split(/[\\/]/).slice(-3, -2)[0])
  }
}
const sorted = [...svcUse.entries()].sort((a, b) => b[1].size - a[1].size)
for (const [svc, files] of sorted.slice(0, 26)) {
  console.log(`  ctx.${svc.padEnd(26)} 被 ${files.size} 个客户端包使用`)
}

console.log('\n=== 3. 有没有 rpc / api / request 一类的服务名 ===')
const interesting = sorted.filter(([n]) => /rpc|api|remote|request|channel|transport|gateway|connection/i.test(n))
if (interesting.length === 0) console.log('  （没有）')
for (const [svc, files] of interesting) {
  console.log(`  ctx.${svc}  ← ${[...files].slice(0, 4).join(', ')}`)
}

console.log('\n=== 4. 客户端包里出现过的 "调用服务端" 迹象 ===')
// 找 rpc 方法名或 endpoint 字符串
const patterns = [/["'`](\/api\/[a-zA-Z0-9_/-]+)["'`]/g, /["'`]([a-z][a-zA-Z]*\/[a-z][a-zA-Z/]*)["'`]\s*\(/g]
const found = new Map()
for (const f of clientFiles) {
  let s
  try {
    s = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      const key = m[1]
      if (!found.has(key)) found.set(key, new Set())
      found.get(key).add(f.split(/[\\/]/).slice(-3, -2)[0])
    }
  }
}
if (found.size === 0) console.log('  （没有明显迹象）')
for (const [k, files] of [...found.entries()].slice(0, 24)) {
  console.log(`  ${k.padEnd(40)} ← ${[...files].slice(0, 3).join(', ')}`)
}
