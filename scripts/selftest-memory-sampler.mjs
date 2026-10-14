/**
 * 内存采样器自检 —— **先确认量具本身准，再拿它去量**。
 *
 * ═══ 为什么需要 ═══
 * `COLLABORATOR_MODEL §E-12`：闸门/量具必须先对着**已知**的状态验一次。
 * 内存采样器是一个量具：它若量错，我会拿一个错的数字去决定方案（比如"要多进程还是单进程"）。
 *
 * 做法：让子进程分配一块**已知大小**的数组，看采样器报出来的峰值
 * 是否落在合理区间（数组本身约 8e6 × 8B ≈ 64MB，加上 V8 与进程基线）。
 *
 * 用法: node scripts/selftest-memory-sampler.mjs
 */

import { spawn, spawnSync } from 'node:child_process'

/**
 * 采样一个进程的工作集峰值（与 probe-batch-cost.mjs 同一实现）。
 *
 * @param pid - 进程 id。
 * @param ms - 采样间隔。
 * @returns `{ stop, peakMb, samples }`。
 */
function makeMemorySampler(pid, ms = 100) {
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

let passed = 0
let failed = 0

/**
 * 断言。
 *
 * @param label - 用例名。
 * @param ok - 是否成立。
 * @param detail - 失败时的补充。
 */
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}\n       ${detail}`)
  }
}

/**
 * 跑子进程并采样。
 *
 * @param code - 子进程代码。
 * @returns Promise<`{ peakMb, samples, out, ms }`>。
 */
function runSampled(code) {
  return new Promise((resolvePromise) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
    const sampler = makeMemorySampler(child.pid)
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('close', () => {
      sampler.stop()
      resolvePromise({ peakMb: sampler.peakMb, samples: sampler.samples, out: out.trim(), ms: Date.now() - t0 })
    })
  })
}

console.log('== 1. 空转进程：应报出一个"进程基线"量级的值（几十 MB） ==')
{
  // 撑够采样窗口，否则可能在第一次采样前就结束了
  const r = await runSampled('setTimeout(()=>console.log("done"), 800)')
  check(`采样到了（${r.samples} 次）`, r.samples > 0, '一次都没采到 → 采样器没用')
  check(`基线落在 10–200 MB（实际 ${r.peakMb} MB）`, r.peakMb >= 10 && r.peakMb <= 200, `实际 ${r.peakMb} MB`)
}

console.log('\n== 2. 分配约 80MB 数组：报出来的峰值必须**明显大于**基线 ==')
{
  const r = await runSampled('const a=[];for(let i=0;i<1e7;i++)a.push(i);setTimeout(()=>console.log("len",a.length), 600)')
  check(`峰值 ≥ 80 MB（实际 ${r.peakMb} MB）`, r.peakMb >= 80, `实际 ${r.peakMb} MB —— 太小说明采样器没在读真实工作集`)
  check(`子进程真的分配了（输出 ${r.out.slice(0, 40)}）`, r.out.includes('len 10000000'), r.out)
}

console.log('\n== 3. 短命进程：不能把"没采到"当成"内存很小" ==')
{
  const r = await runSampled('console.log("instant")')
  // 这条不是"必须采到"，而是要求**如实报告**：samples=0 时 peakMb 会是 0，
  // 而 0 会被误读成"内存占用为零"。所以量具的调用方必须看 samples。
  check(
    `要么采到样本、要么 samples=0 能被识别（samples=${r.samples}, peak=${r.peakMb} MB）`,
    r.samples === 0 ? r.peakMb === 0 : r.peakMb > 0,
    `samples=${r.samples} 与 peak=${r.peakMb} 不自洽`,
  )
  console.log(`       （注意：samples=0 时 peak 只能是 0，调用方必须据此判断"没量到"而不是"占用小"）`)
}

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) process.exit(1)
console.log('量具可信：基线、明显增大、短命进程三种情形都如实反映。\n')
