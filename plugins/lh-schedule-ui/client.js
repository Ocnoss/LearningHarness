/**
 * lh-schedule-ui 的【客户端半】—— 学习日历（把"我排了什么"和"我做了什么"放在一张表上）。
 *
 * ═══ 它做什么 ═══
 *   · `main` 槽（keyed）注册 key `lh-calendar` → 中央面板（与 conversation 平级）；
 *   · `sidebar.panellist`（list）注册**同名 id** → 侧栏图标。
 * 两者一一对应：宿主侧栏的 `PanelRow` 处理体就是 `selectPanel(id)`，而 `selectPanel`
 * 只校验"main 注册表里有没有这个 key"（宿主源码 `433242`），**没有 id 白名单**。
 * 所以两半必须**同时**注册——只注册侧栏图标而 main 缺失，点击会抛
 * `layout.selectPanel: main panel "lh-calendar" is not registered` 且不改选中态。
 *
 * ═══ 一张表上三件事 ═══
 * 面板本体是**月历网格 + 当日详情**，每一天都可能挂着三类东西（都由服务端一次算好）：
 *   · 🗓 日程（计划）—— 可在此新建/改期/标记完成/撤销；
 *   · 💬 对话（事实）—— 这天有学习活动痕迹的对话（来自 `lh/trace/observed`），
 *     可以**一键绑到选中的那条日程**（"这次对话就是在做这条计划"）；
 *   · 📚 课程动作 —— 这天建了课/改了名/绑了会话（来自 `lh/course/*`）。
 *
 * ═══ 写走服务端路由，不是我拼事件 ═══
 * 浏览器**没有**事件日志的写权限，也不该有。每个动作都打一条本插件服务端半的 POST 路由，
 * 那条路由调 `@lh/schedule/commands`——与 agent 工具**同一份代码**。
 *
 * ═══ 会话从哪来：宿主给的 `useSessions`（main 槽 standardProps）═══
 * 服务端**不知道有哪些会话**（会话注册表在宿主/浏览器那一侧），它只报
 * "哪天哪段对话有过活动"（带 session_id）。面板拿这份 id 去 `useSessions` 里查标题。
 * 查不到就显示短 id——**如实显示一个未知的 id，比猜一个标题好**。
 *
 * ═══ 色彩与动效的纪律（我看不见界面，所以这两条是硬的）═══
 * 1. **颜色一律来自主题令牌**（`--dsw-alias-*`），带兜底色。自己调 hsl 会在另一种
 *    配色模式里做出低对比度，而我**看不到结果**。
 * 2. **动效只能是内联样式能表达的**：宿主明说"不要在组件外写 DOM / 不要 append 到 body"，
 *    所以不注入 `<style>`、也就没有 @keyframes。只用 `transition`。
 * 3. **不用 JSX**：本文件是手工 bundle，没有转译步骤，JSX 会直接语法错误。
 */

window.__ModuleLoader__.load({
  id: '@lh/schedule-ui',
  factory: (require) => {
    /** @type {any} */
    var module = { exports: {} }
    /** @type {any} */
    var exports = module.exports

    const React = require('react')

    /** 本插件服务端半的路由前缀。 */
    const API = '/lh/schedule'

    /** 面板与侧栏图标共用的 id（两半必须同名，见文件头）。 */
    const PANEL_ID = 'lh-calendar'

    // ⚠ 待办区**不是第二个面板**，它是这个面板的第三种读法（月 / 周 / 待办）——
    //   2026-10-10 按作者要求"将待办区集成到学习日历里"改的。
    //   为什么这样更好：同一份数据只该有一个入口。原先它是 `main key = 'lh-todo'`
    //   加第二个侧栏图标，于是"我排了什么"与"接下来做什么"被拆进了两个入口，
    //   而它们本来就是同一个问题的两面（一块网格看结构、一条列表看顺序）。

    /** 界面偏好（纯显示状态，不是事实）。 */
    const LS_VIEW = 'lh.schedule.view'
    const LS_DAY = 'lh.schedule.selectedDay'
    /** 验收期区是收起还是展开——**记住**，因为这是个人的阅读习惯，不是每次都要重选的开关。 */
    const LS_MILESTONES_OPEN = 'lh.schedule.milestonesOpen'
    /** 是否显示已撤销的日程（默认不显示；开关在宿主的设置里）。 */
    const LS_SHOW_CANCELLED = 'lh.schedule.showCancelled'

    /** 主题令牌（14 个语义色，Inspect 实测；全部 requiresLightAndDark，所以都带兜底）。 */
    const TOKEN = {
      brand: 'var(--dsw-alias-brand-primary, #3b82f6)',
      success: 'var(--dsw-alias-state-success-primary, #16a34a)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      idle: 'var(--dsw-alias-state-idle-primary, #9ca3af)',
      error: 'var(--dsw-alias-state-error-primary, #dc2626)',
    }

    /**
     * **验收期**的 kind 集合（与服务端 `MILESTONE_KINDS` 同口径）。
     *
     * 界面不再区分"是哪一种验收期"（作者 2026-10-10：不需要区分具体是什么的验收期），
     * 所以它只有一个用途：判断一条日程**是不是**验收期（表单里那个复选框的初值）。
     * 顺手统一了写入口：表单勾上「验收期」就写 `exam`（最中性的那个词），
     * 于是新的数据里不会再出现四种验收期的分叉——而历史事件里的 mock/final/deadline
     * 照旧被认出来（这个集合是并集，不是替换）。
     */
    const MILESTONE_KINDS = ['exam', 'mock', 'final', 'deadline']
    /** 表单勾上「验收期」时写进 `kind` 的那个值。 */
    const ACCEPTANCE_KIND = 'exam'

    /** 状态 → 标记与颜色（**唯一**留在界面上的分类信息，它说的是"这条现在怎么样"）。 */
    const STATUS = {
      planned: { mark: '·', color: TOKEN.idle },
      done: { mark: '✓', color: TOKEN.success },
      cancelled: { mark: '✗', color: TOKEN.error },
      skipped: { mark: '↷', color: TOKEN.warn },
    }

    /** 星期表头（周一起，与 `weekBounds` 的口径一致）。 */
    const WEEK_HEADS = ['一', '二', '三', '四', '五', '六', '日']

    /** 动效时长（毫秒）。 */
    const MOTION = { fast: 110, base: 160 }

    /**
     * 每一格的固定高度。
     *
     * ═══ 为什么必须是**固定**高度而不是 minHeight（作者 2026-10-09 反馈）═══
     * 反馈是"单元格内容太多时会挤压其他单元格，导致总体表格不可读"。根因有两条，都要修：
     *   ① **横向**：`repeat(7, 1fr)` 的 `1fr` 隐含下限是 `auto`（min-content）——
     *      某一格里有不能断行的长内容时，那一列会**撑破自己的份额**，把别的列挤窄。
     *      修法是 `minmax(0, 1fr)` + `overflow: hidden`，列宽从此只由容器决定（见 `S.grid`）。
     *   ② **纵向**：`minHeight` 会让"内容多的格子"变高，整行跟着变高——同一天里
     *      别的格子被拉出大片空白，格与格的对齐也乱了。固定高度 + `overflow: hidden`
     *      让每一格**永远一样大**；超出的内容由底部那行"还有 N 条…"交代
     *      （信息不丢，只是收起——这正是"省略"该有的形状）。
     * 于是无论标题多长、一天有几条，表格始终是表格。
     */
    const CELL_H = '100px'

    // ══════════════════════════════════════════════════════════════════════
    // 模块级状态（ctx 与"main 是否注册成功"要跨组件读）
    // ══════════════════════════════════════════════════════════════════════

    /** ctx 存到模块级：apply 的作用域不是会话作用域，组件里只能从这里拿服务。 */
    let ctxRef = null

    /**
     * "切到某个面板"的可选能力。
     *
     * ⚠ 不能写 `ctx.layout`：没在 `exports.inject` 里声明就访问服务会抛
     *   `cannot get property "layout" without inject`（本项目实测过的原话）。
     * 而把它写进 inject 又会让"这一层没有 layout"变成**整块界面起不来**
     * （浏览器卡在 Failed to load plugins）。所以走 `ctx.get()` 可选访问：
     * 拿不到就退回浮层入口，并说明原因。
     */
    let layout = null

    /**
     * `main` 面板是否真的注册成功。
     * 只有它成功了，`selectPanel(PANEL_ID)` 才不会抛错——所以点击处理器要先看它。
     */
    /**
     * 已注册成功的 `main` 面板 id 集合。
     *
     * ⚠ `selectPanel` 只校验"main 注册表里有没有这个 key"，**没有 id 白名单**
     *   （宿主源码 `433242`）；main 缺失时它会抛错且**不改选中态**。
     *   所以点击处理器必须先查这里，而不是假设注册成功了。
     */
    const registeredPanels = new Set()

    /** 兜底浮层是否打开（只在 main 没注册成功时用得上）。 */
    let overlayOpen = false

    /**
     * 「显示已撤销的日程」——**默认关**（作者 2026-10-10：撤销的默认不可见）。
     *
     * 它放成**模块级**变量（而不是组件里的 state），因为改它的地方在**设置**里
     * （宿主的 `settings.general.item` 席位），而读它的地方是日历面板：
     * 两处是两个组件，中间靠下面的发布订阅打通（面板订阅、设置行写值 + publish）。
     * 值本身存在 localStorage（纯界面偏好，不是事实——所以不进事件日志）。
     */
    let showCancelled = readLocal(LS_SHOW_CANCELLED, '0') === '1'

    /**
     * 改「显示已撤销」并通知所有订阅者。
     * @param value - 新的值。
     */
    function setShowCancelled(value) {
      showCancelled = value === true
      writeLocal(LS_SHOW_CANCELLED, showCancelled ? '1' : '0')
      publish()
    }

    /** 极简发布订阅：面板状态在组件里，但"浮层开不开"要跨组件读。 */
    const listeners = new Set()
    function subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
    function publish() {
      for (const fn of [...listeners]) {
        try {
          fn()
        } catch {
          /* 一个订阅者坏了不该拖垮别人 */
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 小工具
    // ══════════════════════════════════════════════════════════════════════

    /** 读浏览器本地的一个字符串偏好。 */
    function readLocal(key, fallback) {
      try {
        const value = window.localStorage.getItem(key)
        return value === null || value === '' ? fallback : value
      } catch {
        return fallback
      }
    }

    /** 写浏览器本地偏好（写不进去不算错：它只是偏好）。 */
    function writeLocal(key, value) {
      try {
        window.localStorage.setItem(key, String(value))
      } catch {
        /* 忽略 */
      }
    }

    /** 浏览器时区名（服务端按它把时间戳折算成"哪一天"）。 */
    function tzName() {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      } catch {
        return 'UTC'
      }
    }

    /** 浏览器本地的今天（`YYYY-MM-DD`）。 */
    function todayLocal() {
      const d = new Date()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${d.getFullYear()}-${m}-${day}`
    }

    /** 某天的月份（`YYYY-MM`）。 */
    function monthOf(day) {
      return String(day).slice(0, 7)
    }

    /** 月份加减。 */
    function shiftMonth(month, delta) {
      const [y, m] = String(month).split('-').map((n) => Number(n))
      if (!Number.isFinite(y) || !Number.isFinite(m)) return month
      const total = y * 12 + (m - 1) + delta
      return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
    }

    /** `YYYY-MM-DD` → `M月D日`。 */
    function prettyDay(day) {
      const parts = String(day).split('-')
      if (parts.length !== 3) return String(day)
      return `${Number(parts[1])}月${Number(parts[2])}日`
    }

    /** 会话短 id（完整 id 太长，而前缀都一样）。 */
    function shortId(id) {
      return typeof id === 'string' && id.length > 6 ? id.slice(-6) : String(id)
    }

    /** 从 `useSessions` 的快照里取 `{ byId }`（形状认不出就返回空表，**不猜**）。 */
    function sessionsById(snapshot) {
      const s = snapshot?.byId !== undefined ? snapshot : snapshot?.value
      const byId = s?.byId
      return byId !== null && typeof byId === 'object' ? byId : Object.create(null)
    }

    /** 会话标题（拿不到标题就显示 id——如实，不假装）。 */
    function sessionTitle(row, id) {
      const title = row?.title
      return typeof title === 'string' && title.trim() !== '' ? title : id
    }

    /**
     * 发一个请求，把**非 2xx 也当成有内容的回答**（服务端的 400/503 都带 error/fix 字段，
     * 直接丢弃它们等于把最有用的一句话扔掉）。
     *
     * @param path - 相对 API 的路径。
     * @param init - fetch 参数。
     * @returns 解析后的 JSON。
     * @throws 带服务端那句话的错误。
     */
    async function request(path, init) {
      const res = await fetch(`${API}${path}`, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let body = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      if (!res.ok) {
        const detail = body?.error ?? `HTTP ${res.status}`
        const tip = Array.isArray(body?.fix) ? `\n修法：${body.fix.join('；')}` : ''
        throw new Error(`${detail}${tip}`)
      }
      return body
    }

    // ══════════════════════════════════════════════════════════════════════
    // 样式
    // ══════════════════════════════════════════════════════════════════════

    const S = {
      panel: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-alias-bg-base, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
      },
      title: { fontSize: '15px', fontWeight: 600 },
      body: { flex: '1 1 auto', display: 'flex', minHeight: 0 },
      left: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' },
      right: {
        width: '340px',
        flex: '0 0 340px',
        borderLeft: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        overflow: 'auto',
        padding: '10px 12px',
      },
      muted: { color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '12px' },
      notice: {
        margin: '8px 14px',
        padding: '8px 10px',
        borderRadius: '6px',
        fontSize: '12px',
        background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
      },
      error: {
        margin: '10px 14px',
        padding: '10px',
        borderRadius: '6px',
        fontSize: '12px',
        background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
        border: '1px solid var(--dsw-alias-state-error-primary, #dc2626)',
        whiteSpace: 'pre-wrap',
      },
      grid: {
        display: 'grid',
        // ⚠ 这里**必须**是 `minmax(0, 1fr)`，不能是 `1fr`：
        //   `1fr` 的隐含下限是 `auto`（= min-content），所以只要某一格里有
        //   不能断行的长内容，那一列就会撑破自己的 1/7，把别的列挤窄——整张表随之不可读。
        //   `minmax(0, 1fr)` 把下限压到 0，列宽从此只由容器决定。
        //   （这是作者 2026-10-09 反馈的那个 bug 的根因。）
        gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        // ── 2026-10-09 视觉重做：从"发丝线连成的一张表"改成"一块块有呼吸的瓷砖" ──
        // 原来那版用 `gap:1px` + 容器底色当分隔线，于是格子的边界是一条硬直线、
        // 四角只有容器一层圆角——作者说"边界缺少过渡、边角过于锋利"。
        // 现在：真间隙（4px）+ 每格自己的圆角与描边，边界由间隙自然断开。
        gap: '4px',
        background: 'transparent',
        border: 'none',
        margin: '10px 14px',
        borderRadius: '12px',
        overflow: 'visible',
      },
      head: {
        padding: '6px 2px',
        fontSize: '11px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        // 表头也不许被挤（列宽已由 minmax(0,1fr) 锁死，这里是双保险）。
        minWidth: 0,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
      },
      // 空位**不留痕**：原来给它填底色，等于在说"这里也是一格，只是空的"，
      // 而它其实只是月首/月末的 padding。不填之后整张网格立刻轻了。
      blank: { height: CELL_H, background: 'transparent' },
      cell: {
        background: 'var(--dsw-alias-bg-base, #ffffff)',
        // 固定高度 + overflow hidden：一格里的东西再多也不会把隔壁顶开、也不会把整行拉高。
        height: CELL_H,
        minWidth: 0,
        overflow: 'hidden',
        padding: '5px 6px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        transition: `background ${MOTION.fast}ms ease, box-shadow ${MOTION.fast}ms ease, transform ${MOTION.fast}ms ease, border-color ${MOTION.fast}ms ease`,
      },
      cellNum: {
        fontSize: '12px',
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        minWidth: 0,
        flex: '0 0 auto',
      },
      // 格子底部的次要行（"还有 N 条…"/"会话 2"/"课程动作 1"）：都要能被省略。
      cellMeta: {
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        fontSize: '10px',
        lineHeight: '13px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
        flex: '0 0 auto',
      },
      // ⚠ 徽章**不能**用"强调色底 + 白字"：本主题的 14 个令牌里
      //   `--dsw-alias-brand-primary` 的定义是 "Primary brand accent"（强调色），
      //   而**没有**任何 "on-brand / label-on-accent" 前景令牌。
      //   实测（2026-10-09 作者反馈"保存/月按钮白底白字"）：在当前配色下它是**浅色**，
      //   白字直接消失。所以铁律是：
      //     **底色只用 surface 令牌（bg-*），文字只用 label 令牌，强调色只做边框与圆点。**
      todayBadge: {
        fontSize: '10px',
        padding: '0 4px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2, #eef0f4)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        border: '1px solid var(--dsw-alias-brand-primary, #3b82f6)',
      },
      overdueBadge: {
        fontSize: '10px',
        padding: '0 4px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2, #eef0f4)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        border: '1px solid var(--dsw-alias-state-error-primary, #dc2626)',
      },
      // ── 验收期区（2026-10-10 重做：作者说"区域太小了"）──
      //
      // 两种状态，同一个位置：
      //   · **收起**（默认）：一条摘要行——最近的验收期仍然一眼可见（那是原始需求），
      //     其余收起来，不再把 4 个名字挤成一排读不清的字；
      //   · **展开**：一整块卡片列表，大号倒计时 + 日期/窗口/课程 + 两个当场能做的动作。
      // 为什么不做成"永远更大的区域"：它会永久吃掉日历的高度，而验收期大多时候
      // 只需要"知道还剩几天"这一件事——所以默认给摘要，需要时再要全景。
      milestoneBar: {
        flex: '0 0 auto',
        borderTop: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
        padding: '6px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        fontSize: '12px',
        minWidth: 0,
      },
      milestoneList: {
        flex: '0 0 auto',
        maxHeight: '42vh',
        overflow: 'auto',
        borderTop: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
        padding: '8px 14px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      milestoneCard: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '7px 10px',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-base, #ffffff)',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        borderLeftWidth: '3px',
        minWidth: 0,
        transition: `border-color ${MOTION.fast}ms ease, transform ${MOTION.fast}ms ease`,
      },
      milestoneTitle: {
        fontSize: '13px',
        fontWeight: 600,
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      milestoneWhen: {
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        flex: '0 0 auto',
        whiteSpace: 'nowrap',
      },
      // 大号倒计时：这一块存在的全部意义就是"还剩几天"，所以数字必须最大。
      milestoneBig: { display: 'flex', alignItems: 'baseline', gap: '3px', flex: '0 0 auto', minWidth: '78px', justifyContent: 'flex-end' },
      milestoneBigNum: { fontSize: '19px', fontWeight: 700, lineHeight: 1 },
      milestoneBigUnit: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #6b7280)' },
      // ── 待办区（2026-10-09 新增）──
      // 它是一张**列表**，不是网格：所以这里只关心"一行读起来顺不顺"。
      todoList: { flex: '1 1 auto', overflow: 'auto', padding: '4px 14px 10px' },
      todoSection: {
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        borderRadius: '10px',
        marginBottom: '8px',
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-base, #ffffff)',
      },
      todoSectionHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        padding: '6px 10px',
        background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
      },
      todoSectionTitle: { fontSize: '12px', fontWeight: 600, flex: '0 0 auto' },
      todoRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        flexWrap: 'wrap',
        padding: '7px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        transition: `background ${MOTION.fast}ms ease`,
      },
      todoMain: { flex: '1 1 220px', minWidth: 0 },
      todoTitleRow: { display: 'flex', alignItems: 'flex-start', gap: '6px', minWidth: 0 },
      todoTitle: { fontSize: '13px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      todoMeta: {
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        marginTop: '2px',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      todoActions: { display: 'flex', gap: '5px', flexWrap: 'wrap', flex: '0 0 auto', alignItems: 'center' },
      postponeRow: {
        flex: '1 1 100%',
        display: 'flex',
        gap: '6px',
        alignItems: 'center',
        flexWrap: 'wrap',
        marginTop: '6px',
        paddingTop: '6px',
        borderTop: '1px dashed var(--dsw-alias-border-l1, #e5e7eb)',
      },
      empty: {
        padding: '22px 10px',
        textAlign: 'center',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
      // 一格里的一条日程。**每一行都必须能被省略号截断**：
      // 格子宽度固定，而日程标题是学习者随手写的、长度不可控
      // （`nowrap + overflow hidden + textOverflow ellipsis + minWidth 0` 四件套缺一不可——
      //   少一个 `minWidth: 0`，flex/grid 子项的最小内容宽度就会把布局顶开）。
      // 左边那道 3px 竖条是**类型色**：用边框而不是底色，符合"强调色只做边框/圆点"的令牌铁律。
      chip: {
        display: 'block',
        fontSize: '11px',
        lineHeight: '15px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
        maxWidth: '100%',
        flex: '0 0 auto',
        padding: '0 4px 0 5px',
        borderRadius: '4px',
        background: 'var(--dsw-alias-bg-layer-2, #eef0f4)',
        borderLeft: '3px solid transparent',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        borderRadius: '8px',
        padding: '8px 10px',
        marginBottom: '8px',
        background: 'var(--dsw-alias-bg-base, #ffffff)',
      },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '6px',
        padding: '4px 0',
        fontSize: '12px',
      },
      rowTitle: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' },
      actionRow: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 7px',
        fontSize: '12px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-base, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
      },
      field: { marginBottom: '6px' },
      label: { display: 'block', fontSize: '11px', marginBottom: '2px', color: 'var(--dsw-alias-label-secondary, #6b7280)' },
      two: { display: 'flex', gap: '6px' },
      overlayPanel: {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        width: '720px',
        maxWidth: '92vw',
        height: '540px',
        maxHeight: '82vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-alias-bg-base, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        borderRadius: '10px',
        boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
        overflow: 'hidden',
        zIndex: 40,
      },
      iconButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: '8px',
        cursor: 'pointer',
        padding: 0,
        color: 'inherit',
        fontSize: '16px',
        lineHeight: 1,
      },
    }

    /**
     * 按钮（不用组件库：本 bundle 只 require 到 react，少一个依赖少一次失败）。
     *
     * ═══ 配色的铁律（这一条是踩出来的，2026-10-09）═══
     * 作者反馈"保存 / 月 按钮变成白底白字"。根因是这里第一版写了
     * `background: brand-primary` + `color: '#fff'`——把**强调色**当底、又硬编白字。
     * 而宿主的主题里（Inspect 实测 14 个令牌）`brand-primary` 的定义是
     * "Primary brand accent"，且**没有**任何 on-brand 前景令牌；当前配色下它是浅色，
     * 白字于是消失。
     *
     * 所以：**底色只用 surface 令牌，文字只用 label 令牌，强调色只做边框。**
     * 这样在明暗两种模式下都由主题自己保证对比度，我不需要（也做不到）看着调。
     *
     * @param props - label / onClick / disabled / title / primary / danger。
     * @returns React 元素。
     */
    function Btn(props) {
      const [hover, setHover] = React.useState(false)
      const disabled = props.disabled === true
      const base = {
        padding: '3px 9px',
        fontSize: '12px',
        borderRadius: '6px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        // "选中/主要" = 更亮的 surface + **强调色边框** + 标签色文字（不是白字）。
        border: props.primary
          ? '1px solid var(--dsw-alias-brand-primary, #3b82f6)'
          : '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: props.primary
          ? 'var(--dsw-alias-bg-layer-2, #eef0f4)'
          : hover
            ? 'var(--dsw-alias-bg-layer-1, #f7f8fa)'
            : 'transparent',
        color: props.danger
          ? 'var(--dsw-alias-state-error-primary, #dc2626)'
          : 'var(--dsw-alias-label-primary, #1f2328)',
        fontWeight: props.primary ? 600 : 400,
        transition: `background ${MOTION.fast}ms ease`,
      }
      return React.createElement(
        'button',
        {
          type: 'button',
          title: props.title,
          disabled,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: base,
        },
        props.label,
      )
    }

    /** 一个小圆点（类型/状态的颜色标记）。`props.style` 可以覆盖几何（用于横向排列的倒计时条）。 */
    function Dot(props) {      return React.createElement('span', {
        style: {
          display: 'inline-block',
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          background: props.color,
          flex: '0 0 auto',
          marginTop: '5px',
          ...(props.style ?? {}),
        },
      })
    }

    /**
     * 用户是不是要求"减少动效"。
     *
     * 为什么要问这一句：动效对一部分人是**难受**（前庭功能敏感），而宿主没有提供
     * 主题里的动效开关，浏览器这个媒体查询是唯一权威来源。查到就**彻底关掉时长**，
     * 而不是"缩短一点"——半吊子的尊重不算尊重。
     *
     * @returns 布尔。
     */
    let reduceMotionCache = null
    function prefersReducedMotion() {
      if (reduceMotionCache !== null) return reduceMotionCache
      try {
        reduceMotionCache = window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
      } catch {
        reduceMotionCache = false
      }
      return reduceMotionCache
    }

    /**
     * 入场动效的样式：挂载（或 `key` 变化）后翻一个 state，让 `transition` 有起点。
     *
     * ═══ 为什么只能这么做 ═══
     * 宿主明说"不要在组件外写 DOM / 不要 append 到 body"，所以不能注入 `<style>`，
     * 也就**没有 @keyframes**（`@lh/workspace-ui` 踩过同一条）。能在内联样式里表达的
     * 动效只有两种：`transition` + 挂载后翻 state（本函数），以及 hover 状态。
     * 换来的是不越界——而越界的动效会让整块界面起不来。
     *
     * @param key - 依赖：它变了就重播一次入场（如换月、换选中日）。
     * @returns 可展开进 style 的对象。
     */
    function useEnterStyle(key) {
      const [shown, setShown] = React.useState(false)
      React.useEffect(() => {
        setShown(false)
        // 两帧之后才翻：requestAnimationFrame 确保浏览器已经用"起点样式"画过一次，
        // 否则同一帧内 0 → 1 不会产生过渡（这是内联动效最常见的哑火原因）。
        const id = window.requestAnimationFrame(() => setShown(true))
        return () => window.cancelAnimationFrame(id)
      }, [key])
      if (prefersReducedMotion()) return { transition: 'none' }
      return {
        opacity: shown ? 1 : 0,
        transform: shown ? 'translateY(0)' : 'translateY(4px)',
        transition: `opacity ${MOTION.slow}ms ease, transform ${MOTION.slow}ms ease`,
      }
    }

    /**
     * 月历里的一格。
     *
     * ═══ 为什么拆成组件（而不是在 map 里内联）═══
     * 只有一个理由：**每一格要有自己的 hover 状态**，而 hook 不能写在循环里。
     * 拆开之后，鼠标划过一格只重渲染那一格，整张表不动。
     *
     * ═══ 内容纪律 ═══
     * 每一行都要能被省略号截断（样式里已带四件套），因为格子是固定大小的，
     * 而日程标题的长度不可控。超出的条目由底部"还有 N 条…"交代——信息不丢，只是收起。
     *
     * @param props - `{ cell, isToday, isSelected, today, onSelect }`。
     * @returns React 元素。
     */
    function DayCell(props) {
      const cell = props.cell
      const [hover, setHover] = React.useState(false)
      const overdue = cell.items.some((it) => it.status === 'planned' && cell.day < props.today)
      const weekend = cell.weekday === 0 || cell.weekday === 6
      const reduce = prefersReducedMotion()

      // 底色优先级：选中 > 悬停 > 周末 > 普通。
      //
      // ⚠ 周末**不再用一块平涂**（作者反馈"填色比较僵硬，边界缺少过渡"）：
      //   改成自上而下的一层极浅渐变——它仍然让人一眼看出"这两天是周末"，
      //   但和相邻格子的边界是**渐隐**的，不是一条硬边。
      //   `linear-gradient` 是内联样式能表达的，不需要注入 `<style>`（宿主不让）。
      const background = props.isSelected
        ? 'var(--dsw-alias-bg-layer-2, #eef0f4)'
        : hover
          ? 'var(--dsw-alias-bg-layer-1, #f7f8fa)'
          : weekend
            ? 'linear-gradient(180deg, var(--dsw-alias-bg-layer-1, #f7f8fa) 0%, var(--dsw-alias-bg-base, #ffffff) 78%)'
            : 'var(--dsw-alias-bg-base, #ffffff)'

      return React.createElement(
        'div',
        {
          onClick: props.onSelect,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          title: `${cell.day}　日程 ${cell.items.length} · 会话 ${cell.sessions.length} · 课程动作 ${cell.course_events.length}`,
          style: {
            ...S.cell,
            background,
            // 选中 = 品牌色描边；今天 = 只把日号加粗 + 一个小圆点（下面）。
            // ⚠ 为什么今天**不用**描边：底色已经承担了 hover，描边承担了"选中"，
            //   再给今天一圈就会三个状态互相打架。而"今天"只需一个标记——
            //   圆点是非文字标记，正好是令牌铁律允许强调色出场的地方之一。
            borderColor: props.isToday
              ? 'var(--dsw-alias-border-l2, #d1d5db)'
              : 'var(--dsw-alias-border-l1, #e5e7eb)',
            transform: hover && !reduce ? 'translateY(-1px)' : 'none',
            // 抬起时给一层极浅投影：明暗模式下都是"浮起来一点"的意思，
            // 且它是**非文字**信息，不存在对比度问题（令牌表里没有阴影令牌）。
            boxShadow: props.isSelected
              ? `inset 0 0 0 2px ${TOKEN.brand}`
              : hover && !reduce
                ? '0 2px 8px rgba(0, 0, 0, 0.07)'
                : 'none',
          },
        },
        // 第一行：日号 + 徽章（全部 flex:0 0 auto——绝不允许它们被内容挤变形）
        React.createElement(
          'div',
          { style: S.cellNum },
          props.isToday ? React.createElement(Dot, { color: TOKEN.brand, style: { marginTop: 0, width: '6px', height: '6px' } }) : null,
          React.createElement(
            'span',
            { style: { flex: '0 0 auto', fontWeight: props.isToday ? 700 : 600 } },
            String(Number(String(cell.day).slice(-2))),
          ),
          props.isToday ? React.createElement('span', { style: S.todayBadge }, '今天') : null,
          overdue ? React.createElement('span', { style: S.overdueBadge }, '欠') : null,
        ),
        // 日程（最多 3 条，每条都能被省略）
        //
        // ⚠ 没有类型色条了（作者 2026-10-10：界面不需要对日程分类）。
        //   留下的只有**状态**那一个字符（·/✓/✗/↷）与删除线——它们是"这条现在怎么样"，
        //   而不是"这条属于哪一类"。
        ...cell.items.slice(0, 3).map((item) => {
          const st = STATUS[item.status] ?? STATUS.planned
          return React.createElement(
            'div',
            {
              key: `i-${item.item_id}-${cell.day}`,
              title: `${item.title}${item.note === null || item.note === undefined ? '' : `（${item.note}）`}`,
              style: {
                ...S.chip,
                color:
                  item.status === 'cancelled'
                    ? 'var(--dsw-alias-label-secondary, #6b7280)'
                    : 'var(--dsw-alias-label-primary, #1f2328)',
                textDecoration: item.status === 'cancelled' ? 'line-through' : 'none',
                opacity: item.status === 'done' ? 0.72 : 1,
              },
            },
            `${st.mark} ${item.start === null ? '' : `${item.start} `}${item.title}`,
          )
        }),
        cell.items.length > 3
          ? React.createElement('div', { style: { ...S.cellMeta, fontWeight: 600 } }, `还有 ${cell.items.length - 3} 条…`)
          : null,
        // "会话 / 课程动作"合成**一行**（用间隔点分开）：
        // 格子高度是固定的，每多一行就多一分把最后一行切一半的风险；
        // 而这两件事都是"这天还有什么"的同类信息，并排比堆叠更好扫。
        cell.sessions.length > 0 || cell.course_events.length > 0
          ? React.createElement(
              'div',
              { style: S.cellMeta },
              [
                cell.sessions.length > 0 ? `会话 ${cell.sessions.length}` : null,
                cell.course_events.length > 0 ? `课程动作 ${cell.course_events.length}` : null,
              ]
                .filter(Boolean)
                .join(' · '),
            )
          : null,
        cell.sessions_truncated === true || cell.items_truncated === true
          ? React.createElement('div', { style: { ...S.cellMeta, color: TOKEN.warn } }, '（已截断）')
          : null,
      )
    }

    // ══════════════════════════════════════════════════════════════════════
    // 面板本体
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 中央面板（`main` key = PANEL_ID）。
     *
     * ═══ 为什么把 useSessions 的兜底写在这里、而不是条件渲染两个组件 ═══
     * hook 不能条件调用。宿主给不给 `useSessions` 是**运行时**才知道的事，
     * 所以**无条件**调用一个"拿不到就用假 hook"的版本：hook 数量在整个生命周期里恒定，
     * 而"拿不到会话清单"只影响标题显示，不影响日历本身（日历数据全是本插件自己的路由）。
     *
     * @param props - 宿主给的 standard props（含 useSessions）。
     * @returns React 元素。
     */
    function CalendarPanel(props) {
      const sessionsHook = typeof props?.useSessions === 'function' ? props.useSessions : (sel) => sel({ byId: {} })
      const sessions = sessionsById(sessionsHook((s) => s))

      const [mode, setMode] = React.useState(() => {
        const saved = readLocal(LS_VIEW, 'month')
        return saved === 'week' ? 'week' : 'month'
      })
      const [month, setMonth] = React.useState(() => monthOf(todayLocal()))
      const [day, setDay] = React.useState(() => readLocal(LS_DAY, todayLocal()) ?? todayLocal())
      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [errorText, setErrorText] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [selectedItemId, setSelectedItemId] = React.useState(null)
      const [editor, setEditor] = React.useState(null)
      /** 验收期区展开与否（默认收起；选择记在本地）。 */
      const [milestonesOpen, setMilestonesOpen] = React.useState(() => readLocal(LS_MILESTONES_OPEN, '0') === '1')

      /**
       * 取一次数据。
       *
       * ═══ 为什么 query 由 mode 决定而不是由服务端猜 ═══
       * 三种读法各自不同：**月**铺一整月（42 格）、**周**铺 7 格、**待办**是一条跨月的列表。
       * 界面只负责说出自己要哪一种，服务端三条路由各司其职。
       *
       * ═══ 为什么待办不能复用日历的载荷 ═══
       * 日历按 `month` 取数，它的 `days` 只有**当月**；而待办回答的是"接下来做什么"，
       * 必然跨月（11 月的日程在 10 月的日历载荷里根本不在）。这是自检抓到过的一条真错，
       * 所以这里宁可多一条请求，也不把两种区间口径混进一个载荷里。
       */
      const load = React.useCallback(
        async (overrides) => {
          const m = overrides?.mode ?? mode
          const mm = overrides?.month ?? month
          const dd = overrides?.day ?? day
          setLoading(true)
          setErrorText(null)
          try {
            const query =
              m === 'todo'
                ? `?tz=${encodeURIComponent(tzName())}`
                : m === 'week'
                  ? `?week=${encodeURIComponent(dd)}&tz=${encodeURIComponent(tzName())}`
                  : `?month=${encodeURIComponent(mm)}&tz=${encodeURIComponent(tzName())}`
            const body = await request(`${m === 'todo' ? '/todo' : '/calendar'}${query}`)
            setData(body)
          } catch (error) {
            setData(null)
            setErrorText(String(error?.message ?? error))
          } finally {
            setLoading(false)
          }
        },
        [mode, month, day],
      )

      // 首次挂载就取一次。
      //
      // ⚠ 这一条不是防御性代码：宿主**记得上次选中的面板**（layout store 的 activePanelId）。
      //   应用重启或页面重载后会直接挂载本组件，而那条路径**不经过**任何按钮，
      //   于是"没人数过"的状态会表现为"一条日程都没有"——一个查不出来的假象
      //   （@lh/workspace-ui 第一版就是这么被误读成"课程全丢了"的）。
      React.useEffect(() => {
        void load()
        // 只在挂载时判定一次；之后的重拉由导航/动作/刷新按钮负责。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // 订阅模块级的"界面偏好变了"：改它的地方在**设置**里（另一个组件），
      // 所以面板必须能被通知到、重新渲染一次——否则设置里勾了"显示已撤销"，
      // 面板要等到下一次翻月才生效（那会让人以为开关没起作用）。
      const [, forceRender] = React.useState(0)
      React.useEffect(() => subscribe(() => forceRender((n) => n + 1)), [])

      /** 切换月份/周并重取。 */
      function go(nextMode, nextMonth, nextDay) {
        if (typeof nextMode === 'string') {
          setMode(nextMode)
          writeLocal(LS_VIEW, nextMode)
        }
        if (typeof nextMonth === 'string') setMonth(nextMonth)
        if (typeof nextDay === 'string') {
          setDay(nextDay)
          writeLocal(LS_DAY, nextDay)
        }
        void load({ mode: nextMode ?? mode, month: nextMonth ?? month, day: nextDay ?? day })
      }

      /** 包一次写操作：busy 期间禁用按钮（避免连点写两条事件），完成后重取。 */
      async function act(fn, okText) {
        setBusy(true)
        setNotice(null)
        try {
          await fn()
          setNotice({ kind: 'ok', text: okText })
          await load()
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      // ⚠ 已撤销的日程**默认不显示**（作者 2026-10-10）——过滤在这里做，一次管住三处：
      //   格子里的 chip、"还有 N 条"的计数、以及右列当天的日程清单（它们都读同一份 `days`）。
      //   放在客户端而不是服务端：这样设置里那个开关是**立刻**生效的，不用重新取数。
      //   （服务端的 `summary.cancelled` 仍然照数——那是"我这段时间撤了几条"的事实。）
      const days = (Array.isArray(data?.days) ? data.days : []).map((day) =>
        showCancelled ? day : { ...day, items: day.items.filter((item) => item.status !== 'cancelled') },
      )
      const courses = Array.isArray(data?.courses) ? data.courses : []
      // 验收期（服务端已经带好倒计时）：**全局**的，所以它不随翻月变。
      const milestones = Array.isArray(data?.milestones) ? data.milestones : []
      const today = data?.today ?? todayLocal()
      const isTodo = mode === 'todo'
      // 待办那一半的数据（`/todo` 的载荷；月/周模式下为空）。
      const backlog = Array.isArray(data?.backlog) ? data.backlog : []
      const overdueItems = Array.isArray(data?.overdue) ? data.overdue : []

      // ── 入场动效（几处各自一个 key）──
      // 换月时网格重播、换选中日时右列重播、验收期条与待办列表内容变了也重播。
      // hook 必须在组件顶层无条件调用（不能写在 if/map 里），所以都放这里。
      const enterGrid = useEnterStyle(data?.month ?? month)
      const enterDay = useEnterStyle(day)
      const enterBar = useEnterStyle(milestones.length)
      const enterTodo = useEnterStyle(`${today}|${backlog.length}|${overdueItems.length}|${days.length}`)
      const selected = days.find((d) => d.day === day) ?? null

      // ── 月历网格的铺法（周一起）──
      //
      // `weekday` 是 0=周日…6=周六，而表头从周一开始，所以前面的空格数是 (weekday+6)%7。
      const leading = days.length > 0 ? ((days[0].weekday ?? 0) + 6) % 7 : 0
      const cells = []
      for (let i = 0; i < leading; i += 1) cells.push(null)
      for (const d of days) cells.push(d)
      while (cells.length % 7 !== 0) cells.push(null)

      /** 一个月的总览数字（放在头部，回答"这个月我排了多少、做了多少"）。 */
      const summary = data?.summary ?? null

      return React.createElement(
        'div',
        { style: S.panel },
        React.createElement(
          'div',
          { style: S.header },
          React.createElement('span', { style: S.title }, '学习日历'),
          React.createElement('span', { style: { flex: '1 1 auto' } }),
          React.createElement(Btn, { label: '月', primary: mode === 'month', onClick: () => go('month') }),
          React.createElement(Btn, { label: '周', primary: mode === 'week', onClick: () => go('week') }),
          // 「待办」是**日历的第三种读法**，不是第二个面板：作者要求把待办区并进学习日历。
          // 好处是入口只有一个——"我排了什么"和"接下来做什么"在同一处切换，
          // 而侧栏不会为了同一份数据长出第二个图标。
          React.createElement(Btn, { label: '待办', primary: isTodo, onClick: () => go('todo') }),
          React.createElement(Btn, {
            label: '今天',
            onClick: () => go(mode === 'todo' ? 'todo' : mode, monthOf(todayLocal()), todayLocal()),
          }),
          mode === 'month'
            ? React.createElement(Btn, { label: '‹', title: '上个月', onClick: () => go('month', shiftMonth(month, -1)) })
            : null,
          mode === 'month'
            ? React.createElement(Btn, { label: '›', title: '下个月', onClick: () => go('month', shiftMonth(month, 1)) })
            : null,
          React.createElement(Btn, { label: '刷新', disabled: loading || busy, onClick: () => void load() }),
        ),

        notice !== null
          ? React.createElement(
              'div',
              {
                style: {
                  ...S.notice,
                  borderColor:
                    notice.kind === 'bad' ? 'var(--dsw-alias-state-error-primary, #dc2626)' : 'var(--dsw-alias-border-l1, #e5e7eb)',
                },
              },
              notice.text,
            )
          : null,

        errorText !== null
          ? React.createElement(
              'div',
              { style: S.error },
              React.createElement('div', null, `读取失败：${errorText}`),
              React.createElement('div', { style: { marginTop: '8px' } },
                React.createElement(Btn, { label: '重试', onClick: () => void load() })),
            )
          : null,

        // ── 主体：待办是**另一种读法**，所以整块主体换掉（网格与右列都不出现）──
        isTodo
          ? React.createElement(TodoBody, {
              data,
              busy,
              enterStyle: enterTodo,
              today,
              act,
              onNotice: setNotice,
            })
          : React.createElement(
          'div',
          { style: S.body },
          // ── 左列：日历 ──
          React.createElement(
            'div',
            { style: S.left },
            React.createElement(
              'div',
              { style: { ...S.muted, padding: '8px 14px 0' } },
              // 只有计数，没有解释（作者 2026-10-10：不要过度的说明性文字）。
              mode === 'month'
                ? `${data?.month ?? month}　计划 ${summary?.planned ?? 0} · 完成 ${summary?.done ?? 0}`
                : `${data?.from ?? ''} ~ ${data?.to ?? ''}　计划 ${summary?.planned ?? 0} · 完成 ${summary?.done ?? 0}`,
              summary !== null && summary.overdue > 0
                ? React.createElement('span', { style: { marginLeft: '8px', color: TOKEN.error } }, `· 过期 ${summary.overdue}`)
                : null,
              data?.tz_fallback === true
                ? React.createElement('span', { style: { marginLeft: '8px', color: TOKEN.warn } }, '· 时区认不出，按 UTC 折算')
                : null,
            ),
            React.createElement(
              'div',
              // 换月时重播一次入场（`enterGrid` 的 key 是月份）——过渡而不是跳变，
              // 这让"翻了一页"这件事在视觉上说得通。
              { style: { ...S.grid, ...enterGrid } },
              ...WEEK_HEADS.map((h) => React.createElement('div', { key: `h-${h}`, style: S.head }, h)),
              ...cells.map((cell, index) =>
                cell === null
                  ? React.createElement('div', { key: `b-${index}`, style: S.blank })
                  : React.createElement(DayCell, {
                      key: cell.day,
                      cell,
                      isToday: cell.day === today,
                      isSelected: cell.day === day,
                      today,
                      onSelect: () => go(mode, month, cell.day),
                    }),
              ),
            ),
            React.createElement('div', { style: { ...S.muted, padding: '0 14px 10px' } },
              '点某一天看当天的日程、当天动过的对话、当天的课程动作。'),
          ),

          // ── 右列：当天的详情 + 新建/编辑 ──
          React.createElement(
            'div',
            { style: { ...S.right, ...enterDay } },
            React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } },
              `${prettyDay(day)}（${WEEK_HEADS[((selected?.weekday ?? 0) + 6) % 7]}）`),

            editor === 'new'
              ? React.createElement(NewItemForm, {
                  day,
                  busy,
                  onCancel: () => setEditor(null),
                  onSubmit: (form) =>
                    act(
                      () => request('/create', { method: 'POST', body: JSON.stringify({ ...form, day, tz: tzName() }) }),
                      '已新建日程。',
                    ).then(() => setEditor(null)),
                })
              : React.createElement(Btn, { label: '＋ 新建这天的日程', primary: true, onClick: () => setEditor('new') }),

            React.createElement('div', { style: { ...S.card, marginTop: '8px' } },
              React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } },
                `日程（${selected?.items?.length ?? 0}）`),
              (selected?.items ?? []).length === 0
                ? React.createElement('div', { style: S.muted }, '无日程')
                : (selected?.items ?? []).map((item) =>
                    React.createElement(ItemRow, {
                      key: item.item_id,
                      item,
                      busy,
                      expanded: editor === item.item_id,
                      selected: selectedItemId === item.item_id,
                      courseName: (id) => courseLabelOf(courses, id),
                      onSelect: () => setSelectedItemId(selectedItemId === item.item_id ? null : item.item_id),
                      onEdit: () => setEditor(editor === item.item_id ? null : item.item_id),
                      onDone: () =>
                        act(
                          () => request('/update', { method: 'POST', body: JSON.stringify({ item_id: item.item_id, status: 'done' }) }),
                          '已完成。',
                        ),
                      onReopen: () =>
                        act(
                          () => request('/update', { method: 'POST', body: JSON.stringify({ item_id: item.item_id, status: 'planned' }) }),
                          '已改回计划中。',
                        ),
                      onCancel: () =>
                        act(
                          () => request('/cancel', { method: 'POST', body: JSON.stringify({ item_id: item.item_id }) }),
                          '已撤销。',
                        ),
                      onPatch: (patch) =>
                        act(
                          () => request('/update', { method: 'POST', body: JSON.stringify({ item_id: item.item_id, ...patch }) }),
                          '已更新。',
                        ).then(() => setEditor(null)),
                    }),
                  ),
            ),

            React.createElement('div', { style: S.card },
              React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } },
                `当日会话（${selected?.sessions?.length ?? 0}）`),
              (selected?.sessions ?? []).length === 0
                ? React.createElement('div', { style: S.muted }, '无会话')
                : (selected?.sessions ?? []).map((s) =>
                    React.createElement(SessionLine, {
                      key: s.session_id,
                      session: s,
                      title: sessionTitle(sessions[s.session_id], s.session_id),
                      busy,
                      canBind: selectedItemId !== null,
                      onBind: () =>
                        act(
                          () =>
                            request('/update', {
                              method: 'POST',
                              body: JSON.stringify({ item_id: selectedItemId, session_id: s.session_id }),
                            }),
                          '已把日程绑到这段对话。',
                        ),
                    }),
                  ),
              React.createElement('div', { style: { ...S.muted, marginTop: '4px' } },
                selectedItemId === null
                  ? '（先在上面点一条日程，就能把它绑到这里的某段对话）'
                  : '已选中一条日程：点对话右侧的「绑到这条」即可。'),
            ),

            React.createElement('div', { style: S.card },
              React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } },
                `课程动作（${selected?.course_events?.length ?? 0}）`),
              (selected?.course_events ?? []).length === 0
                ? React.createElement('div', { style: S.muted }, '无课程动作')
                : (selected?.course_events ?? []).map((c, index) =>
                    React.createElement('div', { key: `c-${index}`, style: { ...S.muted, padding: '2px 0' } },
                      `${String(c.type).replace('lh/course/', '')}　${c.title ?? c.node_id ?? ''}` +
                        (c.session_id === null ? '' : `　对话 ${shortId(c.session_id)}`)),
                  ),
            ),
          ),
        ),

        // ── 下端：验收期区（作者要求"显示在下端带倒计时"；2026-10-10 因"区域太小"重做）──
        //
        // 为什么在**面板最下面**而不是塞进右列：它是**全局**的（不只本月），
        // 是看日历时的背景信息——"离大考还有 42 天"应该一直看得见，
        // 而不是要翻到那一天才知道。倒计时的数字由服务端算好，
        // 界面只负责措辞（绝不自己再算一遍日期，否则两处迟早不一致）。
        //
        // 两种形态共用一个位置：
        //   · 收起 = 一条摘要行，只把**最近的**那个说清楚（含大号数字），其余折叠；
        //   · 展开 = 完整列表，每个都有大号倒计时 + 日期/窗口/课程 + 当场能做的两个动作。
        milestones.length === 0
          ? null
          : milestonesOpen
            ? React.createElement(
                'div',
                { style: { ...S.milestoneList, ...enterBar } },
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                  React.createElement('span', { style: { ...S.muted, fontWeight: 600 } }, `验收期（${milestones.length}）`),
                  React.createElement('span', { style: { flex: '1 1 auto' } }),
                  React.createElement(Btn, {
                    label: '收起',
                    onClick: () => {
                      setMilestonesOpen(false)
                      writeLocal(LS_MILESTONES_OPEN, '0')
                    },
                  }),
                ),
                ...milestones.map((m) => {
                  const big = milestoneBigValue(m)
                  const done = m.status === 'done'
                  return React.createElement(
                    'div',
                    {
                      key: m.item_id,
                      style: {
                        ...S.milestoneCard,
                        // 所有验收期都是同一道品牌色左缘：**不再按类型分色**
                        // （作者 2026-10-10：不需要区分具体是什么的验收期）。
                        borderLeftColor: TOKEN.brand,
                        opacity: done ? 0.6 : 1,
                      },
                    },
                    React.createElement('span', { style: S.milestoneTitle, title: m.title }, m.title),
                    React.createElement(
                      'span',
                      { style: S.milestoneWhen },
                      m.day === null
                        ? '未定日期'
                        : m.until === null || m.until === undefined
                          ? m.day
                          : `${m.day} ~ ${m.until}`,
                      m.course_id === null || m.course_id === undefined ? '' : `　${courseLabelOf(courses, m.course_id)}`,
                    ),
                    // 大号倒计时：这一块存在的全部意义就是"还剩几天"，所以数字最大。
                    React.createElement(
                      'span',
                      { style: S.milestoneBig },
                      React.createElement('span', { style: S.milestoneBigNum }, big.value),
                      big.unit === '' ? null : React.createElement('span', { style: S.milestoneBigUnit }, big.unit),
                    ),
                    React.createElement(Btn, {
                      label: '去那天',
                      disabled: busy || m.day === null,
                      onClick: () => {
                        setEditor(null)
                        go('month', monthOf(m.day), m.day)
                      },
                    }),
                    done
                      ? null
                      : React.createElement(Btn, {
                          label: '完成',
                          disabled: busy,
                          onClick: () =>
                            act(
                              () => request('/update', { method: 'POST', body: JSON.stringify({ item_id: m.item_id, status: 'done' }) }),
                              '已完成。',
                            ),
                        }),
                  )
                }),
              )
            : React.createElement(
                'div',
                { style: { ...S.milestoneBar, ...enterBar } },
                React.createElement('span', { style: { ...S.muted, fontWeight: 600, flex: '0 0 auto' } }, '验收期'),
                (() => {
                  // 摘要行只讲**最近的**那一个（列表已按"未完成的在前、日期升序"排过）。
                  const m = milestones[0]
                  const big = milestoneBigValue(m)
                  return React.createElement(
                    'span',
                    { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: '1 1 auto' } },
                    React.createElement(Dot, { color: TOKEN.brand, style: { marginTop: 0 } }),
                    React.createElement(
                      'span',
                      { style: { ...S.milestoneTitle, flex: '0 1 auto' }, title: `${m.day ?? ''}　${m.title}` },
                      m.title,
                    ),
                    React.createElement('span', { style: S.milestoneWhen }, m.day ?? ''),
                    React.createElement(
                      'span',
                      { style: S.milestoneBig },
                      React.createElement('span', { style: S.milestoneBigNum }, big.value),
                      big.unit === '' ? null : React.createElement('span', { style: S.milestoneBigUnit }, big.unit),
                    ),
                  )
                })(),
                milestones.length > 1
                  ? React.createElement('span', { style: { ...S.muted, flex: '0 0 auto' } }, `共 ${milestones.length} 个`)
                  : null,
                React.createElement(Btn, {
                  label: '展开',
                  onClick: () => {
                    setMilestonesOpen(true)
                    writeLocal(LS_MILESTONES_OPEN, '1')
                  },
                }),
              ),
      )
    }

    /**
     * 日历日加减几天（客户端用）。
     *
     * 服务端那一份在 `@lh/schedule/schedule.js`（`addDays`）。两边都只有几行，
     * 但**必须在同一套算术上**：都用 `YYYY-MM-DDT00:00:00Z` 的 UTC 毫秒加减，
     * 不碰本地时区——否则夏令时那天两边会差一天，而"推迟一天"就差一天。
     *
     * @param day - 日历日。
     * @param n - 天数。
     * @returns 新的日历日。
     */
    function shiftDayLocal(day, n) {
      const ms = Date.parse(`${day}T00:00:00Z`) + n * 86400000
      return new Date(ms).toISOString().slice(0, 10)
    }

    /**
     * 待办区里的一条。
     *
     * ═══ 为什么每个动作都要在这里出现（作者的原话）═══
     * "日程很有可能是模型生成的，在确定生成的时候可能用户没有详细的审阅，
     * 或是有突发情况打断" —— 所以待办区的每一行都必须能**当场**做完决定：
     * 提前完成 / 推迟到某天 / 无限期推迟 / 撤销。少一个，用户就得回到日历上找它。
     *
     * @param props - `{ item, busy, onUpdate(patch, okText), onCancel }`。
     * @returns React 元素。
     */
    function TodoRow(props) {
      const item = props.item
      const [open, setOpen] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [hover, setHover] = React.useState(false)
      const today = props.today ?? todayLocal()

      // 去掉类型标签与色点（作者 2026-10-10：界面不需要对日程分类）。
      const meta = [
        props.courseName(item.course_id),
        item.day === null || item.day === undefined ? null : item.day,
        item.start === null || item.start === undefined ? null : item.start,
        item.minutes_planned === null || item.minutes_planned === undefined ? null : `${item.minutes_planned} 分钟`,
        item.note === null || item.note === undefined ? null : item.note,
      ]
        .filter(Boolean)
        .join(' · ')

      /** 推迟的快捷选项：相对**这条日程自己的日期**算，不是相对今天。 */
      //
      // ═══ 为什么要以 item.day 为基准（作者点出来的）═══
      // 作者原话："毕竟改的不一定是'今天'的日程"。一条排在 10-20 的日程点"一天后"，
      // 人想说的是 10-21，而不是"明天"。以**今天**为基准的写法在"今天改明天的日程"时
      // 恰好也对，所以那个错很难被发现——它只在改**未来**或**过期**的日程时才露出来。
      // 没有日期的待办以今天为基准（它本来就没有别的锚点）。
      const base = typeof item.day === 'string' && item.day !== '' ? item.day : today
      const quick = [
        { label: '一天后', day: shiftDayLocal(base, 1) },
        { label: '三天后', day: shiftDayLocal(base, 3) },
        { label: '一周后', day: shiftDayLocal(base, 7) },
      ]

      return React.createElement(
        'div',
        {
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            ...S.todoRow,
            background: hover ? 'var(--dsw-alias-bg-layer-1, #f7f8fa)' : 'transparent',
          },
        },
        React.createElement(
          'div',
          { style: S.todoMain },
          React.createElement(
            'div',
            { style: S.todoTitleRow },
            React.createElement('span', { style: S.todoTitle, title: item.title }, item.title),
          ),
          meta === '' ? null : React.createElement('div', { style: S.todoMeta, title: meta }, meta),
        ),
        React.createElement(
          'div',
          { style: S.todoActions },
          React.createElement(Btn, {
            label: '完成',
            primary: true,
            disabled: props.busy,
            onClick: () => props.onUpdate({ status: 'done' }, '已完成。'),
          }),
          React.createElement(Btn, {
            label: open ? '收起' : '推迟',
            disabled: props.busy,
            onClick: () => setOpen(!open),
          }),
          React.createElement(Btn, { label: '撤销', danger: true, disabled: props.busy, onClick: props.onCancel }),
        ),
        open
          ? React.createElement(
              'div',
              { style: S.postponeRow },
              ...quick.map((q) =>
                React.createElement(Btn, {
                  key: q.day,
                  label: q.label,
                  disabled: props.busy,
                  onClick: () => props.onUpdate({ day: q.day }, `已推迟到 ${q.day}。`),
                }),
              ),
              // 「不定日期」就是原来的"无限期推迟"——**并进推迟里**，不再单独占一个按钮。
              React.createElement(Btn, {
                label: '不定日期',
                disabled: props.busy,
                onClick: () => props.onUpdate({ day: '' }, '已推迟（未定日期）。'),
              }),
              React.createElement('input', {
                style: { ...S.input, width: '130px', flex: '0 0 auto' },
                placeholder: 'YYYY-MM-DD',
                value: draft,
                onChange: (e) => setDraft(e.target.value),
              }),
              React.createElement(Btn, {
                label: '定到这天',
                disabled: props.busy || draft.trim() === '',
                onClick: () => {
                  props.onUpdate({ day: draft.trim() }, `已推迟到 ${draft.trim()}。`)
                  setDraft('')
                  setOpen(false)
                },
              }),
            )
          : null,
      )
    }

    /**
     * 「待办区」的**主体** —— 嵌在日历面板里，不是第二个面板。
     *
     * ═══ 为什么它是主体的一块，而不是一个独立面板（2026-10-10 作者要求）═══
     * 作者说"将待办区集成到学习日历里"。原先它占一个 main 面板 + 一个侧栏图标，
     * 于是**同一份数据有两个入口**；而"我排了什么"与"接下来做什么"本来就是同一个问题的两面
     * （一块网格看结构，一条列表看顺序）。现在它是日历的**第三种读法**（月 / 周 / 待办），
     * 共用头部、共用下端的验收期倒计时条。
     *
     * ═══ 为什么它不自己取数 ═══
     * 取数、忙碌状态、动作后的重取、错误与提示都归外层（`CalendarPanel`）——
     * 一个视图里有两套"正在忙"和两条提示，是界面开始骗人的起点。
     * 这里只负责画：分区、行动作、空状态。
     *
     * @param props - `{ data, busy, enterStyle, today, act }`。
     * @returns React 元素。
     */
    function TodoBody(props) {
      const { data, busy, act } = props
      const [adding, setAdding] = React.useState(false)
      const [draftTitle, setDraftTitle] = React.useState('')

      const backlog = Array.isArray(data?.backlog) ? data.backlog : []
      const overdue = Array.isArray(data?.overdue) ? data.overdue : []
      const days = Array.isArray(data?.days) ? data.days : []
      const courses = Array.isArray(data?.courses) ? data.courses : []
      const today = props.today ?? todayLocal()

      /** 改一条（推迟到某天 / 不定日期 / 完成，都走同一条路）。 */
      const update = (item, body, okText) =>
        act(() => request('/update', { method: 'POST', body: JSON.stringify({ item_id: item.item_id, ...body }) }), okText)
      /** 撤销一条。 */
      const cancelItem = (item) =>
        act(() => request('/cancel', { method: 'POST', body: JSON.stringify({ item_id: item.item_id }) }), '已撤销。')

      /**
       * 一个分区（标题 + 若干行）。**没有说明文字**——分区标题已经说完了（作者 2026-10-10）。
       * @param title - 分区标题。
       * @param items - 这个分区里的日程。
       * @returns React 元素。
       */
      function section(title, items) {
        return React.createElement(
          'div',
          { key: title, style: S.todoSection },
          React.createElement(
            'div',
            { style: S.todoSectionHead },
            React.createElement('span', { style: S.todoSectionTitle }, title),
            React.createElement('span', { style: { ...S.muted, flex: '0 0 auto' } }, `${items.length}`),
          ),
          ...items.map((item) =>
            React.createElement(TodoRow, {
              key: item.item_id,
              item,
              busy,
              today,
              courseName: (id) => courseLabelOf(courses, id),
              onUpdate: (body, okText) => update(item, body, okText),
              onCancel: () => cancelItem(item),
            }),
          ),
        )
      }

      const empty = data !== null && backlog.length === 0 && overdue.length === 0 && days.length === 0

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } },
        // 头部只有两个东西：一个「＋ 新建待办」和一个展开中的输入框。
        // （原来这里还有一行"今天 … 待办 N · 欠账 N · 计划中 N"的总览——作者说不要说明性文字，
        //   而且分区标题左边本来就各有一个计数。）
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px 0' } },
          React.createElement('span', { style: { flex: '1 1 auto' } }),
          React.createElement(Btn, {
            label: adding ? '取消' : '＋ 新建待办',
            primary: !adding,
            onClick: () => setAdding(!adding),
          }),
        ),
        adding
          ? React.createElement(
              'div',
              { style: { display: 'flex', gap: '6px', padding: '8px 14px 0' } },
              React.createElement('input', {
                style: { ...S.input, flex: '1 1 auto' },
                placeholder: '未定日期的事',
                value: draftTitle,
                onChange: (e) => setDraftTitle(e.target.value),
              }),
              React.createElement(Btn, {
                label: '加入',
                primary: true,
                disabled: busy || draftTitle.trim() === '',
                onClick: () =>
                  act(
                    () => request('/create', { method: 'POST', body: JSON.stringify({ title: draftTitle.trim(), tz: tzName() }) }),
                    '已加入。',
                  ).then(() => {
                    setDraftTitle('')
                    setAdding(false)
                  }),
              }),
            )
          : null,
        React.createElement(
          'div',
          { style: { ...S.todoList, ...(props.enterStyle ?? {}) } },
          // 「无限期推迟」的去处排在**最前**：它们是"需要你现在做决定"的东西，
          // 而未来的日程只是"知道就好"。（作者原话：放到待办置顶的位置。）
          backlog.length === 0 ? null : section('未定日期', backlog),
          overdue.length === 0 ? null : section('已过期', overdue),
          ...days.map((day) =>
            section(
              `${prettyDay(day.day)}　${WEEK_HEADS[((day.weekday ?? 0) + 6) % 7]}` +
                (day.day === today ? '　今天' : day.day === shiftDayLocal(today, 1) ? '　明天' : ''),
              day.items,
            ),
          ),
          empty ? React.createElement('div', { style: S.empty }, '没有待办') : null,
        ),
      )
    }

    /**
     * 验收期的**大号倒计时**：拆成"数字"与"单位/说明"两段，好让数字吃到最大字号。
     *
     * 为什么不复用服务端那句 `countdownText`（"还剩 2 天"）：那是给**一行文字**用的，
     * 而展开区里要的是"**2** 天"这种排版。同一个事实两种排版是正当的，
     * 但口径必须一致——所以两处都读服务端算好的 `countdown`，谁也不自己算日期。
     *
     * @param m - 带 countdown 的日程项。
     * @returns `{ value, unit }`。
     */
    function milestoneBigValue(m) {
      const cd = m.countdown ?? null
      if (m.status === 'done') return { value: '✓', unit: '已完成' }
      if (cd === null) return { value: '—', unit: '' }
      if (cd.phase === 'before') return { value: String(cd.days_left), unit: '天' }
      if (cd.phase === 'today') return { value: '今天', unit: '' }
      if (cd.phase === 'during') return { value: String(cd.days_to_end), unit: '天（进行中）' }
      return { value: String(Math.abs(cd.days_left)), unit: '天前' }
    }

    /**
     * 把课程 id 显示成人认得的东西。
     *
     * 界面拿得到 `courses`（含 title 与 path），所以能显示"行测 / 资料分析"，
     * 而不是 `course-99c407ec`——后者是**存储 id**，不该出现在给人看的界面上。
     * 课被删了或不在清单里时如实退回 id（不假装有名字）。
     *
     * @param courses - 载荷里的课程清单。
     * @param id - 课程 node_id。
     * @returns 显示名或 null。
     */
    function courseLabelOf(courses, id) {
      if (typeof id !== 'string' || id === '') return null
      const hit = Array.isArray(courses) ? courses.find((c) => c !== null && c.node_id === id) : undefined
      if (hit === undefined) return id.replace(/^course-/, '')
      const name = Array.isArray(hit.path) && hit.path.length > 0 ? hit.path.join(' / ') : hit.title
      return typeof name === 'string' && name !== '' ? name : id.replace(/^course-/, '')
    }

    /**
     * 一条日程的行（含"更多操作"）。
     * @param props - item / busy / expanded / selected / 各回调。
     * @returns React 元素。
     */
    function ItemRow(props) {
      const item = props.item
      const status = STATUS[item.status] ?? STATUS.planned
      const [hover, setHover] = React.useState(false)
      return React.createElement(
        'div',
        {
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            padding: '5px 6px',
            borderRadius: '6px',
            background: props.selected
              ? 'var(--dsw-alias-bg-layer-2, #eef0f4)'
              : hover
                ? 'var(--dsw-alias-bg-layer-1, #f7f8fa)'
                : 'transparent',
            cursor: 'pointer',
          },
        },
        React.createElement(
          'div',
          { style: S.row, onClick: props.onSelect },
          // 状态那个字符（· / ✓ / ✗ / ↷）本身就是标记；不再有类型色点与类型标签
          // （作者 2026-10-10：界面不需要对日程分类）。
          React.createElement(Dot, { color: status.color }),
          React.createElement(
            'div',
            { style: S.rowTitle },
            React.createElement('span', { style: { color: status.color } }, `${status.mark} `),
            item.start === null ? null : React.createElement('span', { style: S.muted }, `${item.start}${item.end === null ? '' : `-${item.end}`}　`),
            React.createElement('span', {
              style: { textDecoration: item.status === 'cancelled' ? 'line-through' : 'none' },
            }, item.title),
            item.until === null
              ? null
              : React.createElement('div', { style: S.muted }, `${item.day} ~ ${item.until}`),
            props.courseName(item.course_id) === null
              ? null
              : React.createElement('div', { style: S.muted }, props.courseName(item.course_id)),
            item.session_id === null ? null : React.createElement('div', { style: S.muted }, `对话 ${shortId(item.session_id)}`),
            item.note === null ? null : React.createElement('div', { style: S.muted }, item.note),
            Array.isArray(item.appearances) && item.appearances.includes('done')
              ? React.createElement('div', { style: S.muted }, '（这天完成的）')
              : null,
          ),
        ),
        React.createElement(
          'div',
          { style: S.actionRow },
          item.status === 'planned'
            ? React.createElement(Btn, { label: '完成', disabled: props.busy, onClick: props.onDone })
            : React.createElement(Btn, { label: '恢复', disabled: props.busy, onClick: props.onReopen }),
          React.createElement(Btn, { label: props.expanded ? '收起' : '改', disabled: props.busy, onClick: props.onEdit }),
          item.status === 'cancelled'
            ? null
            : React.createElement(Btn, { label: '撤销', danger: true, disabled: props.busy, onClick: props.onCancel }),
        ),
        props.expanded
          ? React.createElement(EditItemForm, { item, busy: props.busy, onCancel: props.onEdit, onSubmit: props.onPatch })
          : null,
      )
    }

    /**
     * 新建日程的内联表单。
     *
     * ⚠ 受控输入（value + onChange）而不是非受控：dsh 会在同一棵树上重渲染很多次，
     *   非受控输入在重渲染时会把用户正在敲的字吞掉。
     *
     * @param props - day / busy / onSubmit / onCancel。
     * @returns React 元素。
     */
    function NewItemForm(props) {
      const [title, setTitle] = React.useState('')
      const [start, setStart] = React.useState('')
      const [end, setEnd] = React.useState('')
      const [isMilestone, setIsMilestone] = React.useState(false)
      const [note, setNote] = React.useState('')
      const canSubmit = title.trim() !== '' && props.busy !== true
      return React.createElement(
        'div',
        { style: S.card },
        React.createElement('div', { style: S.field },
          React.createElement('label', { style: S.label }, '学什么'),
          React.createElement('input', {
            style: S.input,
            value: title,
            placeholder: '如：资料分析 · 速算专项',
            onChange: (e) => setTitle(e.target.value),
          })),
        React.createElement('div', { style: S.two },
          React.createElement('div', { style: { ...S.field, flex: '1 1 0' } },
            React.createElement('label', { style: S.label }, '开始'),
            React.createElement('input', {
              style: S.input,
              value: start,
              placeholder: '09:00',
              onChange: (e) => setStart(e.target.value),
            })),
          React.createElement('div', { style: { ...S.field, flex: '1 1 0' } },
            React.createElement('label', { style: S.label }, '结束'),
            React.createElement('input', {
              style: S.input,
              value: end,
              placeholder: '10:00',
              onChange: (e) => setEnd(e.target.value),
            }))),
        // ⚠ 这里**不是**"给日程选分类"（作者 2026-10-10：界面不需要对日程分类）。
        //   它只回答一个问题：**这条是不是验收期**（要不要进下端那个带倒计时的区域）。
        //   所以它是一个复选框，而不是一个类型下拉——"是哪一种验收期"不需要人回答。
        React.createElement('label', { style: { ...S.label, display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
          React.createElement('input', {
            type: 'checkbox',
            checked: isMilestone,
            onChange: (e) => setIsMilestone(e.target.checked),
          }),
          '验收期'),
        React.createElement('div', { style: S.field },
          React.createElement('label', { style: S.label }, '备注'),
          React.createElement('input', {
            style: S.input,
            value: note,
            placeholder: '备注',
            onChange: (e) => setNote(e.target.value),
          })),
        React.createElement('div', { style: S.actionRow },
          React.createElement(Btn, {
            label: '建',
            primary: true,
            disabled: !canSubmit,
            onClick: () =>
              props.onSubmit({
                title: title.trim(),
                start: start.trim() === '' ? null : start.trim(),
                end: end.trim() === '' ? null : end.trim(),
                kind: isMilestone ? ACCEPTANCE_KIND : 'study',
                note: note.trim() === '' ? null : note.trim(),
              }),
          }),
          React.createElement(Btn, { label: '取消', onClick: props.onCancel })),
      )
    }

    /**
     * 改稿日程的内联表单（只放最常改的四个字段；绑课程/对话在右侧的对话列表里做）。
     * @param props - item / busy / onSubmit / onCancel。
     * @returns React 元素。
     */
    function EditItemForm(props) {
      const item = props.item
      const [day, setDay] = React.useState(item.day ?? '')
      const [until, setUntil] = React.useState(item.until ?? '')
      const [start, setStart] = React.useState(item.start ?? '')
      const [end, setEnd] = React.useState(item.end ?? '')
      const [note, setNote] = React.useState(item.note ?? '')
      const [title, setTitle] = React.useState(item.title ?? '')
      // 只暴露"是不是验收期"这一个问题（不暴露类型词表）。
      const [isMilestone, setIsMilestone] = React.useState(MILESTONE_KINDS.includes(item.kind))
      return React.createElement(
        'div',
        { style: { ...S.card, marginTop: '4px' } },
        React.createElement('div', { style: S.field },
          React.createElement('label', { style: S.label }, '标题'),
          React.createElement('input', { style: S.input, value: title, onChange: (e) => setTitle(e.target.value) })),
        React.createElement('div', { style: S.field },
          React.createElement('label', { style: S.label }, '日期'),
          React.createElement('input', { style: S.input, value: day, onChange: (e) => setDay(e.target.value) })),
        React.createElement('div', { style: S.field },
          React.createElement('label', { style: S.label }, '验收期最后一天'),
          React.createElement('input', {
            style: S.input,
            value: until,
            placeholder: 'YYYY-MM-DD',
            onChange: (e) => setUntil(e.target.value),
          })),
        React.createElement('label', { style: { ...S.label, display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
          React.createElement('input', {
            type: 'checkbox',
            checked: isMilestone,
            onChange: (e) => setIsMilestone(e.target.checked),
          }),
          '验收期'),
        React.createElement('div', { style: S.two },
          React.createElement('div', { style: { ...S.field, flex: '1 1 0' } },
            React.createElement('label', { style: S.label }, '开始'),
            React.createElement('input', { style: S.input, value: start, onChange: (e) => setStart(e.target.value) })),
          React.createElement('div', { style: { ...S.field, flex: '1 1 0' } },
            React.createElement('label', { style: S.label }, '结束'),
            React.createElement('input', { style: S.input, value: end, onChange: (e) => setEnd(e.target.value) }))),
        React.createElement('div', { style: S.field },
          React.createElement('label', { style: S.label }, '备注'),
          React.createElement('input', { style: S.input, value: note, onChange: (e) => setNote(e.target.value) })),
        React.createElement('div', { style: S.actionRow },
          React.createElement(Btn, {
            label: '保存',
            primary: true,
            disabled: props.busy === true,
            onClick: () =>
              props.onSubmit({
                title: title.trim(),
                day: day.trim(),
                until: until.trim(),
                kind: isMilestone ? ACCEPTANCE_KIND : 'study',
                start: start.trim(),
                end: end.trim(),
                note: note.trim(),
              }),
          }),
          React.createElement(Btn, { label: '取消', onClick: props.onCancel })),
      )
    }

    /**
     * 一段对话的一行（可绑到选中的日程）。
     * @param props - session / title / busy / canBind / onBind。
     * @returns React 元素。
     */
    function SessionLine(props) {
      const s = props.session
      const first = typeof s.first_at === 'string' ? s.first_at.slice(11, 16) : ''
      const last = typeof s.last_at === 'string' ? s.last_at.slice(11, 16) : ''
      return React.createElement(
        'div',
        { style: S.row },
        React.createElement('span', { style: S.muted }, '💬'),
        React.createElement(
          'div',
          { style: S.rowTitle },
          React.createElement('div', { style: { wordBreak: 'break-word' } }, props.title),
          React.createElement('div', { style: S.muted },
            `${s.events} 条事件${first === '' ? '' : `　${first}${last === '' || last === first ? '' : `-${last}`}`}` +
              `　${shortId(s.session_id)}`),
        ),
        props.canBind
          ? React.createElement(Btn, { label: '绑到这条', disabled: props.busy, onClick: props.onBind })
          : null,
      )
    }

    /**
     * 侧栏图标（`sidebar.panellist`）。
     * @param props - size / active。
     * @returns React 元素。
     */
    function CalendarIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      const active = props?.active === true
      const [hover, setHover] = React.useState(false)
      return React.createElement(
        'button',
        {
          type: 'button',
          title: '学习日历',
          'aria-label': '学习日历',
          onClick: () => openCalendar(),
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
            transition: `background ${MOTION.fast}ms ease`,
          },
        },
        '🗓',
      )
    }

    /**
     * 打开日历面板。
     *
     * 优先切到 main 面板；main 没注册成功时退回浮层。
     * 两条路都不可用时**不静默**——把原因打出来（学习者在浏览器 console 里看得到）。
     */
    function openPanel(panelId) {
      if (registeredPanels.has(panelId)) {
        try {
          if (layout !== null && typeof layout.selectPanel === 'function') {
            layout.selectPanel(panelId)
            return
          }
          // 没有 layout（未实测的层）：把话说明白，而不是让点击**什么都不发生**。
          console.warn(`[lh-schedule-ui] 拿不到 layout.selectPanel，无法切到 ${panelId}。浮层入口仍可用。`)
        } catch (error) {
          console.warn(`[lh-schedule-ui] selectPanel(${panelId}) 失败：${String(error?.message ?? error)}`)
        }
      }
      // 退回浮层（兜底入口：`main` 没注册成功时至少还能用日历）
      overlayOpen = true
      publish()
    }

    /**
     * 打开日历（保留这个名字，因为它读起来就是它的意思）。
     */
    function openCalendar() {
      openPanel(PANEL_ID)
    }

    /**
     * 兜底浮层（仅当 main 没注册成功时才真的有内容）。
     * @returns React 元素或 null。
     */
    function OverlayFallback() {
      const [, force] = React.useState(0)
      React.useEffect(() => subscribe(() => force((n) => n + 1)), [])
      if (!overlayOpen) return null
      return React.createElement(
        'div',
        { style: S.overlayPanel },
        React.createElement(
          'div',
          { style: S.header },
          React.createElement('span', { style: S.title }, '学习日历（兜底浮层）'),
          React.createElement('span', { style: { flex: '1 1 auto' } }),
          React.createElement(Btn, {
            label: '关闭',
            onClick: () => {
              overlayOpen = false
              publish()
            },
          }),
        ),
        React.createElement(CalendarPanel, {}),
      )
    }

    /**
     * 宿主**设置**里的一行：学习日历的选项。
     *
     * ═══ 为什么不自己做一个设置面板（作者问过这件事）═══
     * 现在只有一个选项，而宿主**已经**提供 `settings.general.item` 这个席位——
     * 它的目录原文就是 "a single setting that needs no page of its own"（`replaceRisk: none`，
     * 且不需要任何额外权限）。借它的好处：不新增入口、不新增面板、不新增一层导航；
     * 以后"隐藏已完成"之类的选项继续往这一行里加，最多变成一个小列表，仍不需要新面板。
     * 同一条路 `@lh/workspace-ui` 已经走过（它在同一个席位放"重载界面"）。
     *
     * @returns React 元素。
     */
    function CalendarOptionsRow() {
      const [, force] = React.useState(0)
      React.useEffect(() => subscribe(() => force((n) => n + 1)), [])
      return React.createElement(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' } },
        React.createElement('input', {
          type: 'checkbox',
          checked: showCancelled,
          onChange: (e) => setShowCancelled(e.target.checked),
        }),
        '显示已撤销的日程',
      )
    }

    /**
     * 插件体。
     * @param ctx - 插件上下文。
     */
    exports.apply = (ctx) => {
      ctxRef = ctx
      // 可选服务：拿不到也不影响装载（见 layout 的注释）。
      try {
        layout = ctx.get('layout') ?? null
      } catch {
        layout = null
      }

      // ── 中央面板：main key `lh-calendar`（**唯一**一个面板；待办是它的第三种读法）──
      //
      // 先注册 main：`selectPanel` 在 main 缺失时会抛错且不改选中态，
      // 所以顺序上先让面板就位，再让侧栏图标可用。
      ctx.slots.inject('main', () => {
        const dispose = ctx.slots.register({ name: 'main', key: PANEL_ID }, CalendarPanel)
        registeredPanels.add(PANEL_ID)
        publish()
        return dispose
      })

      // ── 侧栏图标：sidebar.panellist，**同名 id** ──
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, label: '学习日历' }, CalendarIcon),
      )

      // ── 兜底浮层（仅当 main 没注册成功时才渲染）──
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'lh-schedule-calendar' }, OverlayFallback),
      )

      // ── 宿主的设置里放一行：显示已撤销的日程 ──
      // 只有"需要人显式决定、且没法从别处推断"的界面偏好才配进设置；其余（比如验收期收不收）
      // 就地放在它自己的区域上——设置项越多，越没人看。
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register({ name: 'settings.general.item', id: 'lh-schedule-options', order: 94 }, CalendarOptionsRow),
      )
    }

    exports.name = 'lh-schedule-ui'

    // ⚠ 宿主门禁认的是**模块导出的** inject（服务名数组）。
    //   `package.json` 的 `dsh.client.inject` 是包名数组，只进 boot 清单，**不装配 fiber 的 inject**。
    //
    //   ⚠ `layout` 刻意**不**在这里声明：它只用于"切到中央面板"这一个动作，
    //   而 inject 少一个服务会让整个客户端插件装载失败（浏览器卡在 "Failed to load plugins"）。
    //   所以走 `ctx.get()` 可选访问，拿不到就退回浮层。
    exports.inject = ['slots']

    return exports
  },
})
