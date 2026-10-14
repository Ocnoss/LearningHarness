/**
 * lh-event-store 的服务半 —— LH 的事件写入接口。
 *
 * ═══ 为什么把它单独拆出来 ═══
 * 信封的构造规则（契约 §2.2）只应该有一处实现：
 *   谁写事件，都经过这里；字段怎么填、版本怎么标、出处怎么写，都在这一处决定。
 * 否则每个记录器插件都会自己拼一遍，早晚拼出不一致的信封——
 * 而事件寿命比写出它的代码长（契约 §2.2 演进纪律），不一致的代价是永久的。
 *
 * 因此本文件是 **LH 事件存储的公开接口**：
 * 后续的记录器插件（对话记录器、操作记录器、资源记录器……）通过 `ctx.lhEvents` 写事件，
 * 而不是自己碰文件。
 *
 * ═══ 与宿主的关系 ═══
 * 宿主自己也有服务机制，但那个机制管的是**宿主**的服务；
 * `ctx.lhEvents` 是 LH 自己给自己定义的接口。两者不冲突：
 * 我们只是用宿主的插件系统来装载 LH 的服务。
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

// 数据目录的定位（不写死盘符，从本模块位置推仓库根）。见 paths.js 的注释。
import { dataDir, dataFile } from './paths.js'

/** 事件 schema 版本。契约要求"只做加法：加字段可以，改语义、删字段不行"。 */
export const SCHEMA_VERSION = 1

/**
 * 本存储模块自身的出处标识。
 *
 * 注意：写入方在事件里标注的 provenance 是**写入方自己**的
 * （例如 `@lh/recorder-trace`），不是这一个——不同写入方是不同的插件。
 * 导出它是为了自检与追溯"正在跑的是这个模块的哪一版"。
 */
export const PROVENANCE = Object.freeze({ plugin: '@lh/event-store', version: '0.0.1' })

/**
 * LH 事件日志的路径（**惰性求值**）。
 *
 * 决策依据见 docs/archive/decisions/012：物理形态是工作区下的 JSONL 文件，
 * 选它而不是数据库，是为了"可带走"与"用户能用记事本打开自己的学习史"。
 *
 * ═══ 为什么是函数而不是常量 ═══
 * 第一版写成 `export const LH_EVENT_LOG = process.env.LH_EVENT_LOG ?? '...'`，
 * 那样会在**模块加载时**把环境变量固化。后果不是风格问题：
 * 任何想把它指到别处的调用方（测试、离线校验、换工作区）都必须在 import 之前设好环境变量，
 * 否则设置被静默忽略——**静默的后果是测试把假数据写进了真实的学习史**。
 * 惰性求值让"指到哪"在任何时刻都成立。
 *
 * ═══ 默认值为什么不再是一个写死的盘符 ═══
 * 原来是 `'D:\\LearningHarnessv0.1\\data'`——**那是作者机器上的路径**。
 * 写死不会让插件跑不起来，但会让它在别人的机器上**跑错目录**（静默错误）。
 * 现在默认值由 `dataDir()` 从**本模块的位置**推到仓库根（见 `paths.js`）。
 *
 * @returns 事件日志文件的绝对路径。
 */
export function eventLogPath() {
  const fromEnv = process.env.LH_EVENT_LOG
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : dataFile('events.jsonl')
}

/**
 * 按契约 §2.2 组装一条事件的信封。
 *
 * 本函数是整个 LH 里**唯一**构造信封的地方。
 *
 * @param params.actor - user / agent / system / 具体插件 id。
 * @param params.type - 事件族 + 动词（如 `lh/plugin/activated`）。
 * @param params.data - 事件负载，必须可 JSON 序列化。
 * @param params.provenance - 产生它的插件 id + 版本。
 * @param params.scope - 节点路径（课程树作用域）；当前只有 'root'（见 decision 012 决策 3）。
 * @param params.sessionRef - 所属会话；未知时省略。
 * @returns 完整的事件对象。
 */
export function createEnvelope({ actor, type, data, provenance, scope = 'root', sessionRef, contentRef }) {
  return {
    // 全局唯一
    id: randomUUID(),
    // 事件发生时间：ISO 带时区，便于跨工具比对（踩过本地时间/UTC 混用的坑）
    timestamp: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    actor,
    type,
    provenance: { ...provenance },
    scope,
    // 留空字段显式写 null，而不是省略：
    // 读取端必须能区分"没有"与"没记"（与契约 §1.3 写细读粗一致）
    session_ref: sessionRef ?? null,
    // 大 payload 不内嵌，进内容存储；这里只放指针（契约 §2.2）。
    // 资源索引文档就走这条路：正文在 data/resources/，信封里只留路径。
    content_ref: contentRef ?? null,
    data,
  }
}

/**
 * LH 外置内容的默认存放目录（**惰性求值**，理由同 `eventLogPath`）。
 *
 * 与事件日志分开：事件是时间流（一行一条、要保持小而快读），
 * 内容是产物（可能是几十 KB 的文档）。契约 §2.2 把这两件事分开正是为此。
 *
 * @returns 内容目录的绝对路径。
 */
export function contentDirPath() {
  const fromEnv = process.env.LH_CONTENT_DIR
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(dataDir(), 'resources')
}

/**
 * 写一份外置内容到**指定路径**，返回它的指针。
 *
 * ═══ 为什么允许指定路径，而不是一律写进 LH_CONTENT_DIR ═══
 * 有些产物**本来就该住在用户看得见的地方**——资料索引就是这一类：
 * 它的用途是"存在工作区里、以后反复引用"。把它埋进 data/ 下的 uuid 文件名，
 * 等于让用户找不到自己最需要的产物（这是作者实测反馈出来的缺陷）。
 * 所以：内容存储支持绝对路径，由调用方决定产物住哪；
 * 事件信封里的 `content_ref` 记的是**实际位置**。
 *
 * @param params.content - 内容文本。
 * @param params.absolutePath - 绝对路径；省略时写进 LH_CONTENT_DIR 并用 uuid 命名。
 * @param params.hint - 未给 absolutePath 时的命名提示，只影响可读性。
 * @returns 写入位置的指针（绝对路径或相对文件名）。
 */
export function writeContent({ content, absolutePath, hint = 'content' }) {
  if (typeof absolutePath === 'string' && absolutePath !== '') {
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, content, 'utf8')
    return absolutePath
  }
  mkdirSync(contentDirPath(), { recursive: true })
  const name = `${hint}-${randomUUID()}.md`
  writeFileSync(join(contentDirPath(), name), content, 'utf8')
  return name
}

/**
 * 按指针读回外置内容。
 *
 * 指针可能是相对 `LH_CONTENT_DIR` 的文件名，也可能是绝对路径——
 * 两种都要能读，否则"指针"就不成其为指针。
 *
 * @param ref - content_ref 的值。
 * @returns 内容文本，不存在则 undefined。
 */
export function readContent(ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  // 绝对路径的粗略判据：带盘符（C:）或 UNC（\\）或 POSIX 根（/）
  const isAbsolute = /^[a-zA-Z]:/.test(ref) || ref.startsWith('\\\\') || ref.startsWith('/')
  const full = isAbsolute ? ref : join(contentDirPath(), ref)
  if (!existsSync(full)) return undefined
  return readFileSync(full, 'utf8')
}

/**
 * 把一段文本变成可安全用作文件名的片段。
 *
 * 保留 Unicode —— 中文文件名是正常的，也是用户想要的。
 * 只剔除 Windows 文件名不允许的字符，并压掉空白。
 *
 * @param text - 原始文本。
 * @param fallback - 结果为空时的兜底名。
 * @returns 安全的文件名片段。
 */
export function safeFileSegment(text, fallback = 'content') {
  const cleaned = String(text ?? '')
    // Windows 禁止的字符：\ / : * ? " < > |
    .replace(/[\\/:*?"<>|]/g, '_')
    // 控制字符
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // 结尾的点与空格在 Windows 上会被吞掉
    .replace(/[. ]+$/, '')
  return cleaned === '' ? fallback : cleaned.slice(0, 80)
}

/**
 * 追加一条事件到 LH 日志。append-only，绝不改写既有内容。
 *
 * @param event - 完整事件对象。
 * @returns 写入的字节数。
 */
export function appendEvent(event) {
  const target = eventLogPath()
  mkdirSync(dirname(target), { recursive: true })
  const line = `${JSON.stringify(event)}\n`
  appendFileSync(target, line, 'utf8')
  return Buffer.byteLength(line, 'utf8')
}

/**
 * 读取日志中的全部事件。
 *
 * **必须容忍 BOM。** 这是踩出来的：我用 PowerShell 的
 * `Get-Content | Set-Content -Encoding UTF8` 清理过一次日志，而 PS5 的
 * `-Encoding UTF8` 会写入 UTF-8 BOM（EF BB BF），于是第一行变成
 * `\uFEFF{"id":...}`，JSON.parse 直接抛错，进而让整个 preset 挂载失败、
 * 会话不可用。任何编辑器或工具都可能加上 BOM，所以读取端必须免疫，
 * 而不是指望写入端永远不写它。
 *
 * 日志不大时全量读是够用的。**一旦需要按条件查询**（如"某知识点近 30 天的事件"），
 * 就该换存储——这是 ADR-012 决策 1 记下的失效信号。
 *
 * @returns 事件数组；文件不存在时返回空数组。
 */
export function readEvents() {
  const target = eventLogPath()
  if (!existsSync(target)) return []
  let text = readFileSync(target, 'utf8')
  // 去掉可能存在的 UTF-8 BOM（U+FEFF）
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/**
 * 统计各类事件的数量。给投影用：投影必须从纯 JSON 状态出发，不能读文件。
 *
 * @param events - 事件数组。
 * @returns 形如 `{ 'lh/user/act': 3 }` 的计数对象。
 */
export function countByType(events) {
  const counts = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  return counts
}

/**
 * LH 事件存储服务。挂在 `ctx.lhEvents` 上，供其它 LH 插件写入事件。
 *
 * 目前只暴露写入与读取。**刻意不提供"修改/删除"**——
 * append-only 不是实现细节，是这个事实源的定义。
 */
export class LhEventStore {
  /** 服务键名。宿主的服务机制用它定位本服务。 */
  static name = 'lhEvents'

  /**
   * 写一条事件。信封由本服务构造，调用方只提供语义字段。
   *
   * @param params.actor - 谁做的（user / agent / 插件 id）。
   * @param params.type - 事件类型。
   * @param params.data - 事件负载。
   * @param params.provenance - 产生它的插件 id + 版本。**必填**：
   *   契约 §1.4 说"重放不变量是相对的"，而插件出处正是重放正确性的前提。
   * @param params.scope - 节点路径，默认 'root'。
   * @param params.sessionRef - 所属会话。
   * @param params.contentRef - 外置内容的指针（大 payload 不内嵌，契约 §2.2）。
   * @returns 写入的事件（含其 id 与 timestamp）。
   */
  append({ actor, type, data, provenance, scope, sessionRef, contentRef }) {
    const event = createEnvelope({ actor, type, data, provenance, scope, sessionRef, contentRef })
    appendEvent(event)
    return event
  }

  /**
   * 写一条**资源**记录。
   *
   * 与普通事件的区别（docs/archive/decisions/009）：资源是可寻址可复用的产物，
   * 因此它的信封多两个字段：
   *   - `derived_from`：血缘列表（DAG，支持跨阶段成果流动）；
   *   - `supersedes`：它取代了哪些旧资源（更新 = 新资源 + 指针，旧版本永不覆盖）。
   *
   * 为什么资源也写进同一个日志、而不是另开一个存储：
   * 事件溯源要求"唯一事实源"。资源与事件是同一个时间流里的两种东西，
   * 分开两个文件会让"某时刻发生了什么"需要 join 两个流，而 join 就会引入不一致。
   * 区分靠 `type` 与这两个字段，不靠物理位置。
   *
   * @param params.actor - 谁产出的。
   * @param params.type - 资源类型（如 `lh/resource/indexed`）。
   * @param params.data - 资源的语义负载。
   * @param params.provenance - 产出它的插件 id + 版本。
   * @param params.scope - 节点路径，默认 'root'。
   * @param params.sessionRef - 所属会话。
   * @param params.contentRef - 外置内容指针（资源正文）。
   * @param params.derivedFrom - 血缘：本资源由哪些更早的东西派生而来。
   * @param params.supersedes - 本资源取代了哪些更早的资源。
   * @returns 写入的事件。
   */
  appendResource({
    actor,
    type,
    data,
    provenance,
    scope,
    sessionRef,
    contentRef,
    derivedFrom,
    supersedes,
  }) {
    const event = createEnvelope({
      actor,
      type,
      data: {
        ...data,
        // 血缘与取代关系放在 data 里而不是信封层：契约 §2.2 的信封是冻结的，
        // 而 ADR-009 的资源信封是插件层约定——两者不该混在一层里。
        derived_from: derivedFrom ?? [],
        supersedes: supersedes ?? [],
      },
      provenance,
      scope,
      sessionRef,
      contentRef,
    })
    appendEvent(event)
    return event
  }

  /**
   * 读回全部事件。
   * @returns 事件数组。
   */
  all() {
    return readEvents()
  }
}
