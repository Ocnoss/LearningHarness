/**
 * lh-resource-indexer —— LH 的学习资源索引器。
 *
 * ═══ 它做什么 ═══
 * 扫描一个资料文件夹，产出：
 *   1. 一份 **Markdown 索引文档**（目录结构 + 文件清单 + 形式分布）；
 *   2. 一条 **LH 资源记录**（写入 LH 事件日志，文档外置到 `content_ref`）。
 *
 * ═══ 为什么资源记录要单独走 appendResource ═══
 * docs/archive/decisions/009 把资源与普通事件分开：
 *   - 事件 = 时间流中的一次性行为；
 *   - 资源 = 可寻址可复用的产物。
 * 所以资源记录多两个字段：`derived_from`（血缘 DAG）与 `supersedes`（更新 = 新资源 + 指针，旧版本永不覆盖）。
 *
 * ═══ 为什么索引文档外置而不内嵌 ═══
 * 实测 `D:\考公资料`（230 文件 / 5.16 GB）生成的索引文档约 16.8 KB ≈ 8,400 tokens。
 * 内嵌进事件会让每条事件都变重，而这份文档只在"需要看资料全貌"时才读——
 * 正是契约 §2.2 说的"大 payload 不内嵌，进内容存储"。
 *
 * ═══ 为什么这里不做"这是不是学习资料"的判断 ═══
 * 参考实现（`D:\Learning plugins\tools\resource-indexer`）用 LLM 判断文件夹是否为学习资料、
 * 并生成内容简介。那一步**属于判断，不属于索引**（契约 §1.1：内核拥有语法，插件拥有判断）。
 * 索引器只做机械的事：把文件系统的事实变成结构化记录。
 * 分类与判断留给后续的分类器插件——那样它才能被替换、被并置、被比较。
 *
 * ═══ 它怎么用 ═══
 * 注册一个模型可调用的工具 `index_learning_resources`。
 * 工具是"插件能被模型使用"的通道，而索引器天然是模型该主动做的事
 * （"我手头有哪些资料"是每次教学决策的前提）。
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanFolder, renderIndexDocument, humanSize } from './scan.js'
// 走包名导入（`@lh/event-store/store`）：安装到 profiles/<名>/node_modules 后
// 相对路径 `../lh-event-store/…` 不再可达（目录名是 `@lh/event-store`），
// 导入失败会让 preset 声明激活失败、任何会话都用不了——照 lh-question-bank 的修法。
import { LhEventStore, writeContent, safeFileSegment } from '@lh/event-store/store'

/** 插件名。 */
export const name = 'lh-resource-indexer'

/** 声明依赖：`tools` 用于注册工具（宿主服务）。 */
export const inject = ['tools']

const PROVENANCE = Object.freeze({ plugin: '@lh/resource-indexer', version: '0.0.1' })

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 记一条调试痕迹（与 LH 事件严格分开）。
 * @param line - 文本。
 */
function trace(line) {
  try {
    appendFileSync(join(HERE, 'trace.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

/**
 * 找同一个资料夹的历史索引记录，用于建立 supersedes 链。
 *
 * 为什么需要它：ADR-009 决定 3 说"更新 = 新资源 + supersedes 指针，旧版本永不覆盖"。
 * 没有这一步，重复索引会产生一堆互不相干的记录，无法知道哪个是最新的。
 *
 * @param store - LH 事件存储。
 * @param sourceRoot - 资料夹路径。
 * @returns 该资料夹此前的索引事件（按时间升序）。
 */
function previousIndexes(store, sourceRoot) {
  return store
    .all()
    .filter((e) => e.type === 'lh/resource/indexed' && e.data?.source_root === sourceRoot)
}

/**
 * 执行一次资料索引。
 *
 * 抽成独立函数而不是写在工具里：它需要能被测试脚本直接调用，
 * 而"能被独立调用"才谈得上验证。
 *
 * ═══ 索引文档写到哪（作者实测反馈修正） ═══
 * 第一版把文档写进 `data/resources/<uuid>.md`，并且**把全文作为工具返回值塞进对话**。
 * 作者的反馈是：这两件都错了——索引文档是**重要的产物**，
 * 它的用途是"存在工作区里、以后反复引用"，而不是变成一段对话记录。
 * 所以现在：
 *   - 文档写进**工作区**的 `lh-index/` 下，用可读的文件名（资料夹名 + 时间戳）；
 *   - 事件的 `content_ref` 指向那个**实际文件**；
 *   - 工具返回值只给"摘要 + 路径 + 目录大纲"，全文不进对话上下文。
 * 第三点同时解决了一个隐患：实测 230 文件的索引全文约 8,400 tokens，
 * 塞进对话后每一轮都要重发，而宿主还有 50KB 的 spill 阈值会截断它。
 *
 * @param params.store - LH 事件存储实例。
 * @param params.root - 资料夹绝对路径。
 * @param params.maxDepth - 最大递归深度。
 * @param params.workspaceRoot - 当前工作区绝对路径（会话的 cwd）；决定文档落点。
 * @param params.outputPath - 显式指定的输出文件绝对路径；给了就用它。
 * @returns `{ event, document, scan, indexPath }`。
 */
export function indexResources({ store, root, maxDepth = 4, workspaceRoot, outputPath }) {
  const scan = scanFolder({ root, maxDepth })
  const generatedAt = new Date().toISOString()
  const document = renderIndexDocument({ scan, generatedAt })

  // 决定文档落点：显式路径 > 工作区下的 lh-index/ > 资料夹旁边
  const target = resolveIndexPath({ root, workspaceRoot, outputPath, generatedAt })

  // 外置内容写进真实文件，事件的 content_ref 指向它
  const contentRef = writeContent({ content: document, absolutePath: target })

  // 取代同一资料夹的历史索引（而非覆盖它们）
  const supersedes = previousIndexes(store, root).map((e) => e.id)

  const event = store.appendResource({
    actor: 'agent',
    type: 'lh/resource/indexed',
    provenance: PROVENANCE,
    // 课程树还不存在，scope 统一 'root'（decisions/012 决策 3）
    scope: 'root',
    contentRef,
    supersedes,
    data: {
      source_root: root,
      file_count: scan.stats.count,
      total_bytes: scan.stats.totalBytes,
      by_extension: scan.stats.byExtension,
      // 记下落点：这样"索引文档在哪"是能从事件流回答的，不必去猜文件名规则
      index_path: contentRef,
    },
  })

  return { event, document, scan, indexPath: contentRef }
}

/**
 * 决定索引文档的落点。
 *
 * 命名规则要让**人**一眼看懂：`<资料夹名>-<时间戳>.md`。
 * 不用 uuid —— 那是给机器寻址用的（`data/resources/` 里用），
 * 而这份文档是给人看的，可读的名字比唯一性更重要（同一次索引不会重名，因为有时间戳）。
 *
 * @param params.root - 资料夹绝对路径。
 * @param params.workspaceRoot - 工作区绝对路径。
 * @param params.outputPath - 显式输出路径。
 * @param params.generatedAt - 生成时间（ISO）。
 * @returns 文档的绝对路径。
 */
function resolveIndexPath({ root, workspaceRoot, outputPath, generatedAt }) {
  if (typeof outputPath === 'string' && outputPath.trim() !== '') return outputPath

  const folderName = safeFileSegment(root.split(/[\\/]/).filter(Boolean).pop() ?? 'resources', 'resources')
  // 时间戳取到分钟并去掉分隔符：够区分同名资料夹的多次索引，又不会长得难读
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const fileName = `${folderName}-索引-${stamp}.md`

  const base = typeof workspaceRoot === 'string' && workspaceRoot.trim() !== ''
    ? join(workspaceRoot, 'lh-index')
    : join(dirname(root), 'lh-index')
  return join(base, fileName)
}

/**
 * 插件体。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  trace('APPLY_CALLED')

  // 生命周期钩子：用于验证"改代码是否触发了重载"。
  // 为什么需要它：宿主的 web profile 默认关掉服务端 HMR，
  // 打开之后必须能**证明**重载真的发生了——否则我无法区分
  // "代码没生效"和"重载没发生"，那正是之前白排查一轮的原因。
  ctx.on('dispose', () => trace('DISPOSED（插件被卸载，通常意味着重载）'))

  const store = new LhEventStore()

  // ── 工具注册 ──
  //
  // 注意 schema 的形状：宿主的工具注册表要的是**字面 JSON Schema**。
  // 第一方插件用 `defineTool({ parameters: { x: { type, required: true } } })` 那种 DSL，
  // 但那是 `defineTool` 内部用 `parameterSchemaSpecToJsonSchema` 编译掉的——
  // **我们不能照抄那个 DSL**（`defineTool` 在 `@deepseek-ai/dsh-tools` 里，
  // 而那个包在工作区解析不到；且注册表要的是编译后的形态）。
  // 所以这里直接写注册表接受的字面形态：`required` 是**根级数组**，不是每个属性上的布尔。
  // 支持的构造（实测自 assertSupportedJsonSchema）：
  //   type / oneOf / properties / required / additionalProperties / items / enum / const + 注释(description, title)
  ctx.tools.register({
    name: 'index_learning_resources',
    description:
      '扫描一个学习资料文件夹，生成资料索引文档（目录结构、文件清单、形式分布），存进当前工作区，' +
      '并把结果记为一条 LH 资源。用于了解"手头有哪些资料"，是教学决策的前提。' +
      '只做机械扫描，不判断资料质量与内容——那是分类器的职责。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['folder_path'],
      properties: {
        folder_path: {
          type: 'string',
          description: '要索引的资料文件夹绝对路径，例如 D:\\考公资料',
        },
        max_depth: {
          type: 'integer',
          description: '最大递归深度，默认 4。深度越大索引越完整。',
        },
        output_path: {
          type: 'string',
          description:
            '可选：索引文档的存放路径。省略时写到当前工作区的 lh-index/ 下，文件名由资料夹名与时间戳构成。',
        },
      },
    },
    output: {
      // 返回的是**摘要与路径**，不是文档全文。
      // 全文写进工作区文件；塞进对话会让每轮重发（实测 8,400 tokens）且会被宿主 50KB 阈值截断。
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['file_count', 'total_size', 'index_path', 'resource_event_id'],
        properties: {
          file_count: { type: 'integer', description: '扫到的文件数' },
          total_size: { type: 'string', description: '总大小，人读形式（如 5.16 GB）' },
          index_path: { type: 'string', description: '索引文档的绝对路径（已写入工作区）' },
          resource_event_id: { type: 'string', description: 'LH 资源记录的 id' },
          by_extension: {
            type: 'object',
            additionalProperties: true,
            description: '按扩展名的 {数量, 字节数} 统计',
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `已索引 ${value.file_count} 个文件（${value.total_size}）。\n` +
            `索引文档已写入：${value.index_path}\n` +
            `LH 资源记录 id：${value.resource_event_id}\n\n` +
            `（文档全文不入对话——需要细节时按上面的路径读取。）`,
        },
      ],
    },
    /**
     * 执行索引。
     *
     * @param args - 模型给出的参数。
     * @param exec - 执行上下文；`exec.agent.session.header.cwd` 是当前工作区。
     * @returns 规范化输出。
     */
    execute(args, exec) {
      const root = args?.folder_path
      if (typeof root !== 'string' || root.trim() === '') {
        throw new Error('folder_path 必填，且必须是非空字符串')
      }
      const maxDepth = typeof args?.max_depth === 'number' ? args.max_depth : 4
      // 工作区路径：会话 header 上的 cwd。
      // 这是"文档该住哪"的依据——索引属于当前工作，不该住到资料夹旁边或 data/ 里。
      const workspaceRoot = exec?.agent?.session?.header?.cwd

      const { event, scan, indexPath } = indexResources({
        store,
        root,
        maxDepth,
        workspaceRoot,
        outputPath: typeof args?.output_path === 'string' ? args.output_path : undefined,
      })
      trace(`INDEXED  root=${root}  files=${scan.stats.count}  index=${indexPath}  event=${event.id}`)

      return Promise.resolve({
        file_count: scan.stats.count,
        total_size: humanSize(scan.stats.totalBytes),
        index_path: indexPath,
        resource_event_id: event.id,
        by_extension: scan.stats.byExtension,
      })
    },
  })

  trace('TOOL_REGISTERED  index_learning_resources')
}
