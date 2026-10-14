/**
 * 一次性（但**固化**的）清理：2026-09 那轮"PDF → 图片 → OCR → 抽取"试验留下的产物。
 *
 * ═══ 为什么它是一个入库的脚本，而不是我手敲一串 Remove-Item ═══
 * `WORKFLOW.md` §3 规则 4（破坏性操作一律白名单）要求四件事，缺一不可：
 *   ① **先跑报告模式**，列出"将删什么"及判据；
 *   ② 判据基于**稳定标识**（绝对路径逐条列出），不是"像不像我的"；
 *   ③ 执行前**自动备份**，报告里写出备份位置；
 *   ④ 一次清理只做一件事，不与验证混在一条命令里（验证是另一条命令：`check-all`）。
 * 把这四条写成代码，比写进某次对话的记性可靠——本项目的病史（`report`：启发式判据删掉了
 * 两条真实记录）正是"判据在猜"造成的。所以**白名单是硬编码的绝对路径**，脚本不会自己推断。
 *
 * ═══ 它不删什么（同样是硬约束）═══
 *   · `data/events.jsonl`（唯一事实源，append-only）；
 *   · `data/model-tiers.json`（模型白名单配置）、`data/practice-signal.json`（刷题面板信号）；
 *   · `data/resources/`（资源索引快照，是"存在工作区里以后反复引用"的产物）；
 *   · 学习者的工作区里那**两个真题库**（88 题，且是 20 条作答对上号的对象）。
 * 脚本开头有一道**硬护栏**：任何目标是仓库根、工作区根、或 `lh-questions` 本体 → 直接拒绝运行。
 *
 * ═══ 已知代价（用户在 2026-10-13 知情后确认）═══
 *   · 6 条历史事件的指针会悬空：5 条 `lh/resource/questions-imported` 的 `bank_path`/`content_ref`
 *     与 1 条 `lh/resource/indexed` 的 `content_ref` 指向 `D:\LHtest`。事件不可改（append-only），
 *     所以悬空是**如实记录**，不是损坏；正文在备份里可恢复。
 *   · 那条孤儿作答 `q-ef7e19b9d513` 的题目正文只存在于
 *     `D:\LHtest\lh-questions\资料分析600题-练习01套.json`（第 207 行）→ 清理后只在备份里。
 *
 * 用法：
 *   node scripts/cleanup-test-extracts.mjs                              # 报告模式（默认，不写不删）
 *   node scripts/cleanup-test-extracts.mjs --apply                      # 备份 → 删除
 *   node scripts/cleanup-test-extracts.mjs --restore <备份目录>          # 按 manifest 还原
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')

/** 备份根：与 T5 的归档同处（`.lh-backup-<时间戳>/` 这一族已被 .gitignore 忽略，不入库）。 */
const BACKUP_ROOT = join(repoRoot, '.lh-backup-archive-2026-10-13')

/**
 * 硬护栏：这些路径**永远不许**成为清理目标，也不许被目标包含。
 *
 * 为什么用"包含"而不是"相等"：目标是目录时会递归删除，所以
 * `目标 = data/question-bank-test` 是安全的，而 `目标 = data` 会把事件日志一起删掉。
 * 只要护栏路径落在目标之内（`相对路径不以 .. 开头` 且不是同一路径），就拒绝。
 */
const FORBIDDEN = [
  repoRoot,
  join(repoRoot, 'data'),
  join(repoRoot, 'data', 'events.jsonl'),
  join(repoRoot, 'data', 'resources'),
  join(repoRoot, 'data', 'model-tiers.json'),
  join(repoRoot, 'data', 'practice-signal.json'),
  join(repoRoot, 'plugins'),
  join(repoRoot, 'scripts'),
  join(repoRoot, 'docs'),
  'D:\\learning Harness test',
  'D:\\learning Harness test\\lh-questions',
]

/**
 * ⊙⊙⊙ 白名单 ⊙⊙⊙
 *
 * 每一条都是**绝对路径**。`reason` 是给人看的判据，`label` 决定它在备份目录里的落点
 * （`<label>/<相对路径>`），于是 `--restore` 能反向还原到原处。
 *
 * `root` 是该条目标所属的"锚点"，用来算备份里的相对路径。
 */
const TARGETS = [
  // ── A. 仓库 data/ 下的提取中间产物（≈3.5 MB，无事件依赖）──
  { root: repoRoot, path: join(repoRoot, 'data', 'ocr'), label: 'repo-data', reason: '某轮 OCR 结果（_smoke / align / lj 三个试验批次）' },
  { root: repoRoot, path: join(repoRoot, 'data', 'align'), label: 'repo-data', reason: '题本↔解析对齐与抽取的试验输出' },
  { root: repoRoot, path: join(repoRoot, 'data', 'extract'), label: 'repo-data', reason: '抽取探针输出' },
  { root: repoRoot, path: join(repoRoot, 'data', 'feasibility'), label: 'repo-data', reason: '三个知识点的可行性取样 OCR' },
  { root: repoRoot, path: join(repoRoot, 'data', 'bank-test'), label: 'repo-data', reason: '测试题库沙盒（20 题，非学习者题库）' },
  { root: repoRoot, path: join(repoRoot, 'data', 'question-bank-test'), label: 'repo-data', reason: '题库自测的临时输出目录（自测会按需重建）' },
  ...[
    'pairing.json',
    'pdf-survey.json',
    'llm-preprocess-pilot.json',
    'pilot-llm-preprocess.json',
    'pilot-run.log',
    'pilot50.log',
    'analysis-audit.txt',
    'audit-now.txt',
    'patch-report.txt',
    'patch-apply.txt',
    'audit-tool-args.txt',
  ].map((name) => ({
    root: repoRoot,
    path: join(repoRoot, 'data', name),
    label: 'repo-data',
    reason: '提取/试点阶段的一次性输出或审计文本',
  })),

  // ── B + C. D:\LHtest：另一处 2026-09 的提取工地（≈25 MB，非 LH 安装）──
  // 用户 2026-10-13 同时勾了 B（图片与脚本）与 C（lr-questions 与 lh-index），
  // 即**整处工地**。这里仍然逐条列出顶层项——白名单的纪律是"明确列出要删什么"，
  // 不是"删掉那个目录"，后者会在将来目录长出新东西时静默扩大影响面。
  ...[
    'pdf_pages',
    'pdf_images',
    'page_jpegs',
    'answer_images',
    'answer_jpegs',
    'pdf_text_pages',
    'lh-index',
    'lh-questions',
    'data',
    'data_probe2',
  ].map((name) => ({
    root: 'D:\\LHtest',
    path: join('D:\\LHtest', name),
    label: 'LHtest',
    reason: name === 'lh-questions' || name === 'lh-index'
      ? '测试导入产物（**被 6 条历史事件的指针引用**；正文可在备份里找回）'
      : 'PDF 转出的图片或试验中间数据（无事件引用）',
  })),
  ...[
    'analyze_pdf.py',
    'check_ocr.py',
    'check_pdf_libs.py',
    'check_pdf_type.py',
    'extracted_questions.txt',
    'extract_answers.py',
    'extract_answer_images.py',
    'extract_images.py',
    'extract_jpegs.py',
    'extract_more_answers.py',
    'extract_pdf.js',
    'extract_pdf.py',
    'pdf_analysis.json',
    'pdf_to_images.py',
    'stderr.txt',
    'stdout.txt',
    'try_ocr_methods.py',
    'try_pymupdf_ocr.py',
  ].map((name) => ({
    root: 'D:\\LHtest',
    path: join('D:\\LHtest', name),
    label: 'LHtest',
    reason: '试验脚本或空输出（无事件引用）',
  })),

  // ── D. 工作区里的旧版题库备份（不是题库本体；面板已正确跳过它）──
  {
    root: 'D:\\learning Harness test\\lh-questions',
    path: 'D:\\learning Harness test\\lh-questions\\考公刷题-片段阅读与逻辑判断.json.bak-analysis-1789758772833',
    label: 'workspace',
    reason: 'patch-bank-analysis.mjs 写的旧版题库备份：不参与任何逻辑，也不是题库本体（面板已正确跳过它）',
  },
]

/** 把一个路径解析成绝对路径（相对 repoRoot 的写法也接受）。 */
const abs = (p) => resolve(p)

/**
 * 护栏：目标是否踩到了禁止路径。
 *
 * @param target - 目标绝对路径。
 * @returns 命中的护栏路径，没踩到返回 null。
 */
function forbiddenHit(target) {
  for (const f of FORBIDDEN) {
    const a = abs(f)
    if (target === a) return f
    // 目标在护栏路径之内（即删除目标会把护栏路径一起删掉）→ 拒绝
    const rel = relative(target, a)
    if (rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`)) return f
  }
  return null
}

/** 递归列出目录下的文件（相对该目录）。 */
function listFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(dir)
  return out
}

/** 汇总一个目标：文件数、字节数、逐文件 sha256。 */
function measure(target) {
  const st = statSync(target)
  if (!st.isDirectory()) {
    return { files: 1, bytes: st.size, sha: { [target]: sha256(target) } }
  }
  const files = listFiles(target)
  const sha = {}
  let bytes = 0
  for (const f of files) {
    bytes += statSync(f).size
    sha[f] = sha256(f)
  }
  return { files: files.length, bytes, sha }
}

/** 算一个文件的 sha256（十六进制）。 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 人类可读体积。 */
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

/** 打印一行（带缩进）。 */
const line = (s = '') => console.log(s)

/**
 * 执行（或预演）清理。
 *
 * @param apply - true = 真的备份并删除；false = 只报告。
 * @returns 报告对象（也写进 manifest）。
 */
function run(apply) {
  line('╔══ 清理报告：2026-09 提取试验产物 ══════════════════════════════════')
  line(`║ 模式：${apply ? 'APPLY（备份 → 删除）' : 'REPORT（只看，不写不删）'}`)
  line(`║ 仓库：${repoRoot}`)
  line(`║ 备份：${apply ? '' : '(报告模式不备份) '}${BACKUP_ROOT}`)
  line('╚════════════════════════════════════════════════════════════════════')
  line()

  const entries = []
  let totalFiles = 0
  let totalBytes = 0

  for (const t of TARGETS) {
    const target = abs(t.path)
    const guard = forbiddenHit(target)
    if (guard !== null) {
      line(`✗ 拒绝：${target}`)
      line(`        它踩到了硬护栏 ${guard}（删它会连带删掉事实源/仓库代码/学习者工作区）`)
      process.exitCode = 1
      return null
    }
    if (!existsSync(target)) {
      line(`· 跳过（不存在）：${target}`)
      entries.push({ ...t, path: target, exists: false, files: 0, bytes: 0 })
      continue
    }
    const m = measure(target)
    totalFiles += m.files
    totalBytes += m.bytes
    const kind = statSync(target).isDirectory() ? '目录' : '文件'
    line(`✓ ${kind}  ${target}`)
    line(`   ${m.files} 个文件 / ${mb(m.bytes)}  —— ${t.reason}`)
    entries.push({ ...t, path: target, exists: true, files: m.files, bytes: m.bytes, sha: m.sha })
  }

  line()
  line(`合计：${entries.filter((e) => e.exists).length} 个目标 / ${totalFiles} 个文件 / ${mb(totalBytes)}`)
  line('不动：data/events.jsonl（事实源）、data/resources/、data/model-tiers.json、')
  line('      data/practice-signal.json、工作区两个真题库。')
  line()

  if (!apply) {
    line('报告模式结束：**没有写入任何东西，也没有删除任何东西**。')
    line('确认无误后执行：node scripts/cleanup-test-extracts.mjs --apply')
    return { entries, totalFiles, totalBytes, applied: false }
  }

  // ── 备份 ──
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(BACKUP_ROOT, `cleanup-test-extracts-${stamp}`)
  mkdirSync(backupDir, { recursive: true })
  line(`备份到：${backupDir}`)

  const copied = []
  for (const e of entries) {
    if (!e.exists) continue
    const rel = e.root === e.path ? '' : relative(e.root, e.path)
    const dest = join(backupDir, e.label, rel === '' ? '.' : rel)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(e.path, dest, { recursive: true, force: true })
    copied.push({ ...e, backup_rel: relative(backupDir, dest) })
    line(`  → ${relative(backupDir, dest)}`)
  }

  // 备份校验：逐文件 sha256 比对（**复制后读回来算**，与 install-lh-schedule 同一纪律）
  const mismatches = []
  let verified = 0
  for (const c of copied) {
    for (const [srcFile, srcSha] of Object.entries(c.sha ?? {})) {
      const relInTarget = relative(c.path, srcFile)
      const destFile = join(backupDir, c.label, relative(c.root, c.path), relInTarget)
      if (!existsSync(destFile)) {
        mismatches.push(`${srcFile} → 备份里找不到`)
        continue
      }
      const destSha = sha256(destFile)
      if (destSha !== srcSha) mismatches.push(`${srcFile} sha256 不一致`)
      else verified += 1
    }
  }
  line()
  line(`备份校验：${verified} 个文件 sha256 一致${mismatches.length ? `，${mismatches.length} 个不一致` : ''}`)
  if (mismatches.length > 0) {
    for (const m of mismatches.slice(0, 20)) line(`  ✗ ${m}`)
    line('**校验没过 → 一个字节都不删**（宁可留下产物，也不丢数据）。')
    process.exitCode = 1
    return null
  }

  // ── 删除 ──
  let deleted = 0
  for (const c of copied) {
    rmSync(c.path, { recursive: true, force: true })
    deleted += 1
    line(`✗ 已删：${c.path}`)
  }

  const manifest = {
    created_at: new Date().toISOString(),
    what: '2026-09 提取试验产物清理（scripts/cleanup-test-extracts.mjs）',
    why: '用户在 2026-10-13 确认：仓库 data/ 下提取中间产物 + D:\\LHtest 整处工地 + 工作区旧版题库备份',
    applied: true,
    targets: copied.map((c) => ({
      path: c.path,
      label: c.label,
      backup_rel: c.backup_rel,
      files: c.files,
      bytes: c.bytes,
      reason: c.reason,
    })),
    skipped_missing: entries.filter((e) => !e.exists).map((e) => e.path),
    not_touched: [
      join(repoRoot, 'data', 'events.jsonl'),
      join(repoRoot, 'data', 'resources'),
      join(repoRoot, 'data', 'model-tiers.json'),
      join(repoRoot, 'data', 'practice-signal.json'),
      'D:\\learning Harness test\\lh-questions\\考公刷题-片段阅读与逻辑判断.json',
      'D:\\learning Harness test\\lh-questions\\考公刷题-片段阅读-第1册.json',
    ],
    total_files: totalFiles,
    total_bytes: totalBytes,
  }
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  line()
  line(`已删 ${deleted} 个目标 / ${totalFiles} 个文件 / ${mb(totalBytes)}`)
  line(`备份清单：${join(backupDir, 'manifest.json')}`)
  line(`回滚：node scripts/cleanup-test-extracts.mjs --restore "${backupDir}"`)
  line()
  line('⚠ 下一步（**另一条命令**，按规则 4 ④「清理与验证不混在一条命令里」）：')
  line('   node scripts/check-all.mjs')
  return { entries: copied, totalFiles, totalBytes, applied: true, backupDir }
}

/**
 * 从一份 manifest 还原。
 *
 * 已存在的目标**不覆盖**：那说明它已经回来了（或用户又建了新的），
 * 静默覆盖会把"新的"换成"旧的"，而这是回滚路径里最不该发生的事。
 *
 * @param backupDir - 备份目录（含 manifest.json）。
 */
function restore(backupDir) {
  const manifestPath = join(backupDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error(`找不到清单：${manifestPath}`)
    process.exitCode = 1
    return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  line(`从 ${manifest.created_at} 的备份还原（${manifest.targets.length} 个目标）`)
  let restored = 0
  const conflicts = []
  for (const t of manifest.targets) {
    const src = join(backupDir, t.backup_rel)
    if (!existsSync(src)) {
      conflicts.push(`备份里没有：${t.backup_rel}`)
      continue
    }
    if (existsSync(t.path)) {
      conflicts.push(`目标已存在，不覆盖：${t.path}`)
      continue
    }
    mkdirSync(dirname(t.path), { recursive: true })
    cpSync(src, t.path, { recursive: true, force: true })
    restored += 1
    line(`← 已还原：${t.path}`)
  }
  line()
  line(`还原 ${restored} 个目标`)
  for (const c of conflicts) line(`⚠ ${c}`)
  if (conflicts.length > 0) process.exitCode = 1
}

// ── 入口 ──
const args = process.argv.slice(2)
const restoreAt = args.indexOf('--restore')
if (restoreAt >= 0) {
  const dir = args[restoreAt + 1]
  if (dir === undefined || dir === '') {
    console.error('用法：node scripts/cleanup-test-extracts.mjs --restore <备份目录>')
    process.exitCode = 2
  } else {
    restore(abs(dir))
  }
} else {
  run(args.includes('--apply'))
}
