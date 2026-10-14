/**
 * 刷题卡片的**外观词汇表** —— agent 能调什么、以及"调错了会怎样"。
 *
 * ═══ 为什么需要一层词汇表，而不是让 agent 直接写 CSS ═══
 * 作者要的是"尽可能多地让 agent 编辑卡片样式"（原话：
 * *"我希望尽可能多的让agent编辑答题卡片的样式，包括不限于一卡多少题（文字布局），
 * 框体、字体大小、背景色"*）。但**直接把 CSS 交给模型**有三个具体问题：
 *
 * 1. **深浅色会坏**。本项目有 `lh-theme` 在管配色，宿主的颜色都是
 *    `--dsw-alias-*` 变量。agent 随手写一个 `#fff` 背景，在浅色模式下就是白底白字
 *    ——而它**看不到结果**，所以它会一直以为自己调对了。
 * 2. **模型没有"看得见"的反馈回路**。它只能写，不能看。所以任何"写错了只是难看"
 *    的自由度，都会稳定地产生难看的卡片，而且没人知道为什么。
 * 3. **没有边界就没有纠错**。若 agent 可以写任意键，"这个属性名到底对不对"
 *    就成了无法回答的问题；有了词汇表，`ignored` 能明确告诉它哪一项没被接受。
 *
 * ═══ 这个模块的职责边界 ═══
 * 这里只做**校验与归一化**（纯函数、可离线测）：把 agent 给的东西变成
 * 一个**确定形状**的 style 对象，并如实报告被忽略的项。
 * 它**不做**"token → 具体颜色"的映射——那是客户端的事，因为
 * 颜色必须由**看到主题变量的那一侧**决定。
 *
 * ═══ 一个刻意的设计：颜色给两档，不是一档 ═══
 * - **语义档**（`accent: 'brand'`）：映射到宿主主题变量，深浅色自动正确。**推荐**。
 * - **自由档**（`accent: '#8a5cf6'`）：agent 想精确指定也行。客户端会在
 *   拿到自定义颜色时**自己算一个对比色**当文字色（见 client.js 的 `readableOn`），
 *   所以"看不见的字"这个失败模式被结构性排除了——自由度不再以可读性为代价。
 *
 * 这就是为什么最终没有把它做成"要么语义、要么逃生口"的二选一：
 * **让自由档安全，就不需要在自由度和安全之间选。**
 */

/** 各枚举的合法取值。键名即 agent 传的字段名。 */
export const STYLE_TOKENS = {
  /** 强调色：卡片左边条与主按钮。 */
  accent: ['brand', 'focus', 'calm', 'warn', 'danger', 'neutral'],
  /** 底色。 */
  background: ['panel', 'tinted', 'plain', 'transparent'],
  /** 字号与留白一起缩放（"字体大小"）。 */
  font_scale: ['compact', 'normal', 'large', 'xlarge'],
  /** 框体的圆角（"框体"）。 */
  radius: ['none', 'small', 'medium', 'large', 'pill'],
  /** 框体的边框。 */
  border: ['none', 'thin', 'accent-left', 'thick'],
  /** 卡片里标题与按钮怎么排（"文字布局"）。 */
  layout: ['row', 'stack', 'banner'],
}

/**
 * 卡片上可以显示/隐藏的信息块（多选）。
 *
 * ⚠ 这里**只列卡片真的画得出来的三种**。曾经还想放 `stats`（做过几道/正确率）
 * 与 `progress`，但卡片当前不显示它们——而按"只放会生效的旋钮"那条规则
 * （见 STYLE_NUMBERS 的注释），**声明了却不生效的项比没有这一项更糟**：
 * agent 会以为自己调对了，学习者看到没变化，两边都不报错。
 * 面板里的进度统计不受这个开关影响（面板一直显示）。
 *
 * 不给 `show` 时默认这三种都显示；给空数组 `[]` 表示"只留标题和按钮"。
 */
export const SHOW_ITEMS = ['bank', 'count', 'hint']

/**
 * 数值项的上下界（"一卡多少题"）。**必须夹紧**：模型给 10000 会画出没法看的东西。
 *
 * ⚠ 这里**只放真的会生效的旋钮**。曾经想加 `panel_layout`（面板一次列几道）
 * 与 `questions_per_view`，但它们需要把面板的作答状态从"一题"改成"每题一份"，
 * 是一次真正的重构——所以在做之前**不能**出现在词汇表里。
 * 理由：`start_practice` 会回报 `style_applied`，而**一个声明了却不生效的旋钮
 * 比没有这个旋钮更糟**——agent 会以为自己调对了，学习者看到的是没变化，
 * 而两边都不会报错。
 *
 * 面板一次取几道已经由 `count` 参数管着了（见工具描述），不需要再来一个。
 */
export const STYLE_NUMBERS = {
  /** 卡片上预览几道题（0 = 不预览）。这是"一卡多少题"落在卡片上的那一半。 */
  preview_questions: { min: 0, max: 8 },
  /** 面板宽度（像素）。给范围而不是自由值：太窄会挤成一列单字，太宽会盖住对话。 */
  panel_width: { min: 320, max: 900 },
}

/** 颜色字段：这几个键既能给 token，也能给 `#rrggbb`。 */
const COLOR_KEYS = ['accent', 'accent_color', 'background_color', 'text_color']

/** `#rgb` / `#rrggbb` / `#rrggbbaa`。 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * 是否是合法的十六进制颜色。
 *
 * @param value - 待检字符串。
 * @returns 合法则 true。
 */
export function isHexColor(value) {
  return typeof value === 'string' && HEX.test(value.trim())
}

/**
 * 校验并归一化 agent 给的卡片外观。
 *
 * ═══ 设计要点：**不抛错，只忽略** ═══
 * 与 `start_practice` 对题库名的处置一致（见 index.js 的注释）：
 * "把卡片画得好看"不是这个工具的职责，**外观参数写错不该让刷题失败**。
 * 所以不认识的值被丢掉、记进 `ignored`，由工具返回值如实告诉 agent，
 * 让它自己纠正——而不是让学习者看到一条错误。
 *
 * @param raw - agent 给的原始对象（可能是任何东西）。
 * @returns `{ style, ignored }`：归一化后的 style 与被忽略项的说明。
 */
export function sanitizeCardStyle(raw) {
  const ignored = []

  // 不是对象就当没给。**数组也算非法**：`["brand"]` 这种形状多半是模型写错了，
  // 静默当成对象处理会得到一堆莫名其妙的默认值。
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) ignored.push(`style 必须是对象，收到 ${Array.isArray(raw) ? 'array' : typeof raw}`)
    return { style: {}, ignored }
  }

  const style = {}

  // ── 枚举项 ──
  //
  // `accent` 跳过：它是**双档**字段（token 或 #rrggbb），所以单独处理。
  // 这里踩过一次：先按枚举校验、再在后面"抢救"hex，结果是
  // **值被接受了、却同时出现在 ignored 里**——而 ignored 是模型的纠错回路，
  // 一条假的"没被接受"会让它把生效了的颜色改回去。
  // 教训：一个字段有两种合法形状时，校验必须在**同一处**做完。
  for (const [key, allowed] of Object.entries(STYLE_TOKENS)) {
    if (key === 'accent') continue
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && allowed.includes(value)) {
      style[key] = value
    } else {
      ignored.push(`${key}=${JSON.stringify(value)} 不在允许值里（可选：${allowed.join(' / ')}）`)
    }
  }

  // ── accent：token 或 hex ──
  if (raw.accent !== undefined && raw.accent !== null) {
    if (typeof raw.accent === 'string' && STYLE_TOKENS.accent.includes(raw.accent)) {
      style.accent = raw.accent
    } else if (isHexColor(raw.accent)) {
      style.accent = raw.accent.trim().toLowerCase()
    } else {
      ignored.push(
        `accent=${JSON.stringify(raw.accent)} 既不是合法 token（${STYLE_TOKENS.accent.join(' / ')}）也不是 #rrggbb`,
      )
    }
  }

  // ── 其余颜色项：只接受 hex ──
  for (const key of COLOR_KEYS) {
    if (key === 'accent') continue // 上面已处理
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (isHexColor(value)) {
      style[key] = value.trim().toLowerCase()
    } else {
      ignored.push(`${key}=${JSON.stringify(value)} 必须是 #rrggbb 形式的颜色`)
    }
  }

  // ── 数值项：夹紧，不报错 ──
  //
  // 为什么夹紧而不是忽略：模型给 `preview_questions: 10000` 时，
  // **它的意图是清楚的**（"多显示一点"），只是过头了。夹到上界比整项丢掉更贴近意图。
  // 但越界要**如实报告**——否则它会以为 10000 生效了。
  for (const [key, { min, max }] of Object.entries(STYLE_NUMBERS)) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      ignored.push(`${key}=${JSON.stringify(value)} 不是数字`)
      continue
    }
    const rounded = Math.round(value)
    const clamped = Math.min(max, Math.max(min, rounded))
    style[key] = clamped
    if (clamped !== rounded) ignored.push(`${key}=${rounded} 超出 ${min}..${max}，已夹到 ${clamped}`)
  }

  // ── show：多选，逐项校验 ──
  if (raw.show !== undefined && raw.show !== null) {
    if (!Array.isArray(raw.show)) {
      ignored.push(`show 必须是数组（如 ["bank","count"]），收到 ${typeof raw.show}`)
    } else {
      const kept = []
      for (const item of raw.show) {
        if (typeof item === 'string' && SHOW_ITEMS.includes(item)) kept.push(item)
        else ignored.push(`show 里的 ${JSON.stringify(item)} 不在允许值里（可选：${SHOW_ITEMS.join(' / ')}）`)
      }
      style.show = [...new Set(kept)]
    }
  }

  // ── 不认识的键：报告出来 ──
  //
  // 这一条是整个模块里最有用的部分。模型很容易"发明"字段名
  // （`fontSize`、`bg`、`color`），而**静默忽略**会让它反复尝试同一个错名字。
  const known = new Set([
    ...Object.keys(STYLE_TOKENS),
    ...Object.keys(STYLE_NUMBERS),
    ...COLOR_KEYS,
    'show',
  ])
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) ignored.push(`不认识的字段 ${key}`)
  }

  return { style, ignored }
}

/**
 * 把归一化后的 style 说成一句人话（给工具返回值用，让 agent 确认生效的是什么）。
 *
 * @param style - `sanitizeCardStyle` 的 style。
 * @returns 描述文本；空 style 时给一句"全用默认"。
 */
export function describeCardStyle(style) {
  const parts = []
  for (const [key, value] of Object.entries(style ?? {})) {
    parts.push(`${key}=${Array.isArray(value) ? value.join('+') : value}`)
  }
  return parts.length === 0 ? '全部用默认外观' : parts.join('、')
}

/**
 * 词汇表的自描述（给工具 description 用）。
 *
 * 为什么让 description 和实现**同源**：如果工具描述里手写一份选项列表，
 * 改了这个模块却忘了改描述，agent 就会按过时的列表去调用——
 * 而它收到的 `ignored` 又会说"这个值不在允许值里"。两边互相矛盾，
 * 模型会开始瞎猜。**让描述从实现生成，这一类不一致就不可能出现。**
 *
 * @returns 一行紧凑的选项说明。
 */
export function describeStyleVocabulary() {
  const enumPart = Object.entries(STYLE_TOKENS)
    .map(([k, v]) => `${k}(${v.join('|')})`)
    .join('、')
  const numPart = Object.entries(STYLE_NUMBERS)
    .map(([k, v]) => `${k}(${v.min}-${v.max})`)
    .join('、')
  return `${enumPart}；${numPart}；show(多选:${SHOW_ITEMS.join('|')})；另可用 accent_color/background_color/text_color 传 "#rrggbb"`
}
