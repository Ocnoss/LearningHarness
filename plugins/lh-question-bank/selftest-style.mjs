/**
 * 外观词汇表的离线测试（`style.js`）。
 *
 * ═══ 为什么这一层值得单独测 ═══
 * 这一层是 agent 与界面之间**唯一**的校验点：客户端刻意不重复校验
 * （两处校验 = 两套规则，迟早不一致）。所以这里的判断错了，
 * 错的不是一个函数，而是**整条链没有第二道防线**。
 *
 * 三类重点：
 *   1. **绝不抛错**。模型给的任何形状（字符串、数组、嵌套、null）都必须被吸收。
 *   2. **如实报告被忽略的项**。模型很容易发明字段名（`fontSize`、`bg`），
 *      静默忽略会让它反复试同一个错名字——`ignored` 是它的纠错回路。
 *   3. **数值夹紧而非丢弃**。`preview_questions: 10000` 的意图是清楚的（"多显示点"），
 *      夹到上界比整项丢掉更贴近意图，但**必须报告**，否则它会以为 10000 生效了。
 *
 * 运行：node plugins/lh-question-bank/selftest-style.mjs
 */

import assert from 'node:assert/strict'

import {
  sanitizeCardStyle,
  describeCardStyle,
  describeStyleVocabulary,
  isHexColor,
  STYLE_TOKENS,
  STYLE_NUMBERS,
  SHOW_ITEMS,
} from './style.js'

let passed = 0
let failed = 0
const failures = []

/**
 * 断言并计数。
 * @param label - 这条在验什么。
 * @param fn - 断言体。
 */
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL ${label}`)
    console.log(`       ${error.message.split('\n').join('\n       ')}`)
  }
}

console.log('')

console.log('══ 1. 合法输入原样通过 ══')

check('枚举 token 全部接受', () => {
  const { style, ignored } = sanitizeCardStyle({
    accent: 'focus',
    background: 'tinted',
    font_scale: 'large',
    radius: 'pill',
    border: 'thick',
    layout: 'stack',
  })
  assert.deepEqual(style, {
    accent: 'focus',
    background: 'tinted',
    font_scale: 'large',
    radius: 'pill',
    border: 'thick',
    layout: 'stack',
  })
  assert.deepEqual(ignored, [])
})

check('数值项接受范围内的值', () => {
  const { style, ignored } = sanitizeCardStyle({ preview_questions: 3, panel_width: 640 })
  assert.equal(style.preview_questions, 3)
  assert.equal(style.panel_width, 640)
  assert.deepEqual(ignored, [])
})

check('十六进制颜色被接受并归一化为小写', () => {
  const { style } = sanitizeCardStyle({ accent_color: '#AABBCC', background_color: '#fff', text_color: '#01234567' })
  assert.equal(style.accent_color, '#aabbcc')
  assert.equal(style.background_color, '#fff')
  assert.equal(style.text_color, '#01234567')
})

check('accent 也可以是十六进制（颜色给两档）', () => {
  const { style, ignored } = sanitizeCardStyle({ accent: '#8A5CF6' })
  assert.equal(style.accent, '#8a5cf6')
  assert.deepEqual(ignored, [])
})

console.log('\n══ 2. 不认识的东西：忽略 + 报告（模型的纠错回路）══')

check('★ 发明的字段名被点名报告', () => {
  // 这是最常见的一类：模型写 `fontSize` / `bg` / `color`。
  const { style, ignored } = sanitizeCardStyle({ fontSize: '18px', bg: 'red', color: 'blue' })
  assert.deepEqual(style, {}, '不认识的字段不该进 style')
  assert.equal(ignored.length, 3, `应逐项报告，实际：${JSON.stringify(ignored)}`)
  assert.ok(ignored.some((m) => m.includes('fontSize')))
  assert.ok(ignored.some((m) => m.includes('bg')))
})

check('★ 枚举值写错时，报错里列出可选值', () => {
  const { style, ignored } = sanitizeCardStyle({ font_scale: 'huge' })
  assert.equal(style.font_scale, undefined)
  assert.equal(ignored.length, 1)
  assert.ok(ignored[0].includes('huge'), '要点名写错的值')
  assert.ok(ignored[0].includes('compact'), '要列出可选值，否则模型只能瞎猜')
})

check('show 逐项过滤，非数组要报错', () => {
  const ok = sanitizeCardStyle({ show: ['bank', 'nope', 'count'] })
  assert.deepEqual(ok.style.show, ['bank', 'count'])
  assert.equal(ok.ignored.length, 1)

  const bad = sanitizeCardStyle({ show: 'bank' })
  assert.equal(bad.style.show, undefined)
  assert.ok(bad.ignored[0].includes('数组'))
})

check('show 去重', () => {
  const { style } = sanitizeCardStyle({ show: ['bank', 'bank', 'count'] })
  assert.deepEqual(style.show, ['bank', 'count'])
})

check('非法颜色被拒绝', () => {
  const { style, ignored } = sanitizeCardStyle({ accent_color: 'red', background_color: '#12345' })
  assert.equal(style.accent_color, undefined)
  assert.equal(style.background_color, undefined)
  assert.equal(ignored.length, 2)
})

console.log('\n══ 3. 数值：夹紧而不是丢弃，但必须报告 ══')

check('★ 超出上界被夹到上界，并如实报告', () => {
  const { style, ignored } = sanitizeCardStyle({ preview_questions: 10000 })
  assert.equal(style.preview_questions, STYLE_NUMBERS.preview_questions.max)
  assert.equal(ignored.length, 1, '夹紧必须报告 —— 否则模型以为 10000 生效了')
  assert.ok(ignored[0].includes('10000'))
  assert.ok(ignored[0].includes(String(STYLE_NUMBERS.preview_questions.max)))
})

check('低于下界同样夹紧', () => {
  const { style, ignored } = sanitizeCardStyle({ panel_width: 10 })
  assert.equal(style.panel_width, STYLE_NUMBERS.panel_width.min)
  assert.equal(ignored.length, 1)
})

check('小数被取整（并报告取整后的差异只在越界时）', () => {
  const { style } = sanitizeCardStyle({ preview_questions: 3.4 })
  assert.equal(style.preview_questions, 3)
})

check('非数字被忽略并报告', () => {
  for (const bad of ['5', null, {}, [], true]) {
    const { style, ignored } = sanitizeCardStyle({ preview_questions: bad })
    assert.equal(style.preview_questions, undefined, `${JSON.stringify(bad)} 不该通过`)
    if (bad !== null) assert.equal(ignored.length, 1, `${JSON.stringify(bad)} 应被报告`)
  }
})

check('NaN / Infinity 被挡住', () => {
  const { style } = sanitizeCardStyle({ preview_questions: Number.NaN, panel_width: Number.POSITIVE_INFINITY })
  assert.equal(style.preview_questions, undefined)
  assert.equal(style.panel_width, undefined)
})

console.log('\n══ 4. 绝不抛错（任何形状都要能吸收）══')

check('★ 敌意输入全部安全返回', () => {
  const hostile = [
    undefined, null, 0, 1, -1, '', 'style', true, false, [], [1, 2], {}, { style: {} },
    { accent: {} }, { accent: [] }, { show: {} }, { show: [null, undefined, 1, {}] },
    { preview_questions: {} }, Object.create(null),
    // 嵌套到没有意义
    { accent: { accent: { accent: 'brand' } } },
  ]
  for (const input of hostile) {
    const r = sanitizeCardStyle(input)
    assert.ok(r !== null && typeof r === 'object', `${JSON.stringify(input)} 让返回值坏了`)
    assert.ok(r.style !== null && typeof r.style === 'object' && !Array.isArray(r.style))
    assert.ok(Array.isArray(r.ignored))
  }
})

check('非对象输入被报告（数组也算非对象）', () => {
  assert.equal(sanitizeCardStyle('brand').ignored.length, 1)
  assert.equal(sanitizeCardStyle(['brand']).ignored.length, 1)
  assert.ok(sanitizeCardStyle(['brand']).ignored[0].includes('array'))
})

check('undefined / null 不产生噪声（视为"没给"）', () => {
  assert.deepEqual(sanitizeCardStyle(undefined), { style: {}, ignored: [] })
  assert.deepEqual(sanitizeCardStyle(null), { style: {}, ignored: [] })
})

console.log('\n══ 5. 描述与实现同源（防止两边不一致）══')

check('★ 词汇表描述里提到了每一个 token', () => {
  // 工具 description 是用这个函数**生成**的（而不是手写一份）。
  // 这一条锁住那个性质：加了 token 却忘了描述，agent 就会按过时的列表调用。
  const text = describeStyleVocabulary()
  for (const [key, values] of Object.entries(STYLE_TOKENS)) {
    assert.ok(text.includes(key), `描述里没有 ${key}`)
    for (const v of values) {
      assert.ok(text.includes(v), `描述里没有 ${key} 的可选值 ${v}`)
    }
  }
  for (const [key, { min, max }] of Object.entries(STYLE_NUMBERS)) {
    assert.ok(text.includes(key), `描述里没有 ${key}`)
    assert.ok(text.includes(String(min)) && text.includes(String(max)), `描述里没有 ${key} 的范围`)
  }
  for (const item of SHOW_ITEMS) {
    assert.ok(text.includes(item), `描述里没有 show 的 ${item}`)
  }
})

check('describeCardStyle 空风格给一句人话', () => {
  assert.equal(describeCardStyle({}), '全部用默认外观')
  assert.equal(describeCardStyle(null), '全部用默认外观')
  assert.ok(describeCardStyle({ accent: 'focus', show: ['bank', 'count'] }).includes('bank+count'))
})

check('isHexColor 的判定与正则一致', () => {
  assert.equal(isHexColor('#fff'), true)
  assert.equal(isHexColor('#ffffff'), true)
  assert.equal(isHexColor('#ffffffaa'), true)
  assert.equal(isHexColor('ffffff'), false)
  assert.equal(isHexColor('#ffff'), false)
  assert.equal(isHexColor(' #fff '), true, '两端空白应容忍')
})

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('全部通过。')
