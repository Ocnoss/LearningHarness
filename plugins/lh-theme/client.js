/**
 * lh-theme 的【客户端半】—— 配色套壳 + LH 模式标记。
 *
 * ═══ 上一版错在哪（留着，免得再犯）═══
 * 上一版把 LH 配色直接覆盖到 `body`，等于**劫持了 dsh 自己的外观**。
 * 而且我在深色块里又重定义了一遍静态调色板——那件事宿主已经在做，
 * 结果是把它的映射又反转一次，于是出现"白底盖暗色滤镜"。
 *
 * ═══ 宿主配色的真实机制（读过源码后的结论，实证）═══
 * 宿主有**两对**样式块：
 *   第 1 对：静态调色板 --dsw-static-*，两个模式**【取值完全相同】**
 *   第 2 对：别名映射   --dsw-alias-*，66 个别名在两模式下指向色阶的**相反两端**
 * 例如：
 *   --dsw-alias-bg-base        浅色 -> neutral-bluish-00 （最浅）  深色 -> neutral-bluish-950（最暗）
 *   --dsw-alias-label-primary  浅色 -> neutral-bluish-1000（最暗） 深色 -> neutral-bluish-50 （最浅）
 *
 * **所以正确做法是只给一条「连续色阶」**：低号位放 LH 的浅色端（奶油米色），
 * 高号位放暗端（黑蓝）。宿主自己的映射会把两端分配到正确的模式上。
 * 我们不需要、也不应该分别写浅色块和深色块。
 *
 * ═══ 权限边界（本次修正的核心）═══
 * 配色只在 **LH 会话**中生效：
 *   1. 订阅客户端 `ctx.sessions.list`（ObservableSnapshot，纯 JS，不需要 React）；
 *   2. 读 `list.current` -> `byId[id].agentPreset`，判断是否为 LH 的 preset id；
 *   3. 是则给 <body> 加 `lh-mode` 类，否则移除。
 * 于是 dsh 自己的会话仍是 dsh 原配色——两套外观互不侵犯。
 */

window.__ModuleLoader__.load({
  id: '@lh/theme',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** 样式元素 id。 */
    const STYLE_ID = 'lh-theme-style'
    /** 开启 LH 配色的 body 类名。 */
    const MODE_CLASS = 'lh-mode'
    /**
     * LH 的 preset id：只有跑在这个 preset 上的会话才套 LH 配色。
     * 为什么在这里写死而不是从服务端取：这个值是配置（preset 目录名），
     * 两端各持一份比跨端传字符串更简单、且不引入新的失败点。
     * 它只在 preset 改名时需要同步——那时本文件与 preset 一起改。
     */
    const LH_PRESET_ID = 'lh'

    // ─────────────────────────────────────────────────────────────
    // 一条连续色阶：低号位 = LH 浅色端（奶油米色），高号位 = 暗端（黑蓝）
    //
    // 号位与角色的对应关系（从宿主的别名映射逐条读出）：
    //   00   底色（浅色模式在此取背景）
    //   50   最亮文字 / 暗色模式下的品牌面
    //   60   平台底 / 多选底
    //   75   悬停底
    //   100  代码内联底 / 次强调
    //   150  浮层底
    //   200  弱化标签 / 滚动条
    //   300  次级文字
    //   400  说明文字
    //   500  幽灵按钮边框
    //   600  三级文字
    //   700  次级文字（暗）
    //   750  面板底（暗）
    //   800  层三底（暗）
    //   850  代码块底（暗）
    //   875  层一底（暗）
    //   950  主背景（暗色模式在此取底色）
    //   1000 最暗文字（浅色模式在此取正文）
    // ─────────────────────────────────────────────────────────────
    const RAMP = `
      /* 低号位：奶油米色（浅色模式的底色与层次） */
      --dsw-static-neutral-bluish-00: #faf7f0;
      --dsw-static-neutral-bluish-50: #f6f1e6;
      --dsw-static-neutral-bluish-60: #f3ecdf;
      --dsw-static-neutral-bluish-75: #ede5d5;
      --dsw-static-neutral-bluish-100: #e5dbc8;
      --dsw-static-neutral-bluish-150: #ddd1ba;
      --dsw-static-neutral-bluish-200: #d4c8b1;

      /* 中段：暖灰过渡 */
      --dsw-static-neutral-bluish-300: #c3b79f;
      --dsw-static-neutral-bluish-400: #a89c86;
      --dsw-static-neutral-bluish-500: #8d826d;
      --dsw-static-neutral-bluish-600: #71685a;
      --dsw-static-neutral-bluish-700: #585144;

      /* 高号位：黑蓝（深色模式的底色，同时也是浅色模式的正文色区） */
      --dsw-static-neutral-bluish-750: #3a4358;
      --dsw-static-neutral-bluish-800: #2c3446;
      --dsw-static-neutral-bluish-850: #222939;
      --dsw-static-neutral-bluish-875: #1b2130;
      --dsw-static-neutral-bluish-900: #161b28;
      --dsw-static-neutral-bluish-950: #111621;
      --dsw-static-neutral-bluish-1000: #0c101a;
    `

    // ─────────────────────────────────────────────────────────────
    // 品牌与强调色：它们指向色阶之外的调色板，两个模式取值也不同，
    // 所以这是**唯一**需要分模式写的地方。
    // 浅色用暖橙、深色用亮蓝，替换掉宿主原本的蓝/黑。
    // ─────────────────────────────────────────────────────────────
    const BRAND_LIGHT = `
      --dsw-alias-brand-primary: #c2410c;
      --dsw-alias-brand-primary-new-colorprimary-new-color: #c2410c;
      --dsw-alias-brand-primary-invert: #faf7f0;
      --dsw-alias-button-primary-hover: #9a3412;
      --dsw-alias-button-info-fill: #c2410c;
      --dsw-alias-button-info-hover: #9a3412;
      --dsw-alias-state-business-primary: #c2410c;
      --dsw-alias-state-business-tertiary: #fdebd8;
    `

    const BRAND_DARK = `
      --dsw-alias-brand-primary: #4c8dff;
      --dsw-alias-brand-primary-new-colorprimary-new-color: #4c8dff;
      --dsw-alias-brand-primary-invert: #111621;
      --dsw-alias-button-primary-hover: #6ba1ff;
      --dsw-alias-button-info-fill: #2f6fed;
      --dsw-alias-button-info-hover: #4c8dff;
      --dsw-alias-state-business-primary: #4c8dff;
      --dsw-alias-state-business-tertiary: #16233c;
    `

    /**
     * 注入样式。
     *
     * 选择器用 `body.lh-mode`：只有带上这个类时配色才生效。
     * 于是"LH 的外观"与"dsh 的外观"在 CSS 层面就是互斥的，不依赖注入顺序。
     * 深色仍由宿主自己的 `body[data-ds-dark-theme]` 表达——我们只提供色阶，
     * 由它的别名映射决定取哪一端。
     *
     * 幂等：HMR 会重新执行本模块，按 STYLE_ID 判断避免叠出第二个标签。
     */
    function injectStyle() {
      if (document.getElementById(STYLE_ID) !== null) return

      const css = `
/* LH 配色 —— 由 @lh/theme 注入，仅在 body.lh-mode（LH 会话）下生效。
   只重定义宿主已暴露的颜色变量；组件样式一概不碰。
   色系：浅色端 = 奶油米色 + 暖橙；暗端 = 黑蓝 + 亮蓝。 */

body.lh-mode {${RAMP}}

/* 品牌色按模式分别覆盖：它们指向色阶之外的调色板 */
body.lh-mode:not([data-ds-dark-theme]) {${BRAND_LIGHT}}
body.lh-mode[data-ds-dark-theme] {${BRAND_DARK}}
`
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = css
      document.head.append(style)
    }

    /**
     * 当前是否处于 LH 会话。
     *
     * @param sessions - 客户端 sessions 服务。
     * @returns 当前选中会话是否跑在 LH 的 preset 上。
     */
    function isLhSession(sessions) {
      try {
        const state = sessions.list.getSnapshot()
        const current = state.current
        if (current === undefined) return false
        return state.byId[current] !== undefined && state.byId[current].agentPreset === LH_PRESET_ID
      } catch {
        // 读不到就不套色：宁可显示 dsh 原样，也不要错误地改掉宿主的外观。
        return false
      }
    }

    /**
     * 按当前会话同步 body 上的模式类。
     * @param sessions - 客户端 sessions 服务。
     */
    function syncMode(sessions) {
      const on = isLhSession(sessions)
      if (on) document.body.classList.add(MODE_CLASS)
      else document.body.classList.remove(MODE_CLASS)
    }

    /** 必须注入的客户端服务：会话列表（用于判断当前会话跑在哪个 preset 上）。 */
    const inject = ['sessions']

    /**
     * 客户端插件体。
     *
     * @param ctx - 客户端插件上下文。
     */
    function apply(ctx) {
      injectStyle()

      /**
       * DOM 就绪后开始同步，并订阅会话列表。
       * 订阅返回取消订阅函数，交给 ctx.effect ——
       * 宿主对插件的要求是"可逆副作用"：注册的东西必须随卸载一起撤销。
       */
      const start = () => {
        syncMode(ctx.sessions)
        ctx.effect(() => ctx.sessions.list.subscribe(() => syncMode(ctx.sessions)))
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true })
      } else {
        start()
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
