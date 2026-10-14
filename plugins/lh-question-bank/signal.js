/**
 * 刷题面板的启动信号 —— 让"对话里的 agent"能打开"浏览器里的面板"。
 *
 * ═══ 为什么需要这个文件 ═══
 * 作者反馈：常驻的侧栏按钮很突兀，刷题应当**由对话触发**
 * （*"我更喜欢能通过对话里 agent 的调用来启动"*）。
 *
 * 但这两端**不在同一棵树里**：
 *   · agent 的工具注册在 **agent preset 作用域**（`lh-question-bank` 注册 `start_practice`）；
 *   · 面板与它的 HTTP 路由在 **profile/host 作用域**（`lh-practice`）。
 * 所以内存里的信号传不过去（早期踩过：preset 是 agent 作用域，够不着 host 面的服务，
 * 见 docs/archive/decisions/014 补充决定 6）。
 *
 * **文件是最朴素的会合点**：两端都能读写同一个路径。它不需要任何新服务，
 * 也不依赖宿主的推送机制（宿主没有现成的服务端→客户端推送；`ctx.provide` 是
 * 客户端插件之间发布服务用的，方向不对）。
 *
 * ═══ 为什么是"信号文件"而不是"队列" ═══
 * 需要的语义只有一个：**"请打开面板"**。它不是任务队列，不需要可靠投递、
 * 不需要顺序、重复打开也无害（面板自己会取题）。
 * 所以只写一个计数器 + 时间戳：
 *   · 面板记下它上次见过的 `seq`，发现更大的就打开；
 *   · 重复写同一个 seq 不会被重复打开；
 *   · 文件丢了也没关系（下次工具调用会重建）。
 *
 * ═══ 为什么不用轮询之外的机制 ═══
 * 宿主没有服务端→客户端的通用推送。自己实现 SSE/WebSocket 能免掉轮询，
 * 但代价是长连接的生命周期管理——而轮询 3 秒一次、请求体极小、
 * 且只在面板**关闭**时进行。**在这个规模上，简单比省流量重要。**
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// LH 数据目录的定位：不写死盘符，从本模块位置推仓库根（见该文件注释）。
// 用包名导入而不是相对路径——相对路径装进 profile 后就断了（ADR-023 的教训）。
import { dataFile } from '@lh/event-store/paths'

/**
 * 信号文件的路径。
 *
 * 放在 LH 的 data/ 下（与 `events.jsonl` 同级），因为它属于**LH 的运行数据**，
 * 不是学习者的学习内容。若环境变量把事件日志指到别处（测试沙盒），信号就跟它放一起——
 * 这样测试与生产不会互相干扰。
 *
 * ⚠ 这里以前是写死的 `'D:\\LearningHarnessv0.1\\data\\practice-signal.json'`——
 * **作者机器上的路径**。写死不会让它报错，而是让它在别人机器上把信号写到
 * 一个莫名其妙的目录，表现是"面板永远不打开"（静默失效）。
 * 现在由 `@lh/event-store/paths` 从模块位置推仓库根。
 *
 * @returns 绝对路径。
 */
export function practiceSignalPath() {
  const logPath = process.env.LH_EVENT_LOG
  if (typeof logPath === 'string' && logPath.trim() !== '') {
    return join(dirname(logPath), 'practice-signal.json')
  }
  return dataFile('practice-signal.json')
}

/**
 * 读当前信号。
 *
 * @returns `{ seq, at, by, bank, count, style }`；文件不存在或损坏时 `seq` 为 0。
 */
export function readPracticeSignal() {
  const path = practiceSignalPath()
  try {
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return {
      seq: typeof parsed?.seq === 'number' ? parsed.seq : 0,
      at: typeof parsed?.at === 'string' ? parsed.at : null,
      by: typeof parsed?.by === 'string' ? parsed.by : null,
      bank: typeof parsed?.bank === 'string' ? parsed.bank : null,
      count: typeof parsed?.count === 'number' ? parsed.count : null,
      // 外观意图随信号一起走：这样**点卡片开面板时**，面板用的就是
      // agent 为这次请求声明的样子，而不是面板自己的一套默认值。
      // 注意这里**不重新校验**——写进来的时候已经由 style.js 归一化过了；
      // 在这里再校验一遍等于把同一套规则实现两次（迟早不一致）。
      style: parsed?.style !== null && typeof parsed?.style === 'object' && !Array.isArray(parsed.style)
        ? parsed.style
        : null,
      // **这次要刷哪些题**（档位 / 知识点 / 指定 id）也随信号走，理由与 style 完全相同：
      // 面板必须按**同一份选择**取题。否则卡片上写着"只练错题"、面板却给全库的题
      // ——那正是作者反馈的"卡片与题库耦合"（2026-09-19）。
      selection: parsed?.selection !== null && typeof parsed?.selection === 'object' && !Array.isArray(parsed.selection)
        ? parsed.selection
        : null,
    }
  } catch {
    // 文件不存在或损坏都当作"还没有信号"。
    // **不抛错**：这是可选的启动信号，不是事实源——它坏了不该让刷题用不了。
    return { seq: 0, at: null, by: null, bank: null, count: null, style: null, selection: null }
  }
}

/**
 * 写一个新信号（seq 递增），用于请求打开刷题面板。
 *
 * @param params.bank - 要刷的题库名（可选；面板省略时用第一个题库）。
 * @param params.count - 一次取几道（可选）。
 * @param params.by - 谁触发的（如 'agent'）。
 * @param params.style - **已经归一化过的**外观意图（见 style.js）。原样存下。
 * @param params.selection - **已经归一化过的**选择（见 practice.js 的 sanitizeSelection）。原样存下。
 * @returns 写入的信号。
 */
export function requestPracticePanel({ bank, count, by = 'agent', style = null, selection = null } = {}) {
  const path = practiceSignalPath()
  const prev = readPracticeSignal()
  const signal = {
    seq: prev.seq + 1,
    at: new Date().toISOString(),
    by,
    bank: bank ?? null,
    count: typeof count === 'number' ? count : null,
    style: style !== null && typeof style === 'object' && Object.keys(style).length > 0 ? style : null,
    selection: selection !== null && typeof selection === 'object' && Object.keys(selection).length > 0 ? selection : null,
  }
  mkdirSync(dirname(path), { recursive: true })
  // 原子替换：先写临时文件再 rename，避免面板读到半截 JSON
  // （与 `bank.js` 的 saveBank 同一理由：读者可能恰好在写入的瞬间来读）
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(signal, null, 2), 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    // 极端情况下（如临时文件与目标跨卷）退回直接写
    writeFileSync(path, JSON.stringify(signal, null, 2), 'utf8')
  }
  return signal
}
