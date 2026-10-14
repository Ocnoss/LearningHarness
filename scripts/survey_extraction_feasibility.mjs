/**
 * 为了选"从哪个文件再抽 30 题"，先做一次**最小的可行性探查**。
 *
 * ═══ 为什么不能直接开跑 ═══
 * 抽取链路依赖解析里有显式的 `【参考答案】X` 标记（实测片段阅读解析里有 37 处）。
 * **其他资料未必用同一套标记。** 如果先花几分钟 OCR 再发现没有答案标记，
 * 那几分钟与那份 OCR 就白费了。
 *
 * 所以这一步只做最便宜的检查：**对每个候选文件的解析半，OCR 头两页**，
 * 看有没有 `【参考答案】`（或其它答案标记）。
 * 两页 OCR 约 6 秒/文件，代价可忽略，却能避免选错文件。
 *
 * 用法: node scripts/survey_extraction_feasibility.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const PY = 'D:\\miniconda\\python.exe'
const ROOT = 'D:\\考公资料\\刷题'
const WORK = 'data/feasibility'

// 候选：每个文件夹取"解析"那一半（题本半的格式已知，不必再查）
const CANDIDATES = [
  { dir: '数量关系600题（26最新）', answer: '花生十三数量600题（无遮挡水印版）【解析】.pdf', question: '花生十三数量600题（无遮挡水印版）【题本】.pdf', kind: '数量关系' },
  { dir: '资料分析600题', answer: '解析篇.pdf', question: '题本篇.pdf', kind: '资料分析' },
  { dir: '逻辑判断600 题', answer: '逻辑判断600题解析篇.pdf', question: '逻辑判断600题题本篇.pdf', kind: '逻辑判断' },
]

/** 在目录里找一个文件名包含关键词的文件。 */
function pick(dir, keyword) {
  const full = join(ROOT, dir)
  if (!existsSync(full)) return null
  const hit = readdirSync(full).find((n) => n.includes(keyword) && n.toLowerCase().endsWith('.pdf'))
  return hit ? join(full, hit) : null
}

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

const MARKERS = [
  ['【参考答案】', /【\s*参\s*考\s*答\s*案\s*】\s*([A-DＡ-Ｄ])/],
  ['【正确答案】', /【\s*正\s*确\s*答\s*案\s*】/],
  ['【答案】', /【\s*答\s*案\s*】/],
  ['答案：', /答\s*案\s*[:：]/],
  ['【实战解析】', /【\s*实\s*战\s*解\s*析\s*】/],
  ['【解析】', /【\s*解\s*析\s*】/],
]

console.log('对每个候选文件的**解析半** OCR 头 3 页，数答案标记\n')

const summary = []
for (const c of CANDIDATES) {
  const a = pick(c.dir, '解析') ?? (c.answer ? join(ROOT, c.dir, c.answer) : null)
  if (!a || !existsSync(a)) {
    console.log(`${c.kind}: 找不到解析文件（试过 ${c.dir}）`)
    continue
  }
  const out = join(WORK, c.kind)
  process.stdout.write(`${c.kind.padEnd(10)} OCR 头 3 页 … `)
  try {
    execFileSync(PY, ['scripts/ocr_pages.py', '--pdf', a, '--pages', '1-3', '--out', out, '--quiet'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 180000,
    })
  } catch (error) {
    console.log(`OCR 失败: ${String(error.message).slice(0, 80)}`)
    continue
  }

  // 汇总这三页的文本
  let text = ''
  for (const n of readdirSync(out)) {
    if (!n.endsWith('.json') || n.startsWith('_')) continue
    text += JSON.parse(readFileSync(join(out, n), 'utf8')).text + '\n'
  }
  const counts = MARKERS.map(([label, re]) => [label, (text.match(new RegExp(re.source, 'g')) ?? []).length])
  const hit = counts.filter(([, n]) => n > 0)
  console.log(`字符 ${text.length}，命中: ${hit.length ? hit.map(([l, n]) => `${l}×${n}`).join(' ') : '（无任何答案标记）'}`)
  summary.push({ kind: c.kind, answerFile: a, chars: text.length, counts })
}

console.log('\n=== 结论 ===')
const viable = summary.filter((s) => s.counts.some(([l, n]) => n > 0 && (l.includes('答案') || l.includes('解析'))))
if (viable.length === 0) {
  console.log('三个候选都没找到答案标记 —— 抽取链路需要先适配它们的格式。')
} else {
  for (const v of viable) {
    const best = v.counts.filter(([, n]) => n > 0).map(([l, n]) => `${l}×${n}`).join(' ')
    console.log(`  可用: ${v.kind.padEnd(10)} (${best})`)
  }
  console.log('\n建议选标记最规整的那个（有显式【参考答案】最好，因为它能一带出答案字母）。')
}
