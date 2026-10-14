/**
 * 量"分题器一次真跑"的内存峰值 —— 作者要的第三个数字（token / 墙钟 / 内存）。
 *
 * ═══ 为什么用自检过的采样器，而不是 Node 的 memoryUsage ═══
 * 分题器这一侧的内存几乎全在 V8（读页文本、拼提示词、解析 JSON），
 * 但**调模型时还有 socket 缓冲与 JSON 反序列化的瞬时峰值**，
 * 而那正是"一次读 14 页、输出上万 token"这条路上最容易吃内存的地方。
 * 从外部采样才看得到那个峰值（采样器本身已由 `selftest-memory-sampler.mjs` 验过：
 * 基线 50MB / 大数组 365MB / 短命进程如实报"没量到"）。
 *
 * 用法:
 *   node scripts/measure-extractor-memory.mjs                      # 默认量"只切窗"（不调模型）
 *   $env:XIAOMI_TOKEN_PLAN_AMS_API_KEY = (…)
 *   node scripts/measure-extractor-memory.mjs --run --sets=2        # 量"真调模型"
 */

import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const doRun = argv.includes('--run')
const sets = Number((argv.find((a) => a.startsWith('--sets=')) ?? '--sets=2').slice(7))

/**
 * 采样一个进程的工作集峰值。
 *
 * @param pid - 进程 id。
 * @param ms - 采样间隔。
 * @returns `{ stop, peakMb, samples }`。
 */
function makeSampler(pid, ms = 150) {
  let peakKb = 0
  let samples = 0
  const timer = setInterval(() => {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    const m = (r.stdout ?? '').match(/"([\d.,]+) K"/)
    if (m !== null) {
      const kb = Number(m[1].replace(/[.,]/g, ''))
      if (Number.isFinite(kb)) {
        peakKb = Math.max(peakKb, kb)
        samples += 1
      }
    }
  }, ms)
  return {
    stop: () => clearInterval(timer),
    get peakMb() {
      return Math.round(peakKb / 1024)
    },
    get samples() {
      return samples
    },
  }
}

const args = doRun
  ? ['scripts/extract-questions.mjs', 'run', '--ocr=data/ocr/align题本上', '--max-questions=12', '--max-question-pages=2', `--sets=${sets}`, '--concurrency=3', '--name=mem-probe']
  : ['scripts/extract-questions.mjs', 'plan', '--ocr=data/ocr/align题本上', '--max-questions=12']

console.log(`${doRun ? '真跑（调模型）' : '只切窗（不调模型）'}：node ${args.join(' ')}\n`)

const t0 = Date.now()
const child = spawn(process.execPath, args, { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
const sampler = makeSampler(child.pid)
let out = ''
child.stdout.on('data', (d) => (out += d.toString('utf8')))
child.stderr.on('data', (d) => (out += d.toString('utf8')))
child.on('close', (code) => {
  sampler.stop()
  const ms = Date.now() - t0
  for (const line of out.trim().split('\n').slice(-8)) console.log(`  ${line}`)
  console.log('')
  if (sampler.samples === 0) {
    console.log('  ⚠ 没采到样本 —— 这个 0 是"没量到"，不是"占用小"（量具语义见 selftest-memory-sampler.mjs）')
  } else {
    console.log(`  退出码 ${code}，墙钟 ${(ms / 1000).toFixed(1)}s，**峰值内存 ${sampler.peakMb} MB**（采样 ${sampler.samples} 次）`)
  }
})
