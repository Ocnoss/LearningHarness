/**
 * 资料扫描与索引构建 —— 资源索引器的实质逻辑。
 *
 * ═══ 它做什么 ═══
 * 递归扫描一个资料文件夹，产出三样东西：
 *   1. **目录树**（供人看结构）
 *   2. **文件清单**（每个文件一条记录，含相对路径、扩展名、大小、mtime）
 *   3. **索引文档**（Markdown，供模型读）
 *
 * ═══ 为什么单独成文件、不写进 index.js ═══
 * 这一层是**纯函数式**的：输入一个路径，输出数据结构，不碰宿主、不碰事件日志。
 * 于是它可以被独立测试——实测 230 个文件 / 5.28 GB 的资料夹在这里跑通之后，
 * 再接上宿主与事件层。分层是为了"每步都能验证"。
 *
 * ═══ 实测结论（用的真实资料夹：D:\考公资料）═══
 * 230 个文件 / 5.28 GB / 7 个顶级模块。
 * 纯文件列表约 9,205 字符（≈4,600 tokens），目录树约 8,890 字符——
 * **索引文档塞得进模型上下文，不需要外置存储方案。**
 * 这个数字是决定"索引怎么给模型看"的依据，所以记在这里。
 *
 * ═══ 与参考实现的关系 ═══
 * 参考 `D:\Learning plugins\tools\resource-indexer` 只借了两点：
 *   - 扫描要支持 `max_depth` / `include_extensions` / `exclude_patterns`；
 *   - 索引文档要包含"概览 + 结构 + 文件清单"三段。
 * 刻意**没有**照搬它的 LLM 判断环节：那一步要调用模型，属于"判断"，
 * 应当由后续的分类器插件负责，而不是塞进索引器（契约 §1.1 内核拥有语法、插件拥有判断）。
 */

import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** 默认扫描的扩展名：学习资料常见形式。 */
export const DEFAULT_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.txt',
  '.md',
  '.ppt',
  '.pptx',
  '.epub',
  '.mobi',
  '.mp4',
  '.mkv',
  '.avi',
  '.mp3',
  '.jpg',
  '.jpeg',
  '.png',
  '.xlsx',
  '.csv',
]

/** 默认排除的目录名片段（不区分大小写）。 */
export const DEFAULT_EXCLUDES = ['node_modules', '__pycache__', '.git', '.venv', 'venv', '$RECYCLE.BIN']

/**
 * 扫描一个资料文件夹。
 *
 * @param params.root - 要扫描的文件夹绝对路径。
 * @param params.maxDepth - 最大递归深度（相对 root，root 自身算第 1 层）。
 * @param params.includeExtensions - 包含的扩展名（小写、含点）；空数组表示不按扩展名过滤。
 * @param params.excludePatterns - 排除的目录/文件名片段（不区分大小写）。
 * @returns 扫描结果 `{ root, files, tree, stats }`。
 * @throws 当 root 不存在或不是目录时。
 */
export function scanFolder({
  root,
  maxDepth = 4,
  includeExtensions = DEFAULT_EXTENSIONS,
  excludePatterns = DEFAULT_EXCLUDES,
}) {
  let rootStat
  try {
    rootStat = statSync(root)
  } catch {
    throw new Error(`scanFolder: 路径不存在或不可访问：${root}`)
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`scanFolder: 路径不是文件夹：${root}`)
  }

  const exts = new Set(includeExtensions.map((e) => e.toLowerCase()))
  const excludes = excludePatterns.map((p) => p.toLowerCase())

  /** 文件清单。 */
  const files = []
  /** 目录树根节点。 */
  const tree = { name: root.split(/[\\/]/).filter(Boolean).pop() ?? root, type: 'folder', children: [] }

  /**
   * 判断某个名字是否应当被排除。
   * @param name - 文件或目录名。
   * @returns 是否排除。
   */
  const shouldExclude = (name) => {
    const lower = name.toLowerCase()
    return excludes.some((p) => lower.includes(p))
  }

  /**
   * 递归扫描。
   * @param dir - 当前目录。
   * @param depth - 当前深度（root 为 1）。
   * @param parentNode - 目录树里的父节点。
   */
  const walk = (dir, depth, parentNode) => {
    if (depth > maxDepth) return

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // 没有权限的目录直接跳过：资料夹里常见系统目录，不该让整次扫描失败。
      return
    }

    // 目录优先、同层按名称排序，让索引文档的次序稳定（可 diff）。
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, 'zh')
    })

    for (const entry of entries) {
      if (shouldExclude(entry.name)) continue
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        const node = { name: entry.name, type: 'folder', children: [], fileCount: 0 }
        parentNode.children.push(node)
        walk(full, depth + 1, node)
        node.fileCount = countFiles(node)
        // 空目录不进树：资料夹里空目录通常是残留，列出只会让索引变吵。
        if (node.fileCount === 0) parentNode.children.pop()
        continue
      }

      if (!entry.isFile()) continue

      const dot = entry.name.lastIndexOf('.')
      const ext = dot === -1 ? '' : entry.name.slice(dot).toLowerCase()
      if (exts.size > 0 && !exts.has(ext)) continue

      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }

      const record = {
        // 相对路径统一用正斜杠：跨平台稳定，也是索引文档里给人看的形态
        path: relative(root, full).split(sep).join('/'),
        name: entry.name,
        ext,
        size: st.size,
        // mtime 是资源可变性的唯一线索：资料被替换过时它能显出来
        mtimeMs: st.mtimeMs,
      }
      files.push(record)
      parentNode.children.push({ name: entry.name, type: 'file', size: st.size, ext })
    }
  }

  walk(root, 1, tree)

  return { root, files, tree, stats: summarize(files) }
}

/**
 * 递归统计一个目录树节点下的文件数。
 * @param node - 目录树节点。
 * @returns 文件数（含所有后代）。
 */
function countFiles(node) {
  let n = 0
  for (const child of node.children ?? []) {
    n += child.type === 'file' ? 1 : countFiles(child)
  }
  return n
}

/**
 * 汇总文件清单的统计信息。
 *
 * @param files - 文件记录数组。
 * @returns `{ count, totalBytes, byExtension }`。
 */
export function summarize(files) {
  const byExtension = {}
  let totalBytes = 0
  for (const f of files) {
    totalBytes += f.size
    const key = f.ext === '' ? '(无扩展名)' : f.ext
    byExtension[key] = byExtension[key] ?? { count: 0, bytes: 0 }
    byExtension[key].count += 1
    byExtension[key].bytes += f.size
  }
  return { count: files.length, totalBytes, byExtension }
}

/**
 * 把字节数渲染成人读的形式。
 * @param bytes - 字节数。
 * @returns 形如 "4.7 MB" 的文本。
 */
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 把扫描结果渲染成 Markdown 索引文档。
 *
 * 为什么它是"给人看"而不是"给模型看的精简版"：实测这个资料夹的完整清单约 4,600 tokens，
 * 塞得进上下文；而在索引里丢掉文件名就等于丢掉最强的信号（文件名本身就是元数据）。
 * 若将来资料夹大到装不下，再引入"分层索引 + 按需展开"。
 *
 * @param params.scan - scanFolder 的返回值。
 * @param params.title - 文档标题；省略时用文件夹名。
 * @param params.generatedAt - 生成时间（ISO）；用于文档头部，便于判断新旧。
 * @returns Markdown 文本。
 */
export function renderIndexDocument({ scan, title, generatedAt }) {
  const { root, files, tree, stats } = scan
  const name = title ?? tree.name

  const lines = []
  lines.push(`# 资料索引：${name}`)
  lines.push('')
  lines.push(`- 来源：\`${root}\``)
  if (generatedAt !== undefined) lines.push(`- 生成时间：${generatedAt}`)
  lines.push(`- 文件总数：${stats.count}`)
  lines.push(`- 总大小：${humanSize(stats.totalBytes)}`)
  lines.push('')

  // ── 扩展名分布 ──
  lines.push('## 形式分布')
  lines.push('')
  lines.push('| 扩展名 | 数量 | 大小 |')
  lines.push('|---|---|---|')
  for (const [ext, s] of Object.entries(stats.byExtension).sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`| ${ext} | ${s.count} | ${humanSize(s.bytes)} |`)
  }
  lines.push('')

  // ── 目录结构 ──
  lines.push('## 目录结构')
  lines.push('')
  lines.push('```')
  lines.push(...renderTree(tree).split('\n'))
  lines.push('```')
  lines.push('')

  // ── 文件清单 ──
  lines.push('## 文件清单')
  lines.push('')
  for (const f of files) {
    lines.push(`- \`${f.path}\` (${humanSize(f.size)})`)
  }
  lines.push('')

  return lines.join('\n')
}

/**
 * 把目录树渲染成缩进文本。
 * @param node - 目录树节点。
 * @param indent - 当前缩进层级。
 * @returns 多行文本。
 */
export function renderTree(node, indent = 0) {
  const pad = '  '.repeat(indent)
  if (node.type === 'file') return `${pad}${node.name}`

  const head = indent === 0 ? `${pad}${node.name}/` : `${pad}${node.name}/  (${node.fileCount} 个文件)`
  const lines = [head]
  for (const child of node.children ?? []) {
    lines.push(renderTree(child, indent + 1))
  }
  return lines.join('\n')
}
