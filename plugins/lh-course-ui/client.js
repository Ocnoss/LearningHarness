/**
 * lh-course-ui 的【客户端半】—— 侧栏入口按钮 + 课程树浮层面板。
 *
 * ═══ 两个插槽，各管一件事 ═══
 *   · `sidebar.footer.action` —— 侧栏底部的**入口按钮**（点开/收起面板）；
 *   · `shell.overlay`         —— 浮在整个应用之上的**课程树面板**（递归树 + 断言 + 传递动画）。
 *
 * ═══ 三条铁律（都是 lh-practice 踩出来的，见其 client.js 文件头）═══
 * 1. **不用 JSX**：手工 bundle 没有转译步骤，一律 `React.createElement`（下面简写 `h`）。
 * 2. **必须导出 `exports.inject`**（服务名数组）：cordis 的 inject 门禁读的是本模块导出的
 *    `exports.inject`，不是 package.json 的 `dsh.client.inject`。用到 `slots`、`sessions`。
 * 3. **注册到"别的包声明的插槽"一律走 `slots.inject`**：`sidebar.footer.action` 与
 *    `shell.overlay` 都不是内核内置插槽，浏览器 boot 是并发拉起插件的，直接 register 可能
 *    在插槽声明到达前执行 → 抛 "slot not declared" → 启动屏 "Failed to load plugins" → 界面起不来。
 *    `slots.inject` 把注册时机交给宿主（声明已到就同步执行，否则推迟到声明那一刻），对启动顺序免疫。
 *
 * ═══ 面板在 root 作用域，props 里没有 sessionId ═══
 * 高亮"当前会话绑定的课程节点"要按 sessionId 查 `session_bindings`，而 shell.overlay 是 root
 * 作用域插槽、不给会话 props。所以去问会话服务：`ctx.sessions.list.getSnapshot().current`。
 */

window.__ModuleLoader__.load({
  id: '@lh/course-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const API = '/lh/course'

    // ⚠ ctx 存到模块级：apply 的作用域不是会话作用域，组件里只能从这里拿服务。
    let ctxRef = null

    // ── 模块级状态：面板开关（按钮与面板两个插槽条目共享同一闭包）──
    let panelOpen = false
    const listeners = new Set()

    /** 通知所有订阅者重渲染。 */
    function emit() {
      for (const fn of listeners) fn()
    }

    /**
     * 订阅模块级状态。
     * @param fn - 回调。
     * @returns 退订函数。
     */
    function subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }

    /**
     * 开/关面板。
     * @param next - 目标状态。
     */
    function setPanelOpen(next) {
      if (panelOpen === next) return
      panelOpen = next
      emit()
    }

    /**
     * 面板开关的 hook（手写 useSyncExternalStore：seed 里没有状态管理库）。
     * @returns 当前是否打开。
     */
    function usePanelOpen() {
      return React.useSyncExternalStore(subscribe, () => panelOpen, () => panelOpen)
    }

    /**
     * 当前会话 id（面板在 root 作用域，props 里没有 sessionId）。
     * @returns 会话 id；拿不到时 null（**不抛错**）。
     */
    function currentSessionId() {
      try {
        const list = ctxRef?.sessions?.list
        if (list === undefined || typeof list.getSnapshot !== 'function') return null
        const id = list.getSnapshot()?.current
        return typeof id === 'string' && id !== '' ? id : null
      } catch {
        return null
      }
    }

    /**
     * 调服务端只读路由。
     * @param path - `/tree` 之类。
     * @returns 解析后的 JSON。
     */
    async function callApi(path) {
      const res = await fetch(`${API}${path}`, { headers: { 'content-type': 'application/json' } })
      if (!res.ok) {
        let detail = ''
        try { detail = await res.text() } catch { /* 忽略 */ }
        throw new Error(`${res.status} ${detail.slice(0, 200)}`)
      }
      return res.json()
    }

    // ── 纯函数（可离线推理，也让渲染逻辑读得清）──

    /**
     * 按 id 找节点。
     * @param tree - /tree 的返回。
     * @param id - node_id。
     * @returns 节点或 null。
     */
    function nodeById(tree, id) {
      if (tree === null || typeof id !== 'string') return null
      return tree.nodes.find((n) => n.node_id === id) ?? null
    }

    /**
     * 某节点的子节点 id 数组。
     * @param tree - /tree 的返回。
     * @param id - node_id。
     * @returns 子 id 数组。
     */
    function childIds(tree, id) {
      return tree?.children_of?.[id] ?? []
    }

    /**
     * 把 propagate_to（`course/<id>`）反解成目标节点标题，用于"传递给…"的表述。
     * @param tree - /tree 的返回。
     * @param propagateTo - 断言的 propagate_to。
     * @returns 目标标题；到根/停止时返回 null。
     */
    function propagateTargetTitle(tree, propagateTo) {
      if (typeof propagateTo !== 'string' || !propagateTo.startsWith('course/')) return null
      const node = nodeById(tree, propagateTo.slice('course/'.length))
      return node === null ? null : node.title
    }

    /**
     * 最近有断言的节点 id 集合（面板给这些节点加"传递中"的高亮）。
     * @param recent - 最近断言数组。
     * @returns id 集合（用普通对象当集合）。
     */
    function activeNodeIds(recent) {
      const set = Object.create(null)
      for (const a of recent) if (typeof a.node_id === 'string') set[a.node_id] = true
      return set
    }

    // ── 样式（内联，避免依赖宿主的样式表）──
    const S = {
      overlay: {
        position: 'fixed', top: 0, right: 0, bottom: 0, width: '420px', maxWidth: '92vw',
        background: 'var(--dsh-color-bg-elevated, #1e1e24)', color: 'var(--dsh-color-text, #e6e6e6)',
        borderLeft: '1px solid var(--dsh-color-border, #333)', boxShadow: '-8px 0 24px rgba(0,0,0,.35)',
        display: 'flex', flexDirection: 'column', zIndex: 9000, fontSize: '13px',
      },
      header: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 12px', borderBottom: '1px solid var(--dsh-color-border, #333)', flex: '0 0 auto',
      },
      body: { overflowY: 'auto', padding: '10px 12px', flex: '1 1 auto' },
      sectionTitle: { fontWeight: 600, margin: '14px 0 6px', opacity: 0.85 },
      nodeRow: (depth, isActive, isCurrent, isSelected) => ({
        display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
        padding: '3px 6px', paddingLeft: `${6 + depth * 16}px`, borderRadius: '6px',
        background: isSelected ? 'var(--dsh-color-bg-active, #2d2d38)' : 'transparent',
        border: isCurrent ? '1px solid var(--dsh-color-primary, #4c8dff)'
          : isActive ? '1px solid rgba(255,180,60,.7)' : '1px solid transparent',
        marginBottom: '2px',
      }),
      caret: { width: '14px', flex: '0 0 auto', opacity: 0.7, textAlign: 'center' },
      badge: {
        marginLeft: 'auto', fontSize: '11px', padding: '0 6px', borderRadius: '8px',
        background: 'var(--dsh-color-bg-muted, #33333d)', opacity: 0.9,
      },
      bubble: (active) => ({
        padding: '6px 8px', borderRadius: '8px', marginBottom: '6px',
        background: 'var(--dsh-color-bg-muted, #2a2a33)',
        borderLeft: `3px solid ${active ? 'rgba(255,180,60,.9)' : 'var(--dsh-color-border, #444)'}`,
      }),
      assertion: {
        padding: '8px', borderRadius: '8px', marginBottom: '8px',
        background: 'var(--dsh-color-bg-muted, #26262e)',
      },
      muted: { opacity: 0.6, fontSize: '12px' },
      error: { color: 'var(--dsh-color-danger, #ff6b6b)', whiteSpace: 'pre-wrap' },
    }

    /**
     * 侧栏入口按钮（注册到 `sidebar.footer.action`）。
     * @returns 元素。
     */
    function CourseTreeButton() {
      const open = usePanelOpen()
      return h(
        Button,
        { onClick: () => setPanelOpen(!open), title: '打开递归课程树与断言传递面板' },
        open ? '关闭课程树' : '课程树',
      )
    }

    /**
     * 课程树浮层面板（注册到 `shell.overlay`）。
     *
     * ⚠ 所有 hook 必须在任何提前 return **之前**调用——否则"打开面板"会因 hook 顺序变化当场抛错。
     * @returns 元素；面板关着时返回 null。
     */
    function CourseTreePanel() {
      const open = usePanelOpen()
      const [tree, setTree] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [assertions, setAssertions] = React.useState([])
      const [recent, setRecent] = React.useState([])
      const [collapsed, setCollapsed] = React.useState({})
      const sinceRef = React.useRef('')

      const currentSid = currentSessionId()
      const currentNodeId = (tree !== null && currentSid !== null) ? (tree.session_bindings?.[currentSid] ?? null) : null
      const active = activeNodeIds(recent)

      // 打开时载入整棵树。
      React.useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        setError(null)
        ;(async () => {
          try {
            const t = await callApi('/tree')
            if (!cancelled) setTree(t)
          } catch (e) {
            if (!cancelled) setError(e?.message ?? String(e))
          }
        })()
        return () => { cancelled = true }
      }, [open])

      // 打开时轮询 /recent，做"断言沿边向上传递"的动画（新断言点亮节点 + 进 feed）。
      React.useEffect(() => {
        if (!open) return undefined
        const id = setInterval(() => {
          void (async () => {
            try {
              const r = await callApi(`/recent?since=${encodeURIComponent(sinceRef.current)}`)
              if (typeof r.server_time === 'string') sinceRef.current = r.server_time
              if (Array.isArray(r.assertions) && r.assertions.length > 0) {
                setRecent((prev) => [...prev, ...r.assertions].slice(-40))
              }
            } catch { /* 轮询失败静默，下一轮再试 */ }
          })()
        }, 2000)
        return () => clearInterval(id)
      }, [open])

      // 选中节点变化时载入它的断言。
      React.useEffect(() => {
        if (!open || selected === null) { setAssertions([]); return undefined }
        let cancelled = false
        ;(async () => {
          try {
            const r = await callApi(`/assertions?node=${encodeURIComponent(selected)}`)
            if (!cancelled) setAssertions(Array.isArray(r.assertions) ? r.assertions : [])
          } catch { if (!cancelled) setAssertions([]) }
        })()
        return () => { cancelled = true }
      }, [open, selected])

      if (!open) return null

      /**
       * 切换某节点的折叠态。
       * @param id - node_id。
       */
      function toggle(id) {
        setCollapsed((prev) => ({ ...prev, [id]: !(prev[id] === true) }))
      }

      /**
       * 递归渲染一个节点及其子树。
       * @param id - node_id。
       * @param depth - 缩进深度（根 = 0）。
       * @returns 元素数组。
       */
      function renderSubtree(id, depth) {
        const node = nodeById(tree, id)
        if (node === null) return []
        const kids = childIds(tree, id)
        const isCollapsed = collapsed[id] === true
        const isCurrent = currentNodeId === id
        const isActive = active[id] === true
        const isSelected = selected === id

        const row = h(
          'div',
          {
            key: id,
            style: S.nodeRow(depth, isActive, isCurrent, isSelected),
            onClick: () => setSelected(id),
            title: isCurrent ? '当前会话绑定的课程' : node.title,
          },
          h('span', {
            style: S.caret,
            onClick: (e) => { e.stopPropagation(); if (kids.length > 0) toggle(id) },
          }, kids.length > 0 ? (isCollapsed ? '▸' : '▾') : '·'),
          h('span', { style: { fontWeight: isCurrent ? 700 : 400 } },
            `${node.title}`,
            h('span', { style: S.muted }, `  L${node.level}`)),
          node.assertion_count > 0
            ? h('span', { style: S.badge }, `${node.assertion_count} 断言`)
            : null,
        )

        const out = [row]
        if (!isCollapsed) {
          for (const kid of kids) out.push(...renderSubtree(kid, depth + 1))
        }
        return out
      }

      const roots = tree?.roots ?? []

      // 把各区块拆成小函数：既避开深层三元 + createElement 的括号地狱，
      // 也让"每块渲染什么"一眼可读（hook 都在上面调完了，这里只是普通函数）。

      /** @returns 树主体（错误 / 载入中 / 空 / 递归树）四态之一。 */
      function renderTreeBody() {
        if (error !== null) return h('div', { style: S.error }, `读取课程树失败：${error}`)
        if (tree === null) return h('div', { style: S.muted }, '载入中…')
        if (roots.length === 0) {
          return h('div', { style: S.muted },
            '还没有课程。在对话里让 AI 调 create_course 建第一门（如"行测"），再 enter_course 绑定当前会话。')
        }
        return h('div', {}, roots.flatMap((r) => renderSubtree(r, 0)))
      }

      /** @returns 当前会话定位说明；树没到则 null。 */
      function renderCurrentHint() {
        if (tree === null) return null
        const text = currentNodeId !== null
          ? `当前会话绑定：${nodeById(tree, currentNodeId)?.title ?? currentNodeId}`
          : '当前会话未绑定课程（enter_course 后，这段对话的输入才会被断言并向上传递）'
        return h('div', { style: S.muted }, text)
      }

      /** @returns 单条断言卡片。 */
      function renderAssertionCard(a) {
        const meta = `${a.asserter ?? '?'} · 置信 ${a.confidence ?? '—'} · ${a.timestamp ?? ''}` +
          (a.propagate_to ? ` · 传给「${propagateTargetTitle(tree, a.propagate_to) ?? '?'}」` : ' · 到顶/停止')
        return h('div', { key: a.id, style: S.assertion },
          h('div', {}, a.statement || '(空断言)'),
          h('div', { style: S.muted }, meta),
          a.derived_from.length > 0
            ? h('div', { style: S.muted }, `↑ 由子断言派生（${a.derived_from.length} 条）`)
            : null,
        )
      }

      /** @returns 选中节点的断言区块；未选中则 null。 */
      function renderSelectedAssertions() {
        if (selected === null) return null
        const title = `「${nodeById(tree, selected)?.title ?? selected}」的断言`
        const body = assertions.length === 0
          ? h('div', { style: S.muted }, '这个节点还没有断言。')
          : assertions.map(renderAssertionCard)
        return h('div', {}, h('div', { style: S.sectionTitle }, title), body)
      }

      /** @returns 传递动态 feed（最近的断言，沿子→父点亮）。 */
      function renderRecentFeed() {
        const title = h('div', { style: S.sectionTitle }, '传递动态（最近）')
        if (recent.length === 0) {
          return h('div', {}, title, h('div', { style: S.muted }, '暂无新断言。在已绑定课程的会话里发一句话试试。'))
        }
        const bubbles = recent.slice().reverse().map((a) => {
          const node = nodeById(tree, a.node_id)
          const fromTitle = node?.title ?? a.node_id
          const toTitle = propagateTargetTitle(tree, a.propagate_to)
          return h('div', { key: a.id, style: S.bubble(true) },
            h('div', {},
              h('strong', {}, `L${node?.level ?? '?'} 「${fromTitle}」`),
              toTitle !== null
                ? h('span', {}, `  ↑ 传递给「${toTitle}」`)
                : h('span', { style: S.muted }, '  · 终点'),
            ),
            h('div', { style: S.muted }, a.statement || ''),
          )
        })
        return h('div', {}, title, bubbles)
      }

      return h('div', { style: S.overlay },
        h('div', { style: S.header },
          h('strong', {}, '课程树 · 断言传递'),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h(Button, { onClick: () => { sinceRef.current = ''; setRecent([]) }, title: '清空动画' }, '重置'),
            h(Button, { onClick: () => setPanelOpen(false) }, '关闭'),
          ),
        ),
        h('div', { style: S.body },
          renderTreeBody(),
          renderCurrentHint(),
          renderSelectedAssertions(),
          renderRecentFeed(),
        ),
      )
    }

    exports.apply = (ctx) => {
      ctxRef = ctx
      // 两个插槽都不是内核内置插槽（由宿主 ui-layout / ui-shell 在其 apply 时声明），
      // 一律走 slots.inject 对启动顺序免疫（理由见文件头铁律 3）。
      // list 型插槽必须给 options.id（宿主 SlotRegistry 校验，缺了抛 requires options.id）。
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'lh-course-tree' }, CourseTreeButton),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'lh-course-tree-panel' }, CourseTreePanel),
      )
    }

    exports.name = 'lh-course-ui'
    // 本模块用到的宿主服务：slots（注册插槽）、sessions（读当前会话 id）。
    exports.inject = ['slots', 'sessions']

    // ── 测试钩子（宿主不读，仅便于将来离线验纯函数）──
    exports.__test = {
      nodeById,
      childIds,
      propagateTargetTitle,
      activeNodeIds,
      setPanelOpen,
      isPanelOpen: () => panelOpen,
    }

    return exports
  },
})
