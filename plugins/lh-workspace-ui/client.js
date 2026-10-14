/**
 * lh-workspace-ui 的【客户端半】—— 课程目录（管理"哪段对话属于哪门课"）。
 *
 * ═══ 它做什么 ═══
 * 把「课程目录」做成一等界面，而不是对话旁边的一块浮层：
 *   · `main` 槽（keyed）注册 key `lh` → 中央面板（与 conversation 平级）；
 *   · `sidebar.panellist`（list）注册**同名 id** `lh` → 侧栏图标。
 * 两者一一对应：宿主侧栏的 `PanelRow` 处理体就是 `selectPanel(id)`，而
 * `selectPanel` 只校验"main 注册表里有没有这个 key"，**没有任何 id 白名单**。
 * 所以两半必须**同时**注册——只注册侧栏图标而 main 缺失，点击会抛
 * `layout.selectPanel: main panel "lh" is not registered` 且不改选中态。
 *
 * 宿主源码依据（`app.asar` 内行号）：`433242` hasMainPanel = entries("main").some(e => e.options.key === id)；
 * 先例：`plugins`（443844/443907/443957）、`schedules`（470850/470961/470971）都是插件用同一公开 API 注册的。
 *
 * ═══ 三块功能的分工 ═══
 *   · 左列 = **课程树**（可折叠，每个根分支一个颜色）；
 *   · 右列 = **选中课程的操作台**：一组按钮（改名 / 加子课程 / 删除）+ 它的对话；
 *   · 右列下方 = **对话索引**：本机所有对话一张表，能按标题筛、能一键归到选中的课。
 *
 * ═══ 写走服务端路由，不是我拼事件 ═══
 * 浏览器**没有**事件日志的写权限，也不该有。每个动作都打一条本插件服务端半的
 * `POST` 路由，那条路由调 `@lh/course-tree/commands` —— 与 agent 工具**同一份代码**。
 * 于是"点按钮建的课"和"模型建的课"在日志里一模一样。
 *
 * ═══ 会话从哪来：宿主给的 `useSessions` / `useWorkspaces` ═══
 * 它们是 `main` 槽 standardProps 的一部分（Cordis Inspect 实测），比自己摸
 * `ctx.sessions.list` 的形状安全，且随列表刷新保持引用稳定。
 * "在课程下开一段新对话"用 `ctx.uiWorkspace.connectWorkspace(workspaceId): Promise<SessionId>`
 * ——**它是唯一能拿到"新会话 id"的公开面**（`startSession()` 返回 void，绑不了）。
 *
 * ═══ 色彩与动效的纪律（我看不见界面，所以这两条是硬的）═══
 * 1. **颜色一律来自主题令牌**（`--dsw-alias-*`，Inspect 实测 14 个，全部 `requiresLightAndDark`）。
 *    自己调 hsl 会在另一种模式里做出低对比度，而我**看不到结果**。所以"每门课一个颜色"
 *    用的是**令牌调色板轮转**，不是算出来的色相。
 * 2. **动效只能是内联样式能表达的**：宿主明说"不要在组件外写 DOM / 不要 append 到 body"
 *    （`app.asar:292611`），所以不能注入 `<style>`、也就**没有 @keyframes**。
 *    能用的只有 `transition` + 挂载后翻一个 state 的入场动画。它做不了高度展开动画，
 *    换来的是不越界。
 */

window.__ModuleLoader__.load({
  id: '@lh/workspace-ui',
  factory: (require) => {
    /** @type {any} */
    var module = { exports: {} }
    /** @type {any} */
    var exports = module.exports

    /**
     * @type {any}
     *
     * ⚠ 不用 JSX：本文件是手工 bundle，没有转译步骤，JSX 会直接语法错误。
     */
    const React = require('react')

    /** 本插件服务端半的路由前缀。 */
    const API = '/lh/workspace'

    /** 面板与侧栏图标共用的 id（两半必须同名，见文件头）。 */
    const PANEL_ID = 'lh'

    /** 折起状态、最近选中、索引筛选词都存在浏览器本地（纯界面偏好，不是事实）。 */
    const LS_COLLAPSED = 'lh.course.collapsed'
    const LS_TREE_OPEN = 'lh.course.treeOpen'
    const LS_SELECTED = 'lh.course.selected'
    const LS_INDEX_OPEN = 'lh.course.indexOpen'

    /**
     * 每个根分支一个颜色，**从主题令牌里挑**（不是算出来的色相）。
     *
     * 为什么是这五个：它们是 Inspect 列出的全部语义色。
     * 用 `state-error-primary` 当普通课程色在语义上有点刺眼，但它是**唯一**的第五个可选色，
     * 而且这里只当"这条分支的标记色"用（不是状态指示），所以可接受。
     * 分支内的子课程**继承根的颜色**——同一条支线一个颜色，比每层都换色好认。
     */
    const ACCENTS = [
      'var(--dsw-alias-brand-primary, #3b82f6)',
      'var(--dsw-alias-state-success-primary, #16a34a)',
      'var(--dsw-alias-state-warn-primary, #d97706)',
      'var(--dsw-alias-state-idle-primary, #9ca3af)',
      'var(--dsw-alias-state-error-primary, #dc2626)',
    ]

    /** 动效时长（毫秒）。集中一处，便于整体调快/调慢并保持一致。 */
    const MOTION = { fast: 110, base: 160, slow: 240 }

    // ══════════════════════════════════════════════════════════════════════
    // 状态：模块级闭包 + 手写 subscribe/emit（seed 里只有 react/react-dom，没有状态库）
    // ══════════════════════════════════════════════════════════════════════

    /** ctx 存到模块级：apply 的作用域不是会话作用域，组件里只能从这里拿服务。 */
    let ctxRef = null

    /**
     * "打开某个会话" + "开一段新对话"的可选能力。
     *
     * ═══ 为什么走 `ctx.get()` 而不是写进 `inject` ═══
     * **inject 少一个服务会让整个客户端插件装载失败**（浏览器卡在 `Failed to load plugins`，
     * 整块界面起不来）。宁可少两个按钮也不要整块起不来，所以取它的可选面：
     * 拿不到就禁用按钮**并说明为什么**，不假装成功。
     *
     * ⚠ 不能写 `ctx.uiWorkspace`：没声明 inject 就访问服务会抛
     *   `cannot get property "uiWorkspace" without inject`（本项目实测过的原话）。
     */
    let uiWorkspace = null

    let panelOpen = false
    let data = null
    let loading = false
    let errorText = null
    let selectedNodeId = readLocal(LS_SELECTED, null)
    /**
     * `main` 面板是否真的注册成功。
     * 只有它成功了，`selectPanel(PANEL_ID)` 才不会抛错——所以点击处理器要先看它。
     */
    let mainRegistered = false

    /** 动作的结果提示（成功或失败都显示；失败**不静默**）。 */
    let notice = null
    /** 正在写（建课/改名/绑定/删除）时为 true，按钮禁用，避免连点写两条事件。 */
    let busy = false

    /**
     * 折叠起来的节点 id 集合。
     * @type {Set<string>}
     */
    let collapsedIds = readCollapsed()
    /** 整块「课程树」是否展开（读不到就默认展开）。 */
    let treeOpen = readFlag(LS_TREE_OPEN, true)
    /** 右列下方「对话索引」是否展开。 */
    let indexOpen = readFlag(LS_INDEX_OPEN, true)

    /** 右列当前打开的**内联编辑器**：`null` | `'rename'` | `'addChild'` | `'newRoot'`。 */
    let editor = null

    /** 删除确认：正在为哪个节点要影响面、拿到的影响面、以及是否在取。 */
    let deleteNodeId = null
    let deleteImpact = null
    let deleteLoading = false

    /** 对话索引的筛选词（只影响显示，不影响任何写入）。 */
    let indexQuery = ''

    /** 最近一次在对话里看到的会话 id（用于"把刚才那篇对话绑到这门课"）。 */
    let lastSessionId = null

    const listeners = new Set()
    function emit() {
      for (const fn of listeners) fn()
    }
    function subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }

    /**
     * 读一个本地偏好的**原始值**（读不到或坏掉就给默认值）。
     * @param key - 键。
     * @param fallback - 默认值。
     * @returns 值。
     */
    function readLocal(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        return raw === null ? fallback : raw
      } catch {
        return fallback
      }
    }

    /**
     * 读一个布尔偏好。
     *
     * 为什么单独一个函数：第一版把"未设置"和"关着"混在一起判断
     * （`read(...) !== false && read(...) !== '0'`），而 localStorage 里存的是字符串，
     * 于是"没存过"和"存了 '0'"这两件事在表达式里**同时**参与，读起来没法验证。
     * 一个设置项只有三种状态（没设过 / 开 / 关），就应该有三条明确的分支。
     *
     * @param key - 键。
     * @param fallback - 没设过时的默认。
     * @returns 布尔。
     */
    function readFlag(key, fallback) {
      const raw = readLocal(key, null)
      if (raw === null) return fallback
      return raw === '1' || raw === true
    }

    /**
     * 读折起的节点集合。
     * @returns 集合。
     */
    function readCollapsed() {
      const raw = readLocal(LS_COLLAPSED, null)
      if (typeof raw !== 'string' || raw === '') return new Set()
      try {
        const list = JSON.parse(raw)
        return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [])
      } catch {
        return new Set()
      }
    }

    /**
     * 写一个本地偏好（写不进去不影响本次会话内的表现）。
     * @param key - 键。
     * @param value - 值。
     */
    function writeLocal(key, value) {
      try {
        if (value === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, String(value))
      } catch {
        /* 忽略 */
      }
    }

    /** hook 共用的快照对象：**必须是稳定引用**，否则 useSyncExternalStore 会无限重渲染。 */
    let viewState = null

    /** 数据 + 交互状态的快照（一次订阅拿全，避免多个 store 互相打架）。 */
    function useView() {
      return React.useSyncExternalStore(subscribe, () => viewState, () => viewState)
    }
    /** 面板开关（浮层兜底用）。 */
    function usePanelOpen() {
      return React.useSyncExternalStore(subscribe, () => panelOpen, () => panelOpen)
    }
    /** 数据变化后同时换引用并通知（顺序不能反：换完引用再 emit，订阅者才拿到新快照）。 */
    function publish() {
      viewState = {
        data,
        loading,
        errorText,
        selectedNodeId,
        notice,
        busy,
        treeOpen,
        collapsedIds,
        indexOpen,
        editor,
        deleteNodeId,
        deleteImpact,
        deleteLoading,
        indexQuery,
        lastSessionId,
        panelOpen,
      }
      emit()
    }
    publish()

    /**
     * 入场动画：挂载后翻一个 state，让 `transition` 有"从哪来"。
     *
     * ═══ 为什么只有这一种动效 ═══
     * 宿主明说不要在组件外写 DOM / 不要 append 到 body，所以**注入不了 `<style>`**，
     * 也就**没有 @keyframes**。剩下能表达的就是"内联 transition + 状态翻转"。
     * 它的直接限制：**做不了高度展开动画**（那需要测量高度或 keyframes）。
     * 所以折叠的反馈落在"箭头旋转 + 内容淡入"上——够用，而且不越界。
     *
     * @param delay - 延迟（毫秒），用于让同级元素错开一点（列表看起来是"流进来"的）。
     * @returns 该元素的内联样式片段。
     */
    function useEnter(delay = 0) {
      const [shown, setShown] = React.useState(false)
      React.useEffect(() => {
        if (delay <= 0) {
          setShown(true)
          return undefined
        }
        const timer = window.setTimeout(() => setShown(true), delay)
        return () => window.clearTimeout(timer)
      }, [delay])
      return {
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(3px)',
        transition: `opacity ${MOTION.base}ms ease, transform ${MOTION.base}ms ease`,
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 取数与写入：只走本插件服务端半注册的 HTTP 路由
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 调服务端路由。
     * @param path - `/tree` 之类。
     * @param options - fetch 选项（POST 时带 body）。
     * @returns 解析后的 JSON。
     */
    async function callApi(path, options) {
      const res = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      let body = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      if (!res.ok) {
        // 服务端的错误体带 error/fix：把两者都端出来，否则学习者只看到一串数字。
        const detail = body?.error ?? `${res.status}`
        const fix = Array.isArray(body?.fix) ? `（${body.fix.join('；')}）` : ''
        throw new Error(`${detail}${fix}`)
      }
      return body
    }

    /** 拉一次课程目录。失败**不白屏**，把错误显示在面板里。 */
    async function load() {
      loading = true
      errorText = null
      publish()
      try {
        data = await callApi('/tree')
        // 自动选中：面板第一次打开时没选任何课程，右列就只剩一句"从左边选一门"，
        // 而操作按钮组也看不到。所以数据到手后补一次默认选中：
        // 优先上次选中的（还在的话）、再第一个根课程。
        const nodes = data?.nodes ?? []
        const stillThere = nodes.some((n) => n.node_id === selectedNodeId)
        if (!stillThere) {
          selectedNodeId = data?.roots?.[0] ?? nodes[0]?.node_id ?? null
          writeLocal(LS_SELECTED, selectedNodeId)
        }
      } catch (error) {
        errorText = String(error?.message ?? error)
      } finally {
        loading = false
        publish()
      }
    }

    /**
     * 跑一个写动作，然后重新拉树。
     *
     * 统一在这里收口，是为了四件事在任何一条路径上都不会漏：
     * busy 置位（防连点写两条）、失败把服务端的 fix 显示出来、成功后刷新、
     * 以及**成功时把右列的内联编辑器关掉**（否则改完名字输入框还杵在那里）。
     *
     * @param label - 提示里用的动作名。
     * @param path - POST 路径。
     * @param payload - 请求体。
     * @returns 服务端返回体；失败返回 null。
     */
    async function write(label, path, payload) {
      if (busy) return null
      busy = true
      notice = { kind: 'info', text: `${label}…` }
      publish()
      try {
        const out = await callApi(path, { method: 'POST', body: JSON.stringify(payload) })
        notice = { kind: 'ok', text: `${label}成功。` }
        editor = null
        busy = false
        publish()
        await load()
        return out
      } catch (error) {
        notice = { kind: 'bad', text: `${label}失败：${String(error?.message ?? error)}` }
        busy = false
        publish()
        return null
      }
    }

    /** 建课程（parentId 为 null 时建在顶层）。 */
    function createCourse(title, parentId) {
      return write('建课程', '/course', { title, parent_id: parentId ?? null })
    }

    /** 改课程名。 */
    function renameCourse(nodeId, title) {
      return write('改名', '/rename', { node_id: nodeId, title })
    }

    /** 把某个会话绑到某门课（"建索引"）。 */
    function bindSession(nodeId, sessionId) {
      return write('归课', '/bind', { node_id: nodeId, session_id: sessionId })
    }

    /**
     * 打开"删除确认"：**先把影响面取回来**，再让学习者看着清单决定。
     *
     * 这一步刻意**不写任何东西**（服务端的 `/impact` 是纯读）。
     * 项目规则 4「破坏性操作一律白名单」的落点就在这里：确认框里的清单
     * 不是界面上抄的，是服务端用与 agent 工具同一份 `previewDelete` 算出来的。
     *
     * @param nodeId - 要删的课程。
     */
    async function askDelete(nodeId) {
      deleteNodeId = nodeId
      deleteImpact = null
      deleteLoading = true
      editor = null
      publish()
      try {
        deleteImpact = await callApi(`/impact?node=${encodeURIComponent(nodeId)}`)
      } catch (error) {
        notice = { kind: 'bad', text: `取影响面失败：${String(error?.message ?? error)}` }
        deleteNodeId = null
      } finally {
        deleteLoading = false
        publish()
      }
    }

    /** 关掉删除确认（什么都不做）。 */
    function cancelDelete() {
      deleteNodeId = null
      deleteImpact = null
      deleteLoading = false
      publish()
    }

    /** 确认删除。服务端**要求** `confirm: true`——白名单挡在接口上，不只挡在按钮上。 */
    async function confirmDelete() {
      const nodeId = deleteNodeId
      if (nodeId === null) return
      const out = await write('删除课程', '/delete', { node_id: nodeId, confirm: true })
      if (out !== null) {
        deleteNodeId = null
        deleteImpact = null
        // 删掉的可能正是选中的那门（或它的祖先），下一次 load 会自动改选。
        selectedNodeId = null
        writeLocal(LS_SELECTED, null)
        publish()
      }
    }

    /**
     * **在一门课下开一段新对话，并立刻把它归到这门课**（"建索引"的落点）。
     *
     * ═══ 为什么用 `connectWorkspace` 而不是 `startSession` ═══
     * `startSession(workspaceId?): void` **不返回会话 id**——拿不到 id 就绑不了，
     * 于是会出现"界面显示了新对话、但它其实没归到任何课下"的静默不一致。
     * `connectWorkspace(workspaceId): Promise<SessionId>` 返回
     * "该工作区里可复用的或新创建的空会话"，那正是能绑的坐标（源码 `718463`、类型签名 `734136`）。
     *
     * ⚠ `connectWorkspace` 会**复用**一个已有的空会话。所以连续给两门课点"新对话"
     *    可能拿到同一段对话——那不是 bug，是"空会话只有一个"；后一次绑定覆盖前一次，
     *    而界面把"这段对话现在归哪门课"显示出来。
     *
     * @param nodeId - 要归到哪门课。
     * @param workspaceId - 在哪个工作区里开；`null` 表示没有可用工作区。
     */
    async function newSessionInCourse(nodeId, workspaceId) {
      if (uiWorkspace === null || typeof uiWorkspace.connectWorkspace !== 'function') {
        notice = { kind: 'bad', text: '宿主的 uiWorkspace 服务不可用，无法新建对话（课程目录的其它功能不受影响）。' }
        publish()
        return
      }
      if (workspaceId === null) {
        notice = {
          kind: 'bad',
          text: '还没有可用的工作区，无法新建对话。先在侧栏「工作区」里添加一个目录。',
        }
        publish()
        return
      }
      busy = true
      notice = { kind: 'info', text: '正在新建对话…' }
      publish()
      let sessionId = null
      try {
        sessionId = await uiWorkspace.connectWorkspace(workspaceId)
      } catch (error) {
        busy = false
        notice = { kind: 'bad', text: `新建对话失败：${String(error?.message ?? error)}` }
        publish()
        return
      }
      busy = false
      publish()
      // 先绑定（**建索引**），再导航——反过来会在绑定完成前就离开这块面板。
      const bound = await write('把新对话归到这门课', '/bind', { node_id: nodeId, session_id: sessionId })
      if (bound !== null) {
        notice = { kind: 'ok', text: `已新建对话并归到这门课：${sessionId}` }
        publish()
        if (typeof uiWorkspace.openSession === 'function') uiWorkspace.openSession(sessionId)
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 纯函数：拍平树 / 会话表 / 时间 / 短 id
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 按 children_of 深度优先拍平课程树，**跳过被折起的节点的后代**。
     *
     * @param view - `/tree` 的返回。
     * @param collapsed - 已折起的节点 id 集合。
     * @returns `[{ node, depth, hasChildren, expanded, accent }]`，顺序即显示顺序。
     */
    function flatten(view, collapsed) {
      const out = []
      if (view === null || view === undefined) return out
      const byId = Object.create(null)
      for (const n of view.nodes ?? []) byId[n.node_id] = n
      const stack = []
      const roots = view.roots ?? []
      // 倒序入栈 → 出栈顺序与 roots 声明一致。根的颜色按它在 roots 里的**位置**分配。
      for (let i = roots.length - 1; i >= 0; i -= 1) {
        stack.push({ id: roots[i], depth: 0, accent: ACCENTS[i % ACCENTS.length] })
      }
      while (stack.length > 0) {
        const { id, depth, accent } = stack.pop()
        const node = byId[id]
        if (node === undefined) continue
        const children = view.children_of?.[id] ?? []
        const hasChildren = children.length > 0
        const expanded = !collapsed.has(id)
        out.push({ node, depth, hasChildren, expanded, accent })
        if (!hasChildren || !expanded) continue
        // 子课程**继承根的颜色**（同一条分支一个颜色，比每层换色好认）。
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ id: children[i], depth: depth + 1, accent })
      }
      return out
    }

    /**
     * 从宿主给的快照里取 `{ byId }`。
     *
     * 兼容两种形状：直接的 `{ byId }`，以及 `{ value: { byId } }`（快照包装）。
     * 认不出就返回空表——**不猜**，界面上表现为"没有对话"，而不是列出别人的会话。
     *
     * @param snapshot - useSessions 的选择结果。
     * @returns `{ [id]: row }`。
     */
    function sessionsById(snapshot) {
      const s = snapshot?.byId !== undefined ? snapshot : snapshot?.value
      const byId = s?.byId
      return byId !== null && typeof byId === 'object' ? byId : Object.create(null)
    }

    /**
     * 从 `useWorkspaces` 的快照里取工作区数组。
     *
     * 形状是 `{ items: [{ workspaceId, ... }] }`（源码 `718464` 读的是 `items[].workspaceId`）。
     * 同样**不猜**：认不出就返回空数组，于是"新对话"按钮会明确说"没有可用工作区"。
     *
     * @param snapshot - useWorkspaces 的选择结果。
     * @returns 工作区数组。
     */
    function workspacesOf(snapshot) {
      const s = snapshot?.items !== undefined ? snapshot : snapshot?.value
      return Array.isArray(s?.items) ? s.items : []
    }

    /**
     * 取一个会话的显示标题。
     * @param row - 会话行。
     * @param id - 会话 id。
     * @returns 标题文本。
     */
    function sessionTitle(row, id) {
      const title = row?.title
      if (typeof title === 'string' && title.trim() !== '') return title
      // 空会话还没有标题（宿主在第一句话之后才生成）。用 id 兜底是**如实**的：
      // 界面上会同时显示短 id 与"未归课"徽章，不会被误读成"这段对话坏了"。
      return id
    }

    /**
     * 会话的排序权重（越大越新）。认不出时间就给 0——排在最后，而不是排在最前。
     * @param row - 会话行。
     * @returns 数字。
     */
    function recencyOf(row) {
      const raw = row?.updatedAt ?? row?.updated_at ?? row?.lastActiveAt
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (typeof raw === 'string') {
        const t = Date.parse(raw)
        if (!Number.isNaN(t)) return t
      }
      return 0
    }

    /**
     * 会话 id 的展示短形态（末 6 位；完整 id 太长，而前缀都一样）。
     * @param id - 会话 id。
     * @returns 短 id。
     */
    function shortId(id) {
      return typeof id === 'string' && id.length > 6 ? id.slice(-6) : String(id)
    }

    // ══════════════════════════════════════════════════════════════════════
    // 样式（内联）
    //
    // 颜色一律 `var(--令牌, 兜底)`，令牌名取自宿主 Inspect 的 Theme.listTokens
    // （14 个，全部 requiresLightAndDark）——见文件头"色彩与动效的纪律"。
    // ══════════════════════════════════════════════════════════════════════

    const S = {
      panel: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-alias-bg-base, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        minHeight: 0,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        flex: '0 0 auto',
      },
      title: { fontSize: '14px', fontWeight: 600 },
      muted: { color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '12px' },
      body: { display: 'flex', flex: '1 1 auto', minHeight: 0 },
      left: {
        width: '320px',
        flex: '0 0 auto',
        borderRight: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        overflowY: 'auto',
        padding: '8px 6px',
        minHeight: 0,
      },
      right: { flex: '1 1 auto', overflowY: 'auto', padding: '14px 16px', minHeight: 0 },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontSize: '13px',
        lineHeight: '1.6',
        borderLeft: '3px solid transparent',
        transition: `background ${MOTION.fast}ms ease, border-color ${MOTION.fast}ms ease`,
      },
      twisty: {
        width: '16px',
        flex: '0 0 auto',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        userSelect: 'none',
        display: 'inline-block',
        transition: `transform ${MOTION.base}ms ease`,
      },
      count: {
        marginLeft: 'auto',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        flex: '0 0 auto',
      },
      badge: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        flex: '0 0 auto',
        whiteSpace: 'nowrap',
      },
      session: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        marginBottom: '6px',
        fontSize: '12px',
        transition: `border-color ${MOTION.fast}ms ease, transform ${MOTION.fast}ms ease`,
      },
      button: {
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        borderRadius: '6px',
        padding: '5px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        transition: `background ${MOTION.fast}ms ease, border-color ${MOTION.fast}ms ease, color ${MOTION.fast}ms ease`,
      },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      input: {
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-base, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        borderRadius: '6px',
        padding: '5px 8px',
        fontSize: '12px',
        minWidth: '180px',
        transition: `border-color ${MOTION.fast}ms ease`,
      },
      iconButton: {
        width: '32px',
        height: '32px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        cursor: 'pointer',
        fontSize: '15px',
        lineHeight: 1,
      },
      overlayWrap: {
        position: 'fixed',
        inset: '0',
        zIndex: 9000,
        display: 'flex',
        justifyContent: 'flex-end',
        // shell.overlay 的条目在主动接收指针事件前是**点击穿透**的，所以这里必须显式声明。
        pointerEvents: 'auto',
      },
      overlayPanel: {
        width: 'min(920px, 92vw)',
        height: '100%',
        background: 'var(--dsw-alias-bg-overlay, #ffffff)',
        borderLeft: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      },
      sectionHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
      empty: { padding: '18px 4px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #6b7280)' },
      error: {
        margin: '10px 14px',
        padding: '10px 12px',
        borderRadius: '8px',
        fontSize: '12px',
        border: '1px solid var(--dsw-alias-state-error-primary, #d33)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
      },
      notice: {
        margin: '8px 0 0',
        padding: '8px 12px',
        borderRadius: '8px',
        fontSize: '12px',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        borderRadius: '8px',
        padding: '10px 12px',
        marginTop: '10px',
        background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
        transition: `border-color ${MOTION.fast}ms ease`,
      },
      actionRow: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '12px', alignItems: 'center' },
      dangerCard: {
        border: '1px solid var(--dsw-alias-state-error-primary, #d33)',
        borderRadius: '8px',
        padding: '10px 12px',
        marginTop: '10px',
        background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
      },
      impactLine: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '2px 0' },
    }

    // ══════════════════════════════════════════════════════════════════════
    // 小组件
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 一个会随悬停变色的按钮。
     *
     * ═══ 为什么要自己记悬停态 ═══
     * 内联样式表达不了 `:hover`（那需要选择器），而宿主不让注入 `<style>`。
     * 所以悬停只能是"组件里存一个 boolean"。代价是每次悬停都会重渲染这一个按钮——
     * 按钮数量是个位数，这个代价可以忽略；换成全局 `<style>` 的代价则是越界。
     *
     * @param props - `{ label, onClick, disabled, tone, title }`。
     * @returns React 元素。
     */
    function Btn(props) {
      const [hover, setHover] = React.useState(false)
      const disabled = props.disabled === true
      /** 三种色调，够用且语义清楚：默认 / 主操作 / 危险。 */
      const tone = props.tone ?? 'default'
      const accent =
        tone === 'danger'
          ? 'var(--dsw-alias-state-error-primary, #d33)'
          : tone === 'primary'
            ? 'var(--dsw-alias-brand-primary, #3b82f6)'
            : 'var(--dsw-alias-border-l2, #d1d5db)'
      return React.createElement(
        'button',
        {
          type: 'button',
          title: props.title,
          disabled,
          onClick: props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            ...S.button,
            ...(disabled ? S.buttonDisabled : {}),
            borderColor: hover && !disabled ? accent : 'var(--dsw-alias-border-l1, #e5e7eb)',
            color: tone === 'default' ? 'var(--dsw-alias-label-primary, #1f2328)' : accent,
            background: hover && !disabled ? 'var(--dsw-alias-bg-layer-2, #eef0f4)' : S.button.background,
          },
        },
        props.label,
      )
    }

    /**
     * 一个输入框 + 确认/取消（建课、改名共用）。
     *
     * 为什么不用 `window.prompt`：Electron 里它默认**不可用**（宿主没开 prompt），
     * 点了会静默无事发生——那正是"形态正确 ≠ 功能可达"。
     *
     * @param props - `{ placeholder, submitLabel, initial, disabled, onSubmit, onCancel }`。
     * @returns React 元素。
     */
    function InlineInput(props) {
      const [text, setText] = React.useState(props.initial ?? '')
      const enter = useEnter()
      const submit = () => {
        const value = text.trim()
        if (value === '' || props.disabled) return
        props.onSubmit(value)
      }
      return React.createElement(
        'div',
        { style: { ...enter, display: 'flex', gap: '6px', alignItems: 'center', marginTop: '8px' } },
        React.createElement('input', {
          type: 'text',
          value: text,
          placeholder: props.placeholder,
          style: S.input,
          autoFocus: true,
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape' && typeof props.onCancel === 'function') props.onCancel()
          },
        }),
        React.createElement(Btn, {
          label: props.submitLabel,
          tone: 'primary',
          disabled: props.disabled === true,
          onClick: submit,
        }),
        typeof props.onCancel === 'function'
          ? React.createElement(Btn, { label: '取消', onClick: props.onCancel })
          : null,
      )
    }

    /**
     * 一条课程行。
     *
     * @param props - `{ row, selected, onSelect, onToggle }`。
     * @returns React 元素。
     */
    function CourseRow(props) {
      const { row, selected, onSelect, onToggle, onMenu, menuOpen } = props
      const node = row.node
      const [hover, setHover] = React.useState(false)
      const enter = useEnter(Math.min(row.depth * 20, 120))
      const expanded = row.expanded

      return React.createElement(
        'div',
        {
          onClick: () => onSelect(node.node_id),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            ...S.row,
            ...enter,
            paddingLeft: `${6 + row.depth * 14}px`,
            // 颜色：这条分支的标记色常驻（左边一条 3px 的竖线），
            // 选中时底色加深、悬停时只提亮底色——三种状态一眼分得开。
            borderLeftColor: selected || hover ? row.accent : 'transparent',
            background: selected
              ? 'var(--dsw-alias-bg-layer-2, #eef0f4)'
              : hover
                ? 'var(--dsw-alias-bg-layer-1, #f7f8fa)'
                : 'transparent',
            fontWeight: row.depth === 0 ? 600 : 400,
          },
        },
        React.createElement(
          'span',
          {
            style: {
              ...S.twisty,
              // 一个字形 + 旋转 = 展开态。比换字符更连贯（有过渡）。
              transform: row.hasChildren && expanded ? 'rotate(90deg)' : 'none',
              opacity: row.hasChildren ? 1 : 0.35,
            },
            // 折起只折这一支，不影响选中；两个点击区必须分开，
            // 否则"想展开一支"会顺手把选中也换掉（大树上很难受）。
            onClick: (event) => {
              event.stopPropagation()
              if (row.hasChildren) onToggle(node.node_id)
            },
            title: row.hasChildren ? (expanded ? '折起子课程' : '展开子课程') : undefined,
          },
          row.hasChildren ? '▸' : '·',
        ),
        React.createElement(
          'span',
          { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          node.title,
        ),
        // ── 行尾：会话说量徽章 + 一个「⋯」──
        //
        // ═══ 为什么收成一个「⋯」（作者 2026-10-08 的要求）═══
        // 上一版这里是三个常显图标（＋ ✎ ✕），作者的原话是"三个图标的界面太混乱了"。
        // 换成：**右对齐一个「⋯」，点开才展开三个动作**。
        //
        // ═══ 为什么展开的是一条**行内**动作条，而不是浮层菜单 ═══
        // 浮层要 `position:absolute/fixed`，而左列是 `overflowY:auto` 的滚动容器——
        // absolute 会被容器边缘裁掉（最后一行尤其明显）；fixed 又会被祖先的
        // `transform` 变成相对它定位（本插件的入场动画正好用了 transform）。
        // 行内展开没有这两个问题，代价是它会撑高那一行。
        // **我看不见界面**，所以选"一定不会错位/被裁掉"的那一种。
        React.createElement(
          'span',
          {
            style: {
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              flex: '0 0 auto',
            },
          },
          node.sessions.length > 0
            ? React.createElement(
              'span',
              { style: { ...S.badge, color: row.accent, borderColor: row.accent } },
              `${node.sessions.length}`,
            )
            : null,
          React.createElement(RowAction, {
            glyph: '⋯',
            title: `「${node.title}」的操作（子课程 / 改名 / 删除）`,
            // 同一个按钮开/关：点开、再点收起。
            onClick: () => onMenu(node.node_id),
            active: menuOpen,
          }),
        ),
      )
    }

    /**
     * 行尾的一个小按钮（目前只有「⋯」；留成通用是因为行内动作条也用它）。
     *
     * 单独一个组件只为一件事：**它自己的悬停态**。内联样式没有 `:hover`，
     * 所以每个按钮得自己记一个 boolean；把它包成组件，行与行的悬停就互不牵连。
     *
     * @param props - `{ glyph, title, danger, active, onClick }`。
     * @returns React 元素。
     */
    function RowAction(props) {
      const [hover, setHover] = React.useState(false)
      const active = props.active === true
      const accent = props.danger === true
        ? 'var(--dsw-alias-state-error-primary, #d33)'
        : 'var(--dsw-alias-label-primary, #1f2328)'
      return React.createElement('button', {
        type: 'button',
        title: props.title,
        onClick: (event) => {
          // 行本身是"选中"的点击区，操作按钮必须停掉冒泡，否则点 ＋ 会顺带改选中。
          // 用可选链：React 一定会传事件，但"点击处理器因为拿不到事件而抛错"这种失败
          // 不值得发生——它会让这一下点击**什么都不做**，而没有任何提示。
          event?.stopPropagation?.()
          props.onClick()
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          width: '22px',
          height: '20px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          borderRadius: '4px',
          border: '1px solid transparent',
          // 展开状态要"亮着"，否则点开之后看不出是它开着的。
          background: active
            ? 'var(--dsw-alias-bg-layer-2, #eef0f4)'
            : hover
              ? 'var(--dsw-alias-bg-layer-1, #f7f8fa)'
              : 'transparent',
          color: active || hover ? accent : 'var(--dsw-alias-label-secondary, #6b7280)',
          cursor: 'pointer',
          fontSize: '13px',
          lineHeight: 1,
          transition: `background ${MOTION.fast}ms ease, color ${MOTION.fast}ms ease`,
        },
      }, props.glyph)
    }

    /**
     * 一个行内动作条：点「⋯」之后在**那一行下面**展开的三个动作。
     *
     * 右对齐、与行尾的「⋯」同侧，视觉上像是从它展开出来的。
     *
     * @param props - `{ onAddChild, onRename, onDelete, busy }`。
     * @returns React 元素。
     */
    function RowMenu(props) {
      const enter = useEnter()
      const item = (label, title, onClick, danger) => React.createElement(Btn, {
        label,
        title,
        tone: danger === true ? 'danger' : 'default',
        disabled: props.busy === true,
        onClick,
      })
      return React.createElement(
        'div',
        {
          style: {
            ...enter,
            display: 'flex',
            gap: '6px',
            justifyContent: 'flex-end',
            padding: '4px 8px 6px',
          },
        },
        item('子课程', '在这门课下面建一门子课程', props.onAddChild),
        item('改名', '改这门课的名字', props.onRename),
        item('删除', '删除这门课及其子课程（先列影响面）', props.onDelete, true),
      )
    }

    /**
     * 左下 Settings → General 里的一行：**重载界面**。
     *
     * ═══ 为什么这一行自己画标签 ═══
     * `settings.general.item` 的目录原文写明："The section column only stacks rows,
     * so a row draws its own internals, **including its label**: nothing projects a
     * `label` here and the owner passes no props at all"。
     * 也就是说：注册时给不给 `label` 都不影响显示，**组件拿不到任何 props**，
     * 文案、当前值、写入路径全归我自己。所以这里是一个自包含的整行。
     *
     * `order: 95` —— 现有各行的位置是 permission(-20) / language(0) / appearance(10) /
     * font-size(11) / transcript-view(12) / developer-tools(15) / shortcuts(16) /
     * link-opening(17) / composer-enter(20) / performance-usage(30) /
     * session-log(90) / current-version(100)。
     * 95 落在"开发/诊断类"那一带的末尾（session-log 之后、当前版本之前）——
     * 它是个开发动作，不该混在日常偏好中间。
     *
     * @returns React 元素。
     */
    function ReloadRow() {
      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '10px 0',
            borderTop: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
          },
        },
        React.createElement(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          React.createElement('div', { style: { fontSize: '13px' } }, '重载界面（LH 开发用）'),
          React.createElement('div', { style: { marginTop: '2px', ...S.muted } },
            '重新加载浏览器页面，界面插件的改动立刻生效。' +
            '服务端半（路由/插件）的改动仍需重启应用——桌面应用的真重启在主菜单里，插件够不着它。'),
        ),
        React.createElement(Btn, {
          label: '重载界面',
          tone: 'primary',
          title: '等价于按 F5：只重新加载这个页面，不动应用进程',
          onClick: reloadUi,
        }),
      )
    }

    /**
     * 删除确认卡：**先把清单摆出来**，再让人点确认。
     *
     * @param props - `{ impact, loading, busy, onCancel, onConfirm }`。
     * @returns React 元素。
     */
    function DeleteConfirm(props) {
      const { impact, loading, busy, onCancel, onConfirm } = props
      const enter = useEnter()
      if (loading || impact === null) {
        return React.createElement('div', { style: { ...S.card, ...enter } }, '正在算影响面…')
      }
      const subs = impact.sub_courses ?? []
      const sessions = impact.session_ids ?? []
      return React.createElement(
        'div',
        { style: { ...S.dangerCard, ...enter } },
        React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-state-error-primary, #d33)' } },
          `确认删除「${impact.title}」？`),
        React.createElement('div', { style: { marginTop: '6px', ...S.muted } },
          '这一步会追加一条 lh/course/deleted 事件。旧事件一条不动，但要恢复得重建同名课程。'),
        React.createElement('div', { style: { marginTop: '8px' } },
          React.createElement('div', { style: S.impactLine },
            React.createElement('span', null, '会一起消失的子课程：'),
            React.createElement('strong', null, String(subs.length)),
            React.createElement('span', { style: S.muted }, ' 门')),
          ...subs.slice(0, 20).map((n) => React.createElement(
            'div',
            {
              key: n.node_id,
              style: {
                ...S.impactLine,
                paddingLeft: `${8 + Math.max(0, n.level - impact.level - 1) * 12}px`,
                ...S.muted,
              },
            },
            '· ',
            n.title,
            React.createElement('span', { style: S.muted }, `  [${n.node_id}]`),
          )),
          subs.length > 20
            ? React.createElement('div', { style: { ...S.impactLine, ...S.muted } }, `…还有 ${subs.length - 20} 门`)
            : null,
          React.createElement('div', { style: { ...S.impactLine, marginTop: '6px' } },
            React.createElement('span', null, '会变成「未归课」的对话：'),
            React.createElement('strong', null, String(sessions.length)),
            React.createElement('span', { style: S.muted }, ' 段')),
          React.createElement('div', { style: { ...S.impactLine, ...S.muted } },
            '⚠ 对话本身**不会被删除**，只是不再属于任何课程。'),
        ),
        React.createElement('div', { style: S.actionRow },
          React.createElement(Btn, {
            label: busy ? '删除中…' : '确认删除',
            tone: 'danger',
            disabled: busy,
            onClick: onConfirm,
          }),
          React.createElement(Btn, { label: '取消', disabled: busy, onClick: onCancel }),
        ),
      )
    }

    /**
     * 一段对话的索引行。
     *
     * @param props - `{ sessionId, row, courseTitle, accent, isCurrent, busy, onBind }`。
     * @returns React 元素。
     */
    function SessionRow(props) {
      const { sessionId, row, courseTitle, accent, isCurrent, busy, onBind } = props
      const [hover, setHover] = React.useState(false)
      const enter = useEnter()
      return React.createElement(
        'div',
        {
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            ...S.session,
            ...enter,
            borderColor: hover ? accent : 'var(--dsw-alias-border-l1, #e5e7eb)',
            transform: hover ? 'translateX(2px)' : 'none',
          },
        },
        React.createElement('span', {
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '999px',
            flex: '0 0 auto',
            background: courseTitle === null ? 'var(--dsw-alias-state-warn-primary, #d97706)' : accent,
          },
          title: courseTitle === null ? '未归课' : courseTitle,
        }),
        React.createElement(
          'span',
          {
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' },
            title: sessionId,
          },
          sessionTitle(row, sessionId),
        ),
        isCurrent
          ? React.createElement('span', {
            style: {
              ...S.badge,
              color: 'var(--dsw-alias-state-success-primary, #16a34a)',
              borderColor: 'var(--dsw-alias-state-success-primary, #16a34a)',
            },
          }, '当前')
          : null,
        React.createElement('span', { style: { ...S.badge, ...S.muted, borderColor: 'var(--dsw-alias-border-l1, #e5e7eb)' } },
          courseTitle === null ? '未归课' : courseTitle),
        React.createElement('span', { style: { ...S.muted, fontFamily: 'monospace' } }, shortId(sessionId)),
        React.createElement(Btn, {
          label: '打开',
          disabled: uiWorkspace === null,
          title: uiWorkspace === null
            ? '宿主的 uiWorkspace 服务不可用（没声明 inject），无法从这里打开对话'
            : '在对话区打开这段对话',
          onClick: () => uiWorkspace?.openSession?.(sessionId),
        }),
        onBind !== null
          ? React.createElement(Btn, {
            label: '归到这门课',
            tone: 'primary',
            disabled: busy === true,
            onClick: () => onBind(sessionId),
          })
          : null,
      )
    }

    // ══════════════════════════════════════════════════════════════════════
    // 右列：课程操作台 + 对话索引
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 右列本体。
     *
     * @param props - `{ view, nodeId, sessions, boundIds, courseOf, accentOf, workspaceId }`。
     * @returns React 元素。
     */
    function RightPane(props) {
      const { view, nodeId, sessions, boundIds, courseOf, accentOf, workspaceId } = props
      const snap = useView()
      const enter = useEnter()

      const node = nodeId === null ? null : ((view.nodes ?? []).find((n) => n.node_id === nodeId) ?? null)
      const here = node?.sessions ?? []
      const unbound = Object.keys(sessions).filter((id) => !boundIds.has(id))

      // ── 对话索引：**本机所有对话**，按标题/短 id 筛 ──
      const query = snap.indexQuery.trim().toLowerCase()
      const allIds = Object.keys(sessions).sort(
        (a, b) => recencyOf(sessions[b]) - recencyOf(sessions[a]) || a.localeCompare(b),
      )
      const indexRows = query === ''
        ? allIds
        : allIds.filter((id) => sessionTitle(sessions[id], id).toLowerCase().includes(query) || id.toLowerCase().includes(query))

      const childrenOf = node === null ? [] : (view.children_of?.[node.node_id] ?? [])

      // ── 对话索引：**与"选没选中课程"无关**，永远在 ──
      //
      // ⚠ 第一版把它放在"选中课程"分支里面，于是树为空（或刚把课删光）时
      //   整块索引都不渲染——而"本机有哪些对话"恰恰是**没有课程时最需要看的东西**
      //   （否则学习者连"我有哪些对话"都找不到）。测试里就是这么暴露出来的：
      //   删掉唯一的课后，索引连同右列一起消失了。
      const indexSection = React.createElement('div', { style: S.card },
        React.createElement(
          'div',
          {
            style: { ...S.sectionHeader, padding: '0', color: 'var(--dsw-alias-label-primary, #1f2328)' },
            title: snap.indexOpen ? '折起对话索引' : '展开对话索引',
            onClick: () => {
              indexOpen = !indexOpen
              writeLocal(LS_INDEX_OPEN, indexOpen ? '1' : '0')
              publish()
            },
          },
          React.createElement('span', {
            style: { ...S.twisty, transform: snap.indexOpen ? 'rotate(90deg)' : 'none' },
          }, '▸'),
          React.createElement('span', { style: { fontSize: '13px', fontWeight: 600 } },
            `对话索引（${allIds.length}）`),
          React.createElement('span', { style: S.muted },
            unbound.length > 0 ? `未归课 ${unbound.length}` : '全部已归课'),
        ),
        snap.indexOpen
          ? React.createElement(
            'div',
            { style: { marginTop: '8px' } },
            React.createElement('input', {
              type: 'text',
              value: snap.indexQuery,
              placeholder: '按标题或 id 过滤…',
              style: { ...S.input, width: '100%', marginBottom: '8px' },
              onChange: (event) => {
                indexQuery = event.target.value
                publish()
              },
            }),
            indexRows.length === 0
              ? React.createElement('div', { style: S.muted },
                allIds.length === 0 ? '宿主的会话清单是空的。' : '没有匹配的对话。')
              : indexRows.map((sid) => React.createElement(SessionRow, {
                key: sid,
                sessionId: sid,
                row: sessions[sid],
                courseTitle: courseOf(sid),
                accent: courseOf(sid) === null
                  ? 'var(--dsw-alias-state-warn-primary, #d97706)'
                  : accentOf(view.session_bindings[sid]),
                isCurrent: sid === snap.lastSessionId,
                busy: snap.busy,
                // 没选中课程时不能"归到这门课"——**把按钮去掉**，而不是让它点了没反应。
                onBind: node === null ? null : (id) => bindSession(node.node_id, id),
              })),
          )
          : null,
      )

      return React.createElement(
        'div',
        { style: { ...enter } },
        snap.notice !== null ? React.createElement('div', { style: S.notice }, snap.notice.text) : null,

        node === null
          ? React.createElement(
            'div',
            null,
            // 说明性文案按作者的要求压到最短：只说"该做什么"，不解释系统怎么工作。
            React.createElement('div', { style: S.empty }, '左边选一门课，或点 ＋ 新建。'),
            React.createElement(InlineInput, {
              placeholder: '新课程名',
              submitLabel: '建顶层课程',
              disabled: snap.busy,
              onSubmit: (title) => createCourse(title, null),
            }),
          )
          : React.createElement(
            'div',
            null,
            // ── 课程标题区 ──
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              React.createElement('span', {
                style: {
                  width: '10px',
                  height: '10px',
                  borderRadius: '999px',
                  background: accentOf(node.node_id),
                  flex: '0 0 auto',
                },
              }),
              React.createElement('span', { style: { fontSize: '16px', fontWeight: 600 } }, node.title)),
            React.createElement('div', { style: { marginTop: '4px', ...S.muted } },
              `第 ${node.level} 层 · 节点 ${node.node_id} · 子课程 ${childrenOf.length}`),

            // 改名 / 加子课程 / 删除**不在这里**——它们跟着左列那一行（见 CourseRow 与
            // DirectoryBody 的行内编辑器）。右列只回答"这门课下有哪些对话"。
            // 说明性文案也一并去掉：作者的原话是"不需要很多说明性描述"。

            // ── 这门课的对话 ──
            React.createElement('div', { style: S.card },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                React.createElement('span', { style: { fontSize: '13px', fontWeight: 600 } }, `这门课的对话（${here.length}）`),
                React.createElement(Btn, {
                  label: '＋ 新对话',
                  tone: 'primary',
                  disabled: snap.busy,
                  title: workspaceId === null
                    ? '还没有可用的工作区，无法新建对话'
                    : '在这个工作区里开一段新对话，并立刻归到这门课（先建索引再跳转）',
                  onClick: () => newSessionInCourse(node.node_id, workspaceId),
                })),
              React.createElement('div', { style: { marginTop: '8px' } },
                here.length === 0
                  ? React.createElement('div', { style: S.muted }, '还没有对话归到这门课。')
                  : here.map((sid) => React.createElement(SessionRow, {
                    key: sid,
                    sessionId: sid,
                    row: sessions[sid],
                    courseTitle: node.title,
                    accent: accentOf(node.node_id),
                    isCurrent: sid === snap.lastSessionId,
                    busy: snap.busy,
                    onBind: null,
                  }))),
              snap.lastSessionId !== null && !here.includes(snap.lastSessionId)
                ? React.createElement(Btn, {
                  label: `把最近那段对话归到这门课（${shortId(snap.lastSessionId)}）`,
                  disabled: snap.busy,
                  title: `会话 id：${snap.lastSessionId}`,
                  onClick: () => bindSession(node.node_id, snap.lastSessionId),
                })
                : null,
            ),
          ),

        // 对话索引永远在最后（与选没选中课程无关，见上面 indexSection 的注释）。
        indexSection,
      )
    }

    /**
     * 课程目录本体（左树右详）。
     *
     * @param props - `{ sessions, boundIds, courseOf, accentOf, workspaceId }`。
     * @returns React 元素。
     */
    function DirectoryBody(props) {
      const { sessions, boundIds, courseOf, accentOf, workspaceId } = props
      const snap = useView()
      const view = snap.data
      const enter = useEnter()
      // ⚠ useMemo 也必须在提前 return 之前调用（hook 顺序铁律）。
      const rows = React.useMemo(
        () => (snap.treeOpen ? flatten(view, snap.collapsedIds) : []),
        [view, snap.treeOpen, snap.collapsedIds],
      )

      const toggleNode = (id) => {
        const next = new Set(collapsedIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        collapsedIds = next
        writeLocal(LS_COLLAPSED, JSON.stringify([...next]))
        publish()
      }

      // ⚠ `view === null` 是"**还没取过数**"，不是"没有课程"。
      //   第一版把它和空树混在一起，于是"没取数"渲染成了"还没有课程"——
      //   一个不存在的空状态被当成了事实。这两种状态必须分开显示。
      if (view === null) {
        return React.createElement('div', { style: S.empty },
          snap.errorText !== null ? `读取失败：${snap.errorText}` : '正在读取课程目录…')
      }
      if (snap.errorText !== null) {
        return React.createElement('div', null,
          React.createElement('div', { style: S.error },
            React.createElement('div', null, `读取失败：${snap.errorText}`),
            React.createElement('div', { style: { marginTop: '6px', ...S.muted } },
              '这只影响这块面板，不影响对话。常见原因：工作区/数据目录没配好，见服务端返回的 fix。')),
          React.createElement(Btn, { label: '重试', onClick: () => void load() }))
      }

      const isEmpty = (view.nodes ?? []).length === 0
      const safeView = view

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, ...enter } },
        React.createElement(
          'div',
          { style: S.body },
          React.createElement('div', { style: S.left },
            React.createElement(
              'div',
              {
                style: S.sectionHeader,
                // 稳定的可测标识 + 它对学习者也有用（悬停提示）。
                title: snap.treeOpen ? '折起课程区' : '展开课程区',
                // 整块课程区的折起（与每个节点自己的折起是两回事：
                // 这一层是"我现在不想看课程"，节点那层是"这一支先收着"）。
                onClick: () => {
                  treeOpen = !treeOpen
                  writeLocal(LS_TREE_OPEN, treeOpen ? '1' : '0')
                  publish()
                },
              },
              React.createElement('span', {
                style: { ...S.twisty, transform: snap.treeOpen ? 'rotate(90deg)' : 'none' },
              }, '▸'),
              React.createElement('span', null, '课程'),
              React.createElement('span', { style: S.count }, `${safeView.nodes.length}`),
              // 「建顶层课程」也搬到这一侧：它是"课程"这一层级的动作，
              // 跟在这一行的标题后面比放在右列更好找。
              React.createElement(RowAction, {
                glyph: '＋',
                title: '建一门顶层课程',
                onClick: () => {
                  selectedNodeId = null
                  writeLocal(LS_SELECTED, null)
                  editor = editor === 'newRoot' ? null : 'newRoot'
                  deleteNodeId = null
                  deleteImpact = null
                  publish()
                },
              }),
            ),
            snap.editor === 'newRoot'
              ? React.createElement(InlineInput, {
                placeholder: '新顶层课程名',
                submitLabel: '建',
                disabled: snap.busy,
                onSubmit: (title) => createCourse(title, null),
                onCancel: () => {
                  editor = null
                  publish()
                },
              })
              : null,
            snap.treeOpen
              ? (isEmpty
                ? React.createElement('div', { style: { ...S.empty, padding: '10px 8px' } },
                  '还没有课程。点上面的 ＋ 建第一门。')
                : rows.map((row) => {
                  const isTarget = row.node.node_id === snap.selectedNodeId
                  return React.createElement(
                    'div',
                    { key: row.node.node_id },
                    React.createElement(CourseRow, {
                      row,
                      selected: isTarget,
                      onSelect: (id) => {
                        selectedNodeId = id
                        writeLocal(LS_SELECTED, id)
                        // 切到别的行时把这一行打开的编辑器/确认关掉——
                        // 否则它们会挂在一个已经不再选中的行下面（看起来像串了行）。
                        editor = null
                        deleteNodeId = null
                        deleteImpact = null
                        publish()
                      },
                      onToggle: toggleNode,
                      menuOpen: isTarget && snap.editor === 'menu',
                      onMenu: (id) => {
                        selectedNodeId = id
                        writeLocal(LS_SELECTED, id)
                        // 「⋯」是开关：再点一次收起。
                        editor = editor === 'menu' ? null : 'menu'
                        deleteNodeId = null
                        deleteImpact = null
                        publish()
                      },
                    }),
                    // ── 行内动作条（点「⋯」展开）──
                    isTarget && snap.editor === 'menu'
                      ? React.createElement(RowMenu, {
                        busy: snap.busy,
                        onAddChild: () => {
                          editor = 'addChild'
                          publish()
                        },
                        onRename: () => {
                          editor = 'rename'
                          publish()
                        },
                        onDelete: () => {
                          editor = null
                          void askDelete(row.node.node_id)
                        },
                      })
                      : null,
                    // ── 行内编辑器 / 删除确认：只挂在**这一行**下面 ──
                    isTarget && snap.editor === 'rename'
                      ? React.createElement(InlineInput, {
                        placeholder: row.node.title,
                        submitLabel: '改名',
                        initial: row.node.title,
                        disabled: snap.busy,
                        onSubmit: (title) => renameCourse(row.node.node_id, title),
                        onCancel: () => {
                          editor = null
                          publish()
                        },
                      })
                      : null,
                    isTarget && snap.editor === 'addChild'
                      ? React.createElement(InlineInput, {
                        placeholder: '子课程名',
                        submitLabel: '建为子课程',
                        disabled: snap.busy,
                        onSubmit: (title) => createCourse(title, row.node.node_id),
                        onCancel: () => {
                          editor = null
                          publish()
                        },
                      })
                      : null,
                    isTarget && snap.deleteNodeId === row.node.node_id
                      ? React.createElement(DeleteConfirm, {
                        impact: snap.deleteImpact,
                        loading: snap.deleteLoading,
                        busy: snap.busy,
                        onCancel: cancelDelete,
                        onConfirm: confirmDelete,
                      })
                      : null,
                  )
                }))
              // 折起时**刻意什么都不写**（作者 2026-10-08 的要求）。
              // 曾经这里有一句"里面还有 N 个节点"——那是给"以为课程丢了"打的补丁；
              // 根因（没取过数被显示成没有课程）修掉之后，这句就成了噪声。
              // 折起状态的线索仍在：标题右边那个计数就是。
              : null,
          ),
          React.createElement('div', { style: S.right },
            React.createElement(RightPane, {
              view: safeView,
              nodeId: snap.selectedNodeId,
              sessions,
              boundIds,
              courseOf,
              accentOf,
              workspaceId,
            })),
        ),
      )
    }

    /**
     * 把宿主的会话/工作区快照 + 课程树捏成面板要的东西。
     *
     * @param props - `{ useSessions, useWorkspaces, view }`。
     * @returns React 元素。
     */
    function DirectoryWithSessions(props) {
      const { useSessions, useWorkspaces, view } = props
      // 无条件调用：即使宿主没给这两个 hook，也用同一个"假 hook"占位，
      // 保证 hook 数量在组件的整个生命周期里恒定（React 的硬要求）。
      const sessionsHook = typeof useSessions === 'function' ? useSessions : (sel) => sel({ byId: {} })
      const workspacesHook = typeof useWorkspaces === 'function' ? useWorkspaces : (sel) => sel({ items: [] })
      const sessions = sessionsById(sessionsHook((s) => s))
      const workspaces = workspacesOf(workspacesHook((s) => s))

      // 记住"最近一次真正显示在对话里的会话"。
      // 为什么需要它：面板一打开，主区就是面板而不是对话，`retainedBy.mainView`
      // 会掉到 0——于是"当前会话"这个概念在面板里根本取不到。
      // 所以这里持续记录，取**最后一次非空**的值（不覆盖成 null）。
      // 它是**临时答案**：它可能指向上一次打开的那篇对话而不是"此刻"的那篇。
      // 界面因此把会话短 id 明写在按钮上，让学习者一眼看得出要绑的是哪一篇。
      const current = Object.keys(sessions).find((id) => (sessions[id]?.retainedBy?.mainView ?? 0) > 0) ?? null
      React.useEffect(() => {
        if (current !== null && current !== lastSessionId) {
          lastSessionId = current
          publish()
        }
      }, [current])

      const bindings = view?.session_bindings ?? {}
      const boundIds = new Set(Object.keys(bindings))

      /**
       * 查一段对话现在归哪门课（不可见/不存在都算未归课）。
       * @param sessionId - 会话 id。
       * @returns 课程标题或 null。
       */
      function courseOf(sessionId) {
        const nodeId = bindings[sessionId]
        if (typeof nodeId !== 'string') return null
        const node = (view?.nodes ?? []).find((n) => n.node_id === nodeId)
        return node === undefined ? null : node.title
      }

      /**
       * 某个节点所在分支的标记色（根分支继承）。
       * @param nodeId - 节点 id。
       * @returns CSS 颜色表达式。
       */
      function accentOf(nodeId) {
        const row = flatten(view, new Set()).find((r) => r.node.node_id === nodeId)
        return row === undefined ? ACCENTS[0] : row.accent
      }

      // 新建对话要落在一个工作区里。优先"当前对话所在的那个"，否则第一个。
      const currentCwd = lastSessionId === null ? null : sessions[lastSessionId]?.cwd
      const matched = workspaces.find((w) => typeof currentCwd === 'string' && w?.path === currentCwd)
      const workspaceId = matched?.workspaceId ?? workspaces[0]?.workspaceId ?? null

      return React.createElement(DirectoryBody, { sessions, boundIds, courseOf, accentOf, workspaceId })
    }

    /**
     * `main` 槽的面板（key = PANEL_ID）。
     *
     * 拆成两层的原因：`useSessions` / `useWorkspaces` 是宿主给的 prop，
     * 而 hook 不能条件调用。所以**先**在外层确认 prop 在不在，
     * **再**把 hook 放在一个必定收得到它们的子组件里。
     *
     * @param props - 宿主给的 standard props。
     * @returns React 元素。
     */
    function DirectoryPanel(props) {
      const snap = useView()

      // ══════════════════════════════════════════════════════════════════════
      // ⚠⚠ 这一条是"课程全没了"那个假象的**根因**，不是防御性代码 ⚠⚠
      //
      // 宿主**记得上次选中的面板**（layout store 的 activePanelId）。所以应用重启
      // 或页面重载之后，如果上次停在课程目录上，**这个组件会直接被挂载**——
      // 那条路径**不经过 `openDirectory()`**，而 `load()` 只在 openDirectory 里调。
      //
      // 第一版就是这样：面板被恢复成选中态 → `data` 仍是初始的 null →
      // 左列标题显示「课程 **0**」、下面写「还没有课程」、右列写「左边还没有选中的课程」。
      // **一条错误都没有**（loading=false、errorText=null），因为根本没人去取过数。
      // 作者看到的就是这一屏，于是合理地以为课程全丢了。
      //
      // 修法：挂载时如果"从没取过数"，就取一次。判据用 `data === null && errorText === null`
      // ——不写成"总是取"，那样每次切回面板都会重拉一遍，没有意义。
      // ══════════════════════════════════════════════════════════════════════
      React.useEffect(() => {
        if (data === null && errorText === null && !loading) void load()
        // 只在挂载时判定一次：之后的重拉由 openDirectory/动作/刷新按钮负责。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const head = React.createElement('div', { style: S.header },
        React.createElement('span', { style: S.title }, '课程目录'),
        React.createElement('span', { style: { flex: '1 1 auto' } }),
        React.createElement(Btn, { label: '刷新', onClick: () => void load() }),
        React.createElement(Btn, {
          label: '重载界面',
          title: '等价于按 F5：只重新加载这个页面（界面插件改完用它生效），不动应用进程',
          onClick: reloadUi,
        }))

      if (typeof props?.useSessions !== 'function') {
        // 宿主没给 useSessions = 会话清单拿不到。如实说，并且**树仍然可用**
        // （读树/建课只靠本插件自己的路由），不整块白屏。
        return React.createElement('div', { style: S.panel }, head,
          React.createElement('div', { style: { ...S.notice, margin: '10px 14px' } },
            '宿主没有提供会话清单（`main` 槽的 useSessions 缺席），所以这块面板只显示课程树，不能列/绑对话。'),
          React.createElement(DirectoryBody, {
            sessions: Object.create(null),
            boundIds: new Set(),
            courseOf: () => null,
            accentOf: () => ACCENTS[0],
            workspaceId: null,
          }))
      }
      return React.createElement('div', { style: S.panel }, head,
        React.createElement(DirectoryWithSessions, {
          useSessions: props.useSessions,
          useWorkspaces: props.useWorkspaces,
          view: snap.data,
        }))
    }

    /**
     * `shell.overlay` 的兜底浮层。
     *
     * 留着它的唯一理由是"main 面板这条路由在真机上可能没生效"，而那种失败是静默的
     * （`slots.inject` 会把注册推迟、闸门也不报）。有它至少还有入口。
     * 浮层拿不到 `useSessions`（不同的槽），所以只给课程树 + 建课，
     * 对话与索引由它自己的说明交代清楚——**不假装有**。
     *
     * @returns React 元素或 null。
     */
    function OverlayFallback() {
      const open = usePanelOpen()
      // ⚠ hook 先行（见上），再做分支。
      if (!open) return null
      if (mainRegistered) return null
      return React.createElement(
        'div',
        { style: S.overlayWrap },
        React.createElement('div', { style: S.overlayPanel },
          React.createElement('div', { style: S.header },
            React.createElement('span', { style: S.title }, '课程目录（兜底浮层）'),
            React.createElement(Btn, { label: '关闭', onClick: () => closeOverlay() })),
          React.createElement('div', { style: { ...S.notice, margin: '10px 14px' } },
            '这是兜底入口：中央面板没注册成功时才出现。浮层里不列对话、也没有对话索引（会话清单只能从 `main` 槽取）。'),
          React.createElement(DirectoryBody, {
            sessions: Object.create(null),
            boundIds: new Set(),
            courseOf: () => null,
            accentOf: () => ACCENTS[0],
            workspaceId: null,
          })),
      )
    }

    // ══════════════════════════════════════════════════════════════════════
    // 入口
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 侧栏图标（`sidebar.panellist` 的条目）。
     *
     * @param props - 宿主给的 `{ size, active }`。
     * @returns React 元素。
     */
    function DirectoryIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      const active = props?.active === true
      const [hover, setHover] = React.useState(false)
      return React.createElement(
        'button',
        {
          type: 'button',
          title: '课程目录',
          'aria-label': '课程目录',
          onClick: () => openDirectory(),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            ...S.iconButton,
            width: `${size + 14}px`,
            height: `${size + 14}px`,
            background: active
              ? 'var(--dsw-alias-bg-layer-2, #eef0f4)'
              : hover
                ? 'var(--dsw-alias-bg-layer-1, #f7f8fa)'
                : 'transparent',
            transform: hover ? 'scale(1.06)' : 'none',
            transition: `background ${MOTION.fast}ms ease, transform ${MOTION.fast}ms ease`,
          },
        },
        '📚',
      )
    }

    /**
     * 打开课程目录面板。
     *
     * 优先切到 main 面板；main 没注册成功（真机上时序没走到）时退回浮层，
     * 两条路都不可用时**不静默**——把原因留在 errorText 里显示给学习者。
     *
     * @param nodeId - 可选：打开时顺带选中某个课程节点。
     */
    function openDirectory(nodeId) {
      if (typeof nodeId === 'string' && nodeId !== '') {
        selectedNodeId = nodeId
        writeLocal(LS_SELECTED, nodeId)
      }
      if (mainRegistered) {
        try {
          ctxRef?.layout?.selectPanel?.(PANEL_ID)
          panelOpen = true
          publish()
          void load()
          return
        } catch (error) {
          // selectPanel 抛错 = main 注册表里没有该 id。不吞掉，落到浮层兜底。
          console.warn(`[lh-workspace-ui] selectPanel 失败，退回浮层：${error?.message ?? error}`)
        }
      }
      panelOpen = true
      publish()
      void load()
    }

    /** 关闭浮层兜底（main 面板由宿主的导航负责关闭）。 */
    function closeOverlay() {
      panelOpen = false
      publish()
    }

    /**
     * 重载界面（= 重新加载浏览器页面）。
     *
     * ═══ 为什么是 `location.reload()`，而不是"重启 dsh" ═══
     * 桌面的**真重启是主进程的原生菜单动作**（"Restart App and Host"），
     * 而我核过 preload 的暴露面与 `dsh-desktop:*` 通道表：**没有任何 restart 通道**。
     * 也就是说插件够不着它——不是权限被拒，是根本没有这条缝。
     *
     * 硬要碰它的唯一办法是杀掉宿主子进程，让应用弹它自己的**致命恢复屏**
     * （"应用无法启动" + 一个 Restart 按钮）。那不是重启键，那是崩溃屏，所以刻意不做。
     *
     * 页面重载覆盖**界面侧**的全部改动（客户端 bundle 会重新拉取）——
     * 那正是开发时最常发生的一类改动。服务端半（路由/插件）的改动仍需重启应用。
     */
    function reloadUi() {
      try {
        window.location.reload()
      } catch (error) {
        notice = { kind: 'bad', text: `重载失败：${String(error?.message ?? error)}` }
        publish()
      }
    }

    /**
     * 插件体。
     * @param ctx - 插件上下文。
     */
    exports.apply = (ctx) => {
      ctxRef = ctx
      // 可选服务：拿不到也不影响装载（见 uiWorkspace 的注释）。
      try {
        uiWorkspace = ctx.get('uiWorkspace') ?? null
      } catch {
        uiWorkspace = null
      }

      // ── 中央面板：main key `lh` ──
      // 先注册 main：`selectPanel` 在 main 缺失时会抛错且不改选中态，
      // 所以顺序上先让面板就位，再让侧栏图标可用。
      ctx.slots.inject('main', () => {
        const dispose = ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          DirectoryPanel,
        )
        mainRegistered = true
        publish()
        return dispose
      })

      // ── 侧栏图标：sidebar.panellist，**同一个 id** ──
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, label: '课程目录' }, DirectoryIcon),
      )

      // ── 左下 Settings → General 里的一行：重载界面 ──
      //
      // 为什么用 `settings.general.item` 而不是开一整页（`settings.section`）：
      // 目录原文说它是"a single setting that needs no page of its own"的additive 席位，
      // 正合这一条。它 replaceRisk: none，且**不需要任何权限**——它只重载页面。
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register({ name: 'settings.general.item', id: 'lh-reload-ui', order: 95 }, ReloadRow),
      )

      // ── 兜底浮层（仅当 main 没注册成功时才渲染）──
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'lh-workspace-directory' }, OverlayFallback),
      )
    }

    exports.name = 'lh-workspace-ui'

    // ⚠ 宿主门禁认的是**模块导出的** inject（服务名数组）。
    //   `package.json` 的 `dsh.client.inject` 是包名数组，只进 boot 清单，**不装配 fiber 的 inject**。
    //   slots：注册插槽；layout：切到 main 面板（selectPanel）。
    //
    //   ⚠ `uiWorkspace` 刻意**不**在这里声明：它只用于"打开/新建对话"这两个增强动作，
    //   而 inject 少一个服务会让整个客户端插件装载失败（浏览器卡在 "Failed to load plugins"）。
    //   宁可少两个按钮，也不要整块界面起不来——所以走 `ctx.get()` 可选访问。
    exports.inject = ['slots', 'layout']

    return exports
  },
})
