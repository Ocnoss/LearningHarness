/**
 * 查：客户端插件的 bundle 是怎么被送进浏览器的？
 *
 * ═══ 为什么必须查清 ═══
 * 要做的刷题面板是**客户端插件**（React 组件注册进宿主插槽）。
 * 这类插件的代码得先到达浏览器，然后 `window.__ModuleLoader__` 才会执行它。
 *
 * 已知事实（来自 `lh-theme` 的实践与探针输出）：
 *   · seed 模块里有 react / ui-primitives / ui-slots，所以客户端插件**能**跑；
 *   · `lh-theme` 已经在跑（配色生效），所以投放链路是通的；
 *   · 探针报错的文案里出现过 `/plugins/@lh/theme/client.js` 这个路径。
 * 但**谁注册了 `/plugins/` 路由、谁注入 script 标签**没查过。
 * 这决定我要不要自己注入，还是白拿。
 *
 * 用法: node scripts/probe_client_bundle_serving.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PKG = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

/**
 * 递归列出文件。
 *
 * @param dir - 目录。
 * @param out - 累积。
 * @returns 文件路径数组。
 */
function walk(dir, out = []) {
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
    if (st.isDirectory()) walk(full, out)
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

const NEEDLES = ['/plugins/', 'script-src', 'index-inject', 'dsh.client', '__DSH_BOOT__']

console.log('对照：谁提到这些关键词\n')
for (const file of walk(PKG)) {
  let s
  try {
    s = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const hits = NEEDLES.filter((n) => s.includes(n))
  if (hits.length === 0) continue
  // 只在"看起来像相关的那几个包"上打印，否则噪声太大
  const rel = file.replace(PKG + '/', '')
  const interesting = /client-modules|web-app|web-frontend|host-webserver|client-hmr|typert/.test(rel)
  if (interesting) {
    console.log(`  ${rel}`)
    console.log(`     命中: ${hits.join(', ')}`)
  }
}

console.log('\n=== 直接找 "/plugins/" 的上下文 ===')
for (const file of walk(PKG)) {
  let s
  try {
    s = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const i = s.indexOf('/plugins/')
  if (i < 0) continue
  const rel = file.replace(PKG + '/', '')
  if (!/client-modules|web-app|web-frontend|host-webserver/.test(rel)) continue
  console.log(`\n--- ${rel} @${i} ---`)
  console.log(s.slice(Math.max(0, i - 500), i + 500))
}
