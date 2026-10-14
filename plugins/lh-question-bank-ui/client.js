/**
 * lh-question-bank-ui 的【客户端半】—— 题库管理面板。
 *
 * ═══ 它是什么形态 ═══
 * 与「课程目录」（`lh`）「学习日历」（`lh-calendar`）并列的**第三个中央面板**：
 *   · `main` 槽（keyed）注册 key `lh-bank` → 中央面板；
 *   · `sidebar.panellist`（list）注册**同名 id** `lh-bank` → 侧栏图标。
 * 两者必须**同时**注册：宿主侧栏的 `PanelRow` 处理体就是 `selectPanel(id)`，
 * 而 `selectPanel` 只校验"main 注册表里有没有这个 key"（宿主源码 `433242`），
 * 没有 id 白名单——只注册侧栏图标而 main 缺失，点击会抛错且不改选中态。
 *
 * ═══ 版式：左列题库 + 右列三段（作者 2026-10-13 定的形态）═══
 *   · 左列 = 题库清单（含"全部题库"与已归档区）——回答"我有哪些库"；
 *   · 右列 = 选中库的三段：**来源 / 题目 / 记录**——回答"这个库是什么、里面有什么、
 *     我做得怎么样"。三段可各自折叠（题多的库不必每次都滚过来源段）。
 *
 * ═══ 写走服务端路由，界面不拼事件 ═══
 * 浏览器**没有**事件日志与工作区的写权限，也不该有。归档/恢复各打一条 POST 路由，
 * 那条路由只做一次文件移动。**界面一个事件都不写**——这是本插件比"课程目录/日历"更窄的地方，
 * 理由见服务端半 `index.js` 顶部的注释。
 *
 * ═══ 会话标题从哪来：宿主给的 `useSessions` ═══
 * 它是 `main` 槽 standardProps 的一部分（Cordis Inspect 实测）。作答记录只带
 * `session_ref`（会话 id），标题要靠它翻——翻不到的（会话已删、或没坐标）
 * **如实显示短 id 或"无会话坐标"**，不猜、不显示别人的会话。
 *
 * ═══ 色彩与动效的纪律（我看不见界面，所以这两条是硬的，ADR-037 §11.2）═══
 * 1. 底色只用 surface 令牌（`--dsw-alias-bg-*`），文字只用 label 令牌（`--dsw-alias-label-*`），
 *    强调色（`brand-*` / `state-*`）**只做边框与圆点**。把强调色当底色 + 硬编白字，
 *    正是那次"白底白字"事故的形状。
 * 2. 动效只能内联样式能表达的（`transition` + 挂载后翻一个 state）——宿主明说
 *    "不要在组件外写 DOM / 不要 append 到 body"，所以没有 `<style>`、也就**没有 @keyframes**。
 *    `prefers-reduced-motion: reduce` 命中时整个关掉（而不是缩短一点）。
 */

window.__ModuleLoader__.load({
  id: '@lh/question-bank-ui',
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

    /** 简写：本文件创建元素的地方很多。 */
    const h = React.createElement

    /** 本插件服务端半的路由前缀。 */
    const API = '/lh/bank'

    /** 面板与侧栏图标共用的 id（两半必须同名）。 */
    const PANEL_ID = 'lh-bank'

    /** 界面偏好（纯偏好，不是事实——所以存浏览器本地，不进事件日志）。 */
    const LS_SELECTED = 'lh.bank.selected'
    const LS_OPEN = 'lh.bank.openSections'
    const LS_ARCHIVED = 'lh.bank.showArchived'
    const LS_ANSWERERS = 'lh.bank.answerers'

    /** 每次「加载更多」增加的条数。 */
    const PAGE_STEP = 50

    /** 动效时长（毫秒）。集中一处，便于整体调快/调慢并保持一致。 */
    const MOTION = { fast: 110, base: 160 }

    // ══════════════════════════════════════════════════════════════════════
    // 状态：模块级闭包 + 手写 subscribe/emit（seed 里只有 react/react-dom，没有状态库）
    // ══════════════════════════════════════════════════════════════════════

    /** ctx 存到模块级：apply 的作用域不是会话作用域，组件里只能从这里拿服务。 */
    let ctxRef = null

    /**
     * "切到中央面板"的可选能力。
     *
     * ⚠ 走 `ctx.get()` 而不是写进 `inject`：`inject` 少一个服务会让**整个客户端插件装载失败**
     * （浏览器卡在 `Failed to load plugins`），宁可退回兜底浮层也不要整块起不来。
     */
    let layout = null

    /**
     * `main` 面板是否真的注册成功。
     * 只有它成功了 `selectPanel(PANEL_ID)` 才不会抛错——所以点击处理器要先看它。
     */
    let mainRegistered = false

    /** 兜底浮层是否打开（只在 main 没注册成功时用得上）。 */
    let overlayOpen = false

    /** 界面状态。整体替换 + publish()，组件靠 useStore() 订阅。 */
    const state = {
      /** 选中的题库名，或 `'all'`（全部题库），或 null（还没选）。 */
      selected: readLocal(LS_SELECTED, null),
      /**
       * 「作答者」多选（默认只看用户）。空数组 = 什么都不显示（不是全选）。
       *
       * 默认必须只含 human：模型答对了不是我会了（ADR-018 决定 6）。
       */
      answerers: readAnswerers(),
      /** 「作答者」复选框浮层开着没有。 */
      answererOpen: false,
      /** `/banks` 的返回。 */
      banks: null,
      /** 选中库的三段：`{ source, questions, attempts }`。 */
      source: null,
      questions: null,
      attempts: null,
      loading: false,
      busy: false,
      error: null,
      notice: null,
      /** 三段各自的折叠状态。 */
      open: readOpen(),
      /** 题目段的筛选与分页（作者要求：表格 + 可选 10/20 题一页）。 */
      qFilters: { q: '', topic: '', kind: '', state: 'all' },
      qPage: 1,
      qPageSize: 5,
      /** 做题记录段的筛选与已加载条数（它是"往回翻"，用加载更多比翻页顺手）。 */
      aFilters: { verdict: 'all', source: '', session: '' },
      aPage: 1,
      aPageSize: 5,
      /** 展开看全文的那道题（一次只展开一道，避免整页被题干撑爆）。 */
      expanded: null,
      /** 正在看/写备注的那条作答（作答事件 id）；null = 都没开。 */
      noteFor: null,
      /** 备注草稿与种类（思路 / 反思）。 */
      noteDraft: '',
      noteKind: 'reflection',
      noteBusy: false,
      noteError: null,
    }

    /** 每页条数的可选项（作者 2026-10-13 指定：5 / 10 / 20）。 */
    const PAGE_SIZES = [5, 10, 20]

    /** 极简发布订阅。 */
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

    /** 组件用它订阅模块级状态。 */
    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => subscribe(() => force((n) => n + 1)), [])
    }

    /** 改状态并通知所有订阅者。 */
    function set(patch) {
      Object.assign(state, patch)
      publish()
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

    /** 读三段的折叠偏好（读不到就默认全展开）。 */
    function readOpen() {
      const raw = readLocal(LS_OPEN, '')
      if (raw === '') return { source: true, questions: true, attempts: true }
      const open = { source: false, questions: false, attempts: false }
      for (const key of raw.split(',')) if (key in open) open[key] = true
      return open
    }

    /** 存三段的折叠偏好。 */
    function writeOpen() {
      writeLocal(
        LS_OPEN,
        ['source', 'questions', 'attempts'].filter((k) => state.open[k]).join(','),
      )
    }

    /**
     * 读「作答者」多选偏好。
     *
     * 默认只勾「用户」：模型答对了不是我会了（ADR-018 决定 6）。
     * 存的是 `human` 或型号 id，逗号分隔。
     *
     * ⚠ 不能走 `readLocal`：它把空串当"没存过"，而**空选是正当状态**
     *（"我故意什么都不看"，writeAnswerers 照存）。这里直接读 localStorage：
     *   · key 不存在（null）→ 第一次用 → 默认 ['human']；
     *   · 空串 → 存过的空选 → 读回 []，不许悄悄变回 ['human']。
     */
    function readAnswerers() {
      let raw = null
      try {
        raw = window.localStorage.getItem(LS_ANSWERERS)
      } catch {
        raw = null
      }
      if (raw === null) return ['human']
      return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    }

    /** 存「作答者」多选偏好（空选也照存——"我故意什么都不看"是正当状态）。 */
    function writeAnswerers() {
      writeLocal(LS_ANSWERERS, state.answerers.join(','))
    }

    /**
     * 「作答者」按钮上的摘要文字。
     *
     * 规则：只勾用户 → 「用户」；只勾一个模型 → 那个型号；其余 → 「N 个作答者」。
     * 为什么不列全名：按钮宽度有限，而**勾了谁**在展开后一眼可见。
     */
    function answererSummary(selected, all) {
      const list = Array.isArray(selected) ? selected : []
      if (list.length === 0) return '（未选）'
      if (list.length === 1) {
        const hit = (all ?? []).find((a) => a.key === list[0])
        return hit?.label ?? list[0]
      }
      return `${list.length} 个作答者`
    }
    /** 会话 id 的展示短形态（末 6 位；完整 id 太长，而前缀都一样）。 */
    function shortId(id) {
      return typeof id === 'string' && id.length > 6 ? id.slice(-6) : String(id ?? '')
    }

    /** ISO 时间戳 → 浏览器本地的 `MM-DD HH:mm`。 */
    function localTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return iso
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    /** 毫秒 → 人读的用时。 */
    function durationText(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      if (ms < 1000) return `${ms}ms`
      return `${(ms / 1000).toFixed(1)}s`
    }

    /** 取一个非空字符串，否则 null。 */
    function textOrNull(value) {
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    }

    /**
     * 题干预览：压掉换行、截断到 `n` 字。
     *
     * ⚠ 与 `view.js` 的 `previewStem` **是同一件事的两份实现**，这是本文件里唯一一处
     * 有意重复：客户端是手工 bundle，只能 `require('react')`，**取不到 view.js**
     * （它在服务端那一侧）。判据只有"压空白 + 截断"两条，所以漂移风险极小；
     * 一旦要动它（比如改省略号样式），**两处必须一起改**。
     *
     * @param stem - 题干。
     * @param n - 最多多少字。
     * @returns 预览文本。
     */
    function previewStem(stem, n) {
      const limit = typeof n === 'number' && n > 0 ? n : 60
      const s = String(stem ?? '').replace(/\s+/g, ' ').trim()
      return s.length <= limit ? s : `${s.slice(0, limit)}…`
    }

    /** 百分比文案（null → 未知，不是 0%）。 */
    function percentText(value) {
      return typeof value === 'number' ? `${Math.round(value * 100)}%` : '—'
    }

    // ── 与服务端半说话 ──

    /** GET 一个 JSON 路由；非 2xx 时把服务端那句话原样抛出（它本来就写成了"读者能照做"的形状）。 */
    async function getJson(path) {
      const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? body?.detail ?? `HTTP ${res.status}`)
      return body
    }

    /** POST 一个 JSON 路由。 */
    async function postJson(path, payload) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      return body
    }

    /**
     * 拼查询串（跳过空值——空筛选不该变成 `state=`）。
     *
     * ⚠ 唯一的例外是 `answerers`：它的空串**有意义**（"一个都不选"），
     * 跳过它服务端就退回粗口径，"一个都没勾 = 不显示任何记录"会被静默打翻。
     */
    function qs(pairs) {
      const parts = []
      for (const [key, value] of Object.entries(pairs)) {
        if (value === null || value === undefined) continue
        if (value === '' && key !== 'answerers') continue
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      }
      return parts.length === 0 ? '' : `?${parts.join('&')}`
    }

    // ══════════════════════════════════════════════════════════════════════
    // 取数
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 拉全部数据：题库清单 + （选中某个库时）它的三段。
     *
     * ═══ 为什么"全部题库"只拉记录段 ═══
     * 来源与题目是**某一个库**的属性；跨库问"来源"没有意义（每个库的出处不同）。
     * 所以选"全部题库"时只列跨库的记录——那正是"我今天/这周做了多少题"要看的东西。
     */
    async function refresh() {
      set({ loading: true, error: null })
      try {
        const banks = await getJson(`/banks${qs({ answerers: state.answerers.join(',') })}`)
        // 选中的库可能已经不在了（被归档/改名）→ 退回第一个库，而不是显示一片空白
        const names = (banks?.banks ?? []).map((b) => b.name)
        let selected = state.selected
        if (selected === null || (selected !== 'all' && !names.includes(selected))) {
          selected = names[0] ?? 'all'
        }
        writeLocal(LS_SELECTED, selected)

        if (selected === 'all') {
          const attempts = await getJson(`/attempts${qs({ bank: 'all', limit: state.aPageSize, offset: (state.aPage - 1) * state.aPageSize, answerers: state.answerers.join(','), ...state.aFilters })}`)
          set({ banks, selected, source: null, questions: null, attempts, loading: false })
          return
        }

        const [source, questions, attempts] = await Promise.all([
          getJson(`/source${qs({ name: selected })}`),
          getJson(`/questions${qs({ name: selected, limit: state.qPageSize, offset: (state.qPage - 1) * state.qPageSize, answerers: state.answerers.join(','), ...state.qFilters })}`),
          getJson(`/attempts${qs({ bank: selected, limit: state.aPageSize, offset: (state.aPage - 1) * state.aPageSize, answerers: state.answerers.join(','), ...state.aFilters })}`),
        ])
        set({ banks, selected, source, questions, attempts, loading: false })
      } catch (error) {
        set({ loading: false, error: String(error?.message ?? error) })
      }
    }

    /** 换一个有内容的库并重拉。 */
    async function selectBank(name) {
      if (state.selected === name) return
      state.selected = name
      writeLocal(LS_SELECTED, name)
      // 换库时把筛选与展开清掉：上一个库的知识点/会话筛选套到新库上会得到空列表，
      // 而"空"与"这个库真没有"从外面看一模一样。
      state.qFilters = { q: '', topic: '', kind: '', state: 'all' }
      state.aFilters = { verdict: 'all', source: '', session: '' }
      state.qPage = 1
      state.aPage = 1
      state.expanded = null
      state.source = null
      state.questions = null
      state.attempts = null
      publish()
      await refresh()
    }

    /** 归档：把一个库移进归档区（可逆）。 */
    async function archiveSelected() {
      const name = state.selected
      if (name === null || name === 'all') return
      set({ busy: true, notice: null })
      try {
        const res = await postJson('/archive', { bank: name })
        set({ busy: false, notice: { kind: 'ok', text: `${name} 已归档（文件在归档区，内容一个字没动）。` } })
        state.selected = null
        await refresh()
        // res.note 是服务端给的说明，界面不重复它——但失败时要用它的原话
        void res
      } catch (error) {
        set({ busy: false, notice: { kind: 'bad', text: String(error?.message ?? error) } })
      }
    }

    /** 恢复：把一个归档库移回工作区。 */
    async function restoreBank(name) {
      set({ busy: true, notice: null })
      try {
        const res = await postJson('/restore', { bank: name })
        set({ busy: false, notice: { kind: 'ok', text: `${name} 已恢复。` }, loading: false })
        await refresh()
        void res
      } catch (error) {
        set({ busy: false, notice: { kind: 'bad', text: String(error?.message ?? error) } })
      }
    }

    /**
     * 题目段重拉（筛选变了 / 翻页 / 换每页条数）。
     *
     * ═══ 为什么改成 offset 翻页而不是"limit 一直长" ═══
     * 作者要的是**表格 + 分页**：第几页/共几页是表格该有的东西，而"加载更多"给不出页码。
     * 服务端的 `/questions` 本来就收 `offset`，所以这一改只是换个取法，不动协议。
     *
     * @param params.page - 目标页（1 起）；省略则用当前页。
     * @param params.size - 每页条数（5 / 10 / 20）；省略则用当前值。
     */
    async function reloadQuestions({ page, size } = {}) {
      const name = state.selected
      if (name === null || name === 'all') return
      if (typeof size === 'number' && PAGE_SIZES.includes(size)) {
        state.qPageSize = size
        state.qPage = 1 // 换了每页条数，页码归位——否则"第 3 页"可能超出新的总页数
      }
      if (typeof page === 'number' && page >= 1) state.qPage = page
      // 展开的那道题如果不在这一页了，把展开收掉（否则会留下一个"看不见却记得住"的状态）
      state.expanded = null
      set({ loading: true, error: null })
      try {
        const questions = await getJson(
          `/questions${qs({
            name,
            limit: state.qPageSize,
            offset: (state.qPage - 1) * state.qPageSize,
            // 与 refresh() 同形：题目行的"作答"列按作答者口径统计，漏了它翻页后会退回 human 口径
            answerers: state.answerers.join(','),
            ...state.qFilters,
          })}`,
        )
        set({ questions, loading: false })
      } catch (error) {
        set({ loading: false, error: String(error?.message ?? error) })
      }
    }

    /**
     * 做题记录段重拉（筛选变了 / 翻页 / 换每页条数）。
     *
     * 与题目段同一套做法（offset 翻页）：页码是表格该有的东西，而「加载更多」给不出页码。
     *
     * @param params.page - 目标页（1 起）。
     * @param params.size - 每页条数（5 / 10 / 20）。
     */
    async function reloadAttempts({ page, size } = {}) {
      if (typeof size === 'number' && PAGE_SIZES.includes(size)) {
        state.aPageSize = size
        state.aPage = 1 // 换了每页条数，页码归位
      }
      if (typeof page === 'number' && page >= 1) state.aPage = page
      set({ loading: true, error: null })
      try {
        const bank = state.selected === 'all' ? 'all' : state.selected
        const attempts = await getJson(
          `/attempts${qs({ bank, limit: state.aPageSize, offset: (state.aPage - 1) * state.aPageSize, answerers: state.answerers.join(','), ...state.aFilters })}`,
        )
        set({ attempts, loading: false })
      } catch (error) {
        set({ loading: false, error: String(error?.message ?? error) })
      }
    }

    /**
     * 保存一条备注（走**与 agent 工具同一份代码**的服务端路由）。
     *
     * 备注是**注解**（只追加）：这里不做"编辑覆盖"、也不发 `supersedes`——
     * 再写一条就是新的一条（"编辑 = 新备注 + supersedes 指向旧的"是 API 的正路，面板没接）。
     */
    async function saveNote(attemptEventId, questionId) {
      const text = state.noteDraft.trim()
      if (text === '') {
        // 空备注不写：它只会变成噪声（服务端也会拒，这里先给一句人话）
        set({ noteError: '不想写就不写，不必存一条空的。' })
        return
      }
      set({ noteBusy: true, noteError: null })
      try {
        await postJson('/note', {
          attempt_event_id: attemptEventId ?? undefined,
          question_id: questionId ?? undefined,
          text,
          note_kind: state.noteKind,
        })
        set({ noteBusy: false, noteDraft: '', noteFor: null })
        await reloadAttempts()
      } catch (error) {
        set({ noteBusy: false, noteError: String(error?.message ?? error) })
      }
    }
    // ══════════════════════════════════════════════════════════════════════
    // 样式（只用主题令牌，见文件头第 1 条纪律）
    //
    // ═══ 视觉对比怎么来的（作者 2026-10-13 要求"添加色彩对比"）═══
    // 我看不见界面，所以"对比"这件事只能靠**层次**而不是靠手调色值：
    //   底色三层：左列用 `--dsw-specific-sidebar-fill`（它本来就是"侧栏列"的令牌），
    //   右列用 `--dsw-alias-bg-base`，卡片用 `bg-layer-1`，表头/表尾用 `bg-layer-2`；
    //   卡片之间靠 1px `border-l1` + 圆角 + 极浅投影分开。
    // 颜色只出现在**非文字**的地方（圆点 / 左侧色条 / 描边 / 表头小方块）——
    // 这条是 ADR-037 §11.2 的铁律：强调色当底色 + 硬编白字就是那次"白底白字"事故。
    // 文字永远是 label-primary / label-secondary，对比度由主题自己保证。
    // ══════════════════════════════════════════════════════════════════════

    /** 语义色（只用于圆点、色条、描边）。 */
    const COLOR = {
      brand: 'var(--dsw-alias-brand-primary, #3b82f6)',
      ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
      bad: 'var(--dsw-alias-state-error-primary, #dc2626)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      idle: 'var(--dsw-alias-state-idle-primary, #9ca3af)',
    }

    /** 题型的**标记色**：只为"一眼看出这页里题型杂不杂"，不代表好坏。 */
    const KIND_COLOR = {
      single_choice: COLOR.brand,
      multiple_choice: COLOR.warn,
      fill_blank: COLOR.ok,
      other: COLOR.idle,
    }

    /** 四态结果的标记色。无法判别用 idle——**它不是失败**，是"没判"（ADR-018 决定 5）。 */
    const VERDICT_COLOR = { correct: COLOR.ok, partial: COLOR.warn, wrong: COLOR.bad, unjudged: COLOR.idle }

    /**
     * 省略号的**四件套**：`nowrap + hidden + ellipsis + minWidth:0`。
     * 最后一条最容易被忘——flex/grid 子项的默认最小尺寸是 `auto`（min-content），
     * 少了它前面的 `ellipsis` 根本不生效（ADR-037 §11.7 踩过）。
     */
    const ELLIPSIS = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }

    /** 表格的列宽模板：`minmax(0, …)` 是硬要求——`1fr` 的下限是 min-content，会被长内容撑破。 */
    const Q_COLS = '64px minmax(0, 1fr) 108px 92px 76px'
    const A_COLS = '92px minmax(0, 1fr) 76px 68px 84px 108px 56px minmax(0, 132px) 56px'

    const S = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #111)',
        fontSize: '13px',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-1, #fafafa)',
        flex: '0 0 auto',
      },
      title: { fontWeight: 600, fontSize: '14px' },
      sub: { color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '12px' },
      body: { display: 'flex', flex: '1 1 auto', minHeight: 0 },
      left: {
        flex: '0 0 264px',
        minWidth: 0,
        borderRight: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        // 侧栏列专用令牌：它就是"让这一列与主区拉开层次"用的
        background: 'var(--dsw-specific-sidebar-fill, #f7f8fa)',
        overflowY: 'auto',
        padding: '8px',
      },
      right: { flex: '1 1 auto', minWidth: 0, overflowY: 'auto', padding: '12px 14px' },
      section: {
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1, #fafafa)',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        marginBottom: '12px',
        overflow: 'hidden',
      },
      sectionHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
        cursor: 'pointer',
        userSelect: 'none',
      },
      /** 段标题左侧的**色条**：三段各一色，靠它一眼认出自己在哪一段。 */
      sectionBar: (color) => ({ flex: '0 0 auto', width: '3px', height: '14px', borderRadius: '2px', background: color }),
      /** 左侧色条（表行 / 列表行共用）：空的时候留白，避免整列文字左右跳动。 */
      rowBar: (color) => ({ flex: '0 0 auto', width: '3px', alignSelf: 'stretch', borderRadius: '2px', background: color ?? 'transparent' }),
      sectionTitle: { fontWeight: 600, flex: '0 0 auto' },
      sectionBody: { padding: '4px 10px 10px' },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 8px',
        borderRadius: '6px',
        minWidth: 0,
      },
      chip: {
        flex: '0 0 auto',
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        borderRadius: '999px',
        padding: '0 6px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      },
      dot: (color) => ({
        flex: '0 0 auto',
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: color,
      }),
      pill: (color) => ({
        flex: '0 0 auto',
        border: `1px solid ${color}`,
        borderRadius: '999px',
        padding: '0 6px',
        fontSize: '11px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary, #111)',
        whiteSpace: 'nowrap',
      }),
      notice: (kind) => ({
        margin: '0 0 10px',
        padding: '6px 8px',
        borderRadius: '6px',
        fontSize: '12px',
        border: `1px solid ${kind === 'bad' ? 'var(--dsw-alias-state-error-primary, #dc2626)' : 'var(--dsw-alias-state-success-primary, #16a34a)'}`,
        color: 'var(--dsw-alias-label-primary, #111)',
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
      }),
      notes: {
        margin: '6px 0 0',
        padding: '6px 8px',
        borderRadius: '6px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
      },
      table: {
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        borderRadius: '8px',
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-base, #fff)',
      },
      /** 表头：抬一层底色 + 一条稍重的下边界，和表体拉开。 */
      thead: {
        display: 'grid',
        gap: '6px',
        padding: '5px 8px',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
        borderBottom: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
      },
      /** 表体行：外框由容器给，行之间只用一条极浅的线。 */
      tr: {
        display: 'grid',
        gap: '6px',
        alignItems: 'center',
        padding: '6px 8px',
        minWidth: 0,
        borderTop: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        transition: `background ${MOTION.fast}ms ease`,
      },
      cell: { ...ELLIPSIS, fontSize: '12px' },
      /** 表尾：分页条所在的横条，与表头同底色，形成"框住表体"的观感。 */
      tfoot: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 8px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
        borderTop: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        flexWrap: 'wrap',
      },
      /** 展开区（题干全文 + 选项 + 答案 + 解析）：比表体再抬一层，一眼看出"这是展开出来的"。 */
      expandBox: {
        padding: '8px 10px',
        borderTop: '1px dashed var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-1, #fafafa)',
      },
      input: {
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #111)',
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        borderRadius: '6px',
        padding: '3px 6px',
        fontSize: '12px',
        minWidth: 0,
      },
      iconButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        borderRadius: '6px',
      },
      overlayWrap: {
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-bg-overlay, rgba(0,0,0,0.4))',
        zIndex: 60,
      },
      overlayPanel: {
        width: 'min(1100px, 92vw)',
        height: 'min(760px, 88vh)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-alias-bg-base, #fff)',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        borderRadius: '10px',
        overflow: 'hidden',
      },
      kbd: {
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        borderRadius: '4px',
        padding: '0 4px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
    }

    /** 一个统一的小按钮（不用宿主组件，避免版本耦合）。 */
    function Btn(props) {
      const [hover, setHover] = React.useState(false)
      const disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          title: props.title,
          disabled,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            ...S.chip,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            background: hover && !disabled ? 'var(--dsw-alias-bg-layer-1, #f7f8fa)' : 'transparent',
            borderColor: props.primary
              ? 'var(--dsw-alias-brand-primary, #3b82f6)'
              : 'var(--dsw-alias-border-l2, #d1d5db)',
            color: 'var(--dsw-alias-label-primary, #111)',
            padding: '2px 8px',
            transition: `background ${MOTION.fast}ms ease`,
          },
        },
        props.label,
      )
    }

    /** 挂载后翻一个 state 的入场动效（内联样式能做的最多也就是它）。 */
    function useEnterStyle(key) {
      const [on, setOn] = React.useState(false)
      React.useEffect(() => {
        let raf = 0
        // 必须等一帧，否则同一帧内 0 → 1 不产生过渡（内联动效最常见的哑火原因）
        raf = window.requestAnimationFrame(() => setOn(true))
        return () => window.cancelAnimationFrame(raf)
      }, [key])
      const reduce =
        typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduce) return { transition: 'none' }
      return {
        opacity: on ? 1 : 0,
        transform: on ? 'none' : 'translateY(2px)',
        transition: `opacity ${MOTION.base}ms ease, transform ${MOTION.base}ms ease`,
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 组件
    // ══════════════════════════════════════════════════════════════════════

    /** 从 useSessions 的快照里取 `{ byId }`（兼容包装形状；认不出就返回空表——不猜）。 */
    function sessionsById(snapshot) {
      const s = snapshot?.byId !== undefined ? snapshot : snapshot?.value
      const byId = s?.byId
      return byId !== null && typeof byId === 'object' ? byId : Object.create(null)
    }

    /** 会话标题：拿不到就退回短 id；没坐标返回 null（界面显示"无会话坐标"）。 */
    function sessionLabel(id, sessions) {
      if (typeof id !== 'string' || id === '') return null
      const row = sessions[id]
      const title = textOrNull(row?.title)
      return { id, short: shortId(id), title }
    }

    /**
     * 一段的外壳（色条 + 标题 + 计数 + 折叠）。
     *
     * @param props - `{ id, title, accent, count, children, extra }`；`accent` 是这段的标记色。
     * @returns React 元素。
     */
    function Section(props) {
      const open = state.open[props.id] === true
      return h(
        'div',
        { style: S.section },
        h(
          'div',
          {
            style: S.sectionHead,
            onClick: () => {
              state.open[props.id] = !open
              writeOpen()
              publish()
            },
          },
          h('span', { style: S.sectionBar(props.accent ?? COLOR.brand) }),
          h('span', { style: S.sectionTitle }, props.title),
          typeof props.count === 'number' ? h('span', { style: S.chip }, String(props.count)) : null,
          h('span', { style: { flex: '1 1 auto' } }),
          props.extra ?? null,
          // 折叠箭头用字符，并用 transform 过渡——**没有 @keyframes**（宿主不许注入 style）
          h(
            'span',
            {
              style: {
                ...S.sub,
                flex: '0 0 auto',
                display: 'inline-block',
                transform: open ? 'rotate(90deg)' : 'none',
                transition: `transform ${MOTION.base}ms ease`,
              },
            },
            '▶',
          ),
        ),
        open ? h('div', { style: S.sectionBody }, props.children) : null,
      )
    }

    /** 如实说明的一块（服务端给的 notes）。 */
    function Notes(props) {
      const list = Array.isArray(props.notes) ? props.notes : []
      if (list.length === 0) return null
      return h(
        'div',
        { style: S.notes },
        list.map((n, i) => h('div', { key: i }, n)),
      )
    }

    /** 左列：题库清单 + 已归档区。 */
    function BankList() {
      const banks = state.banks?.banks ?? []
      const archived = state.banks?.archived ?? []
      const showArchived = readLocal(LS_ARCHIVED, '1') === '1'
      const totals = state.banks?.totals ?? {}
      return h(
        'div',
        null,
        h(
          'div',
          { style: { ...S.row, padding: '4px 8px' } },
          h('span', { style: { ...S.sub, flex: '1 1 auto' } }, `题库 ${totals.bank_count ?? 0} · 题 ${totals.question_count ?? 0}`),
        ),
        h(
          'div',
          {
            style: {
              ...S.row,
              cursor: 'pointer',
              border: state.selected === 'all' ? '1px solid var(--dsw-alias-brand-primary, #3b82f6)' : '1px solid transparent',
              background: 'var(--dsw-alias-bg-layer-1, #fafafa)',
            },
            onClick: () => void selectBank('all'),
          },
          h('span', { style: { ...ELLIPSIS, flex: '1 1 auto' } }, '全部题库'),
          h('span', { style: S.chip }, String(totals.matched_attempt_count ?? 0)),
        ),
        banks.map((b) =>
          h(
            'div',
            {
              key: b.name,
              style: {
                ...S.row,
                cursor: 'pointer',
                border: state.selected === b.name ? '1px solid var(--dsw-alias-brand-primary, #3b82f6)' : '1px solid transparent',
              },
              onClick: () => void selectBank(b.name),
              title: b.path ?? b.name,
            },
            h('span', {
              style: S.dot(
                b.ok
                  ? 'var(--dsw-alias-state-success-primary, #16a34a)'
                  : 'var(--dsw-alias-state-error-primary, #dc2626)',
              ),
            }),
            h('span', { style: { ...ELLIPSIS, flex: '1 1 auto' } }, b.title || b.name),
            h('span', { style: S.chip }, `${b.question_count} 题`),
            b.attempts !== undefined && b.attempts !== null
              ? h('span', { style: { ...S.chip, borderColor: 'transparent' } }, `${b.attempts.attempted} 做过`)
              : null,
          ),
        ),
        archived.length > 0
          ? h(
              'div',
              { style: { marginTop: '8px' } },
              h(
                'div',
                {
                  style: { ...S.row, cursor: 'pointer', padding: '4px 8px' },
                  onClick: () => {
                    writeLocal(LS_ARCHIVED, showArchived ? '0' : '1')
                    publish()
                  },
                },
                h('span', { style: { ...S.sub, flex: '1 1 auto' } }, `已归档 ${archived.length}`),
                h('span', { style: S.sub }, showArchived ? '收起' : '展开'),
              ),
              showArchived
                ? archived.map((a) =>
                    h(
                      'div',
                      { key: a.name, style: S.row },
                      h('span', { style: { ...ELLIPSIS, flex: '1 1 auto' } }, a.title || a.name),
                      h('span', { style: S.chip }, `${a.question_count} 题`),
                      h(Btn, {
                        label: state.busy ? '…' : '恢复',
                        disabled: state.busy,
                        onClick: () => void restoreBank(a.name),
                      }),
                    ),
                  )
                : null,
            )
          : null,
      )
    }

    /** 来源段。 */
    function SourceSection() {
      const s = state.source
      const extra = h(
        'span',
        { style: { ...S.sub, flex: '0 0 auto' } },
        s?.source_root ? String(s.source_root) : '无来源根',
      )
      if (s === null) {
        return h(Section, { id: 'source', title: '来源', accent: COLOR.ok, extra }, h('div', { style: S.sub }, state.selected === 'all' ? '选一个题库看它的来源' : '读取中…'))
      }
      const cov = s.coverage ?? {}
      return h(
        Section,
        { id: 'source', title: '来源', accent: COLOR.ok, extra },
        h(
          'div',
          { style: { ...S.row, flexWrap: 'wrap' } },
          h('span', { style: S.chip }, `抽取：${s.method ?? '未记'}`),
          s.model ? h('span', { style: S.chip }, `模型：${s.model}`) : null,
          h('span', { style: S.chip }, `生成于 ${localTime(s.generated_at)}`),
          s.answer_source_file ? h('span', { style: S.chip }, `答案来自：${s.answer_source_file}`) : null,
        ),
        h(
          'div',
          { style: { ...S.row, flexWrap: 'wrap' } },
          h('span', { style: S.chip }, `带知识点 ${cov.with_topics ?? 0}/${s.bank?.question_count ?? 0}`),
          cov.without_analysis > 0 ? h('span', { style: S.chip }, `缺解析 ${cov.without_analysis}`) : null,
          (cov.unmapped_topics ?? []).length > 0
            ? h('span', { style: S.chip }, `词表外标签 ${(cov.unmapped_topics ?? []).length}`)
            : null,
          (cov.duplicate_ids ?? []).length > 0 ? h('span', { style: S.chip }, `重复 id ${cov.duplicate_ids.length}`) : null,
        ),
        h(
          'div',
          { style: { marginTop: '6px' } },
          (s.source_files ?? []).map((f, i) =>
            h(
              'div',
              { key: i, style: { ...S.row, padding: '3px 0' }, title: f.path },
              h('span', { style: { ...ELLIPSIS, flex: '1 1 auto', fontSize: '12px' } }, f.path),
              h('span', { style: S.chip }, `${f.question_count} 题`),
              f.first_number !== null && f.first_number !== undefined
                ? h('span', { style: S.chip }, `${f.first_number} … ${f.last_number ?? f.first_number}`)
                : null,
              (f.pages ?? []).length > 0 ? h('span', { style: S.chip }, `页 ${f.pages.join('/')}`) : null,
            ),
          ),
        ),
        (s.import_events ?? []).length > 0
          ? h(
              'div',
              { style: { marginTop: '6px' } },
              h('div', { style: { ...S.sub, marginBottom: '2px' } }, '导入事件（日志里的佐证）'),
              (s.import_events ?? []).map((e, i) =>
                h(
                  'div',
                  { key: i, style: { ...S.row, padding: '3px 0' }, title: e.bank_path ?? '' },
                  h('span', { style: { ...S.chip, borderColor: 'transparent' } }, localTime(e.timestamp)),
                  h('span', { style: { ...ELLIPSIS, flex: '1 1 auto', fontSize: '12px' } }, e.bank_path ?? '(无路径)'),
                  h('span', { style: S.chip }, `+${e.added_count ?? 0}/换${e.replaced_count ?? 0}/拒${e.rejected_count ?? 0}`),
                  e.model ? h('span', { style: S.chip }, e.model) : null,
                  e.in_workspace === false ? h('span', { style: S.chip }, '别的工作区') : null,
                ),
              ),
            )
          : null,
        h(Notes, { notes: s.notes }),
      )
    }

    /** 题目段：筛选 + 列表 + 展开看全文。 */
    /**
     * 一条可 hover 的行（表格行 / 列表行共用）。
     *
     * 为什么单独抽一个组件：hover 是**状态**，而 state 只能待在组件里。
     * 动效只用 `transition`（宿主不许注入 `<style>`，所以没有 @keyframes）。
     *
     * @param props - `{ style, selected, onClick, title, children }`。
     * @returns React 元素。
     */
    function HoverRow(props) {
      const [hover, setHover] = React.useState(false)
      const picked = props.selected === true
      return h(
        'div',
        {
          style: {
            ...props.style,
            cursor: props.onClick === undefined ? 'default' : 'pointer',
            background: picked
              ? 'var(--dsw-alias-bg-layer-2, #f3f4f6)'
              : hover
                ? 'var(--dsw-alias-bg-layer-1, #fafafa)'
                : 'transparent',
          },
          title: props.title,
          onClick: props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        props.children,
      )
    }

    /**
     * 分页条（表格页脚）。
     *
     * @param props - `{ total, page, pageSize, loading, onPage, onSize }`。
     * @returns React 元素。
     */
    function Pagination(props) {
      const unit = typeof props.unit === 'string' ? props.unit : '题'
      const size = typeof props.pageSize === 'number' && props.pageSize > 0 ? props.pageSize : 10
      const pages = Math.max(1, Math.ceil((props.total ?? 0) / size))
      const page = Math.min(Math.max(1, props.page ?? 1), pages)
      const btn = (label, target, disabled) =>
        h(Btn, { label, disabled: disabled === true || props.loading === true, onClick: () => props.onPage(target) })
      return h(
        'div',
        { style: S.tfoot },
        h('span', null, `共 ${props.total ?? 0} ${unit}`),
        h('span', { style: { flex: '1 1 auto' } }),
        h('span', null, '每页'),
        ...PAGE_SIZES.map((n) =>
          h(
            'button',
            {
              key: n,
              type: 'button',
              onClick: () => props.onSize(n),
              style: {
                ...S.chip,
                cursor: 'pointer',
                // 选中态用**描边 + 更亮一层底**表达，不用强调色当底色（令牌铁律）
                borderColor: n === size ? COLOR.brand : 'var(--dsw-alias-border-l2, #d1d5db)',
                background: n === size ? 'var(--dsw-alias-bg-base, #fff)' : 'transparent',
                color: 'var(--dsw-alias-label-primary, #111)',
                fontWeight: n === size ? 600 : 400,
                padding: '2px 8px',
                transition: `background ${MOTION.fast}ms ease, border-color ${MOTION.fast}ms ease`,
              },
            },
            String(n),
          ),
        ),
        h('span', { style: { ...S.kbd, marginLeft: '4px' } }, `${page} / ${pages}`),
        btn('‹ 上一页', page - 1, page <= 1),
        btn('下一页 ›', page + 1, page >= pages),
      )
    }

    /** 题目段：**表格 + 分页**（作者 2026-10-13 要求表格、10/20 题一页）。 */
    function QuestionsSection() {
      const v = state.questions
      // ⚠ hook 必须在**任何分支之前**调用：它的内部是 useState/useEffect，
      //   而"某次渲染少调一个 hook"会让 React 直接抛错（表现为白屏）。
      //   换页/换库/换筛选时 key 变 → 入场动效重播。
      const enter = useEnterStyle(`q-${state.selected}-${state.qPage}-${state.qPageSize}-${state.qFilters.topic}-${state.qFilters.kind}-${state.qFilters.state}`)
      const extra = v ? h('span', { style: { ...S.sub, flex: '0 0 auto' } }, `${v.total}/${v.bank_total}`) : null
      if (v === null || state.selected === 'all') {
        return h(
          Section,
          { id: 'questions', title: '题目', accent: COLOR.brand, extra },
          h('div', { style: S.sub }, state.selected === 'all' ? '选一个题库看它的题目' : '读取中…'),
        )
      }
      const filterRow = h(
        'div',
        { style: { ...S.row, flexWrap: 'wrap', gap: '6px', padding: '2px 0 8px' } },
        h('input', {
          style: { ...S.input, width: '160px' },
          placeholder: '筛题干',
          value: state.qFilters.q,
          onChange: (e) => {
            state.qFilters.q = e.target.value
            publish()
          },
          onKeyDown: (e) => {
            if (e.key === 'Enter') void reloadQuestions({ page: 1 })
          },
        }),
        h(
          'select',
          {
            style: S.input,
            value: state.qFilters.topic,
            onChange: (e) => {
              state.qFilters.topic = e.target.value
              void reloadQuestions({ page: 1 })
            },
          },
          h('option', { value: '' }, '全部知识点'),
          (v.topics ?? []).map((t) => h('option', { key: t, value: t }, t)),
        ),
        h(
          'select',
          {
            style: S.input,
            value: state.qFilters.kind,
            onChange: (e) => {
              state.qFilters.kind = e.target.value
              void reloadQuestions({ page: 1 })
            },
          },
          h('option', { value: '' }, '全部题型'),
          h('option', { value: 'single_choice' }, '单选'),
          h('option', { value: 'multiple_choice' }, '多选'),
          h('option', { value: 'fill_blank' }, '填空'),
          h('option', { value: 'other' }, '其他'),
        ),
        h(
          'select',
          {
            style: S.input,
            value: state.qFilters.state,
            onChange: (e) => {
              state.qFilters.state = e.target.value
              void reloadQuestions({ page: 1 })
            },
          },
          h('option', { value: 'all' }, '全部'),
          h('option', { value: 'unseen' }, '未作答'),
          h('option', { value: 'done' }, '已作答'),
          h('option', { value: 'wrong' }, '最近错误'),
        ),
        h(Btn, { label: '筛选', primary: true, onClick: () => void reloadQuestions({ page: 1 }) }),
      )

      return h(
        Section,
        { id: 'questions', title: '题目', accent: COLOR.brand, extra },
        filterRow,
        v.items.length === 0
          ? h('div', { style: S.sub }, '当前筛选下无题目')
          : h(
              'div',
              { style: { ...S.table, ...enter } },
              h(
                'div',
                { style: { ...S.thead, gridTemplateColumns: Q_COLS } },
                h('span', null, '题号'),
                h('span', null, '题干'),
                h('span', null, '知识点'),
                h('span', null, '作答'),
                h('span', null, '详情'),
              ),
              v.items.map((q) => renderQuestion(q)),
              h(Pagination, {
                total: v.total,
                page: state.qPage,
                pageSize: state.qPageSize,
                loading: state.loading,
                onPage: (p) => void reloadQuestions({ page: p }),
                onSize: (n) => void reloadQuestions({ size: n }),
              }),
            ),
      )
    }

    /**
     * 表格里的一道题：一行 + （展开时）下方一块详情。
     *
     * 详情里**给看答案与解析**——这是管理/校对视角，不是作答过程（ADR-019 那条约束的是刷题那条路）。
     *
     * @param q - 题目段返回的条目。
     * @returns React 元素。
     */
    function renderQuestion(q) {
      const expanded = state.expanded === q.id
      const kindColor = KIND_COLOR[q.kind] ?? COLOR.idle
      const resultColor = q.attempts === null ? null : VERDICT_COLOR[q.attempts.last_verdict] ?? COLOR.idle
      const number = q.source?.number ?? shortId(q.id)
      return h(
        'div',
        { key: q.id },
        h(
          HoverRow,
          {
            style: { ...S.tr, gridTemplateColumns: Q_COLS },
            selected: expanded,
            onClick: () => {
              state.expanded = expanded ? null : q.id
              publish()
            },
          },
          // 题号列：题型色条 + 题号（色只做标记，不做文字色）
          h(
            'span',
            { style: { ...S.cell, display: 'flex', alignItems: 'center', gap: '5px' }, title: q.kind },
            h('span', { style: S.rowBar(kindColor), 'aria-hidden': true }),
            h('span', { style: { ...ELLIPSIS } }, String(number)),
          ),
          h('span', { style: { ...S.cell, fontWeight: expanded ? 500 : 400 }, title: previewStem(q.stem, 200) }, previewStem(q.stem, 60)),
          h(
            'span',
            { style: { ...S.cell, display: 'flex', gap: '4px', overflow: 'hidden' } },
            (q.topics ?? []).length === 0
              ? h('span', { style: { ...S.sub, fontSize: '11px' } }, '—')
              : (q.topics ?? []).slice(0, 2).map((t) => h('span', { key: t, style: S.chip }, t)),
          ),
          q.attempts === null
            ? h('span', { style: { ...S.sub, fontSize: '11px' } }, '未作答')
            : h(
                'span',
                { style: { ...S.cell, display: 'flex', alignItems: 'center', gap: '5px' } },
                h('span', { style: S.dot(resultColor ?? COLOR.idle) }),
                h('span', { style: ELLIPSIS }, `${q.attempts.total} 次`),
              ),
          h('span', { style: { ...S.sub, fontSize: '11px' } }, expanded ? '收起' : '展开'),
        ),
        expanded ? h(ExpandBox, { q }) : null,
      )
    }

    /**
     * 展开后的题目详情（选项 / 答案 / 解析 / 作答史）。
     *
     * ═══ 为什么它是**独立组件**而不是内联的一坨 ═══
     * 它要一个入场动效，而 `useEnterStyle` 内部是 useState/useEffect——
     * 如果写在 `renderQuestion` 里、只在 `expanded` 为真时调用，那就是**条件 hook**：
     * 同一组件前后两次渲染的 hook 数量不一致，React 会直接抛错（症状是白屏）。
     * 抽成组件之后，hook 归属这个组件自己，进出场都不会影响别人。
     *
     * @param props - `{ q }`。
     * @returns React 元素。
     */
    function ExpandBox(props) {
      const q = props.q
      const enter = useEnterStyle(`exp-${q.id}`)
      return h(
        'div',
        { style: { ...S.expandBox, ...enter } },
        (q.options ?? []).length > 0
          ? (q.options ?? []).map((opt, i) =>
              h(
                'div',
                { key: i, style: { ...S.row, padding: '2px 0', alignItems: 'flex-start' } },
                h('span', { style: { ...S.chip, flex: '0 0 auto' } }, String.fromCharCode(65 + i)),
                h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: '12px', whiteSpace: 'pre-wrap' } }, opt),
              ),
            )
          : null,
        h(
          'div',
          { style: { ...S.row, padding: '4px 0', flexWrap: 'wrap' } },
          h('span', { style: S.pill(COLOR.brand) }, `答案 ${(q.answer ?? []).join('/')}`),
          (q.accept ?? []).length > 0 ? h('span', { style: S.chip }, `也接受 ${(q.accept ?? []).join('、')}`) : null,
          (q.topics ?? []).map((t) => h('span', { key: t, style: S.chip }, t)),
          h('span', { style: S.chip }, q.kind),
          q.source?.number ? h('span', { style: S.chip }, `题号 ${q.source.number}`) : null,
          q.source?.page ? h('span', { style: S.chip }, `页 ${q.source.page}`) : null,
        ),
        q.analysis
          ? h('div', { style: { ...S.sub, whiteSpace: 'pre-wrap', marginTop: '4px', fontSize: '12px' } }, q.analysis)
          : h('div', { style: S.sub }, '（本题无解析）'),
        q.attempts !== null
          ? h(
              'div',
              { style: { ...S.sub, marginTop: '4px', fontSize: '12px' } },
              `作答 ${q.attempts.total} 次：正确 ${q.attempts.correct} / 部分正确 ${q.attempts.partial ?? 0} / 错误 ${q.attempts.wrong} / 无法判别 ${q.attempts.unjudged}；最后一次 ${localTime(q.attempts.last_at)} 答了「${q.attempts.last_response}」`,
            )
          : null,
      )
    }

    /** 做题记录段（作者 2026-10-13 从「记录」改名）：时间 / 题目 / 作答 / 结果 / 来源 / 用时 / 会话。 */
    function AttemptsSection() {
      const v = state.attempts
      const extra = v ? h('span', { style: { ...S.sub, flex: '0 0 auto' } }, `${v.total} 条`) : null
      if (v === null) {
        return h(Section, { id: 'attempts', title: '做题记录', accent: COLOR.warn, extra }, h('div', { style: S.sub }, '读取中…'))
      }
      const filterRow = h(
        'div',
        { style: { ...S.row, flexWrap: 'wrap', gap: '6px', padding: '2px 0 8px' } },
        h(
          'select',
          {
            style: S.input,
            value: state.aFilters.verdict,
            onChange: (e) => {
              state.aFilters.verdict = e.target.value
              void reloadAttempts()
            },
          },
          h('option', { value: 'all' }, '全部结果'),
          h('option', { value: 'correct' }, '正确'),
          h('option', { value: 'partial' }, '部分正确'),
          h('option', { value: 'wrong' }, '错误'),
          h('option', { value: 'unjudged' }, '无法判别'),
        ),
        // ── 「作答者」多选 ──
        //
        // 为什么做成复选框而不是下拉单选：作者要"按不同型号的模型分别看"，
        // 单选一次只能看一个；而多选还顺手解决"想看用户+某个模型"的对比。
        //
        // ⚠ 滚动条本身**没法定制**：宿主明说不要在组件外写 DOM、也没法注入 `<style>`，
        //   所以没有 `::-webkit-scrollbar`。能做的只有控制容器高度与内边距，
        //   让它在最常见的 2–5 个作答者时不出现滚动条，多了才滚。
        h(
          'div',
          { style: { position: 'relative', flex: '0 0 auto' } },
          h(Btn, {
            label: `作答者：${answererSummary(state.answerers, v.answerers)}`,
            primary: true,
            onClick: () => {
              state.answererOpen = !state.answererOpen
              publish()
            },
          }),
          state.answererOpen
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    zIndex: 20,
                    top: 'calc(100% + 4px)',
                    left: 0,
                    minWidth: '220px',
                    maxHeight: '180px',
                    overflowY: 'auto',
                    padding: '8px 10px',
                    border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
                    borderRadius: '8px',
                    background: 'var(--dsw-alias-bg-overlay, #fff)',
                    boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
                  },
                },
                h(
                  'div',
                  { style: { ...S.row, gap: '6px', padding: '0 0 6px' } },
                  h(Btn, {
                    label: '选中所有模型',
                    onClick: () => {
                      const models = (v.answerers ?? []).filter((a) => a.key !== 'human').map((a) => a.key)
                      // 勾上全部模型；**不动**「用户」那一格（"选中所有模型"就是字面意思）
                      state.answerers = [...new Set([...state.answerers, ...models])]
                      writeAnswerers()
                      publish()
                      void reloadAttempts()
                    },
                  }),
                  h(Btn, {
                    label: '只看用户',
                    onClick: () => {
                      state.answerers = ['human']
                      writeAnswerers()
                      publish()
                      void reloadAttempts()
                    },
                  }),
                ),
                (v.answerers ?? []).map((a) =>
                  h(
                    'label',
                    {
                      key: a.key,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '3px 0',
                        fontSize: '12px',
                        cursor: 'pointer',
                        ...ELLIPSIS,
                      },
                      title: a.key,
                    },
                    h('input', {
                      type: 'checkbox',
                      checked: state.answerers.includes(a.key),
                      onChange: (e) => {
                        const set = new Set(state.answerers)
                        if (e.target.checked) set.add(a.key)
                        else set.delete(a.key)
                        state.answerers = [...set]
                        writeAnswerers()
                        publish()
                        void reloadAttempts()
                      },
                    }),
                    h('span', { style: { ...ELLIPSIS, flex: '1 1 auto' } }, a.label),
                    h('span', { style: S.sub }, String(a.count)),
                  ),
                ),
                state.answerers.length === 0
                  ? h('div', { style: { ...S.sub, paddingTop: '4px' } }, '一个都没勾 = 不显示任何记录')
                  : null,
              )
            : null,
        ),
        (v.sessions ?? []).length > 0
          ? h(
              'select',
              {
                style: S.input,
                value: state.aFilters.session,
                onChange: (e) => {
                  state.aFilters.session = e.target.value
                  void reloadAttempts()
                },
              },
              h('option', { value: '' }, '全部会话'),
              (v.sessions ?? []).map((s) => h('option', { key: s.session_id, value: s.session_id }, `${shortId(s.session_id)}（${s.count}）`)),
            )
          : null,
        h(Btn, { label: '刷新', onClick: () => void reloadAttempts() }),
      )

      return h(
        Section,
        { id: 'attempts', title: '做题记录', accent: COLOR.warn, extra },
        filterRow,
        h(Notes, { notes: v.notes }),
        h(
          'div',
          { style: S.table },
          h(
            'div',
            { style: { ...S.thead, gridTemplateColumns: A_COLS } },
            h('span', null, '时间'),
            h('span', null, '题目'),
            h('span', null, '作答'),
            h('span', null, '正确答案'),
            h('span', null, '结果'),
            h('span', null, '作答者'),
            h('span', null, '用时'),
            h('span', null, '会话'),
            h('span', null, '备注'),
          ),
          v.items.length === 0 ? h('div', { style: { ...S.sub, padding: '8px 6px' } }, '当前筛选下无记录') : null,
          v.items.map((a, i) =>
            // 每行包一层：备注编辑块要能落在**这一行下面**（在表格里，而不是整个表单下面）
            h(
              'div',
              { key: a.event_id ?? i },
              h(
              HoverRow,
              { style: { ...S.tr, gridTemplateColumns: A_COLS } },
              h('span', { style: S.cell }, localTime(a.timestamp)),
              h('span', { style: S.cell, title: `${a.bank} / ${a.question_id}\n${a.question?.stem_preview ?? ''}` }, a.question?.stem_preview ?? a.question_id),
              h('span', { style: S.cell }, a.response === '' ? '（空）' : a.response),
              // 官方答案：一律**字符型**（选择题 A/C、填空 42、将来简答整段文字，在这列是同一件事）
              h(
                'span',
                { style: { ...S.cell, fontWeight: 500 }, title: a.question?.answer_text ?? '' },
                a.question?.answer_text === '' ? '—' : a.question?.answer_text ?? '—',
              ),
              h(
                'span',
                { style: { ...S.cell, display: 'flex', alignItems: 'center', gap: '5px' } },
                // 结果色只做圆点，文字仍是 label-primary——令牌铁律
                h('span', { style: S.dot(VERDICT_COLOR[a.verdict] ?? COLOR.idle) }),
                h(
                  'span',
                  { style: ELLIPSIS, title: a.verdict === 'partial' ? `部分正确：${a.score_got}/${a.score_total}` : undefined },
                  a.verdict === 'correct'
                    ? '正确'
                    : a.verdict === 'partial'
                      ? `部分正确 ${a.score_got}/${a.score_total}`
                      : a.verdict === 'wrong'
                        ? '错误'
                        : '无法判别',
                ),
              ),
              // 作答者：人 / 型号。悬停给完整信息（型号、来源种类、批次）。
              h(
                'span',
                {
                  style: S.cell,
                  title:
                    a.source === 'human'
                      ? '用户作答'
                      : a.source === 'llm'
                        ? `模型作答${a.model ? ` · ${a.model}` : '（未记型号）'}`
                        : `来源：${a.source}`,
                },
                a.source === 'human' ? '用户' : a.source === 'llm' ? a.model ?? '模型（未记录型号）' : a.source,
              ),
              h('span', { style: S.cell }, durationText(a.duration_ms)),
              h(
                'span',
                {
                  style: {
                    ...S.cell,
                    // 没有会话坐标的那些**视觉上就淡一档**：它是数据缺失，不该看起来和别的行一样确定
                    color: a.session_ref === null ? 'var(--dsw-alias-label-secondary, #6b7280)' : undefined,
                    fontStyle: a.session_ref === null ? 'italic' : undefined,
                  },
                  title: a.session_ref ?? '',
                },
                a.session_ref === null ? '无会话坐标' : sessionLabel(a.session_ref, sessionTitleMap)?.title ?? shortId(a.session_ref),
              ),
              // 备注列（窄）：有备注显示 ✎ 与条数，点一下在**这一行下面**展开读/写区。
              // 为什么不加宽列显示正文：表已 9 列，而备注是长文本，塞进列里必然变成省略号（等于没显示）。
              h(
                'span',
                {
                  style: { ...S.cell, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px' },
                  title: (a.notes ?? []).length > 0 ? (a.notes ?? []).map((n) => n.text).join('\n---\n') : '写一条备注（思路 / 反思）',
                  onClick: () => {
                    state.noteFor = state.noteFor === a.event_id ? null : a.event_id
                    state.noteDraft = ''
                    state.noteKind = 'reflection'
                    state.noteError = null
                    publish()
                  },
                },
                h('span', null, (a.notes ?? []).length > 0 ? '✎' : '＋'),
                (a.notes ?? []).length > 0 ? h('span', { style: S.sub }, String((a.notes ?? []).length)) : null,
              ),
            ),
            // 备注读/写区：落在**这一行之内**（作者 2026-10-13 要求：不要在整张表下面）
            state.noteFor === a.event_id
              ? h(
                  'div',
                  { style: S.expandBox },
              (a.notes ?? []).length === 0
                ? h('div', { style: { ...S.sub, marginBottom: '6px' } }, '这条作答还没有备注。')
                : (a.notes ?? []).map((n) =>
                    h(
                      'div',
                      { key: n.event_id, style: { ...S.row, alignItems: 'flex-start', padding: '2px 0' } },
                      h('span', { style: S.chip }, n.note_kind === 'reasoning' ? '思路' : '反思'),
                      h('span', { style: S.chip, borderColor: 'transparent' }, n.author === 'agent' ? `模型${n.model ? ` ${n.model}` : ''}` : '用户'),
                      h('span', { style: { ...S.sub, flex: '0 0 auto' } }, localTime(n.created_at)),
                      h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: '12px', whiteSpace: 'pre-wrap' } }, n.text),
                    ),
                  ),
              h(
                'div',
                { style: { ...S.row, gap: '6px', marginTop: '4px', flexWrap: 'wrap' } },
                h(
                  'select',
                  {
                    style: S.input,
                    value: state.noteKind,
                    onChange: (e) => {
                      state.noteKind = e.target.value
                      publish()
                    },
                  },
                  h('option', { value: 'reasoning' }, '思路（答题时）'),
                  h('option', { value: 'reflection' }, '反思（答题后）'),
                ),
                h('textarea', {
                  style: { ...S.input, flex: '1 1 320px', minHeight: '52px', resize: 'vertical' },
                  placeholder: '我为什么选它 / 我错在哪 —— 不想写就不写',
                  value: state.noteDraft,
                  onChange: (e) => {
                    state.noteDraft = e.target.value
                    publish()
                  },
                }),
                h(Btn, {
                  label: state.noteBusy ? '保存中…' : '保存备注',
                  primary: true,
                  disabled: state.noteBusy,
                  onClick: () => void saveNote(a.event_id, a.question_id),
                }),
              ),
              state.noteError !== null ? h('div', { style: S.notice('bad') }, state.noteError) : null,
              // 已有备注时给一句"只追加"的说明——因为改一条备注的正确做法是**再记一条**
              (a.notes ?? []).length > 0
                ? h('div', { style: { ...S.sub, marginTop: '4px' } }, '备注只追加：再写一条是最新的（旧的原话仍在日志里）。')
                : null,
                )
              : null,
            ),
          ),
          h(Pagination, {
            total: v.total,
            page: state.aPage,
            pageSize: state.aPageSize,
            loading: state.loading,
            unit: '条',
            onPage: (p) => void reloadAttempts({ page: p }),
            onSize: (n) => void reloadAttempts({ size: n }),
          }),
        ),
      )
    }

    /**
     * 会话 id → 标题的映射。
     *
     * 它是**模块级**变量（不是 state）：会话清单来自宿主 hook，更新频率由宿主决定，
     * 放在组件外可以让记录段这个纯渲染组件直接读它，不必层层传 prop。
     */
    let sessionTitleMap = Object.create(null)

    /** 右列：选中库的头部 + 三段。 */
    function Detail(props) {
      const banks = state.banks?.banks ?? []
      const current = banks.find((b) => b.name === state.selected) ?? null
      const enter = useEnterStyle(state.selected)
      return h(
        'div',
        { style: { ...S.right, ...enter } },
        h(
          'div',
          { style: { ...S.row, padding: '0 0 8px', flexWrap: 'wrap' } },
          h('span', { style: { ...S.title, flex: '0 0 auto' } }, state.selected === 'all' ? '全部题库' : current?.title ?? String(state.selected)),
          current !== null ? h('span', { style: { ...S.sub, flex: '1 1 auto', minWidth: 0, ...ELLIPSIS } }, current.path ?? '') : h('span', { style: { flex: '1 1 auto' } }),
          current !== null
            ? h(Btn, {
                label: state.busy ? '…' : '归档',
                disabled: state.busy,
                title: '把题库文件移进 lh-questions/.archived/（内容一个字不动，可恢复）',
                onClick: () => void archiveSelected(),
              })
            : null,
          h(Btn, { label: state.loading ? '…' : '刷新', primary: true, disabled: state.loading, onClick: () => void refresh() }),
        ),
        state.notice !== null ? h('div', { style: S.notice(state.notice.kind) }, state.notice.text) : null,
        state.error !== null ? h('div', { style: S.notice('bad') }, state.error) : null,
        h(Notes, { notes: state.banks?.notes }),
        h(SourceSection, null),
        h(QuestionsSection, null),
        h(AttemptsSection, null),
      )
    }

    /** 中央面板的组件。 */
    function BankPanel(props) {
      useStore()
      // 会话清单只从 main 槽拿得到（浮层那个槽没有这个 standardProp）
      const hook = typeof props?.useSessions === 'function' ? props.useSessions : null
      const sessions = hook ? sessionsById(hook((s) => s)) : Object.create(null)
      sessionTitleMap = sessions

      // 挂载时如果"从没取过数"，就取一次。
      // ⚠ 判据用 `banks === null && error === null`：不写成"总是取"（每次切回面板都重拉没意义），
      //   也不能什么都不做——面板被恢复成选中态而 data 是 null 时，界面会显示"0 个题库"
      //   且**一条错误都没有**（作者会合理地以为题库全丢了）。这个坑 workspace-ui 踩过。
      React.useEffect(() => {
        if (state.banks === null && state.error === null && !state.loading) void refresh()
        // 只在挂载时判定一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      return h(
        'div',
        { style: S.panel },
        h(
          'div',
          { style: S.header },
          h('span', { style: S.title }, '题库管理'),
          h('span', { style: S.sub }, state.banks?.workspace?.dir ?? ''),
          h('span', { style: { flex: '1 1 auto' } }),
          hook ? null : h('span', { style: S.sub }, '（浮层里没有会话清单，会话列只显示短 id）'),
        ),
        h(
          'div',
          { style: S.body },
          h('div', { style: S.left }, h(BankList, null)),
          h(Detail, null),
        ),
      )
    }

    /** `shell.overlay` 的兜底浮层（只在 main 没注册成功时才渲染）。 */
    function OverlayFallback() {
      const [, force] = React.useState(0)
      React.useEffect(() => subscribe(() => force((n) => n + 1)), [])
      if (!overlayOpen || mainRegistered) return null
      return h(
        'div',
        { style: S.overlayWrap, onClick: () => { overlayOpen = false; publish() } },
        h(
          'div',
          { style: S.overlayPanel, onClick: (e) => e.stopPropagation() },
          h(BankPanel, null),
        ),
      )
    }

    // ══════════════════════════════════════════════════════════════════════
    // 入口
    // ══════════════════════════════════════════════════════════════════════

    /** 侧栏图标（`sidebar.panellist` 的条目）。 */
    function BankIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      const active = props?.active === true
      const [hover, setHover] = React.useState(false)
      return h(
        'button',
        {
          type: 'button',
          title: '题库管理',
          'aria-label': '题库管理',
          onClick: () => openPanel(),
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
        '🗂️',
      )
    }

    /**
     * 打开题库面板：优先切到 main 面板；main 没注册成功时退回浮层，
     * 两条路都不可用时**不静默**——把原因留在 error 里显示给学习者。
     */
    function openPanel() {
      if (mainRegistered) {
        try {
          ctxRef?.layout?.selectPanel?.(PANEL_ID)
          overlayOpen = false
          publish()
          void refresh()
          return
        } catch (error) {
          console.warn(`[lh-question-bank-ui] selectPanel 失败，退回浮层：${error?.message ?? error}`)
        }
      }
      overlayOpen = true
      publish()
      void refresh()
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

      // ── 中央面板：main key `lh-bank` ──
      // 先注册 main：`selectPanel` 在 main 缺失时会抛错且不改选中态。
      ctx.slots.inject('main', () => {
        const dispose = ctx.slots.register({ name: 'main', key: PANEL_ID }, BankPanel)
        mainRegistered = true
        publish()
        return dispose
      })

      // ── 侧栏图标：sidebar.panellist，**同名 id** ──
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, label: '题库' }, BankIcon),
      )

      // ── 兜底浮层（仅当 main 没注册成功时才渲染）──
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'lh-bank-directory' }, OverlayFallback),
      )
    }

    exports.name = 'lh-question-bank-ui'

    // ⚠ 宿主门禁认的是**模块导出的** inject（服务名数组）。
    //   `package.json` 的 `dsh.client.inject` 是包名数组，只进 boot 清单，**不装配 fiber 的 inject**。
    //   `layout` 刻意不在这里声明（见上），拿不到就退回浮层。
    exports.inject = ['slots']

    return exports
  },
})
