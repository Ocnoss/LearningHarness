/**
 * lh-practice 的【客户端半】—— 对话里的刷题卡片 + 刷题面板。
 *
 * ═══ 它做什么 ═══
 * 注册两个插槽：
 *   1. `tool.call.toolview`（keyed，按工具名）→ **对话里的卡片**，本插件的入口；
 *   2. `shell.overlay`（list）→ **面板本体**，浮在整个应用之上的作答界面。
 *
 * ═══ 入口怎么给（这个设计改过两次，前两版都被作者否掉）═══
 * 1. 常驻的"刷题"按钮（`sidebar.footer.action`）—— 否掉：
 *    *"一个出现在 dsh 界面内的刷题按钮很突兀"*。
 * 2. 信号一到就**自动弹出**面板 —— 也否掉。作者给的是类比：
 *    *"就像有的网页端ai在生成报告之后，点击一个对话里的链接或者框，
 *      右侧就会弹出报告的页面那样"*。
 * 3. 现在：**对话里的卡片**。学习者说"刷题" → agent 调 `start_practice`
 *    → 宿主用我们的组件渲染那次调用（一张卡片）→ **学习者点它**才开面板。
 *    由学习者点，而不是替他打开——这是第 2 版和第 3 版的关键差别。
 *
 * 于是界面上**没有常驻入口**：卡片只在对话里出现过一次，面板关掉就没了。
 *
 * ═══ 为什么面板是 shell.overlay 而不是别的 ═══
 * 宿主自己的文档（`dsh-client-runtime` 的 `slots.d.ts`）写着：
 *   > `root` 是单值插槽，**不要**在那里注册 —— 第二项会把 AppFrame 整个遮掉。
 *   > 要做"浮在整个应用之上的自己的界面"，请注册到 `shell.overlay`
 *   > （列表插槽：可叠加，且在你的条目主动接收指针事件之前是**点击穿透**的）。
 *
 * ═══ 写法上的两个约束（都来自实测）═══
 * 1. **不用 JSX**：本文件是手工 bundle，没有转译步骤。JSX 会直接导致语法错误。
 *    所以一律用 `React.createElement`。
 * 2. **必须在模块里导出 `inject`（服务名数组）**：cordis 的 inject 门禁读的是
 *    **本模块导出的 `exports.inject`**，不是 package.json 的 `dsh.client.inject`——
 *    那个声明只进 boot manifest，宿主当前版本并不拿它装配 fiber 的 inject
 *    （对照宿主自己的客户端包：如 dsh-session-log-export 的 client.js
 *    导出 `inject = ["slots", "locale"]`，服务名，不是包名）。
 *    只在 package.json 里声明、没导出，启动时就会抛
 *    `cannot get property "slots" without inject`（实测踩过）。
 *
 * ═══ 数据从哪来 ═══
 * 界面**不能**直接调服务端工具（`ctx.remote` 需要构建期生成的契约，
 * 而生成器没随发行版发布）。所以走同一插件的服务端半注册的 HTTP 路由：
 *   GET  /lh/practice/pending → agent 最近一次刷题请求（题库/题数）
 *   GET  /lh/practice/bank    → 题面（不含答案）
 *   POST /lh/practice/attempt → 判分与解析
 * 「题面不含答案」是刻意的：界面上**结构上不可能**先看答案再作答。
 *
 * ⚠ `/pending` 仍然存在，但**它不再打开面板**（那是被否掉的设计）。
 * 它现在的用途是给卡片和兜底入口提供"agent 请了几道题"这个信息。
 */

window.__ModuleLoader__.load({
  id: '@lh/practice',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const API = '/lh/practice'

    /** 面板是否打开 —— 模块级状态，两个插槽条目共享（都在同一 factory 闭包里）。 */
    let panelOpen = false
    /** 订阅者：状态变化时通知两个组件重渲染。 */
    const listeners = new Set()

    /**
     * 改面板开关状态并通知订阅者。
     * @param next - 新状态。
     */
    function setPanelOpen(next) {
      panelOpen = next
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
     * 用一个模块级状态驱动的 hook。
     *
     * 为什么手写而不引第三方状态库：seed 模块里只有 react/react-dom，
     * 没有状态管理库。这个面板的状态足够简单，手写 `useSyncExternalStore` 正好。
     *
     * @returns 当前是否打开。
     */
    function usePanelOpen() {
      return React.useSyncExternalStore(subscribe, () => panelOpen, () => panelOpen)
    }

    /**
     * 面板是否收成了**胶囊**。
     *
     * 为什么要这个状态：面板是**跨会话、总在最前**的独立视窗，
     * 而学习者可能同时开着好几个会话。面板一直摊开会挡住对话内容；
     * 收成胶囊之后它仍然在（状态不丢、题不丢），只是不占地方。
     *
     * ⚠ 与"关闭"是**两件不同的事**：
     *   关闭 → `panelOpen=false`，面板连状态一起没了（下次从头上取题）；
     *   最小化 → 仍在会话里待着，点胶囊就回来，进度、当前题、作答都不丢。
     * 所以它们必须是两个独立状态，不能拿一个去顶另一个。
     */
    let collapsed = false

    /**
     * 收起/展开。
     * @param next - 目标状态。
     */
    function setCollapsed(next) {
      if (collapsed === next) return
      collapsed = next
      for (const fn of listeners) fn()
    }

    /**
     * 订阅"是否收起"。
     * @returns 当前是否收起。
     */
    function useCollapsed() {
      return React.useSyncExternalStore(subscribe, () => collapsed, () => collapsed)
    }

    /**
     * **当前会话 id**（从 sessions 服务的列表快照读）。
     *
     * ═══ 为什么不能从插槽 props 拿（这是「AI深解」第一次跑就失败的原因）═══
     * `sessionId` 是**会话作用域**插槽才有的标准 props，而本面板注册在
     * `shell.overlay` —— 那是 **root 作用域**的插槽（面板要跨会话、浮在最上面，
     * 就只能挂在那里）。于是 `props.sessionId` **永远是 undefined**，
     * 「AI深解」报的正是"拿不到当前会话 id"。
     *
     * 修法不是换插槽（换了就不再跨会话了），而是**去问会话服务**：
     * `ctx.sessions.list` 是一个可订阅快照，它的 `current` 就是当前会话
     * （`ISessions.list: ObservableSnapshot<SessionListState>`，
     * 而 `SessionListState.current: SessionId | undefined`）。
     *
     * @returns 会话 id；拿不到时 null（**不抛错** —— 面板其余功能不该因此失效）。
     */
    function currentSessionId() {
      try {
        const list = ctxRef?.sessions?.list
        if (list === undefined || typeof list.getSnapshot !== 'function') return null
        const id = list.getSnapshot()?.current
        return typeof id === 'string' && id !== '' ? id : null
      } catch {
        // 快照取不到（服务没就绪/形状不符）不该让按钮炸掉：
        // 调用方会据此给出"拿不到会话"的明确提示。
        return null
      }
    }

    /**
     * 决定「AI深解」这条消息发到哪个会话。
     *
     * 先看插槽 props（会话作用域插槽会给，将来若把面板挪过去就自然生效），
     * 再退回**当前会话**（root 作用域下的正路）。
     *
     * @param props - 插槽 props。
     * @returns 会话 id 或 null。
     */
    function resolveSessionId(props) {
      if (typeof props?.sessionId === 'string' && props.sessionId !== '') return props.sessionId
      return currentSessionId()
    }

    /**
     * 调一次后端路由。
     *
     * @param path - 路由后缀（如 '/bank'）。
     * @param options - fetch 选项。
     * @returns 解析后的 JSON。
     */
    async function callApi(path, options) {
      const res = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      return body
    }

    // ─────────────────────────────────────────────────────────────
    //  外观：把 agent 声明的意图翻译成 CSS
    // ─────────────────────────────────────────────────────────────
    //
    // ═══ 这里为什么**不做校验** ═══
    // 校验在服务端一处完成（`@lh/question-bank/style.js` 的 `sanitizeCardStyle`），
    // 这里只做"合法的值 → 具体 CSS"。两处都校验等于把同一套规则实现两次，
    // 而两份规则迟早不一致——那时"哪个才对"会成为无法回答的问题。
    //
    // 所以这里的兜底只有一条：**查表查不到就用默认值**。
    // 于是即使服务端将来加了新 token 而这里没跟上，结果也只是"那个旋钮没效果"，
    // 不会画出坏掉的东西。
    //
    // ═══ 颜色为什么走主题变量 ═══
    // 本项目有 `lh-theme` 在管配色，宿主的颜色都是 `--dsw-alias-*` 变量。
    // 语义档映射到变量 → 深浅色模式自动正确。
    // 自由档（`#rrggbb`）则**必须自己算文字色**，否则浅底白字会看不见——
    // 见 `readableOn`。这一步是"允许模型自由指定颜色"能成立的前提。

    /** 语义强调色 → 主题变量。 */
    const ACCENT_VARS = {
      brand: 'var(--dsw-alias-brand-primary, #c96)',
      focus: 'var(--dsw-alias-brand-primary, #c96)',
      calm: 'var(--dsw-alias-label-secondary, #8a8f98)',
      warn: 'var(--dsw-alias-label-warning, #d90)',
      danger: 'var(--dsw-alias-label-danger, #d33)',
      neutral: 'var(--dsw-alias-border-secondary, rgba(128,128,128,0.5))',
    }

    /** 语义底色 → 主题变量。 */
    const BG_VARS = {
      panel: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base, transparent))',
      tinted: 'var(--dsw-alias-bg-hover, rgba(128,128,128,0.10))',
      plain: 'transparent',
      transparent: 'transparent',
    }

    /** 字号与留白一起缩放（"字体大小"）。 */
    const SCALES = {
      compact: { font: '12px', pad: '8px 10px', line: 1.45, gap: '6px' },
      normal: { font: '14px', pad: '12px 14px', line: 1.6, gap: '10px' },
      large: { font: '16px', pad: '14px 18px', line: 1.7, gap: '12px' },
      xlarge: { font: '18px', pad: '18px 22px', line: 1.75, gap: '14px' },
    }

    /** 框体圆角。 */
    const RADII = { none: '0', small: '4px', medium: '10px', large: '16px', pill: '999px' }

    /**
     * 框体边框。
     *
     * `accent-left` 是默认值：**左边一条强调色**是这个卡片的识别特征，
     * 它不抢眼但一眼能认出来，且不依赖任何颜色假设。
     */
    const BORDERS = {
      none: { border: 'none' },
      thin: { border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.35))' },
      'accent-left': { borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--dsw-alias-border-secondary, rgba(128,128,128,0.35))' },
      thick: { borderWidth: '2px', borderStyle: 'solid', borderColor: 'var(--dsw-alias-border-secondary, rgba(128,128,128,0.55))' },
    }

    /** 解析 `#rgb` / `#rrggbb` / `#rrggbbaa` → `{r,g,b,a}`；非法返回 null。 */
    function parseHex(hex) {
      if (typeof hex !== 'string') return null
      let s = hex.trim().replace(/^#/, '')
      if (s.length === 3) s = s.split('').map((ch) => ch + ch).join('')
      if (s.length !== 6 && s.length !== 8) return null
      if (!/^[0-9a-f]+$/i.test(s)) return null
      const n = (i) => parseInt(s.slice(i, i + 2), 16)
      return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? n(6) / 255 : 1 }
    }

    /**
     * 给一个背景色算一个**看得清**的文字色。
     *
     * ═══ 为什么这一步让"允许模型自由给颜色"变得安全 ═══
     * 模型只能写、不能看。所以它会稳定地产生"浅底白字"这种结果，
     * 而且**永远不知道**自己搞砸了。与其禁止自由颜色（作者要的是"尽可能多"的自由度），
     * 不如把"文字色"从模型手里拿走：**由背景亮度决定**。
     * 这样任意颜色都不会产生读不了的字——自由度不再以可读性为代价。
     *
     * 用相对亮度（Rec. 709 系数）而不是简单平均：人眼对绿最敏感、对蓝最不敏感，
     * 平均会让纯蓝被误判成"亮色"而配上深色字。
     *
     * @param hex - 背景色。
     * @returns 文字色（`#111` / `#f5f5f5`），或 null（hex 非法时不猜）。
     */
    function readableOn(hex) {
      const rgb = parseHex(hex)
      if (rgb === null) return null
      const lin = (v) => {
        const c = v / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      const luminance = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
      return luminance > 0.45 ? '#111111' : '#f5f5f5'
    }

    /**
     * 把（已校验的）外观意图解析成一组可直接用的 CSS 值。
     *
     * @param style - 服务端归一化过的 style（可能为 null）。
     * @param surface - 'card' 或 'panel'（两者的默认值不同）。
     * @returns `{ accent, accentEdge, bg, fg, scale, radius, border, layout, show, preview, width }`。
     */
    function resolveStyle(style, surface) {
      const s = style !== null && typeof style === 'object' ? style : {}

      // ── 强调色 ──
      // `accent_color` 优先于 `accent`（前者是显式指定，语义档是"随便挑一个顺眼的"）。
      let accent = ACCENT_VARS[s.accent] ?? ACCENT_VARS.brand
      let custom = null
      if (typeof s.accent_color === 'string' && parseHex(s.accent_color) !== null) {
        accent = s.accent_color
        custom = s.accent_color
      }

      // ── 底色与文字色 ──
      let bg = BG_VARS[s.background] ?? (surface === 'card'
        ? 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base, transparent))'
        : 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base))')
      let fg = 'var(--dsw-alias-label-primary)'
      if (typeof s.background_color === 'string' && parseHex(s.background_color) !== null) {
        bg = s.background_color
        // ★ 文字色**由背景算**，不由模型给 —— 见 readableOn 的注释。
        fg = readableOn(s.background_color) ?? fg
      }
      if (typeof s.text_color === 'string' && parseHex(s.text_color) !== null) {
        // 模型明确要文字色时听它的（它可能就是想要低对比度），但这属于"知道自己在做什么"。
        fg = s.text_color
      }

      const scale = SCALES[s.font_scale] ?? SCALES.normal
      const radius = RADII[s.radius] ?? RADII.medium
      const borderKey = BORDERS[s.border] !== undefined ? s.border : 'accent-left'
      const border = BORDERS[borderKey]

      // `show` 缺省时显示三项（向后兼容：不给 show 的卡片和以前一模一样）。
      // **显式给空数组表示"只留标题和按钮"**——所以这里判的是"是不是数组"，
      // 不是"数组里有没有东西"。否则 `show: []` 会被悄悄变成默认值，
      // 而那是另一种"声明了却不生效"。
      const show = Array.isArray(s.show) ? s.show : ['bank', 'count', 'hint']

      return {
        accent,
        accentIsCustom: custom,
        accentLeft: borderKey === 'accent-left',
        bg,
        fg,
        scale,
        radius,
        border,
        borderKey,
        layout: s.layout === 'stack' || s.layout === 'banner' ? s.layout : 'row',
        show,
        preview: typeof s.preview_questions === 'number' ? s.preview_questions : 0,
        width: typeof s.panel_width === 'number' ? s.panel_width : 520,
      }
    }

    // ─────────────────────────────────────────────────────────────
    //  入口：对话里的卡片（**不是自动弹出**）
    // ─────────────────────────────────────────────────────────────
    //
    // ═══ 这个入口改过三次，前两版都被作者否掉了 ═══
    // 1. `sidebar.footer.action` 常驻按钮 —— 否掉：*"一个出现在 dsh 界面内的
    //    刷题按钮很突兀"*。
    // 2. 信号一到就**自动弹出**面板 —— 也否掉。作者给的是类比：
    //    *"就像有的网页端ai在生成报告之后，点击一个对话里的链接或者框，
    //      右侧就会弹出报告的页面那样"*。
    //    → 要点是**在对话里给一个可点的东西**，由学习者点，而不是替他打开。
    // 3. 现在：`tool.call.toolview`（keyed 插槽，按**工具名**分发）——
    //    给 `start_practice` 注册一个自己的渲染器，于是 agent 调用它的地方
    //    就长出一张卡片，**点它才开面板**。
    //
    // ═══ 为什么这个插槽正好合适（摘自宿主的类型声明）═══
    // `dsh-client-ui-tool/lib/types/client/contract/slots.d.ts` 原文：
    //   > Keyed atomic Tool call view, dispatched by the wire Tool name.
    //   > Register with `key: '<tool name>'` to own how one tool's calls render
    //   > inside a turn — the key domain is open (any wire tool name,
    //   > **including a tool your own package registered**)…
    //   > an unclaimed key falls back to the generic tool row.
    // 也就是说"给自己的工具定制渲染"是**宿主明说的用法**。
    //
    // ⚠ 两个已知的坑，都靠代码兜而不是靠小心：
    //   a) **键写错不会报错，只是不渲染**（原文："a typo simply never renders"）。
    //      所以卡片之外必须留一个兜底入口，见 `FallbackEntry`。
    //   b) 这个插槽的注册选项形状**未验证**（keyed 型要不要给 `id`？）。
    //      于是注册时依次试几种形状，并且**永不抛错**——
    //      客户端插件 apply 抛错会让整个界面起不来，那个代价已经付过一次了。

    /** 已经见过的信号序号。初值 -1 表示"还没读过"，于是第一次只同步、不误判为新请求。 */
    let lastSeenSeq = -1

    /**
     * 面板组件挂上来的"打开并取题"入口。
     *
     * 卡片点不了 `load()`——它在面板组件的闭包里。所以由面板注册一个入口函数，
     * 卡片调它。（和上一版的 `openFromSignal` 是同一个桥，只是触发者从轮询换成了点击。）
     *
     * @type {null | ((opts: { bank?: string | null, count?: number | null }) => void)}
     */
    let requestOpen = null

    /**
     * **显式打开面板**（卡片被点、兜底按钮被点，都走这里）。
     *
     * ═══ 为什么收起态必须在这里被清掉（这个 bug 坑了作者一次）═══
     * 收起（最小化）是"我**暂时**不想看它"，**不是**"我拒绝再看它"。
     * 而第一版实现里，卡片点击只做了 `setPanelOpen(true)`、**没清 `collapsed`**，
     * 于是：切过一次会话（自动收起）之后，`collapsed` 一直是 true，
     * 此后**点卡片只会渲染出胶囊**——学习者的感受是"卡片打不开了"。
     *
     * 而 trace 里 `GET /bank` 每秒一次，说明点击其实**完全正常**、
     * 题也在取——坏的只有"渲染成什么"。**这类"逻辑都跑对了、只是没显示"
     * 是最难从现象反推的一类**，所以规则写死在这里：
     *
     *   **任何显式打开请求，都必须同时清掉收起态。**
     *
     * @param opts - `{ bank, count, style }`，交给面板去取题。
     */
    function openPanelWith(opts) {
      setCollapsed(false)
      setPanelOpen(true)
      if (requestOpen !== null) requestOpen(opts)
    }

    /** 最近一次 agent 的刷题请求（用于卡片文案与兜底按钮）。 */
    let pendingRequest = null

    /**
     * 对话里的卡片处于什么状态。
     *
     * ═══ 为什么是**三态**而不是布尔 ═══
     * 卡片注册现在挂在 `slots.inject('tool.call.toolview', …)` 上：
     * **插槽声明可能还没到**，那时注册还没发生——这既不是"成功"也不是"失败"。
     * 用布尔就会把"还没轮到"误判成"失败"（于是兜底入口乱闪），
     * 或者把"失败"当成"已成功"（于是兜底入口永远不出现，学习者没有入口）。
     *
     *   'pending'    → 插槽还没声明，注册推迟中（**正常状态**，不是错误）
     *   'registered' → 注册成功（三条形状里有一条被接受）
     *   'failed'     → 插槽已声明，但三条形状全被拒（**真的坏**，要靠兜底入口）
     *
     * ⚠ 兜底入口的判据是 `cardState !== 'registered'`（而不是 `=== 'failed'`）：
     * 只要入口还不能用，就该给学习者另一条路——包括"推迟中"那段时间。
     * 正常启动时 `slots.inject` 在插槽已声明的情况下是**同步执行**的，
     * 所以这个窗口通常不存在（apply 返回时已经是 registered）。
     */
    let cardState = 'pending'

    /** 轮询定时器句柄。 */
    let pollTimer = null

    /**
     * 记下 agent 的刷题请求并通知订阅者。
     *
     * ⚠ 这里**不打开面板**——打开是学习者的动作（点卡片）。
     * 轮询只用来知道"有没有人请我刷题"，好让卡片与兜底入口有准确文案。
     *
     * @param sig - `/pending` 返回的信号。
     */
    function setPendingRequest(sig) {
      pendingRequest = {
        bank: sig.bank ?? null,
        count: sig.count ?? null,
        seq: sig.seq,
        // 外观随请求一起记住：卡片与面板都从这里取，于是**只有一处校验**（服务端）。
        style: sig.style ?? null,
      }
      for (const fn of listeners) fn()
    }

    /**
     * 订阅"最近一次刷题请求"。
     * @returns 当前请求（没有则 null）。
     */
    function usePendingRequest() {
      return React.useSyncExternalStore(subscribe, () => pendingRequest, () => pendingRequest)
    }

    /**
     * 启动/停止轮询。
     *
     * 为什么用 `setInterval` 而不是递归 `setTimeout`：这里的请求很轻，
     * 且不需要保证"上一次完成才发下一次"——重复请求无害（读一个文件而已）。
     */
    function startPolling() {
      if (pollTimer !== null) return
      const tick = async () => {
        try {
          const sig = await callApi('/pending')
          if (lastSeenSeq < 0) {
            // 第一次读：只记住，不当作新请求。
            // 这一条很重要——否则**每次页面刷新都会显示"agent 请你刷题"**，
            // 而那个信号其实是上一次对话留下来的。
            lastSeenSeq = sig.seq
            return
          }
          if (typeof sig.seq === 'number' && sig.seq > lastSeenSeq) {
            lastSeenSeq = sig.seq
            setPendingRequest(sig)
          }
        } catch {
          /* 网络抖动或服务未就绪：静默重试，不打扰学习者 */
        }
      }
      void tick()
      pollTimer = setInterval(tick, 3000)
    }

    /** 停止轮询。 */
    function stopPolling() {
      if (pollTimer === null) return
      clearInterval(pollTimer)
      pollTimer = null
    }

    // ─────────────────────────────────────────────────────────────
    //  刷题面板
    // ─────────────────────────────────────────────────────────────
    /**
     * 浮层刷题面板。
     *
     * 状态机：idle（等开始）→ answering（显示题面、等作答）→ graded（显示对错与解析）。
     *
     * @returns React 元素或 null。
     */
    function PracticePanel(props) {
      const open = usePanelOpen()
      const isCollapsed = useCollapsed()
      const pending = usePendingRequest()
      /** 「AI深解」的发送状态：'' | 'sending' | 'sent'（失败走 error 提示）。 */
      const [deepDive, setDeepDive] = React.useState('')
      const [bank, setBank] = React.useState(null)
      const [banks, setBanks] = React.useState([])
      const [question, setQuestion] = React.useState(null)
      const [choice, setChoice] = React.useState('')
      const [phase, setPhase] = React.useState('idle')
      const [verdict, setVerdict] = React.useState(null)
      const [stats, setStats] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [batch, setBatch] = React.useState([])
      const [batchIndex, setBatchIndex] = React.useState(0)
      const askedAt = React.useRef(0)

      // ── 拖拽状态 ──
      //
      // `pos === null` 表示"用默认位置（右下角）"——一从未拖过就一直是 null，
      // 于是默认布局不需要存任何东西，也不会因为存了个 0 而跑到左上角。
      const [pos, setPos] = React.useState(() => loadPanelPos())
      const [dragging, setDragging] = React.useState(false)
      /** 学习者自己拖出来的尺寸。null = 还没拖过，于是用 agent 声明的宽度。 */
      const [size, setSize] = React.useState(() => loadPanelSize())
      const [resizing, setResizing] = React.useState(false)
      /** 拖拽起点：指针位置 + 面板当时的左上角。 */
      const dragRef = React.useRef(null)
      /** 缩放起点：指针位置 + 面板当时的尺寸。 */
      const resizeRef = React.useRef(null)
      const panelRef = React.useRef(null)
      /** 上一次**已经生效的** agent 声明宽度（用来判断"这次是不是真的改了宽度"）。 */
      const lastAgentWidth = React.useRef(null)

      /**
       * 表头按下 → 开始拖。
       *
       * 用**指针事件**（pointerdown/move/up）而不是鼠标事件：
       * 指针事件把鼠标、触摸、触控笔统一成一套，且 `setPointerCapture`
       * 能让指针移出元素后依然收到 move —— 拖出面板边界是常态，没有它就会"拖丢"。
       */
      const onDragStart = React.useCallback((e) => {
        // 表头里有按钮（关闭）。按在按钮上不该开始拖——否则点"关闭"会变成拖一下。
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('button') !== null) return
        const rect = panelRef.current?.getBoundingClientRect()
        if (!rect) return
        dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
        setPos({ x: rect.left, y: rect.top })
        setDragging(true)
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 不支持捕获也能拖，只是移出元素后会断 */
        }
        e.preventDefault()
      }, [])

      const onDragMove = React.useCallback((e) => {
        const d = dragRef.current
        if (d === null) return
        const rect = panelRef.current?.getBoundingClientRect()
        setPos(clampPanelPos(e.clientX - d.dx, e.clientY - d.dy, rect))
      }, [])

      const onDragEnd = React.useCallback((e) => {
        if (dragRef.current === null) return
        dragRef.current = null
        setDragging(false)
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* 忽略 */
        }
        // 只在松手时落盘：拖动过程中每帧写 localStorage 没有意义且会卡。
        setPos((current) => {
          if (current !== null) savePanelPos(current)
          return current
        })
      }, [])

      // ── 切换会话 → 自动收起 ──
      //
      // 为什么这是个好触发条件：面板是**跨会话**的（切了会话它还在），
      // 但它显示的是**上一个会话**的题。切走之后它既挡着新会话的对话，
      // 又容易让人以为是新会话的题——所以"切会话就收起"是**语义上正确**的动作，
      // 不只是省地方。而且它**不丢状态**：切回来点胶囊就继续。
      //
      // 怎么检测：`ctx.sessions.list` 是可订阅快照（`ObservableSnapshot`），
      // 它的 `current` 就是当前会话。订阅它比轮询可靠（不猜间隔），
      // 也比"读一次记住"准确（切换往往不伴随别的渲染）。
      React.useEffect(() => {
        const list = ctxRef?.sessions?.list
        if (list === undefined || typeof list.subscribe !== 'function') return undefined
        let last = null
        try {
          last = list.getSnapshot()?.current ?? null
        } catch {
          last = null
        }
        const unsubscribe = list.subscribe(() => {
          let now = null
          try {
            now = list.getSnapshot()?.current ?? null
          } catch {
            return
          }
          if (now === last) return
          const switched = last !== null && now !== null && now !== last
          last = now
          // 只在"从一个会话切到另一个会话"时收起，且**只在面板正开着时**。
          // 面板本来就关着还去设收起态，没有任何收益，却会在下一次
          // 显式打开时冒出来否决它（正是上一个 bug 的一半原因）。
          // 首次拿到 current（last 为 null）不算切换——否则打开应用就会莫名收起。
          if (switched && panelOpen) setCollapsed(true)
        })
        return unsubscribe
      }, [])

      // 窗口尺寸变化时把面板夹回界内（否则缩小窗口后它可能跑到看不见的地方）。
      React.useEffect(() => {
        const onResize = () => {
          setPos((current) => {
            if (current === null) return current
            const rect = panelRef.current?.getBoundingClientRect()
            const next = clampPanelPos(current.x, current.y, rect)
            if (next.x !== current.x || next.y !== current.y) savePanelPos(next)
            return next
          })
          setSize((current) => {
            if (current === null) return current
            const next = clampPanelSize(current.w, current.h)
            if (next.w !== current.w || next.h !== current.h) savePanelSize(next)
            return next
          })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // ── 角上的缩放把手 ──
      //
      // 与拖动同一套指针事件。用**右下角**：它不挡标题、不挡内容，
      // 而且是"窗口可以变大"这个约定俗成的方位。
      const onResizeStart = React.useCallback((e) => {
        const rect = panelRef.current?.getBoundingClientRect()
        if (!rect) return
        resizeRef.current = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height }
        setResizing(true)
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 忽略 */
        }
        e.preventDefault()
        // 阻止冒泡：把手在面板内部，别让它顺带触发拖动
        e.stopPropagation()
      }, [])

      const onResizeMove = React.useCallback((e) => {
        const r = resizeRef.current
        if (r === null) return
        setSize(clampPanelSize(r.w + (e.clientX - r.x), r.h + (e.clientY - r.y)))
      }, [])

      const onResizeEnd = React.useCallback((e) => {
        if (resizeRef.current === null) return
        resizeRef.current = null
        setResizing(false)
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* 忽略 */
        }
        setSize((current) => {
          if (current !== null) savePanelSize(current)
          return current
        })
      }, [])

      /**
       * 本次面板里**已经出过**的题 id。
       *
       * ═══ 为什么这个必须由客户端记（服务端选题是无状态的）═══
       * 服务端的 `selectQuestions` 是纯函数：给题库、计数、策略，它算出题——
       * **它不知道刚才给过谁**。所以"再来一题"必须由**界面**说清楚"别给这些"，
       * 否则同一个策略会算出同一批题。
       *
       * 踩过的现象：点"再来一题"题目不变。原因有两层，**两层都要修**
       * （只修第一层会在"题全做完了"的时候复发）：
       *   1. 以前不传 `order`，服务端默认 `sequential` —— 那是"按题库原顺序取前 N 道"，
       *      于是每次都拿回第 1 道；现在默认走 `unseen`（先出没做过的）。
       *   2. `unseen` 在"全做过了"时会**退化为按顺序重刷**（有意为之：宁可重刷，
       *      也不返回空集让学习者以为没题了），那时又会回到第 1 道；
       *      所以还要把已出过的 id 传回去排除。
       *
       * 只保留最近若干条：URL 长度有限，而重刷一轮之后更早的记录也没意义了。
       */
      const shownIds = React.useRef([])

      /**
       * **这次要刷哪些题**（由卡片传进来；见 `openPanelWith`）。
       *
       * ═══ 为什么它是"这次改动的关键一半" ═══
       * 面板以前把这个写死成 `order: 'unseen'`——也就是说**不管卡片上写的是什么，
       * 面板一律按"先出没做过的"取题**。于是卡片上写"只练错题"也不会生效：
       * 选择传进来了，却没人用。**"传了但没用"比"没传"更难发现**，
       * 因为两边看起来都做对了。
       *
       * 默认值保持 `{order:'unseen'}`——与改动**之前**的行为一致，
       * 这样"没有选择"的旧卡片打开后的表现完全不变（向后兼容）。
       */
      const selectionRef = React.useRef({ order: 'unseen' })

      /**
       * 取题。
       *
       * @param count - 一次要几道。
       * @param bankName - 题库名（可选）。信号里带了就用它；否则由服务端选第一个题库。
       */
      const load = React.useCallback(async (count, bankName) => {
        setBusy(true)
        setError('')
        try {
          const sel = selectionRef.current ?? {}
          const ids = Array.isArray(sel.ids) ? sel.ids : null
          // 指定了 ids 就按它的道数取（"就做这几道"里那个"几道"是学习者说的数量）
          const want = ids !== null && ids.length > 0 ? ids.length : count

          const q = new URLSearchParams({ count: String(want) })
          if (bankName) q.set('bank', bankName)

          if (ids !== null && ids.length > 0) {
            // 明确指定了题目：**不要再传 order / exclude_ids**。
            // 那两个是"帮我挑"的语义，而这次是"就这些"——
            // 一起传会让"就做这几道"变成"少做几道 / 换了题"。
            q.set('ids', ids.slice(0, 200).join(','))
          } else {
            // 没指定就按选择里的档位走；选择里没写档位时用 unseen
            // （先出没做过的，全做过了它会自己退化为按顺序重刷）。
            q.set('order', typeof sel.order === 'string' ? sel.order : 'unseen')
            if (typeof sel.topic === 'string' && sel.topic !== '') q.set('topic', sel.topic)
            if (shownIds.current.length > 0) {
              q.set('exclude_ids', shownIds.current.slice(-80).join(','))
            }
          }

          const view = await callApi(`/bank?${q.toString()}`)
          setBanks(view.banks ?? [])
          setBank(view.bank)
          setStats(view.stats)
          const qs = view.questions ?? []
          // 记下这次出过的题，供下一次取题排除
          shownIds.current = [...shownIds.current, ...qs.map((x) => x.id)].slice(-120)
          setBatch(qs)
          setBatchIndex(0)
          setQuestion(qs[0] ?? null)
          setChoice('')
          setVerdict(null)
          setPhase(qs.length > 0 ? 'answering' : 'idle')
          askedAt.current = Date.now()
          // 「取到 0 道」要说清楚为什么：要能区分"题都做完了"与"题库本来就是空的"
          if (qs.length === 0) setError(view.note ?? '没有可出的题了')
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      // ── 轮询的生命周期 + 把"打开并取题"这个入口交给卡片 ──
      //
      // 面板**关闭时**轮询（只为知道 agent 有没有请我刷题）；**打开时**停掉。
      // ⚠ 轮询**不再打开面板**：打开是学习者的动作（点对话里的卡片）。
      //
      // `requestOpen` 是卡片唯一能用的入口——`load()` 在这个闭包里，
      // 而卡片是另一个组件。所以由这里把它挂出去。
      React.useEffect(() => {
        requestOpen = (opts) => {
          // ⚠ 只负责取题：**打开与展开由 `openPanelWith` 统一处理**。
          // 第一版在这里顺手 setPanelOpen(true)，结果漏了"清收起态"，
          // 造成"点了卡片只出胶囊"（见 openPanelWith 的注释）。
          //
          // ★ 选择在这里**落到 ref 上**：`load` 是 `useCallback([])`（依赖为空，
          // 刻意保持稳定，否则它会连带把 effect 一起重跑）。所以不能把选择塞进
          // `load` 的闭包——那样拿到的是首次渲染时的旧值。用 ref 传是这类
          // "稳定的回调 + 每次都变的参数"的标准解法。
          if (opts?.selection !== undefined) {
            selectionRef.current = opts.selection ?? { order: 'unseen' }
            // 换了选择就**清空"已出过"的记忆**：那是"同一次连续刷题里别重复"的记账，
            // 换了选择就是新的一轮，留着会把新一轮的题也排除掉。
            shownIds.current = []
          }
          void load(opts?.count ?? 1, opts?.bank ?? undefined)
        }
        if (!open) startPolling()
        else stopPolling()
        return () => {
          // 卸载时清掉：否则组件重挂会留下多个定时器
          requestOpen = null
          stopPolling()
        }
      }, [open, load])

      /**
       * 提交当前作答。
       */
      const submit = React.useCallback(async () => {
        if (!question || !bank) return
        setBusy(true)
        setError('')
        try {
          const r = await callApi('/attempt', {
            method: 'POST',
            body: JSON.stringify({
              bank: bank.name,
              questionId: question.id,
              response: choice,
              durationMs: Date.now() - askedAt.current,
            }),
          })
          setVerdict(r)
          setStats(r.stats)
          setPhase('graded')
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [question, bank, choice])

      /**
       * 下一题（批量里推进，用完了就再取）。
       */
      const next = React.useCallback(() => {
        const ni = batchIndex + 1
        if (ni < batch.length) {
          setBatchIndex(ni)
          setQuestion(batch[ni])
          setChoice('')
          setVerdict(null)
          setPhase('answering')
          askedAt.current = Date.now()
        } else {
          load(1)
        }
      }, [batch, batchIndex, load])

      // ── agent 声明的宽度 vs 学习者拖出来的尺寸：谁赢？ ──
      //
      // 规则（刻意写清楚，因为两种"合理的直觉"会打架）：
      //   · 学习者**手动拖过** → 他的尺寸赢（他刚表达过意图，不该被下一句对话改掉）；
      //   · 但若 agent 这次带来的 `panel_width` **与上次生效的值不同** →
      //     说明这是学习者**要求改样式**的结果，应当让它生效（并放弃手动尺寸）。
      // 这样"改样式"能用，而"agent 重复同一样式"不会把学习者的拖动冲掉。
      //
      // ⚠⚠ 这个 effect **必须在下面那行 `if (!open) return null` 之前** ⚠⚠
      // 踩过一次，而且是"刷新后打不开面板"这种当场就坏的形式：
      // hook 写在提前 return 之后 → 面板关着时 N 个 hook、打开时 N+1 个，
      // React 直接抛 "Rendered more hooks than during the previous render"，
      // **面板永远渲染不出来**，看起来就像"点了没反应"。
      // 规矩：组件里**所有 hook 都要在第一个 return 之前**，没有例外。
      const agentWidth = typeof pending?.style?.panel_width === 'number' ? pending.style.panel_width : null
      React.useEffect(() => {
        if (agentWidth === null) return
        if (lastAgentWidth.current === agentWidth) return
        const wasFirst = lastAgentWidth.current === null
        lastAgentWidth.current = agentWidth
        // 第一次只是记录（别把学习者上次会话拖的尺寸冲掉）；
        // 之后每次**变化**才以声明为准。
        if (!wasFirst) setSize(clampPanelSize(agentWidth, (size?.h ?? 0) || 420))
      }, [agentWidth])

      // 面板的外观：与卡片同一份意图（`pending.style`），只是默认值不同。
      // ⚠ 必须算在下面两个提前 return **之前**：收起态的胶囊也要用它
      // （放在 return 之后会踩 TDZ —— 胶囊渲染时 `st` 还没初始化）。
      const st = resolveStyle(pending?.style, 'panel')

      if (!open) return null

      // ── 收起态：一颗胶囊 ──
      //
      // 位置沿用面板自己的坐标（`pos`），所以收起/展开看起来是**原地缩小**，
      // 而不是跳到别处再跳回来——那两下跳动会让人以为是两个不同的东西。
      if (isCollapsed) {
        return h(
          'button',
          {
            key: 'capsule',
            title: '展开刷题面板（切会话时会自动收起，进度不会丢）',
            onClick: () => setCollapsed(false),
            style: {
              position: 'fixed',
              ...(pos === null ? { right: '24px', bottom: '24px' } : { left: `${pos.x}px`, top: `${pos.y}px` }),
              display: 'flex',
              alignItems: 'center',
              gap: '9px',
              padding: '9px 18px',
              borderRadius: '999px',
              border: 'none',
              background: st.bg,
              color: st.fg,
              cursor: 'pointer',
              // ═══ 怎么让它"显眼"而又不冒对比度的风险 ═══
              // 不做"整颗胶囊涂成强调色"——强调色可能是 agent 传的 `#rrggbb`，
              // 也可能是主题变量（**变量算不出亮度**，没法像 readableOn 那样
              // 自动配一个读得清的文字色），涂上去就有出现"看不清的字"的风险。
              //
              // 改成**用强调色做外环 + 圆点**，文字仍留在主题底色上：
              // 视觉重量上去了（一圈高饱和描边 + 一个实心圆点），
              // 可读性却完全不受强调色影响。降级也安全——
              // 万一 `st.accent` 取不到值，环与点消失，字仍然清楚。
              boxShadow: `0 10px 26px rgba(0,0,0,0.30), 0 0 0 2px ${st.accent}`,
              fontSize: '14px',
              fontWeight: 600,
              letterSpacing: '0.02em',
              zIndex: 2147000000,
              pointerEvents: 'auto',
            },
          },
          // 实心圆点 = "它还活着、里面有东西"的通用暗示。
          // 用圆形而不是图标：不引图标库，且任何字号下都不会变形。
          h('span', {
            key: 'dot',
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: st.accent,
              flex: '0 0 auto',
            },
          }),
          `刷题${question ? ` ${batchIndex + 1}/${batch.length || 1}` : ''}`,
        )
      }

      const width = size?.w ?? st.width
      const height = size?.h ?? null

      const panelStyle = {
        position: 'fixed',
        // ── 位置：可拖动，且记得住 ──
        //
        // ═══ 为什么让面板可拖 ═══
        // 它固定在右下角时，会挡住题目、选项或输入框——而学习者**没法把它挪开**，
        // 只能关掉再重开（重开后还在原位）。拖动是这个形态最小的可用性修补。
        //
        // 位置与尺寸都存在 localStorage：刷新后回到原处。**不存进会话/事件日志**——
        // 那是"学习事实"的日志，面板坐标不是学习事实（契约 §1.4：
        // 内核不知道什么值得记，界面偏好显然不属于）。
        ...(pos === null ? { right: '24px', bottom: '24px' } : { left: `${pos.x}px`, top: `${pos.y}px` }),
        width: `${width}px`,
        ...(height === null ? { maxHeight: '78vh' } : { height: `${height}px` }),
        // ⚠ 外层**不滚动**，滚动交给内层。
        // 踩过的坑：把手原本放在带 `overflow:auto` 的同一个盒子里，
        // 而绝对定位在滚动容器内会**跟着内容滚**——题目一多，
        // 缩放把手就跑到内容末尾去了，得滚到底才够得着。
        // 所以拆成"外层定位 + 内层滚动 + 把手贴外层角"。
        overflow: 'hidden',
        // 颜色跟随主题变量（lh-theme 与宿主自己的主题都在管这些变量）；
        // agent 若指定了自定义色，则用算好的对比文字色，见 readableOn。
        background: st.bg,
        color: st.fg,
        borderRadius: st.radius,
        boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
        padding: st.scale.pad,
        fontSize: st.scale.font,
        lineHeight: st.scale.line,
        zIndex: 2147000000,
        ...st.border,
        borderTop: st.accentLeft ? `3px solid ${st.accent}` : st.border.borderTop,
      }
      const head = {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: st.scale.gap,
        // 表头就是拖拽把手 —— 这是最常见的约定：拖边框容易误触，
        // 而"拖标题栏"不需要解释。
        cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none',
        touchAction: 'none',
      }
      const opt = (label) => ({
        display: 'block',
        width: '100%',
        textAlign: 'left',
        margin: '6px 0',
        padding: '8px 10px',
        cursor: 'pointer',
        borderRadius: '8px',
        border: `1px solid ${choice === label ? 'var(--dsw-alias-brand-primary, #c96)' : 'var(--dsw-alias-border-secondary, rgba(128,128,128,0.35))'}`,
        background: choice === label ? 'var(--dsw-alias-bg-hover, rgba(128,128,128,0.12))' : 'transparent',
        color: 'inherit',
        font: 'inherit',
      })

      const children = []
      children.push(
        h(
          'div',
          {
            key: 'head',
            style: head,
            onPointerDown: onDragStart,
            onPointerMove: onDragMove,
            onPointerUp: onDragEnd,
            onPointerCancel: onDragEnd,
            // 提示"这里能拖"。title 是零成本的发现手段——不占地方，
            // 悬停就能看到，比画一个拖拽图标更省。
            title: '拖动此处可移动面板',
          },
          h('strong', null, bank ? `刷题 · ${bank.name}` : '刷题'),
          h(
            'span',
            { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
            // 最小化（收成胶囊）。**与"关闭"分开**：收起不丢状态。
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              title: '收起成胶囊（进度不丢，点胶囊回来）',
              onClick: () => setCollapsed(true),
            }, '—'),
            h(Button, { size: 'sm', variant: 'ghost', onClick: () => setPanelOpen(false) }, '关闭'),
          ),
        ),
      )

      if (stats) {
        const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`)
        children.push(
          h(
            'div',
            { key: 'stats', style: { opacity: 0.75, marginBottom: '10px', fontSize: '13px' } },
            `做过 ${stats.attempted}/${stats.total} · 覆盖 ${pct(stats.coverage)} · 正确率 ${pct(stats.accuracy)}` +
              `（对 ${stats.correct} 错 ${stats.wrong}${stats.unjudged ? ` 判不了 ${stats.unjudged}` : ''}）` +
              (stats.missed ? ` · 错题 ${stats.missed}` : ''),
          ),
        )
      }

      if (error) {
        children.push(
          h('div', { key: 'err', style: { color: 'var(--dsw-alias-label-danger, #d33)', margin: '8px 0' } }, error),
        )
      }

      if (phase === 'idle' && !busy) {
        children.push(
          h(
            'div',
            { key: 'start', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h(Button, { variant: 'primary', onClick: () => load(1) }, '一次一题'),
            h(Button, { onClick: () => load(5) }, '一次五题'),
            h(Button, { variant: 'ghost', onClick: () => load(1) }, '刷新进度'),
          ),
        )
      }

      if (question) {
        children.push(h('div', { key: 'stem', style: { margin: '12px 0', whiteSpace: 'pre-wrap' } }, question.stem))
        // 填空题：给输入框（这是"打字以外的输入方式"里不得不打字的那一类）
        if (question.kind === 'fill_blank' || (question.options ?? []).length < 2) {
          children.push(
            h('input', {
              key: 'input',
              value: choice,
              onChange: (e) => setChoice(e.target.value),
              placeholder: '填写答案',
              disabled: phase === 'graded',
              style: {
                width: '100%',
                padding: '8px 10px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.35))',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
              },
            }),
          )
        } else {
          // 选择题：**可点击的选项按钮**（这就是"比对话更不容易误触"的那一半）
          for (const o of question.options) {
            children.push(
              h(
                'button',
                {
                  key: o.label,
                  style: opt(o.label),
                  onClick: () => {
                    if (phase === 'graded') return
                    setChoice(o.label)
                  },
                },
                `${o.label}. ${o.text}`,
              ),
            )
          }
        }
      }

      if (verdict) {
        const mark = verdict.correct === true ? '✓ 答对' : verdict.correct === false ? '✗ 答错' : '? 判不了'
        const historyLine = formatHistory(verdict.history)
        children.push(
          h(
            'div',
            { key: 'verdict', style: { marginTop: '10px' } },
            h('div', { style: { fontWeight: 600 } }, mark),
            // 作答历史：**只在这里**（判分之后）出现，取题时不显示。
            // 放在判定之后、解析之前：先说"这题你做过、上次如何"，
            // 再给解析——顺序上更像"回顾"，而不是"提示"。
            historyLine !== null
              ? h('div', {
                  style: {
                    marginTop: '4px',
                    opacity: 0.8,
                    fontSize: '13px',
                    borderLeft: `2px solid ${st.accent}`,
                    paddingLeft: '8px',
                  },
                }, historyLine)
              : null,
            verdict.correct !== true ? h('div', null, `标准答案：${(verdict.answer ?? []).join('、')}`) : null,
            verdict.analysis
              ? h(
                  'div',
                  { style: { marginTop: '6px', opacity: 0.85 } },
                  // 解析的来路要如实标注：题库里的解析很多是 OCR 两栏**串行**抽出来的，
                  // 读起来会跳。不标注，学习者会以为是自己读不懂，而不是"这段文字本身是乱的"。
                  verdict.analysis_kind && verdict.analysis_kind.includes('串行')
                    ? h('div', { style: { opacity: 0.7, fontSize: '12px' } }, `（题库解析·${verdict.analysis_kind}）`)
                    : null,
                  verdict.analysis,
                )
              : null,
            verdict.correct === null ? h('div', { style: { opacity: 0.7 } }, '（判不了，已如实记 null——没有算成答错）') : null,
          ),
        )
      }

      // 操作区
      const actions = []
      if (question && phase === 'answering') {
        actions.push(h(Button, { key: 'submit', variant: 'primary', disabled: busy || choice === '', onClick: submit }, '提交'))
      }
      if (phase === 'graded') {
        const label = batchIndex + 1 < batch.length ? `下一题（${batchIndex + 2}/${batch.length}）` : '再来一题'
        actions.push(h(Button, { key: 'next', variant: 'primary', onClick: next }, label))
      }
      if (question && phase === 'answering' && batch.length > 1) {
        actions.push(h('span', { key: 'pos', style: { opacity: 0.6, alignSelf: 'center' } }, `${batchIndex + 1}/${batch.length}`))
      }

      // ── 「AI深解」──
      //
      // ⚠ **只要显示了题目就有这个按钮**，不是"答错才出现"。
      // 作者明确要求过：*"注意深解不一定针对错题，别做仅错题时弹出的多余逻辑"*。
      // 理由也站得住：答对但蒙对、或者想知道更优解法，都是真实需求。
      //
      // 它做的事：把题号 + 本人作答 + 三步要求写成一条消息，**发进当前对话**。
      // 于是产物是一段可以继续追问的对话，而不是一个读不完的弹窗。
      if (question) {
        const label = deepDive === 'sending' ? '发送中…' : deepDive === 'sent' ? '已发到对话 ✓' : 'AI深解'
        actions.push(
          h(Button, {
            key: 'deepdive',
            variant: 'ghost',
            disabled: deepDive === 'sending' || busy,
            title: '把这道题（含题号与我的答案）发到当前对话，让 agent 先自解、再查题库解析、最后分析我的错因',
            onClick: async () => {
              setDeepDive('sending')
              setError('')
              try {
                // 会话 id：优先插槽 props（会话作用域插槽会给），
                // 否则问会话服务要**当前会话**（面板在 root 作用域，props 里没有）。
                await sendIntoSession(
                  ctxRef,
                  resolveSessionId(props),
                  composeDeepDive({ bankName: bank?.name, question, choice, verdict }),
                )
                setDeepDive('sent')
              } catch (err) {
                // 失败**必须说出来**：这个接口没有一线先例，若此处静默，
                // 学习者只会看到"点了没反应"，而那是无从下手的状态。
                setDeepDive('')
                setError(`AI深解没能发出去：${err?.message ?? err}`)
              }
            },
          }, label),
        )
      }

      if (actions.length) {
        children.push(h('div', { key: 'actions', style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } }, actions))
      }

      return h(
        'div',
        { ref: panelRef, style: panelStyle },
        h(
          'div',
          {
            key: 'scroll',
            style: {
              overflowY: 'auto',
              // 内层只在有明确高度时撑满；否则跟着内容长（外层 maxHeight 兜住）
              height: height === null ? undefined : '100%',
              maxHeight: height === null ? 'calc(78vh - 2 * 1em)' : undefined,
            },
          },
          children,
        ),
        // ── 缩放把手（右下角）──
        //
        // 为什么自己做而不是用 CSS 的 `resize: both`：
        // 原生的 resize 只在 `overflow` 不是 visible 的元素上生效，能改尺寸
        // **但拿不到回调**——于是没法把尺寸存进 localStorage（刷新就丢），
        // 也没法在超出可视区时夹紧。而"尺寸失控"正是这类功能最典型的静默失效。
        h('div', {
          key: 'resize-handle',
          title: '拖动可改变面板大小',
          onPointerDown: onResizeStart,
          onPointerMove: onResizeMove,
          onPointerUp: onResizeEnd,
          onPointerCancel: onResizeEnd,
          style: {
            position: 'absolute',
            right: '2px',
            bottom: '2px',
            width: '18px',
            height: '18px',
            cursor: 'nwse-resize',
            touchAction: 'none',
            opacity: 0.45,
            // 用两条斜线画出"可以拉"的暗示，不引图标库
            background:
              'linear-gradient(135deg, transparent 55%, currentColor 55%, currentColor 62%, transparent 62%, transparent 74%, currentColor 74%, currentColor 81%, transparent 81%)',
          },
        }),
      )
    }

    /**
     * 面板位置在 localStorage 里的键。
     *
     * ⚠ 用 `localStorage` 而不是"存回服务端"：面板坐标是**界面偏好**，
     * 不是学习事实。写进 LH 的事件日志会污染唯一事实源
     * （契约 §1.4「内核不知道什么值得记」；ADR-012 决策 4「调试痕迹与 LH 事件严格分开」——
     * 界面坐标比调试痕迹更不属于学习史）。
     */
    const POS_KEY = 'lh-practice.panel-pos'
    /** 面板尺寸在 localStorage 里的键（拖动改位置、拖角改尺寸，两者分开存）。 */
    const SIZE_KEY = 'lh-practice.panel-size'

    /** 面板尺寸的边界。与 style.js 的 STYLE_NUMBERS.panel_width 同源（那边夹 agent 给的值）。 */
    const SIZE_LIMITS = { minW: 320, maxW: 900, minH: 180, maxH: 1400 }

    /**
     * 把尺寸夹进合理范围，并保证**在可视区内**。
     *
     * 与位置同理：窗口缩小后旧尺寸可能比窗口还大，那时面板会遮住整个界面且拖不动角。
     *
     * @param w - 宽。
     * @param h - 高。
     * @returns 夹紧后的尺寸。
     */
    function clampPanelSize(w, h) {
      const vw = window.innerWidth || 1200
      const vh = window.innerHeight || 800
      const width = Math.min(Math.max(SIZE_LIMITS.minW, Math.round(w)), Math.min(SIZE_LIMITS.maxW, vw - 16))
      const height = Math.min(Math.max(SIZE_LIMITS.minH, Math.round(h)), Math.min(SIZE_LIMITS.maxH, vh - 16))
      return { w: width, h: height }
    }

    /** 读回上次的尺寸；坏数据当作"没存过"。 */
    function loadPanelSize() {
      try {
        const raw = window.localStorage.getItem(SIZE_KEY)
        if (raw === null) return null
        const s = JSON.parse(raw)
        if (!Number.isFinite(s?.w) || !Number.isFinite(s?.h)) return null
        return clampPanelSize(s.w, s.h)
      } catch {
        return null
      }
    }

    /** 记住面板尺寸。 */
    function savePanelSize(size) {
      try {
        window.localStorage.setItem(SIZE_KEY, JSON.stringify(size))
      } catch {
        /* 忽略 */
      }
    }

    /** 读回上次的位置；坏数据一律当作"没存过"。 */
    function loadPanelPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY)
        if (raw === null) return null
        const p = JSON.parse(raw)
        if (typeof p?.x !== 'number' || typeof p?.y !== 'number') return null
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
        return { x: p.x, y: p.y }
      } catch {
        // 隐私模式 / 存储被禁用 / 坏 JSON：全部退回默认位置，**不报警**。
        return null
      }
    }

    /** 记住面板位置（失败就算了——记不住位置不该影响刷题）。 */
    function savePanelPos(pos) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(pos))
      } catch {
        /* 忽略 */
      }
    }

    /**
     * 把坐标夹回可视区内。
     *
     * 为什么必须夹：窗口缩小、或换了屏幕之后，旧坐标可能落在**屏幕外**——
     * 那时面板"还在"但谁也看不到它，而学习者只会觉得"刷题坏了"。
     * 这是拖拽类功能最典型的静默失效，必须在写入与读取两侧都防。
     *
     * @param x - 左坐标。
     * @param y - 上坐标。
     * @param size - 面板尺寸（用于保证右下角也在界内）。
     * @returns 夹紧后的坐标。
     */
    function clampPanelPos(x, y, size) {
      const vw = window.innerWidth || 1200
      const vh = window.innerHeight || 800
      const w = size?.width ?? 520
      const h = size?.height ?? 320
      // 留 8px 边距，别贴着屏幕边（贴边时圆角与阴影会被裁掉）
      return {
        x: Math.min(Math.max(8, x), Math.max(8, vw - w - 8)),
        y: Math.min(Math.max(8, y), Math.max(8, vh - h - 8)),
      }
    }

    /**
     * 从**这张卡片自己那次调用**里取出外观意图。
     *
     * ═══ 为什么需要它（以及为什么一开始没这么做）═══
     * 卡片最初只从 `/pending`（最近一次请求的信号）取样式。那让"改样式"这条链路
     * 变得**每一张卡片都跟着变**：学习者调完样式，会看到对话里所有卡片一起改了
     * ——既分不清自己改的是哪一张，也没法把新旧两版放在一起看。
     *
     * 作者要的工作模式是：**新样式应用在新的那张卡片上**，旧卡片保持原样。
     * 于是必须让每张卡片读**它自己**那次工具调用的参数。
     *
     * 一开始回避这条路，是因为 `block` 的确切形状没验证、而猜形状的后果是
     * 静默显示错内容。现在**形状已经核过**（宿主自己的类型声明）：
     *   `RunningToolCall { argsRaw: string, … }`
     *   `ToolResultNode  { call: { name, argsRaw } | null, … }`
     * 两种状态都带 `argsRaw`；`call` 为 null 只发生在**上下文截断把那次调用移出窗口**时。
     *
     * ═══ 返回值的三态语义（这一点很容易写错）═══
     *   `undefined` → 这张卡片**拿不到**自己那次调用（被截断了）→ 调用方退回 `/pending`
     *   `null`      → 这张卡片**明确没有**声明外观 → 用**默认**（不是用最近一次的样式！）
     *   `object`    → 用这一份
     * 把 `null` 也当成"回退"是错的：那会让一张本来没声明样式的旧卡片
     * 跟着最新请求一起变——正是要修掉的那个毛病。
     *
     * @param block - 插槽 props 里的那次调用（运行态或完成态）。
     * @returns 见上（三态）。
     */
    function styleFromBlock(block) {
      let raw = null
      if (typeof block?.argsRaw === 'string') raw = block.argsRaw               // 运行态
      else if (typeof block?.call?.argsRaw === 'string') raw = block.call.argsRaw // 完成态
      else return undefined                                                    // 拿不到

      let args = null
      try {
        args = JSON.parse(raw)
      } catch {
        // 参数不是合法 JSON：把它当作"这次调用没有声明外观"，
        // 而不是"不知道"——因为我们确实读到了原文，只是它不成立。
        return null
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
      const style = args.style
      if (style === undefined || style === null) return null
      return typeof style === 'object' && !Array.isArray(style) ? style : null
    }

    /**
     * 对**来自参数**的外观做最小的形状/范围防护。
     *
     * ═══ 这是不是"两处校验"？不是，边界要划清 ═══
     * 词汇表（哪些 token 存在）仍然只在服务端一处定义：这里**不认识就查不到映射**，
     * 于是自动回落到默认值。所以新加 token 时这里不需要改，也不会画坏。
     *
     * 这里只补一件服务端做不了的事：**参数是"发出前的原文"，没经过服务端夹紧**。
     * 所以数值要挡住荒谬值（`panel_width: 99999` 会把卡片撑爆）。
     * 重复的只有两条上下界，而它们漂移的后果是"夹到另一个也合理的数"——无害。
     *
     * @param style - 从参数里读到的原始对象。
     * @returns 可以交给 resolveStyle 的对象。
     */
    function guardRawStyle(style) {
      if (style === null || typeof style !== 'object' || Array.isArray(style)) return null
      const out = {}
      for (const [k, v] of Object.entries(style)) {
        if (typeof v === 'number') {
          if (!Number.isFinite(v)) continue
          // 只有这两个数值键；越界一律夹紧（不丢弃：意图是清楚的）
          if (k === 'panel_width') out[k] = Math.min(900, Math.max(320, Math.round(v)))
          else if (k === 'preview_questions') out[k] = Math.min(8, Math.max(0, Math.round(v)))
          else out[k] = v
        } else if (typeof v === 'string' || Array.isArray(v)) {
          // 字符串/数组照传：token 由查表决定有没有效果，非法颜色由 parseHex 挡住。
          out[k] = v
        }
        // 其它类型（对象/布尔/null）丢掉：它们不可能是合法取值
      }
      return out
    }

    /**
     * 把"深解这道题"这件事写成一条**发给当前对话**的消息。
     *
     * ═══ 为什么是"发一条消息"而不是直接给答案 ═══
     * 作者要的形态是：点按钮 → **在当前对话里发起一次咨询**，
     * 且消息里带**题号与学习者自己的答案**。
     * 于是这件事的产物是**一段对话**（会进会话日志、可追溯、可追问），
     * 而不是一个弹窗——学习者能接着说"那 B 为什么不行"。
     *
     * ═══ 消息里为什么要写清"三步顺序" ═══
     * 作者的原始要求：*"要求模型首先自己做一次，产生自己的题解，
     * 再检索参考题库里的题解（不一定总是有），帮助用户分析错因"*。
     * 这个顺序**不能靠模型自觉**——先看参考解析再"自己解"是假的独立解，
     * 而且那种顺序下模型会把自己的错误推理对齐到参考解析上（看起来更可信，其实更糟）。
     * 所以顺序写进消息里。
     *
     * ⚠ 有一条**必须让模型知道的诚实边界**：题库里的解析很多是
     * OCR 两栏串行的（读起来会跳），甚至可能有页脚噪声。
     * 不告诉它，它会把串行的文字当权威原文去"解释"，于是编出连贯但错的道理。
     *
     * @param params.bankName - 题库名。
     * @param params.question - 当前题目（含 id / number / stem）。
     * @param params.choice - 学习者选的答案（可能还没作答，那就空着）。
     * @param params.verdict - 判分结果（可能为 null）。
     * @returns 一段可以直接发出去的消息文本。
     */
    function composeDeepDive({ bankName, question, choice, verdict }) {
      const lines = ['请对这道题做一次**深度讲解**（我点了界面上的"AI深解"）。', '']
      lines.push(`题库：${bankName ?? '(未指定)'}`)
      if (question?.number) lines.push(`题号：${question.number}`)
      lines.push(`题目 id：${question?.id ?? '(未知)'}`)
      if (question?.stem) lines.push('', '题干：', String(question.stem).trim())
      if (Array.isArray(question?.options) && question.options.length > 0) {
        lines.push('', '选项：')
        for (const o of question.options) lines.push(`  ${o.label}. ${o.text}`)
      }
      if (typeof choice === 'string' && choice !== '') {
        lines.push('', `我的作答：${choice}`)
      } else {
        lines.push('', '我的作答：（还没作答）')
      }
      if (verdict) {
        if (Array.isArray(verdict.answer) && verdict.answer.length > 0) {
          lines.push(`正确答案：${verdict.answer.join('、')}`)
        }
        if (verdict.correct === true) lines.push('判定：我做对了')
        else if (verdict.correct === false) lines.push('判定：我做错了')
        else lines.push('判定：判不了（没有可用的判据）')
      }
      lines.push(
        '',
        '请按这个顺序来，不要跳步：',
        '1. **先自己独立解一遍**：给出你的题解与结论（选项 + 理由）。**先不要看题库解析。**',
        '2. **再检索题库里这道题的参考解析**（用你能用的工具按题目 id 查；**不一定有**——',
        '   没有就直说没有，不要编）。拿到后也要如实说明它的**来路与质量**：',
        '   这些解析多是 OCR 自动抽取的，**两栏可能串行**（读起来会跳）、可能带页脚噪声，',
        '   不是逐字可信的原文。**不要把串行的句子当成权威依据去解释。**',
        '3. **然后帮我分析错因**：对比你的题解与参考解析，说清我为什么会选错',
        '   （是知识点没掌握、还是被某个选项的措辞骗了、还是题干读漏了关键限定），',
        '   并给出可迁移的判据（下次遇到同类题看什么）。',
        '',
        '如果你在第 1 步与第 2 步之间发现自己错了，**明确说出来**——',
        '那正是我最需要看到的部分。',
      )
      return lines.join('\n')
    }

    /**
     * 把一条消息**发进当前会话**。
     *
     * ═══ 这是全项目里唯一"照着宿主声明写、但没有一线先例"的一段代码 ═══
     * 宿主的 `ISessions.binding(id)` 与 `ISession.prompt(content, mode)`
     * 都是从类型声明里读到的（宿主自己的 `ConversationController.send()`
     * 就是这么干的：`scopedSession("send").prompt([…], "queue")`）——
     * 但那是**会话作用域内**的调用，而本插件是 profile 作用域的客户端插件，
     * 按 `sessionId` 显式寻址这条路**没有先例可抄**。
     *
     * 所以：**能力探测 + 绝不抛错 + 失败必须可见**。
     * 理由是这一天里已经付过的代价——猜接口形状会把界面弄坏，
     * 而"点了没反应"让人无从下手。因此这里把失败**写在面板上**
     * （调用方拿到 Error 后 setError），附上到底哪一环缺失。
     *
     * @param ctx - apply() 拿到的客户端插件上下文。
     * @param sessionId - 目标会话（来自插槽 props）。
     * @param text - 要发的文本。
     * @returns 成功返回 true；失败抛错（由调用方展示）。
     */
    async function sendIntoSession(ctx, sessionId, text) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('拿不到当前会话 id（插槽 props 里没有 sessionId）')
      }
      const sessions = ctx?.sessions
      if (sessions === undefined) {
        throw new Error('拿不到 sessions 服务（它没在 exports.inject 里，或宿主没提供）')
      }
      const binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
      const session = binding?.session
      if (session === undefined || typeof session.prompt !== 'function') {
        throw new Error(
          `拿不到会话的 prompt 接口（binding=${binding === undefined ? '无' : '有'}，` +
            `session=${session === undefined ? '无' : '有'}）`,
        )
      }
      // 'queue' = 追加一个回合（当前有回合在跑就排队）。**不用 'steer'**：
      // steer 会打断正在跑的回合，而"深解一道题"不该把学习者正在说的话打断。
      const result = await session.prompt([{ type: 'text', text }], 'queue')
      if (result && result.ok === false) {
        throw new Error(`发送被拒绝：${result.error?.code ?? '?'} ${result.error?.message ?? ''}`)
      }
      return true
    }

    /**
     * 把"这道题之前做过几次、上次答了什么"说成一句人话。
     *
     * ═══ 为什么这条只在判分之后才显示（不是随手放的位置）═══
     * 作者的要求是"我想让学习者知道这道题做过、上次自己选了什么答案，
     * **但是是在本次作答之后**"。
     * 这与本项目已有的"结构上不可能先看答案再作答"同源，实现方式也一样：
     * **数据根本不在取题那条返回里**（`/bank` 不带 history，只有 `/attempt` 带）。
     * 所以这里只是"把已经拿到的东西显示出来"，不需要任何"记得别说"的纪律。
     *
     * ═══ 为什么它值得显示（不只是好玩）═══
     * "这题我做过、上次错了"是**连续感**：它把一次次孤立的作答连成一条线。
     * 没有它，学习者看到的是"我错了"；有了它才是"**我又**错了"——后者才会促使人回头看。
     *
     * @param history - `/attempt` 返回的 history（null = 第一次做）。
     * @returns 一行文本；第一次做时返回 null（**什么都不显示**）。
     */
    function formatHistory(history) {
      if (history === null || history === undefined) return null
      const n = typeof history.attempts === 'number' ? history.attempts : 0
      if (n <= 0) return null

      const judgment =
        history.last_correct === true ? '答对' : history.last_correct === false ? '答错' : '判不了'
      const when = typeof history.last_at === 'string' && history.last_at !== ''
        ? `（${formatWhen(history.last_at)}）`
        : ''
      const what = typeof history.last_response === 'string' && history.last_response !== ''
        ? `上次你选的是「${history.last_response}」，${judgment}`
        : `上次${judgment}`
      return `📌 这题你之前做过 ${n} 次：${what}${when}`
    }

    /**
     * 把 ISO 时间说成"多久以前"。
     *
     * 为什么不显示完整时间戳：学习者关心的是"是不是最近做的"，
     * 精确到秒反而要他自己算。**近的说"刚刚/几小时前"，远的说日期。**
     *
     * @param iso - ISO 时间字符串。
     * @param now - 当前毫秒时间（便于测试注入，不依赖真实时钟）。
     * @returns 人话；解析不了就退回日期部分。
     */
    function formatWhen(iso, now = Date.now()) {
      const t = Date.parse(iso)
      if (!Number.isFinite(t)) return String(iso).slice(0, 10)
      const diffMin = Math.floor((now - t) / 60000)
      if (diffMin < 1) return '刚刚'
      if (diffMin < 60) return `${diffMin} 分钟前`
      const diffH = Math.floor(diffMin / 60)
      if (diffH < 24) return `${diffH} 小时前`
      const diffD = Math.floor(diffH / 24)
      if (diffD === 1) return '昨天'
      if (diffD < 30) return `${diffD} 天前`
      return String(iso).slice(0, 10)
    }

    /**
     * 把"这次刷哪些题"说成一句人话（**卡片上的那一行**）。
     *
     * ═══ 为什么这一段是这次改动的重点 ═══
     * 作者的反馈是"我说'给我 10 题'或'我想重刷做过的题目'，弹出的卡片依然是
     * **49 题的全题库**"。两半原因：① `start_practice` 当时**没有表达选择的词汇**；
     * ② 卡片上**只写题库名**，那句"题库：考公刷题-…"读起来就像"整个题库"。
     * 所以即使选择传进来了，**不写出来学习者照样以为没生效**。
     *
     * ⚠ 这份映射要与服务端的 `ORDER_HINTS`（practice.js）保持一致。
     * 客户端**不做校验**（不认识就不加标签），所以漂移的后果只是"少一句标签"，
     * 不会画出坏东西——这是刻意留的失效方向。
     *
     * @param selection - `/pending` 或卡片自己那次调用里带的选择（可为 null）。
     * @param count - 几道（可为 null）。
     * @returns 一行文本，如"只出做过的 · 10 道"；没有可说的时候返回 null。
     */
    function describeSelectionLine(selection, count) {
      const s = selection !== null && typeof selection === 'object' ? selection : {}
      const parts = []

      const ids = Array.isArray(s.ids) ? s.ids : null
      if (ids !== null && ids.length > 0) {
        parts.push(`指定的 ${ids.length} 道`)
      } else {
        const ORDER_LABELS = {
          sequential: '按顺序',
          random: '随机抽',
          unseen: '只出没做过的',
          attempted: '只出做过的',
          missed: '只出错题',
        }
        // `order` 缺席时**什么都不说**（而不是说"按顺序"）：
        // 面板此时按自己的默认走（unseen），写"按顺序"反而与事实不符。
        if (typeof s.order === 'string' && ORDER_LABELS[s.order] !== undefined) {
          parts.push(ORDER_LABELS[s.order])
        }
      }
      if (typeof s.topic === 'string' && s.topic !== '') parts.push(`知识点「${s.topic}」`)
      if (typeof count === 'number' && count > 0) parts.push(`${count} 道`)
      return parts.length === 0 ? null : parts.join(' · ')
    }

    /**
     * 从**这张卡片自己那次调用**里取出选择（与 `styleFromBlock` 同一套三态语义）。
     *
     * @param block - 插槽 props 里的那次调用。
     * @returns `undefined`=拿不到自己那次调用；`null`=明确没有选择；object=有。
     */
    function selectionFromBlock(block) {
      let raw = null
      if (typeof block?.argsRaw === 'string') raw = block.argsRaw
      else if (typeof block?.call?.argsRaw === 'string') raw = block.call.argsRaw
      else return undefined

      let args = null
      try {
        args = JSON.parse(raw)
      } catch {
        return null
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
      const picked = {}
      for (const key of ['order', 'topic', 'ids']) {
        if (args[key] !== undefined && args[key] !== null) picked[key] = args[key]
      }
      return Object.keys(picked).length > 0 ? picked : null
    }

    /**
     * 对**来自参数**的选择做最小防护（与 `guardRawStyle` 同一理由：
     * 参数是"发出前的原文"，没经过服务端夹紧）。
     *
     * ═══ 它**不**校验档位名 ═══
     * 档位名只在服务端一处定义（`ORDER_KINDS`）。这里不认识就不加标签，
     * 于是加新档位时客户端不必跟着改，也不会画坏。
     *
     * @param selection - 从参数里读到的原始对象。
     * @returns 可交给 describeSelectionLine 的对象。
     */
    function guardRawSelection(selection) {
      if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) return null
      const out = {}
      if (typeof selection.order === 'string') out.order = selection.order
      if (typeof selection.topic === 'string' && selection.topic !== '') out.topic = selection.topic
      if (Array.isArray(selection.ids)) {
        const ids = selection.ids.filter((x) => typeof x === 'string' && x !== '').slice(0, 200)
        if (ids.length > 0) out.ids = ids
      }
      return Object.keys(out).length > 0 ? out : null
    }

    /**
     * 对话里的刷题卡片 —— **本插件的入口**。
     *
     * 注册在 `tool.call.toolview`、`key: 'start_practice'`：agent 每次调用那个工具，
     * 宿主都会用这个组件渲染那一次调用。于是"要不要刷题"这件事出现在**对话流里**，
     * 而不是界面某个角落的常驻按钮上。
     *
     * ═══ 为什么卡片自己不去解析 props.block ═══
     * 组件能拿到 `block`（这次工具调用的运行/结果节点），理论上能从里面读出
     * "题库名、几道题、外观"。但那两种节点的**确切形状未验证**，而猜形状的后果是
     * **静默显示错内容**（比报错更糟）。所以数据一律问 `/pending`
     * （那条路由本来就在，且已被测试覆盖）——来源确定，形状也确定，
     * 而且**外观在那里已经校验过**（服务端唯一一处校验）。
     *
     * 代价：一屏里有多张卡片时，它们显示的是**最近一次请求**的外观。
     * 这是被接受的粗糙处——面板本来也只会用最近一次请求的样子。
     *
     * @param props - 宿主给的插槽 props（含 callId / toolName / block 等，本组件不强依赖）。
     * @returns React 元素。
     */
    function StartPracticeCard(props) {
      const [busy, setBusy] = React.useState(false)
      const [preview, setPreview] = React.useState(null)
      const pending = usePendingRequest()

      // ── 这张卡片自己的外观 ──
      //
      // 优先读**它自己那次调用**的参数：这样"学习者说改样式 → agent 再调一次
      // → 对话里多一张新卡片"，而**旧卡片保持原样**（作者要的工作模式）。
      // 只有在拿不到自己那次调用时（上下文截断把调用移出窗口）才退回最近一次信号
      // ——那时"显示一个大概对的样子"比"什么都不显示"好。
      const ownStyle = styleFromBlock(props?.block)
      const effectiveStyle = ownStyle === undefined
        ? pending?.style          // 拿不到自己那份 → 退回最近一次请求
        : guardRawStyle(ownStyle) // 自己那份（可能是 null = 明确用默认）
      const st = resolveStyle(effectiveStyle, 'card')

      // 卡片自己的题库/题数：同样优先用自己那次调用，退路才是 /pending。
      // 注意这里**不解析 args 的语义**（那是服务端的事）——只用来显示文案。
      const ownBank = (() => {
        const raw = typeof props?.block?.argsRaw === 'string'
          ? props.block.argsRaw
          : (typeof props?.block?.call?.argsRaw === 'string' ? props.block.call.argsRaw : null)
        if (raw === null) return undefined
        try {
          const a = JSON.parse(raw)
          return { bank: a?.bank_name ?? null, count: a?.count ?? null }
        } catch {
          return undefined
        }
      })()
      const bank = (ownBank === undefined ? pending?.bank : ownBank.bank) ?? null
      const count = (ownBank === undefined ? pending?.count : ownBank.count) ?? null

      // ── 这张卡片代表"刷哪些题" ──
      //
      // 与外观同一套三态语义（见 selectionFromBlock）：
      // 拿不到自己那次调用才退回 `/pending`；明确没有选择就用 null。
      const ownSelection = selectionFromBlock(props?.block)
      const effectiveSelection = ownSelection === undefined
        ? (pending?.selection ?? null)
        : guardRawSelection(ownSelection)
      /** 卡片上那一行"只出错题 · 10 道"——**没有选择时是 null（什么都不显示）**。 */
      const selectionLine = describeSelectionLine(effectiveSelection, count)

      const start = React.useCallback(async () => {
        setBusy(true)
        try {
          // 题库/题数/样式/选择都用**这张卡片自己的**（若有）——
          // 否则点旧卡片会打开"另一次请求"的选择与样子，与它自己对不上。
          const sig = ownStyle === undefined ? await callApi('/pending').catch(() => null) : null
          // 走 `openPanelWith`（而不是直接 requestOpen）：
          // 它保证"显式请求一定展开"——见 openPanelWith 的注释。
          openPanelWith({
            bank: bank ?? sig?.bank,
            count: count ?? sig?.count,
            style: effectiveStyle ?? sig?.style,
            // ★ 选择必须一起传下去：面板要按**卡片上写的这份选择**取题，
            // 否则卡片写着"只出错题"、面板却给全库的题（这正是本次要修的）。
            selection: effectiveSelection ?? sig?.selection,
          })
        } finally {
          setBusy(false)
        }
      }, [bank, count, effectiveStyle, ownStyle, effectiveSelection])

      // ── 题面预览（"一卡多少题"落在卡片上的那一半）──
      //
      // 只在 `preview_questions > 0` 时才去取，且**取不到就什么都不显示**：
      // 预览是锦上添花，它失败不该让卡片不可用（卡片的本职是"可点"）。
      //
      // ⚠ 预览必须用**与面板同一份选择**：否则卡片上写着"只出错题"、
      // 预览的却是全库前几道——那正是这次要修的"卡片与题库耦合"的另一个出口。
      const previewCount = st.preview

      // ⚠⚠ 依赖项必须是**稳定的字符串**，不能直接放 `effectiveSelection`。
      // 那个对象每次渲染都是新的（`guardRawSelection` 会新建一个），
      // 放进依赖数组会让 effect 每次渲染都重跑 → **无限取题**。
      // 用 JSON 串做"内容相同即相同"的判据。这个坑在 React 里很常见，
      // 而它的表现是"面板/卡片疯狂发请求"，非常显眼但也非常费解。
      const selectionKey = JSON.stringify(effectiveSelection ?? null)

      React.useEffect(() => {
        if (!previewCount || previewCount <= 0) {
          setPreview(null)
          return
        }
        let alive = true
        const q = new URLSearchParams({ count: String(previewCount) })
        if (bank) q.set('bank', bank)
        // 把选择也带上（与面板同一个筛选）。非法值由服务端忽略，这里不校验。
        const sel = effectiveSelection ?? {}
        if (Array.isArray(sel.ids) && sel.ids.length > 0) {
          q.set('ids', sel.ids.slice(0, 200).join(','))
        } else {
          if (typeof sel.order === 'string') q.set('order', sel.order)
          if (typeof sel.topic === 'string' && sel.topic !== '') q.set('topic', sel.topic)
        }
        callApi(`/bank?${q.toString()}`)
          .then((view) => { if (alive) setPreview((view.questions ?? []).slice(0, previewCount)) })
          .catch(() => { if (alive) setPreview(null) })
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [previewCount, bank, selectionKey])

      const show = st.show

      // 副标题按 `show` 组装：**不给 show 时与以前完全一样**（向后兼容）。
      const bits = []
      if (show.includes('bank')) bits.push(bank ? `题库：${bank}` : '题库：由面板选')
      // 有"这次刷哪些题"那一行时，就不再单独重复"几道"（那行里已经写了）
      if (show.includes('count') && count && selectionLine === null) bits.push(`${count} 题`)
      if (show.includes('hint')) bits.push('点击开始作答')

      const stack = st.layout !== 'row'

      const body = h(
        'div',
        { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 600, fontSize: st.scale.font } }, `▶ 刷题`),
        // ── "这次刷哪些题"（本次改动的重点）──
        //
        // 放在题库那行**上面**：它是学习者最在意的一句
        // （"我说了只练错题，卡片上写的是什么"）。
        // 没有选择时**什么都不显示**——不给一句废话（"按顺序"）误导人。
        selectionLine !== null
          ? h('div', {
              style: {
                marginTop: '2px',
                fontSize: st.scale.font,
                fontWeight: 600,
                borderLeft: `2px solid ${st.accent}`,
                paddingLeft: '8px',
              },
            }, selectionLine)
          : null,
        bits.length > 0
          ? h('div', { style: { opacity: 0.75, fontSize: st.scale.font } }, bits.join(' · '))
          : null,
        // 预览题面：只显示题干预览，**不含答案**（题面本来就不含答案，见服务端设计）。
        preview && preview.length > 0
          ? h('div', { style: { marginTop: st.scale.gap, opacity: 0.85, fontSize: st.scale.font } },
              preview.map((q, i) =>
                h('div', {
                  key: q.id ?? i,
                  style: {
                    whiteSpace: 'pre-wrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  },
                }, `${i + 1}. ${String(q.stem ?? '').slice(0, 120)}`),
              ),
            )
          : null,
      )

      return h(
        'div',
        {
          // 卡片要接收点击，所以**必须自己声明 pointer-events**：
          // 对话流是正常文档流，这里不是浮层，写上是防止将来被套进点击穿透的容器。
          style: {
            display: 'flex',
            flexDirection: stack ? 'column' : 'row',
            alignItems: stack ? 'stretch' : 'center',
            gap: st.scale.gap,
            margin: '8px 0',
            padding: st.scale.pad,
            borderRadius: st.radius,
            background: st.bg,
            color: st.fg,
            lineHeight: st.scale.line,
            pointerEvents: 'auto',
            ...st.border,
            // 左边条只在 `accent-left` 时加：它是这个卡片的识别特征。
            borderLeft: st.accentLeft ? `3px solid ${st.accent}` : st.border.borderLeft,
          },
        },
        body,
        h(Button, { variant: 'primary', disabled: busy, onClick: start }, busy ? '打开中…' : '开始'),
      )
    }

    /**
     * 兜底入口 —— **只在卡片没生效时才出现**。
     *
     * ═══ 为什么需要它 ═══
     * 宿主的文档明说 `tool.call.toolview` 的键写错时"**只是不渲染**"（不报错）。
     * 而它现在是本插件唯一的入口：卡片不出现 = 学习者**没有任何办法打开面板**。
     * 一个静默失效的入口，比一个报错的入口危险得多。
     *
     * 所以：只有在"**agent 请过刷题** 且 **面板关着** 且 **卡片没注册成功**"
     * 三个条件同时成立时才出现一个小按钮。正常情况（卡片能用）它永不出现，
     * 所以不违背"界面上不要常驻入口"那条反馈。
     *
     * @returns React 元素或 null。
     */
    function FallbackEntry() {
      const open = usePanelOpen()
      const pending = usePendingRequest()
      // ⚠ 判据是 `!== 'registered'`（不是 `=== 'failed'`）：见 cardState 的注释——
      // "推迟中"同样需要兜底入口，否则那段窗口里学习者没有入口。
      if (open || cardState === 'registered' || pending === null) return null
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            right: '24px',
            bottom: '24px',
            zIndex: 2147000000,
            pointerEvents: 'auto',
          },
        },
        h(Button, {
          variant: 'primary',
          onClick: () => openPanelWith({ bank: pending.bank, count: pending.count }),
        }, '开始刷题（卡片未生效，点这里）'),
      )
    }

    /**
     * 插件体。
     *
     * @param ctx - 客户端插件上下文。
     */
    // ⚠ `ctx` 要存到模块级：`apply()` 的作用域**不是会话作用域**，
    // 而"发消息"这个动作需要按 sessionId 显式寻址（见 sendIntoSession 的注释）。
    // 组件里拿不到原始 ctx（插槽只给 hooks 与 props），所以只能在这里存下来。
    let ctxRef = null

    exports.apply = (ctx) => {
      ctxRef = ctx
      // ⚠ 这里访问的每个 ctx 服务都必须在下面的 exports.inject 里声明，
      // 否则 cordis 门禁抛 `cannot get property "<名>" without inject`。
      // ⚠ list 型插槽必须给 `options.id`（宿主 SlotRegistry 校验，缺了抛
      //   `list slot "<名>" requires options.id`）；id 在该插槽内唯一即可。
      //   对照宿主自己的注册写法：如 dsh-client-ui-commands 的
      //   `{ name: "conversation.input.overlay", id: "command-popup", order: 1 }`。
      //
      // ═══ 现在注册两个插槽，各管一件事 ═══
      // 1. `shell.overlay`：刷题**面板本体**（浮在整个应用之上的作答界面）。
      // 2. `tool.call.toolview`：对话里的**卡片**，也就是入口。
      //
      // 注意：这里**不再有** `sidebar.footer.action` 那个常驻按钮——
      // 作者否掉了它（*"一个出现在 dsh 界面内的刷题按钮很突兀"*），
      // 那一版连同 `PracticeEntry` 组件一起删掉了。
      // **留着被否掉的设计，比没有它更糟**：它会让"按钮"看起来仍然是个选项。
      //
      // ═══ 为什么 shell.overlay 必须走 `slots.inject` 而不是直接 register ═══
      // `shell.overlay` 是宿主 ui-layout 的 root 条目**在它 apply 时**才声明的子插槽，
      // 而浏览器 boot 是 `Promise.all` **并发**拉起所有插件的：本插件的依赖
      // （slots + sessions，都来自 runtime 核心）第一批就满足，ui-layout 却还要
      // 等 ui-theme 先提供 theme —— 于是本插件可能**先** apply。
      // 那一刻直接 register 会被 SlotCore 抛
      // `slot "shell.overlay" is not declared (a parent entry's children table must declare it)`，
      // 插件 fiber 失败 → 启动屏报 "Failed to load plugins" → **整个界面起不来**
      // （2026-09-19 生产事故，实测）。
      // `slots.inject` 是宿主给这条路开的正口（dsh-client-runtime 的类型声明原文：
      // 声明已存在就同步执行，否则推迟到声明提交的那一刻再执行），
      // 注册时机交给宿主决定，本插件对启动顺序免疫。
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ id: 'lh-practice-panel', name: 'shell.overlay' }, PracticePanel),
      )

      // ── 卡片：入口 ──
      //
      // ═══ 为什么它也**必须**走 `slots.inject`（这是上一版修复漏掉的一半）═══
      // `tool.call.toolview` 由宿主 **ui-tool** 在它 apply 时才声明 ——
      // 和 `shell.overlay` 完全同一个形状：**不是内核内置插槽**。
      // 于是同一个启动竞态对它一样成立。
      //
      // 上一次之所以没暴露，只是因为报错发生在**第一个**注册（shell.overlay）
      // 就中断了 apply，**根本没走到这一行**。把 shell.overlay 改好之后，
      // 执行就会继续走到这里 —— 若这里仍直接 register，就会换一个插槽名再失败一次。
      //
      // 而这一次的后果形态与上次**不同**（值得记住）：
      // 下面有 try/catch 兜着，所以**不会白屏**，而是**静默地少掉入口**
      // —— 对话里不再出现刷题卡片，只有 console.warn。
      // **"少一个功能"比"起不来"更难发现**，所以它更该被结构性地消灭，
      // 而不是靠"这次运气好"。
      //
      // 还有第三个插槽相关的位置要一起看：兜底入口挂在 shell.overlay（见下），
      // 已经改好了。**凡是注册到"别的包声明的插槽"，一律走 inject。**
      //
      // ═══ 为什么保留 try/catch + 依次试形状 ═══
      // 插槽**声明**到达之后，剩下的失败只可能是**注册选项形状**写错
      // （keyed 型要不要 `id`？`atomic` 与 `keyed` 是不是同一个注册入口？
      //  这两点我只从类型声明读到、没有见过任何真实样例）。
      // 那种错该被大声报出来并走兜底入口，而不是让界面起不来。
      //
      // `key` 必须与工具名**逐字**一致（`start_practice`，见
      // plugins/lh-question-bank/index.js 的 tools.register）。写错不会报错，
      // 只是永远不渲染——这正是兜底入口存在的理由。
      const cardShapes = [
        { name: 'tool.call.toolview', key: 'start_practice', id: 'lh-practice-start-card' },
        { name: 'tool.call.toolview', key: 'start_practice' },
        { name: 'tool.call.toolview', id: 'start_practice' },
      ]
      ctx.slots.inject('tool.call.toolview', () => {
        for (const shape of cardShapes) {
          try {
            ctx.slots.register(shape, StartPracticeCard)
            cardState = 'registered'
            console.log(`[lh-practice] 卡片已注册：${JSON.stringify(shape)}`)
            return
          } catch (error) {
            console.warn(`[lh-practice] 卡片注册形状被拒：${JSON.stringify(shape)} — ${error?.message ?? error}`)
          }
        }
        // 三条形状都被拒：**这是真的失败**，不是"还没轮到"。
        cardState = 'failed'
        console.error(
          '[lh-practice] ⚠ 对话里的刷题卡片**注册失败**（插槽已声明，但三条注册形状都被拒）。\n' +
            '  面板本身仍可用：只要 agent 请过刷题，右下角会出现一个兜底按钮。\n' +
            '  （刻意不抛错：那会让整个界面起不来，代价远大于少一张卡片。）',
        )
      })

      // 兜底入口：与面板并列注册，但它在卡片能用时**渲染 null**。
      // 同上面板：shell.overlay 的注册必须挂在 slots.inject 里（声明到达才执行）。
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ id: 'lh-practice-fallback', name: 'shell.overlay' }, FallbackEntry),
      )
    }

    exports.name = 'lh-practice'
    // 本模块用到的宿主服务（inject 门禁按这个装配 fiber；见文件头约束 2）。
    //
    // `sessions` 是「AI深解」需要的：发一条消息进当前对话要按 sessionId 寻址
    // （见 sendIntoSession）。**刻意不声明 `conversation`** —— 那个服务也能发消息
    // （`ctx.conversation.send`），但它是"按当前作用域找会话"，而本插件的 apply
    // 不在会话作用域里；更要紧的是：inject 里声明一个**没出现**的服务会让
    // apply 永远不执行（插件静默不工作），风险比少一条路大得多。
    exports.inject = ['slots', 'sessions']

    // ── 测试钩子（宿主不读它，只有离线测试读）──
    //
    // ═══ 为什么值得在客户端半开这个口子 ═══
    // `readableOn` 是"允许 agent 自由指定颜色"能成立的**前提**：
    // 它错了就会出现"浅底白字"，而那种错误**在浏览器里只能靠眼睛发现**——
    // 模型看不到、测试也看不到，而学习者只会觉得"卡片坏了"。
    //
    // 这些是纯函数（输入→输出，不碰 DOM），天生可以离线验。
    // 唯一的障碍是它们在这个 factory 闭包里、浏览器又不能 import 本地模块，
    // 所以只能开一个具名出口把它们交出来。
    // 这是**刻意开的口子**，不是顺手暴露内部：
    // 没有它，"自由度不以可读性为代价"这句话就只是一句没有验证过的声明。
    exports.__test = {
      readableOn,
      parseHex,
      resolveStyle,
      // 每张卡片读自己样式的那条链（三态语义最容易写错，必须可离线验）
      styleFromBlock,
      guardRawStyle,
      // 拖动与缩放的夹紧逻辑（"面板跑到看不见的地方"是这类功能最典型的静默失效）
      clampPanelPos,
      clampPanelSize,
      // 组件本体 + 状态开关：用来验 **hook 顺序**（见 selftest-client.mjs 第 8 节）。
      // 为什么需要：hook 写在提前 return 之后，会让"打开面板"当场抛错，
      // 而这是**运行时才暴露**的一类错——静态看每行都对。
      PracticePanel,
      StartPracticeCard,
      FallbackEntry,
      setPanelOpen,
      setPendingRequest,
      // 「AI深解」：消息组装（纯函数）与发送路径（要能在假 ctx 上验失败时的行为）
      composeDeepDive,
      sendIntoSession,
      // 会话 id 的解析（面板在 root 作用域，props 里没有 sessionId —— 这是第一次跑就失败的根因）
      resolveSessionId,
      currentSessionId,
      // 收起态（胶囊）
      setCollapsed,
      // 读状态（测试要断言"收起态有没有被清掉"，只有 setter 就验不了）
      isCollapsed: () => collapsed,
      isPanelOpen: () => panelOpen,
      // 显式打开的必经之路（收起态不得否决它 —— 这是"点了卡片只出胶囊"那个 bug 的修法）
      openPanelWith,
      // 作答历史（判分之后才显示的那条）
      formatHistory,
      formatWhen,
      // 卡片承载"选择"（本次改动）
      describeSelectionLine,
      selectionFromBlock,
      guardRawSelection,
      ACCENT_VARS,
      BG_VARS,
      SCALES,
      RADII,
      BORDERS,
    }

    return exports
  },
})
