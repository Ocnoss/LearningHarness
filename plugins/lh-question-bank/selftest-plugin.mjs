/**
 * lh-question-bank 的插件层自测 —— 用一个**假的 ctx** 把插件真跑起来。
 *
 * ═══ 为什么值得写这个假的 ═══
 * 宿主的现实是：**服务端插件改代码必须重启整个 dsh**，而一次重启会打断学习者，
 * 且"重启后才发现 schema 不被接受"会让排查成本非常高
 * （`preset row 不激活 → 整个预设的会话全废` 这个坑已经踩过一次，
 * 代价是当时所有 lh 会话都用不了）。
 *
 * 所以：**能离线验的，绝不留到重启后验。**
 * 这个假 ctx 只实现插件真正用到的那一小块（`tools.register` / `on`）。
 * 它能拦住的错很具体：schema 形状不对、参数校验写错、落盘路径算错、事件没写。
 * 它拦不住的也很明确：**宿主是否真的接受这个 schema**——那必须重启才算数。
 *
 * 注意：修这个文件**不要用 PowerShell 的 Set-Content**（实测把多字节字符写成了
 * U+FFFD，整个文件花掉、只能删掉重写）。文本文件一律用编辑器或 Node 改。
 *
 * 运行：node plugins/lh-question-bank/selftest-plugin.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'

import * as plugin from './index.js'
import { extractAttempts, summarizeAttempts } from './attempt.js'
import { readPracticeSignal } from './signal.js'

/**
 * 测试夹具用的**假资料根**。
 *
 * ⚠ 它不是要真的存在的目录——它只是参与题目 id 派生的一个**字符串标签**
 * （见 `deriveQuestionId`）。所以这里可以写一个固定的盘符路径，
 * 而**运行时代码里不行**（那会让插件在别人机器上读错目录）。
 */
const FIXTURE_SOURCE_ROOT = 'D:\\考公资料' // lh-path-ok: 测试夹具；只是 id 派生用的字符串标签，不需要真实存在

const here = dirname(fileURLToPath(import.meta.url))
const sandbox = join(here, '..', '..', 'data', 'question-bank-plugin-test')

let passed = 0
let failed = 0
const failures = []

/**
 * 跑一个用例。
 *
 * @param name - 用例名。
 * @param fn - 用例体（可 async）。
 */
async function check(name, fn) {
  try {
    // 必须 await：不 await 的话，异步断言会在 try 之外 reject，
    // 于是「代码正确拒绝了」被记成失败、而真正的失败被记成通过——测试变成随机噪声。
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, message: error?.message ?? String(error) })
    console.log(`  FAIL ${name}\n       ${error?.message ?? String(error)}`)
  }
}

/**
 * 造一个假 ctx，收集注册的工具。
 *
 * 只实现插件真正用到的接口。**刻意不实现更多**——假 ctx 越像真的就越难维护，
 * 而它的价值只在于"能不能把插件体跑起来"。
 *
 * @returns `{ ctx, tools, dispose }`。
 */
function makeFakeCtx() {
  const tools = new Map()
  const contexts = []
  const injects = []
  let disposeHandler = null
  const ctx = {
    tools: {
      register(def) {
        if (typeof def?.name !== 'string' || def.name === '') throw new Error('工具必须有 name')
        if (typeof def?.execute !== 'function') throw new Error(`工具 ${def.name} 必须有 execute`)
        if (tools.has(def.name)) throw new Error(`工具名重复：${def.name}`)
        tools.set(def.name, def)
      },
    },
    on(event, handler) {
      if (event === 'dispose') disposeHandler = handler
    },
    /**
     * 假的 `ctx.inject`（cordis 自带成员，与 `on`/`get` 同级）。
     *
     * 为什么必须有：插件用 `ctx.inject(['systemPrompt'], cb)` 注册运行时上下文。
     * 假的 ctx 缺了它，`apply()` 就会抛 `ctx.inject is not a function`——
     * 而那是**假 ctx 的缺陷**，不是插件的缺陷（E25：假实现出错比真实现更隐蔽）。
     *
     * 行为刻意照抄真实语义：**回调立即执行一次**，把 scope 交给它；
     * scope 上提供 `systemPrompt.context()` 并把注册记下来供断言用。
     * 真宿主里"服务就绪后"才回调，测试里没有异步服务的概念，所以立即执行是对的。
     */
    inject(services, callback) {
      injects.push(services)
      const scope = {
        systemPrompt: {
          context(def) {
            contexts.push(def)
            return () => {}
          },
        },
      }
      if (typeof callback === 'function') callback(scope)
    },
  }
  return { ctx, tools, contexts, injects, dispose: () => disposeHandler?.() }
}

/**
 * 造一个 exec（工具执行上下文）。
 *
 * @param sessionId - 会话 id。
 * @returns exec 对象。
 */
function makeExec(sessionId = 'session-selftest') {
  return { agent: { session: { id: sessionId, header: { cwd: sandbox } } } }
}

/**
 * 清空沙盒里的产物，保证用例互不干扰。
 *
 * 它**不删沙盒目录本身**，只删里面的产物。
 * 第一版写成 `rmSync(sandbox)` + `mkdirSync`，结果把 `reset()` 之前写进去的
 * 题目文件一起删掉了，后面的用例全部读到"文件不存在"——
 * 那种失败看起来像代码坏了，其实是测试自己在拆自己的台。
 */
function reset() {
  rmSync(join(sandbox, 'lh-questions'), { recursive: true, force: true })
  rmSync(join(sandbox, 'events.jsonl'), { force: true })
  // 事件日志指向沙盒内，避免污染真实的 data/events.jsonl。
  // 这能生效是因为 store.js 的 eventLogPath() 是**惰性求值**的
  // （第一版写成模块级常量，于是这里的设置被静默忽略——
  //   后果是测试把假数据写进了真实的学习史）。
  process.env.LH_EVENT_LOG = join(sandbox, 'events.jsonl')
}

/** 读回沙盒里的事件日志。 */
function readSandboxEvents() {
  const p = join(sandbox, 'events.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

// 沙盒目录在顶层就建好，且此后不再被删——见 reset() 的注释
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

console.log('\n══ 1. 插件装载 ══')

reset()
const { ctx, tools, dispose } = makeFakeCtx()
plugin.apply(ctx)

await check('注册了 11 个工具，名字正确', () => {
  assert.deepEqual([...tools.keys()].sort(), [
    'add_note',
    'get_practice_stats',
    'get_questions',
    // 只读取题解：给「AI深解」那条链用（不写事件，见第 11 节）
    'get_solution',
    'import_questions',
    // 把最脆的"抽取/配对"甩给子 agent（这两条各自 spawn 子 agent，见 index.js 顶部注释）
    'import_questions_from_source',
    'list_question_banks',
    'record_attempt',
    'start_practice',
    'submit_answer',
    'verify_pairing',
  ])
})

// 为什么这里要单独再对一次 package.json（闸门 check-plugin-contract 已经会比）：
// 上面那条清单是**手抄的**，而手抄的清单不会自己发现"代码加了工具、这里忘了加"——
// 实测发生过：`import_questions_from_source` / `verify_pairing` 加进代码后，
// 这条断言**整整一轮都没红**（因为清单里也没有它们，两边"同样地旧"）。
// 所以补一条"代码 vs 声明"的对照：它让"忘了改声明"在**本插件的自测里**就暴露，
// 而不必等到跑整仓 check-all。
await check('★ 注册的工具集与 package.json 的 lh.provides.tools 一致（防"忘了改声明"）', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
  const declared = [...(pkg.lh?.provides?.tools ?? [])].sort()
  assert.deepEqual(
    [...tools.keys()].sort(),
    declared,
    '代码注册的工具与 lh.provides.tools 声明不一致（ADR-024 决定 3：读包比读文档可靠，所以声明必须对）',
  )
})

await check('每个工具都有 description / parameters / output / execute', () => {
  for (const [name, def] of tools) {
    assert.equal(typeof def.description, 'string', `${name} 缺 description`)
    assert.ok(def.description.length > 20, `${name} 的 description 太短，模型无法据它判断何时该用`)
    assert.equal(def.parameters?.type, 'object', `${name} 的 parameters 必须是 object`)
    assert.ok(Array.isArray(def.parameters?.required), `${name} 的 required 必须是根级数组（宿主约定）`)
    assert.equal(typeof def.output?.schema, 'object', `${name} 缺 output.schema`)
    assert.equal(typeof def.output?.render, 'function', `${name} 缺 output.render`)
  }
})

await check('工具 schema 只用宿主支持的关键字（多一个都会让注册失败）', () => {
  // 实测自 assertSupportedJsonSchema 的支持集（见 index.js 注释）
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title'])
  const offenders = []
  /**
   * 递归走一遍 schema。
   *
   * 关键细节：`properties` 下的键是**属性名**，不是 schema 关键字。
   * 第一版没区分，于是把 bank_name / question_id 这些全报成了"不支持的关键字"。
   * 检查器必须知道"这一步的键是数据，不是词汇"。
   */
  const walk = (node, path, isPropertyMap = false) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`))
      return
    }
    for (const key of Object.keys(node)) {
      if (!isPropertyMap && !allowed.has(key)) offenders.push(`${path}.${key}`)
      // properties 的下一层是属性名映射；items / oneOf 的下一层又是 schema
      walk(node[key], `${path}.${key}`, key === 'properties')
    }
  }
  for (const [name, def] of tools) {
    walk(def.parameters, `${name}.parameters`)
    walk(def.output.schema, `${name}.output.schema`)
  }
  assert.deepEqual(offenders, [], `用到了不支持的关键字：${offenders.join(', ')}`)
})

await check('required 只列真实存在的属性（写错名字会让模型永远调不动）', () => {
  const problems = []
  for (const [name, def] of tools) {
    for (const key of def.parameters.required) {
      if (!Object.hasOwn(def.parameters.properties, key)) problems.push(`${name}.required 里的 ${key} 不在 properties 里`)
    }
  }
  assert.deepEqual(problems, [])
})

// ═══════════════════════════════════════════════════════════
//  用【宿主的校验器】验输出 schema —— 本轮补上的最关键一环
// ═══════════════════════════════════════════════════════════
//
// 为什么必须用宿主的校验器，而不是自己写一套断言：
// 作者实测撞到过这个报错——
//     tool "list_question_banks" returned invalid output:
//     "value.banks[1].source_root" must be a string
// 根因是输出 schema 把 `source_root` 写成 `type: 'string'`，
// 而真实题库里这个字段**可以是 null**（手写题库没记来源）。
//
// **而我的离线测试完全查不出它**——假 ctx 的 `register()` 只把定义收进 Map，
// 不做任何输出校验。于是"离线全过"与"真实会话一用就炸"可以同时成立。
//
// 宿主导出了 `validateJsonSchemaValue`，它正是拒绝我的那个校验器。
// 接上它之后，"schema 与真实输出不符"这类问题在离线阶段就会红。
const HOST_TOOLS_URL =
  'file:///C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

let hostValidate = null
let hostAssertSupported = null
try {
  const hostTools = await import(HOST_TOOLS_URL)
  hostValidate = hostTools.validateJsonSchemaValue
  hostAssertSupported = hostTools.assertSupportedJsonSchema
} catch (error) {
  console.log(`  !! 无法加载宿主校验器（跳过输出校验）：${error?.message ?? error}`)
}

// 用宿主自己的关键字检查器复查一遍，比我自己维护的 allowed 集更权威
// （我那份集是从报错文案与实测反推的；这份是宿主真正用的）
if (hostAssertSupported !== null) {
  await check('★ 所有 schema 通过宿主的关键字检查器（比我自维护的清单更权威）', () => {
    const failures = []
    for (const [name, def] of tools) {
      for (const [label, schema] of [['parameters', def.parameters], ['output.schema', def.output.schema]]) {
        try {
          hostAssertSupported(schema)
        } catch (error) {
          failures.push(`${name}.${label}: ${error?.message ?? error}`)
        }
      }
    }
    assert.deepEqual(failures, [], `以下 schema 被宿主的关键字检查器拒绝：\n${failures.join('\n')}`)
  })
}

if (hostValidate !== null) {
  await check('★ 输出 schema 能接受真实的执行结果（跑一遍再交给宿主校验）', async () => {
    // 比"null 骨架"更有力：直接跑真实代码路径，把结果丢给宿主校验器。
    const sb = join(here, '..', '..', 'data', 'output-schema-check')
    rmSync(sb, { recursive: true, force: true })
    mkdirSync(join(sb, 'lh-questions'), { recursive: true })
    const prevLog = process.env.LH_EVENT_LOG
    process.env.LH_EVENT_LOG = join(sb, 'events.jsonl')

    const localTools = new Map()
    // `inject` 必须给（cordis 自带成员）：插件用它注册运行时上下文。
    // 假 ctx 少了它，apply() 会抛 "ctx.inject is not a function"——
    // 那是假 ctx 的缺陷，而不是插件的（E25）。
    plugin.apply({
      tools: { register: (d) => localTools.set(d.name, d) },
      on() {},
      inject(_services, cb) {
        if (typeof cb === 'function') {
          cb({ systemPrompt: { context: () => () => {} } })
        }
      },
    })
    const ex = { agent: { session: { id: 's', header: { cwd: sb } } } }

    const failures = []
    const validate = (name, value) => {
      const violations = hostValidate(localTools.get(name).output.schema, value)
      if (violations.length > 0) failures.push(`${name}: ${violations.slice(0, 5).join('; ')}`)
    }

    // 1) 导入题（顺便造出一个真实题库）
    validate(
      'import_questions',
      await localTools.get('import_questions').execute(
        {
          bank_name: 'schema测试题库',
          questions: [{ number: 1, stem: '这是一道用于校验输出 schema 的题，答案是甲。', options: ['甲', '乙'], answer: 'A', kind: 'single_choice' }],
        },
        ex,
      ),
    )

    // 2) 列题库 —— 正是作者撞到报错的那个工具
    validate('list_question_banks', await localTools.get('list_question_banks').execute({}, ex))

    // 3) 取题
    const got = await localTools.get('get_questions').execute({ bank_name: 'schema测试题库', count: 1 }, ex)
    validate('get_questions', got)

    // 4) 提交作答：correct 的三种取值（true / false / null）都要过
    const qid = got.questions[0].id
    for (const resp of ['A', 'B', '']) {
      validate('submit_answer', await localTools.get('submit_answer').execute({ bank_name: 'schema测试题库', question_id: qid, response: resp }, ex))
    }

    // 5) 进度：accuracy / coverage 可能是 null 也可能是数字，两种都要过
    validate('get_practice_stats', await localTools.get('get_practice_stats').execute({ bank_name: 'schema测试题库' }, ex))

    // 6) 低阶记录工具
    validate('record_attempt', await localTools.get('record_attempt').execute({ bank_name: 'schema测试题库', question_id: qid, response: 'A', source: 'human' }, ex))

    // 7) 关键：**另一个题库没有 source_root**（手写题库的常见形态）——
    //    作者撞到的 `source_root must be a string` 就是这种情形
    await localTools.get('import_questions').execute(
      { bank_name: '无来源题库', questions: [{ stem: '没有 source_root 的题，答案是甲。', options: ['甲', '乙'], answer: 'A' }] },
      ex,
    )
    validate('list_question_banks', await localTools.get('list_question_banks').execute({}, ex))

    process.env.LH_EVENT_LOG = prevLog
    rmSync(sb, { recursive: true, force: true })

    assert.deepEqual(failures, [], `以下输出被宿主校验器拒绝：\n${failures.join('\n')}`)
  })
}

await check('dispose 钩子可调用（验证重载痕迹的机制在）', () => {
  dispose()
})

console.log('\n══ 2. import_questions：正常路径 ══')

reset()
const { ctx: ctx2, tools: tools2 } = makeFakeCtx()
plugin.apply(ctx2)
const importTool = tools2.get('import_questions')
const attemptTool = tools2.get('record_attempt')

const sampleQuestions = [
  { number: 1, stem: '我国现行宪法是哪一年颁布的？', options: ['1954年', '1975年', '1978年', '1982年'], answer: 'D', kind: 'single_choice', analysis: '1982年12月4日通过。' },
  { number: 2, stem: '下列属于行政处罚种类的有：', options: ['警告', '罚款', '没收违法所得', '拘役'], answer: 'A、B、C', kind: 'multiple_choice' },
  { number: 3, stem: '我国法定结婚年龄为男不得早于____周岁。', answer: '22', accept: ['二十二'], kind: 'fill_blank' },
]
const questionsFile = join(sandbox, '抽出的题目.json')
writeFileSync(questionsFile, JSON.stringify(sampleQuestions, null, 2), 'utf8')

const imported = await importTool.execute(
  { bank_name: '行测-常识判断', file_path: questionsFile, source_root: FIXTURE_SOURCE_ROOT, source_file: '行测/常识判断.pdf', provenance_model: 'deepseek-flash' },
  makeExec(),
)

await check('3 道题全部入库，无拒绝', () => {
  assert.equal(imported.question_count, 3)
  assert.equal(imported.added_count, 3)
  assert.equal(imported.rejected_count, 0)
  assert.equal(imported.replaced_count, 0)
})

await check('题库落到工作区的 lh-questions/ 下', () => {
  assert.equal(imported.bank_path, join(sandbox, 'lh-questions', '行测-常识判断.json'))
  assert.ok(existsSync(imported.bank_path), '题库文件没写出来')
})

await check('渲染能跑，且不把题库全文塞进对话', () => {
  const rendered = importTool.output.render({}, imported)
  const text = rendered.map((r) => r.text).join('\n')
  assert.match(text, /现有 3 道题/)
  assert.ok(text.length < 1000, `渲染太长（${text.length} 字），会把上下文挤爆`)
})

await check('事件写进了 LH 事件日志', () => {
  const evs = readSandboxEvents().filter((e) => e.type === 'lh/resource/questions-imported')
  assert.equal(evs.length, 1)
  assert.equal(evs[0].data.question_count, 3)
  assert.equal(evs[0].content_ref, imported.bank_path)
  assert.equal(evs[0].provenance.model, 'deepseek-flash', 'provenance 必须留下抽取模型（决定下游信任度）')
})

await check('题库正文不在事件里（只在文件里）', () => {
  const evs = readSandboxEvents().filter((e) => e.type === 'lh/resource/questions-imported')
  assert.ok(!('questions' in evs[0].data), '题目正文被内嵌进事件了——大 payload 应当外置')
})

await check('题库文件本身就是合法 JSON 且带 schema 版本（可被独立读回）', () => {
  const bank = JSON.parse(readFileSync(imported.bank_path, 'utf8'))
  assert.equal(bank.schema_version, 1)
  assert.equal(bank.questions.length, 3)
  assert.match(bank.questions[0].id, /^q-[0-9a-f]{12}$/)
})

console.log('\n══ 3. import_questions：幂等与合并 ══')

await check('完全相同的题目重导 → 全部替换、总数不变（幂等）', async () => {
  const again = await importTool.execute({ bank_name: '行测-常识判断', file_path: questionsFile, source_root: FIXTURE_SOURCE_ROOT, source_file: '行测/常识判断.pdf' }, makeExec())
  assert.equal(again.question_count, 3, '重导后题数变了，说明 id 不稳定')
  assert.equal(again.added_count, 0)
  assert.equal(again.replaced_count, 3)
})

await check('supersedes 链指向上一条同题库记录（更新 = 新资源 + 指针）', () => {
  const evs = readSandboxEvents().filter((e) => e.type === 'lh/resource/questions-imported')
  assert.equal(evs.length, 2)
  assert.equal(evs[0].data.supersedes.length, 0, '第一条不该取代任何东西')
  assert.deepEqual(evs[1].data.supersedes, [evs[0].id], '第二条应当取代第一条')
})

await check('追加新题 → 老题保留，总数累加', async () => {
  const extra = join(sandbox, '追加.json')
  writeFileSync(extra, JSON.stringify([{ number: 4, stem: '这是一道全新的题，答案是甲。', options: ['甲', '乙'], answer: 'A', kind: 'single_choice' }]), 'utf8')
  const r = await importTool.execute({ bank_name: '行测-常识判断', file_path: extra, source_root: FIXTURE_SOURCE_ROOT, source_file: '行测/常识判断.pdf' }, makeExec())
  assert.equal(r.question_count, 4)
  assert.equal(r.added_count, 1)
  assert.equal(r.replaced_count, 0)
})

await check('部分题不合格 → 好的入库、坏的报原因（不整批拒绝）', async () => {
  const mixed = join(sandbox, '混合.json')
  writeFileSync(
    mixed,
    JSON.stringify([
      { number: 10, stem: '合格的题', options: ['甲', '乙'], answer: 'A', kind: 'single_choice' },
      { number: 11, stem: '', options: ['甲'], answer: 'A' },
      { number: 12, stem: '答案标签越界', options: ['甲', '乙'], answer: 'E', kind: 'single_choice' },
    ]),
    'utf8',
  )
  const r = await importTool.execute({ bank_name: '混合题库', file_path: mixed }, makeExec())
  assert.equal(r.added_count, 1)
  assert.equal(r.rejected_count, 2)
  assert.equal(r.errors.length, 2)
  assert.match(r.errors[0].message, /缺题干/)
  assert.match(r.errors[1].message, /不是有效选项标签/)
})

await check('全部不合格 → 抛错，不留下一个空题库', async () => {
  const bad = join(sandbox, '全坏.json')
  writeFileSync(bad, JSON.stringify([{ stem: '', answer: 'A' }]), 'utf8')
  await assert.rejects(async () => importTool.execute({ bank_name: '空题库', file_path: bad }, makeExec()), /没有一道题通过校验/)
  assert.ok(!existsSync(join(sandbox, 'lh-questions', '空题库.json')), '拒绝了却还是建了文件')
})

await check('内联 questions 也能用', async () => {
  const r = await importTool.execute({ bank_name: '内联题库', questions: [{ stem: '内联题', options: ['甲', '乙'], answer: 'B', kind: 'single_choice' }] }, makeExec())
  assert.equal(r.added_count, 1)
})

await check('既不给 file_path 也不给 questions → 报错说清楚', async () => {
  await assert.rejects(async () => importTool.execute({ bank_name: 'x' }, makeExec()), /必须提供 file_path/)
})

await check('文件不存在 → 报错带路径', async () => {
  await assert.rejects(async () => importTool.execute({ bank_name: 'x', file_path: join(sandbox, '没有这个文件.json') }, makeExec()), /题目文件不存在/)
})

await check('文件不是 JSON → 报错说清楚', async () => {
  const broken = join(sandbox, '坏的.json')
  writeFileSync(broken, '{ this is not json', 'utf8')
  await assert.rejects(async () => importTool.execute({ bank_name: 'x', file_path: broken }, makeExec()), /不是合法 JSON/)
})

await check('文件里没有可识别的题目 → 报错说清楚', async () => {
  const weird = join(sandbox, '怪形态.json')
  writeFileSync(weird, JSON.stringify({ hello: 'world' }), 'utf8')
  await assert.rejects(async () => importTool.execute({ bank_name: 'x', file_path: weird }, makeExec()), /没有识别出题目/)
})

await check('题库名里的非法字符被安全化（不留路径穿越的机会）', async () => {
  const r = await importTool.execute({ bank_name: '../../逃逸/题库:名', questions: [{ stem: '安全化测试题', options: ['甲', '乙'], answer: 'A' }] }, makeExec())
  // 判据是**解析后的真实路径**，不是字符串里有没有 '..'——
  // '..-..-逃逸-题库-名.json' 里含 '..' 但它是个合法文件名，并没有穿越。
  const resolved = resolve(r.bank_path)
  assert.ok(resolved.startsWith(resolve(sandbox) + sep), `路径逃出了工作区：${resolved}`)
  assert.ok(resolved.startsWith(resolve(join(sandbox, 'lh-questions')) + sep), `落点不在 lh-questions/ 下：${resolved}`)
})

await check('已有题库文件损坏时拒绝覆盖（不许静默销毁学习者的题库）', async () => {
  const p = join(sandbox, 'lh-questions', '受损题库.json')
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, '{ 坏掉的 json', 'utf8')
  await assert.rejects(
    async () => importTool.execute({ bank_name: '受损题库', questions: [{ stem: '新题', options: ['甲'], answer: 'A' }] }, makeExec()),
    /拒绝覆盖/,
  )
  // 而且原文件必须原样还在
  assert.equal(readFileSync(p, 'utf8'), '{ 坏掉的 json')
})

await check('拿不到工作区路径 → 明确报错（不猜落点）', async () => {
  await assert.rejects(async () => importTool.execute({ bank_name: 'x', questions: [{ stem: 'y', answer: 'z' }] }, { agent: { session: { id: 's' } } }), /拿不到工作区路径/)
})

console.log('\n══ 4. record_attempt ══')

reset()
const { ctx: ctx3, tools: tools3 } = makeFakeCtx()
plugin.apply(ctx3)
const import3 = tools3.get('import_questions')
const attempt3 = tools3.get('record_attempt')

const imported3 = await import3.execute({ bank_name: '作答测试', file_path: questionsFile, source_root: FIXTURE_SOURCE_ROOT, source_file: '行测/常识判断.pdf' }, makeExec())
const bankFile = JSON.parse(readFileSync(imported3.bank_path, 'utf8'))
const qSingle = bankFile.questions.find((q) => q.kind === 'single_choice')
const qMulti = bankFile.questions.find((q) => q.kind === 'multiple_choice')
const qFill = bankFile.questions.find((q) => q.kind === 'fill_blank')

await check('答对 → correct=true', async () => {
  const r = await attempt3.execute({ bank_name: '作答测试', question_id: qSingle.id, response: 'D', source: 'human' }, makeExec())
  assert.equal(r.correct, true)
})

await check('答错 → correct=false', async () => {
  const r = await attempt3.execute({ bank_name: '作答测试', question_id: qSingle.id, response: 'A', source: 'human' }, makeExec())
  assert.equal(r.correct, false)
})

await check('多选顺序无关', async () => {
  const r = await attempt3.execute({ bank_name: '作答测试', question_id: qMulti.id, response: 'C、A、B', source: 'human' }, makeExec())
  assert.equal(r.correct, true)
})

await check('填空题的 accept 替代答案也算对', async () => {
  const r = await attempt3.execute({ bank_name: '作答测试', question_id: qFill.id, response: '二十二', source: 'human' }, makeExec())
  assert.equal(r.correct, true)
})

await check('空作答 → null（不默认算错）', async () => {
  const r = await attempt3.execute({ bank_name: '作答测试', question_id: qSingle.id, response: '', source: 'human' }, makeExec())
  assert.equal(r.correct, null)
  assert.match(attempt3.output.render({}, r).map((x) => x.text).join(''), /判不了/)
})

await check('事件里 actor 与 source 都是 llm（模型答对不算"我会了"）', async () => {
  await attempt3.execute({ bank_name: '作答测试', question_id: qSingle.id, response: 'D', source: 'llm' }, makeExec())
  const attempts = readSandboxEvents().filter((e) => e.type === 'lh/user/attempt')
  const llmOne = attempts.filter((a) => a.data.source === 'llm')
  assert.equal(llmOne.length, 1)
  assert.equal(llmOne[0].actor, 'llm', 'actor 应当是 llm，便于直接按 actor 筛选')
  assert.equal(llmOne[0].data.correct, true)
})

await check('作答事件带 session_ref（可回溯到当时的会话）', async () => {
  const a = readSandboxEvents().find((e) => e.type === 'lh/user/attempt')
  assert.equal(a.session_ref, 'session-selftest')
  assert.equal(a.data.context.session_ref, 'session-selftest')
  // seq 明确为 null（工具执行期拿不到宿主序号）——不编造坐标
  assert.equal(a.data.context.seq, null)
})

await check('工具传 note → 备注真的落盘（接线测试：schema 收了就必须透传）', async () => {
  // 2026-10-14 审查抓到的缺陷：record_attempt 的 schema 声明了 note/note_kind，
  // execute 却没透传给 recordAttempt——备注**不报错地消失**。
  // 函数层（selftest-note）一直是绿的，缺的正是这条**工具接线**的断言。
  const before = readSandboxEvents().filter((e) => e.type === 'lh/resource/note-made').length
  const r = await attempt3.execute(
    {
      bank_name: '作答测试',
      question_id: qSingle.id,
      response: 'D',
      source: 'llm',
      model: 'test-model-x',
      note: '排除 A/B 后在 C、D 之间犹豫，选 D 是因为题干问的是"现行"',
      note_kind: 'reasoning',
    },
    makeExec(),
  )
  const notes = readSandboxEvents().filter((e) => e.type === 'lh/resource/note-made')
  assert.equal(notes.length, before + 1, '工具收了 note 就必须写一条 note-made 事件')
  const note = notes[notes.length - 1]
  assert.equal(note.data.target_kind, 'attempt')
  assert.equal(note.data.target_id, r.attempt_event_id, '备注要挂在**这次**作答上')
  assert.equal(note.data.note_kind, 'reasoning')
  assert.equal(note.data.author, 'agent', '模型答的 → 备注归模型')
  assert.equal(note.data.model, 'test-model-x')
})

await check('题目不存在 → 抛错，而不是记一条"答错"', async () => {
  const before = readFileSync(join(sandbox, 'events.jsonl'), 'utf8')
  await assert.rejects(
    async () => attempt3.execute({ bank_name: '作答测试', question_id: 'q-000000000000', response: 'A', source: 'human' }, makeExec()),
    /没有 id 为/,
  )
  assert.equal(readFileSync(join(sandbox, 'events.jsonl'), 'utf8'), before, '失败时不该写任何事件')
})

await check('题库不存在 → 抛错，并把可用题库名列出来', async () => {
  // 断言改过一次：原文案是"题库不存在：<路径>"，现在是
  //   「题库「X」不存在。可用的题库名（请用其中之一原样重试）：「作答测试」」
  // 新文案更好——它把可选项直接给出，agent 不需要额外调一次工具就能自我纠正
  // （实测旧文案里写的"用 list_question_banks 看有哪些题库"**agent 不会去调**，
  //   而是直接把错误抛给学习者）。
  await assert.rejects(
    async () => attempt3.execute({ bank_name: '不存在的题库', question_id: 'q-x', response: 'A', source: 'human' }, makeExec()),
    /题库「不存在的题库」不存在[\s\S]*可用的题库名/,
  )
})

await check('非法 source → 抛错', async () => {
  await assert.rejects(async () => attempt3.execute({ bank_name: '作答测试', question_id: qSingle.id, response: 'A', source: 'robot' }, makeExec()), /source 非法/)
})

await check('缺 question_id / response → 抛错说清楚', async () => {
  await assert.rejects(async () => attempt3.execute({ bank_name: '作答测试', response: 'A', source: 'human' }, makeExec()), /question_id 必填/)
  await assert.rejects(async () => attempt3.execute({ bank_name: '作答测试', question_id: qSingle.id, source: 'human' }, makeExec()), /response 必填/)
})

console.log('\n══ 5. 数据往返：统计能从事件流重建 ══')

await check('作答统计完全从 events.jsonl 重建（单一事实源）', () => {
  const { attempts, malformed } = extractAttempts(readSandboxEvents())
  assert.equal(malformed.length, 0, `有坏记录：${JSON.stringify(malformed)}`)
  // 断言**结构不变量**，不写死次数——
  // 写死次数会让这条用例依赖"别的用例跑没跑"，一个用例挂了就连带误报（第一版就是这样）。
  const s = summarizeAttempts({ attempts })
  assert.equal(s.total, attempts.length)
  assert.equal(s.correct + s.wrong + s.unjudged, s.total, '三项之和必须等于总数')
  assert.ok(s.by_source.human.total > 0, '应当有人答的记录')
  assert.equal(s.by_source.llm.total, 2, '本段让模型答了两次（actor/scc 那条 + note 接线那条）——数字要跟用例一起变')
  assert.equal(s.by_source.llm.correct, 2, '两次都答对了（都是选 D）')
  assert.equal(s.by_source.human.unjudged, 1, '人答的里有一次空作答，必须单列为判不了')
  const judged = s.correct + s.wrong
  if (judged > 0) assert.equal(s.accuracy, Number((s.correct / judged).toFixed(4)), '正确率分母只能算判得了的')
  console.log(`       统计：total=${s.total} correct=${s.correct} wrong=${s.wrong} unjudged=${s.unjudged} accuracy=${s.accuracy}`)
})

await check('题库文件与事件流对得上（事件记的题数与文件实际一致）', () => {
  const evs = readSandboxEvents().filter((e) => e.type === 'lh/resource/questions-imported')
  const last = evs[evs.length - 1]
  const bank = JSON.parse(readFileSync(last.data.bank_path, 'utf8'))
  assert.equal(bank.question_count, last.data.question_count, '事件与文件不一致：有人绕过事件改了文件？')
})

console.log('\n══ 6. 刷题循环：取题（绝不能带答案）══')

reset()
const { ctx: ctx6, tools: tools6 } = makeFakeCtx()
plugin.apply(ctx6)
const import6 = tools6.get('import_questions')
const listBanks6 = tools6.get('list_question_banks')
const getQ6 = tools6.get('get_questions')
const submit6 = tools6.get('submit_answer')
const stats6 = tools6.get('get_practice_stats')

const bankName6 = '刷题循环测试'
await import6.execute({ bank_name: bankName6, file_path: questionsFile, source_root: FIXTURE_SOURCE_ROOT, source_file: '行测/常识判断.pdf' }, makeExec())
// 再加两道，够测分页与顺序
await import6.execute(
  {
    bank_name: bankName6,
    questions: [
      { number: 20, stem: '第五道题：甲还是乙？', options: ['甲', '乙'], answer: 'A', kind: 'single_choice' },
      { number: 21, stem: '第六道题：丙还是丁？', options: ['丙', '丁'], answer: 'B', kind: 'single_choice' },
    ],
    source_root: FIXTURE_SOURCE_ROOT,
    source_file: '行测/常识判断.pdf',
  },
  makeExec(),
)

await check('list_question_banks 能看到题库，并给出题数', async () => {
  const r = await listBanks6.execute({}, makeExec())
  const mine = r.banks.find((b) => b.name === bankName6)
  assert.ok(mine, `列表里没有 ${bankName6}`)
  assert.equal(mine.ok, true)
  assert.equal(mine.question_count, 5)
})

await check('工作区没有题库时明确说"还没有"，而不是报错', async () => {
  const empty = join(sandbox, '空工作区')
  mkdirSync(empty, { recursive: true })
  const r = await listBanks6.execute({}, { agent: { session: { id: 's', header: { cwd: empty } } } })
  assert.equal(r.bank_count, 0)
  assert.match(listBanks6.output.render({}, r).map((x) => x.text).join(''), /还没有题库/)
})

const taken = await getQ6.execute({ bank_name: bankName6, count: 3 }, makeExec())

await check('取到 3 道，且是题库里的原始顺序', async () => {
  assert.equal(taken.question_count, 3)
  assert.equal(taken.total_in_bank, 5)
  assert.equal(taken.order, 'sequential')
  const bank = JSON.parse(readFileSync(join(sandbox, 'lh-questions', `${bankName6}.json`), 'utf8'))
  assert.deepEqual(
    taken.questions.map((q) => q.id),
    bank.questions.slice(0, 3).map((q) => q.id),
    '取题顺序与题库文件顺序不一致——那会让"按章节刷"失效',
  )
})

await check('★ 取题的结果里**没有答案、没有解析**（否则出题即泄题）', async () => {
  assert.ok(!('answer' in taken.questions[0]), '题目对象里带了 answer')
  assert.ok(!('analysis' in taken.questions[0]), '题目对象里带了 analysis')
  assert.ok(!('accept' in taken.questions[0]), '题目对象里带了 accept')
  // 渲染文本里也不能漏出答案
  const text = getQ6.output.render({}, taken).map((x) => x.text).join('\n')
  assert.ok(!text.includes('1982年12月4日'), '渲染文本里出现了题库的解析原文')
})

await check('选项是结构化的 {label, text}，文本与按钮界面共用同一份数据', async () => {
  const q = taken.questions[0]
  assert.equal(q.kind, 'single_choice')
  assert.deepEqual(q.options[0], { label: 'A', text: '1954年' })
  assert.equal(q.options[3].label, 'D')
})

await check('填空题的 options 是空数组（界面据此决定让他打字）', async () => {
  const bankOnDisk = JSON.parse(readFileSync(join(sandbox, 'lh-questions', `${bankName6}.json`), 'utf8'))
  const fillId = bankOnDisk.questions.find((q) => q.kind === 'fill_blank').id
  const r = await getQ6.execute({ bank_name: bankName6, ids: [fillId] }, makeExec())
  assert.equal(r.questions[0].kind, 'fill_blank')
  assert.deepEqual(r.questions[0].options, [])
})

await check('exclude_ids 能避免连着出同一道', async () => {
  const first = taken.questions[0].id
  const r = await getQ6.execute({ bank_name: bankName6, count: 1, exclude_ids: [first] }, makeExec())
  assert.notEqual(r.questions[0].id, first)
})

await check('★ 题库不存在时报错指路，而不是静默给空', async () => {
  await assert.rejects(async () => getQ6.execute({ bank_name: '不存在的题库' }, makeExec()), /题库「不存在的题库」不存在/)
})

await check('★ 题库名写错时，报错里直接列出可用题库名（不让 agent 再调一次工具）', async () => {
  // 实测 agent 会把「片段阅读600题」说成「片段阅读」。
  // 第一版的报错是"用 list_question_banks 看有哪些题库"——**而 agent 没去调，
  // 直接把错误抛给了学习者**。所以指路式提示不可靠，必须把选项写进错误本身。
  let message = ''
  try {
    await getQ6.execute({ bank_name: '刷题循环' }, makeExec())
  } catch (error) {
    message = error.message
  }
  assert.ok(message.includes('不存在'), '报错里没说清不存在')
  assert.ok(message.includes(bankName6), `报错里没有列出可用题库名「${bankName6}」:\n${message}`)
  assert.ok(message.includes('名字相近'), `没有给出相近名提示:\n${message}`)
})

await check('★ 报错里给出的题库名必须真的能用（给了错名字比不给更糟）', async () => {
  let message = ''
  try {
    await getQ6.execute({ bank_name: '刷题循环' }, makeExec())
  } catch (error) {
    message = error.message
  }
  const quoted = [...message.matchAll(/「([^」]+)」/g)].map((m) => m[1]).filter((n) => n !== '刷题循环')
  assert.ok(quoted.length > 0, '报错里没有引出任何名字')
  for (const name of quoted) {
    const r = await getQ6.execute({ bank_name: name, count: 1 }, makeExec())
    assert.ok(r.question_count >= 1, `报错里给的「${name}」取不到题`)
  }
})

await check('★ 伴生文件不被当成题库列出（否则 agent 会看到名字很像的多个选项）', async () => {
  // 实测撞到过：build_bank.py 产出 `…option-notes.json`，
  // 而 listQuestionBanks 只判断"以 .json 结尾"，于是把它也列成了题库。
  //
  // ⚠ 这条用例**只写伴生文件、不建新题库**——建新题库会污染后面几段
  // （它们假设本段只有一个题库）。第一版就是在这里建了题库，
  // 导致第 7、8 段全线失败。
  const dir = join(sandbox, 'lh-questions')
  writeFileSync(join(dir, `${bankName6}.option-notes.json`), JSON.stringify({ notes: {} }), 'utf8')
  writeFileSync(join(dir, `${bankName6}.extract-report.json`), JSON.stringify({ rows: [] }), 'utf8')
  const r = await listBanks6.execute({}, makeExec())
  const names = r.banks.map((b) => b.name)
  assert.ok(names.includes(bankName6), '题库本体不在列表里')
  assert.ok(
    !names.some((n) => n.includes('option-notes') || n.includes('extract-report')),
    `伴生文件被当成了题库：${names.join('、')}`,
  )
  rmSync(join(dir, `${bankName6}.option-notes.json`), { force: true })
  rmSync(join(dir, `${bankName6}.extract-report.json`), { force: true })
})

await check('本段沙盒里只有这一个题库（与其它段隔离）', async () => {
  const r = await listBanks6.execute({}, makeExec())
  assert.equal(r.bank_count, 1, `本段只应有一个题库，实际 ${r.bank_count}`)
})

console.log('\n══ 7. 刷题循环：提交作答（记录与讲解必须同一步）══')

const q1 = taken.questions[0]

await check('答错 → 同时拿到对错、标准答案、解析', async () => {
  const r = await submit6.execute({ bank_name: bankName6, question_id: q1.id, response: 'A' }, makeExec())
  assert.equal(r.correct, false)
  assert.deepEqual(r.answer, ['D'])
  assert.match(r.analysis, /1982/, '答错时要能拿到解析，否则讲不出为什么')
  assert.equal(r.source, 'human', '默认应当是学习者的作答')
})

await check('答对 → correct=true，且 render 不啰嗦', async () => {
  const r = await submit6.execute({ bank_name: bankName6, question_id: q1.id, response: 'D' }, makeExec())
  assert.equal(r.correct, true)
  const text = submit6.output.render({}, r).map((x) => x.text).join('')
  assert.match(text, /答对/)
})

await check('★ 提交一次只产生一条作答事件（不会重复记）', async () => {
  const before = readSandboxEvents().filter((e) => e.type === 'lh/user/attempt').length
  await submit6.execute({ bank_name: bankName6, question_id: q1.id, response: 'D' }, makeExec())
  const after = readSandboxEvents().filter((e) => e.type === 'lh/user/attempt').length
  assert.equal(after - before, 1)
})

await check('★ 判不了 → null，且 render 明说"没被算成答错"', async () => {
  const r = await submit6.execute({ bank_name: bankName6, question_id: q1.id, response: '' }, makeExec())
  assert.equal(r.correct, null)
  assert.match(submit6.output.render({}, r).map((x) => x.text).join(''), /判不了/)
})

await check('★ 没有解析时 render 提醒"别编造依据"（防止模型硬讲）', async () => {
  const noAnalysis = taken.questions[1].id // sampleQuestions 里第 2 题没有 analysis
  const r = await submit6.execute({ bank_name: bankName6, question_id: noAnalysis, response: 'A' }, makeExec())
  assert.equal(r.correct, false)
  assert.match(submit6.output.render({}, r).map((x) => x.text).join(''), /别编造标准答案之外的依据/)
})

await check('source 默认 human；要求示范时才用 llm', async () => {
  const r = await submit6.execute({ bank_name: bankName6, question_id: q1.id, response: 'D', source: 'llm' }, makeExec())
  assert.equal(r.source, 'llm')
})

console.log('\n══ 8. 刷题循环：进度与错题 ══')

const stats = await stats6.execute({ bank_name: bankName6 }, makeExec())

await check('进度统计的形状完整', () => {
  assert.equal(stats.total_questions, 5)
  assert.ok(stats.attempted_questions >= 1)
  assert.ok(stats.coverage > 0 && stats.coverage <= 1)
})

await check('★ 模型代答不被算进学习成果', () => {
  assert.ok(stats.llm_attempts >= 1, '本段答过至少一次 llm')
  const text = stats6.output.render({}, stats).map((x) => x.text).join('\n')
  assert.match(text, /模型代答，未计入正确率/)
})

await check('判不了的次数单列，且不进正确率分母', () => {
  assert.ok(stats.human_unjudged >= 1)
  const judged = stats.human_correct + stats.human_wrong
  assert.equal(stats.accuracy, Number((stats.human_correct / judged).toFixed(4)))
})

await check('★ 错题本能被列出（最近一次答错的题）', async () => {
  // 注意顺序：上面有一条用例故意把 q1 答对了（验证"答对后移出错题本"），
  // 所以这里必须先制造一次明确的答错，否则断言会和那条用例打架。
  // 第一版就是漏了这一点，把"代码对"记成了失败。
  await submit6.execute({ bank_name: bankName6, question_id: q1.id, response: 'A' }, makeExec())
  const s = await stats6.execute({ bank_name: bankName6 }, makeExec())
  assert.ok(s.missed_recent.length >= 1, '刚答错了一道，错题本却是空的')
  assert.ok(s.missed_recent.map((m) => m.id).includes(q1.id), '第一道刚答错，应当出现在错题本里')
  const text = stats6.output.render({}, s).map((x) => x.text).join('\n')
  assert.match(text, /最近答错的/)
})

await check('★ 后来答对的题会从错题本里消失（按"最近一次"而非"曾经错过"）', async () => {
  const before = await stats6.execute({ bank_name: bankName6 }, makeExec())
  const target = before.missed_recent[0].id
  const bankOnDisk = JSON.parse(readFileSync(join(sandbox, 'lh-questions', `${bankName6}.json`), 'utf8'))
  const q = bankOnDisk.questions.find((x) => x.id === target)
  await submit6.execute({ bank_name: bankName6, question_id: target, response: q.answer.join('、') }, makeExec())
  const after = await stats6.execute({ bank_name: bankName6 }, makeExec())
  assert.ok(!after.missed_recent.map((m) => m.id).includes(target), '答对了却还留在错题本里')
})

await check('★ order=attempted：只取**做过的**（"重刷做过的题"要的就是这一档）', async () => {
  // 为什么会加这一档：2026-09-19 反馈——学习者说"我想重刷做过的题目"，
  // 弹出的卡片却是**整个题库**。根因是当时只有 `missed`（上次答错的），
  // "做过的"无处可映射，只能退化成 sequential（=全库）。
  //
  // ⚠ `attempted` 与 `missed` **不是一回事**：前者含"做过且做对了"的题。
  // 这一条断言的重点正是：**做对的那些也算"做过的"**。
  const s = await stats6.execute({ bank_name: bankName6 }, makeExec())
  const r = await getQ6.execute({ bank_name: bankName6, order: 'attempted', count: 99 }, makeExec())

  assert.equal(r.order, 'attempted', '策略不该被退化（这里有做过的题）')
  assert.equal(r.question_count, s.attempted_questions, `做过的题应全部取回，实际 ${r.question_count}/${s.attempted_questions}`)

  const missedIds = new Set(s.missed_recent.map((m) => m.id))
  const hasCorrectOne = r.questions.some((q) => !missedIds.has(q.id))
  assert.ok(
    hasCorrectOne || r.questions.length === missedIds.size,
    'order=attempted 看起来只是 missed 的别名 —— 它必须包含"做过且做对了"的题',
  )
})

await check('order=attempted 在一道都没做过时退化为顺序，不返回空', async () => {
  const freshBank = '没做过任何题的库'
  await import6.execute({
    bank_name: freshBank,
    file_path: questionsFile,
    source_root: FIXTURE_SOURCE_ROOT,
    source_file: '行测/未作答.pdf',
  }, makeExec())
  const r = await getQ6.execute({ bank_name: freshBank, order: 'attempted', count: 2 }, makeExec())
  assert.ok(r.question_count > 0, 'attempted 在没做过时返回了空 —— 学习者会看到"没题了"')
  assert.match(r.note, /还没有做过的题/)
})

await check('order=missed 取到的题全是错题本里的，且数量对得上', async () => {
  const s = await stats6.execute({ bank_name: bankName6 }, makeExec())
  const r = await getQ6.execute({ bank_name: bankName6, order: 'missed', count: 99 }, makeExec())
  const missedIds = new Set(s.missed_recent.map((m) => m.id))
  assert.equal(r.question_count, missedIds.size)
  for (const q of r.questions) {
    assert.ok(missedIds.has(q.id), `${q.id} 不在错题本里，却是 order=missed 取出来的`)
  }
})

await check('★ order=unseen 在全部做过之后退化为顺序，而不是返回空', async () => {
  const bankOnDisk = JSON.parse(readFileSync(join(sandbox, 'lh-questions', `${bankName6}.json`), 'utf8'))
  for (const q of bankOnDisk.questions) {
    await submit6.execute({ bank_name: bankName6, question_id: q.id, response: q.answer.join('、'), source: 'llm' }, makeExec())
  }
  const r = await getQ6.execute({ bank_name: bankName6, order: 'unseen', count: 2 }, makeExec())
  assert.equal(r.question_count, 2, 'unseen 退化了却返回了空')
  assert.match(r.note, /都做过了/)
})

await check('不认识的 order 退回 sequential 并留痕，而不是抛错', async () => {
  const r = await getQ6.execute({ bank_name: bankName6, order: '按遗忘曲线', count: 1 }, makeExec())
  assert.equal(r.order, 'sequential')
  assert.match(r.note, /不认识/)
})

await check('随机顺序仍能取到题（不重复、不丢）', async () => {
  const r = await getQ6.execute({ bank_name: bankName6, count: 5, order: 'random' }, makeExec())
  assert.equal(r.question_count, 5)
  assert.equal(new Set(r.questions.map((q) => q.id)).size, 5, '随机取题出现了重复')
})

await check('count 超出题数时如实说明只取到几道', async () => {
  const r = await getQ6.execute({ bank_name: bankName6, count: 99 }, makeExec())
  assert.equal(r.question_count, 5)
  assert.match(r.note, /只取到 5 道/)
})

await check('进度统计的 render 不给假精度（无数据时说"还没有数据"）', () => {
  const fake = {
    bank_name: 'x',
    total_questions: 0,
    attempted_questions: 0,
    coverage: null,
    accuracy: null,
    human_correct: 0,
    human_wrong: 0,
    human_unjudged: 0,
    llm_attempts: 0,
    missed_recent: [],
  }
  const text = stats6.output.render({}, fake).map((x) => x.text).join('\n')
  assert.match(text, /还没有数据/)
  assert.ok(!text.includes('0.0%'), '把"没数据"渲染成了 0.0% —— 那是假的精度')
})

console.log('\n══ 9. 无来源题库：source_root 为 null 时也要能用（作者实测撞到的报错）══')

await check('★ 不含 source_root 的题库能被列出，且 source_root 是 null', async () => {
  // 作者实测：tool "list_question_banks" returned invalid output:
  //   "value.banks[1].source_root" must be a string
  // 根因是输出 schema 写成 `type: 'string'`，而手写题库没有 source_root
  // （`listQuestionBanks` 里给的是 `bank?.source_root ?? null`）。
  //
  // 这一段放在最后：它会新建题库，跑在中间会污染其余段落的"只有一个题库"假设
  // （第一版就是放在第 6 段里，导致第 7、8 段全线失败）。
  await import6.execute(
    { bank_name: '无来源题库', questions: [{ stem: '这道题没有 source_root，答案是甲。', options: ['甲', '乙'], answer: 'A' }] },
    makeExec(),
  )
  const listed = await listBanks6.execute({}, makeExec())
  const noSource = listed.banks.find((b) => b.name === '无来源题库')
  assert.ok(noSource, '无来源题库没被列出')
  assert.equal(noSource.source_root, null, 'source_root 应为 null')
})

await check('★ 列出含 null 字段的题库时，渲染不能假设它是字符串', async () => {
  const listed = await listBanks6.execute({}, makeExec())
  const text = listBanks6.output.render({}, listed).map((x) => x.text).join('\n')
  assert.ok(text.includes('无来源题库'))
  assert.ok(text.includes(bankName6))
})

await check('无来源题库也能取题与作答', async () => {
  const got = await getQ6.execute({ bank_name: '无来源题库', count: 1 }, makeExec())
  assert.equal(got.question_count, 1)
  const r = await submit6.execute({ bank_name: '无来源题库', question_id: got.questions[0].id, response: 'A' }, makeExec())
  assert.equal(r.correct, true)
})

console.log('\n══ 10. start_practice：把「开始刷题」卡片放进对话 ══')

// 入口的设计改过两次，前两版都被作者否掉：常驻侧栏按钮（"很突兀"）、
// 以及"信号一到就自动弹面板"。现在是第三版：**对话里的卡片，由学习者点**。
//
// 所以这个工具要成立，需要两件事同时对：
//   1. 它写出递增信号 —— 卡片点开时靠它知道"agent 请了哪个题库、几道题"；
//   2. 它返回的渲染文本**告诉学习者去点卡片** —— 否则卡片在那儿也没人知道要点。

const startPractice = tools6.get('start_practice')

await check('start_practice 已注册，且描述说明它放卡片、不取题、不自动开面板', () => {
  assert.ok(startPractice, '没有注册 start_practice')
  assert.match(startPractice.description, /卡片/, '描述里没说是"卡片"这种形态，agent 就不知道入口长什么样')
  assert.match(startPractice.description, /不取题/, '描述里没说明它不取题（否则 agent 会误以为它出题）')
  assert.match(startPractice.description, /get_questions/, '没告诉 agent"只想在对话里问题就用 get_questions"')
  // ★ 这一条防的是**退回被否掉的第二版**（"信号一到就自动弹面板"）。
  //
  // 这里刻意**不用** "描述里不许出现'自动打开'" 这种否定式断言：
  // 试过，它会被**禁令本身**触发——描述里写着"也不会自动弹出面板"，
  // 而那正是我们要求的说法。**一个会被正确写法触发的检查，比没有检查更坏**：
  // 人会为了让检查变绿而把该说的话删掉。
  //
  // 改成断言"该说的那句必须说"：要点在于**学习者得动手**。
  assert.match(
    startPractice.description,
    /点/,
    '描述里必须说明"由学习者点" —— 否则 agent 会以为面板会自己出现',
  )
})

await check('★ 调用后写出递增信号（面板靠它判断是否是新请求）', async () => {
  const before = readPracticeSignal().seq
  const r = await startPractice.execute({ bank_name: bankName6, count: 5 }, makeExec())
  assert.equal(r.opened, true)
  assert.equal(r.signal_seq, before + 1, 'seq 必须比上次大 1')
  const after = readPracticeSignal()
  assert.equal(after.seq, before + 1)
  assert.equal(after.by, 'agent', 'by 应标为 agent —— 好知道是谁开的')
  assert.equal(after.count, 5)
})

await check('★ 题库名对得上时，信号里带上它（面板就能直接刷对的库）', async () => {
  const r = await startPractice.execute({ bank_name: bankName6 }, makeExec())
  assert.equal(r.chosen_bank, bankName6)
  assert.equal(readPracticeSignal().bank, bankName6)
})

await check('★ 题库名写错时不报错，但返回值里列出全部可选项（agent 能自纠）', async () => {
  // 为什么不报错：这个工具的职责是"打开面板"，而不是"校验题库名"。
  // 名字不对时面板会用第一个题库——但那不该让工具失败、让学习者看到一条错误。
  // 同时把可选项列出来，agent 就能告诉学习者"你说的那个库不在，有的是这些"。
  const r = await startPractice.execute({ bank_name: '不存在的库' }, makeExec())
  assert.equal(r.opened, true)
  assert.equal(r.chosen_bank, null, '对不上时 chosen_bank 应为 null')
  assert.ok(r.bank_count >= 1)
  assert.ok(r.banks.some((b) => b.name === bankName6), '返回值里应列出真实题库名')
})

await check('不带参数也能开（面板会让学习者选）', async () => {
  const r = await startPractice.execute({}, makeExec())
  assert.equal(r.opened, true)
  assert.equal(r.chosen_bank, null)
  assert.ok(r.signal_seq > 0)
})

await check('渲染里告诉学习者去点卡片，并给出可用题库（多于一个时）', async () => {
  const r = await startPractice.execute({}, makeExec())
  const text = startPractice.output.render({}, r).map((x) => x.text).join('\n')
  // ★ 这两条是"入口能不能被发现"的关键：卡片渲染在对话里，但**要不要点、
  //   点了会发生什么**必须由 agent 的这句话说清楚。渲染文本漏了它，
  //   学习者看着一张卡片不知道该不该点。
  assert.match(text, /卡片/, '渲染里要提到卡片 —— 否则学习者不知道该点哪里')
  assert.match(text, /点/, '渲染里要说明"点它"—— 卡片不是自动生效的')
  assert.match(text, /题库/)
  // 防退回被否掉的"自动打开"语义（见本节开头）。
  assert.doesNotMatch(text, /已在界面上打开/, '不能再说"已打开面板" —— 面板是学习者点开的')
})

// ── 外观：agent 能定制卡片，且**错了能自己知道** ──
//
// 这条链有三段，全都要在：工具校验 → 写进信号 → 界面从 /pending 取到。
// 这里验前两段（第三段在客户端，由 selftest-client.mjs 与 selftest-style.mjs 覆盖）。

await check('★ style 被写进信号（面板靠它拿到 agent 声明的外观）', async () => {
  const r = await startPractice.execute(
    { style: { accent: 'focus', font_scale: 'large', preview_questions: 3 } },
    makeExec(),
  )
  assert.equal(r.style_applied.includes('accent=focus'), true, `返回值应说明生效的外观：${r.style_applied}`)
  assert.deepEqual(r.style_ignored, [], '合法输入不该有 ignored')
  const sig = readPracticeSignal()
  assert.equal(sig.seq, r.signal_seq)
  assert.equal(sig.style?.accent, 'focus', '信号里必须带上外观 —— 否则面板只会用默认样子')
  assert.equal(sig.style?.font_scale, 'large')
  assert.equal(sig.style?.preview_questions, 3)
})

await check('★ 外观写错时：不报错，但如实列出被忽略的项（agent 的纠错回路）', async () => {
  // 与题库名写错同一条处置原则：这个工具的职责是"把入口放进对话"，
  // 不是"校验外观"。外观参数写错**不该让刷题失败**——
  // 但也不能静默：模型很容易发明字段名（fontSize），
  // 静默忽略会让它反复试同一个错名字。
  const r = await startPractice.execute(
    { style: { fontSize: '18px', font_scale: 'huge', preview_questions: 9999 } },
    makeExec(),
  )
  assert.equal(r.opened, true, '外观写错仍然要成功放进卡片')
  assert.ok(r.style_ignored.length >= 3, `应逐项报告，实际：${JSON.stringify(r.style_ignored)}`)
  assert.ok(r.style_ignored.some((m) => m.includes('fontSize')), '要点名不认识的字段')
  assert.ok(r.style_ignored.some((m) => m.includes('huge')), '要点名写错的枚举值')
  assert.ok(r.style_ignored.some((m) => m.includes('9999')), '要报告被夹紧的数值')

  const sig = readPracticeSignal()
  assert.equal(sig.style?.font_scale, undefined, '非法枚举不该进信号')
  assert.equal(sig.style?.preview_questions, 8, '越界值应被夹到上界而不是丢掉')
})

await check('不带 style 时信号里是 null（与加这个功能之前完全一致）', async () => {
  const r = await startPractice.execute({}, makeExec())
  assert.equal(r.opened, true)
  assert.equal(r.style_applied, '全部用默认外观')
  assert.equal(readPracticeSignal().style, null, '不给 style 不该往信号里塞空对象')
})

await check('外观也会出现在渲染文本里（agent 与学习者都能看到生效了什么）', async () => {
  const r = await startPractice.execute({ style: { accent: 'calm' } }, makeExec())
  const text = startPractice.output.render({}, r).map((x) => x.text).join('\n')
  assert.match(text, /卡片外观/, '渲染里要说明生效的外观')
})

console.log('\n══ 10b. 卡片承载"选择"（本次改动的重点）══')
//
// 作者反馈：说"给我 10 题"或"我想重刷做过的题目"，弹出的卡片依然是**整个题库**。
// 根因是 `start_practice` 当时**没有表达选择的词汇**，所以选择根本传不到卡片。

await check('★ order 被写进信号（卡片与面板据此取题）', async () => {
  const r = await startPractice.execute({ bank_name: bankName6, order: 'missed', count: 10 }, makeExec())
  assert.equal(r.opened, true)
  assert.match(r.selection_applied, /只出.*错题|错题/, `selection_applied 应说明"只出错题"，实际：${r.selection_applied}`)
  assert.deepEqual(r.selection_ignored, [], '合法档位不该有 ignored')
  const sig = readPracticeSignal()
  assert.equal(sig.selection?.order, 'missed', '选择必须进信号 —— 否则面板无从知道该给哪些题')
  assert.equal(sig.count, 10)
})

await check('★ "重刷做过的" → attempted（这是作者原话里那个说法）', async () => {
  const r = await startPractice.execute({ order: 'attempted' }, makeExec())
  assert.match(r.selection_applied, /做过的/)
  assert.equal(readPracticeSignal().selection?.order, 'attempted')
})

await check('★ 指定 ids 时自动按道数取（否则卡片会写"指定 3 道 · 1 道"）', async () => {
  const r = await startPractice.execute({ ids: ['q-aaaaaaaaaaaa', 'q-bbbbbbbbbbbb', 'q-cccccccccccc'] }, makeExec())
  const sig = readPracticeSignal()
  assert.deepEqual(sig.selection?.ids, ['q-aaaaaaaaaaaa', 'q-bbbbbbbbbbbb', 'q-cccccccccccc'])
  assert.equal(sig.count, 3, `没给 count 时应按 ids 的道数取，实际 ${sig.count}`)
  assert.match(r.selection_applied, /指定 3 道/)
})

await check('显式给了 count 就听它的（不覆盖）', async () => {
  await startPractice.execute({ ids: ['q-aaaaaaaaaaaa', 'q-bbbbbbbbbbbb'], count: 1 }, makeExec())
  assert.equal(readPracticeSignal().count, 1)
})

await check('知识点写进信号', async () => {
  await startPractice.execute({ topic: '片段阅读' }, makeExec())
  assert.equal(readPracticeSignal().selection?.topic, '片段阅读')
})

await check('★ 选择写错时不报错，但如实列出被忽略的项', async () => {
  // 与题库名、外观同一条处置原则：这个工具的职责是"把入口放进对话"，
  // 不是"校验参数"。但**静默忽略**会让模型以为自己说的"只错题"生效了。
  const r = await startPractice.execute(
    { order: '按遗忘曲线', only_wrong: true, topic: '' },
    makeExec(),
  )
  assert.equal(r.opened, true, '选择写错仍然要成功放进卡片')
  assert.ok(r.selection_ignored.length >= 3, `应逐项报告，实际：${JSON.stringify(r.selection_ignored)}`)
  assert.ok(r.selection_ignored.some((m) => m.includes('按遗忘曲线')), '要点名写错的档位')
  assert.ok(r.selection_ignored.some((m) => m.includes('only_wrong')), '要点名不认识的字段')
  assert.equal(readPracticeSignal().selection, null, '全被忽略时信号里不该留一个空选择')
})

await check('不带选择时信号里是 null（与加这个功能之前完全一致）', async () => {
  const r = await startPractice.execute({ bank_name: bankName6 }, makeExec())
  assert.equal(readPracticeSignal().selection, null)
  assert.ok(typeof r.selection_applied === 'string' && r.selection_applied.length > 0, '仍要有一句默认描述')
})

await check('选择也出现在渲染文本里（agent 会照它向学习者复述）', async () => {
  const r = await startPractice.execute({ order: 'missed', count: 5 }, makeExec())
  const text = startPractice.output.render({}, r).map((x) => x.text).join('\n')
  assert.match(text, /这次刷/, '渲染里要有一行说明"这次刷哪些题"')
})

console.log('\n══ 11. get_solution：只读取题解（给「AI深解」那条链）══')

// 这个工具存在的理由很具体：深解那条消息要求模型"先自解 → 再查参考解析 → 分析错因"，
// 而在此之前**第 2 步根本做不到**：get_questions 刻意不含答案，
// 唯一能看到解析的 submit_answer 会**写一条作答事件**（模型自己编的答案）。
// 于是模型只能撒谎，或者污染学习史。

const getSolution = tools6.get('get_solution')

await check('get_solution 已注册，且描述写清了"必须先自己解"与解析可能串行', () => {
  assert.ok(getSolution, '没有注册 get_solution')
  assert.match(getSolution.description, /只读|不记录/, '描述里必须说明它是只读的（否则模型会以为它也会记作答）')
  assert.match(getSolution.description, /先自己|独立解/, '描述里必须写"先自己解"——顺序反了就是假的独立解')
  assert.match(getSolution.description, /串行/, '必须告知解析可能是 OCR 两栏串行，否则模型会当权威原文用')
})

await check('★★ 它**不写任何事件**（这是它存在的全部意义）', async () => {
  // 这条是本节最重要的断言。若它写了事件，"查题解"就会往学习史里塞一条
  // 模型自己编的作答——污染的正是统计与将来的选题能力所依赖的数据。
  const taken = await getQ6.execute({ bank_name: bankName6, count: 1 }, makeExec())
  const id = taken.questions[0].id

  const before = readSandboxEvents().length
  const r = await getSolution.execute({ bank_name: bankName6, ids: [id] }, makeExec())
  const after = readSandboxEvents().length

  assert.equal(after, before, `get_solution 写了 ${after - before} 条事件 —— 一个"查资料"的动作不该在事实源里留痕`)
  assert.equal(r.solutions.length, 1)
})

await check('★★ 真的能拿到解析（不是空串）—— 这条会抓住"忘了 includeAnswer"', async () => {
  // getQuestions 默认返回 presentable（**答案与解析已被剥掉**）。
  // 第一版忘了传 includeAnswer:true，于是返回的 answer/analysis 全是空，
  // 而且**不报错**：模型会据实说"题库里没有解析"，整条深解链看起来正常、实际永远拿不到证据。
  const taken = await getQ6.execute({ bank_name: bankName6, count: 1 }, makeExec())
  const id = taken.questions[0].id

  const r = await getSolution.execute({ bank_name: bankName6, ids: [id] }, makeExec())
  const s = r.solutions[0]
  assert.ok(s, '没查到题解')
  assert.ok(Array.isArray(s.answer) && s.answer.length > 0, '答案被剥掉了 —— includeAnswer 没传对')
  assert.ok(s.analysis.length > 0, `解析是空的（长度 ${s.analysis.length}）—— 多半是 includeAnswer 没传对`)
  assert.match(s.analysis, /1982/, '拿到的不是我期望的那道题的解析')
  assert.ok(typeof s.analysis_kind === 'string' && s.analysis_kind !== '', '必须标注解析的来路与质量')
})

await check('没有解析的题如实返回空串（不编造）', async () => {
  const taken = await getQ6.execute({ bank_name: bankName6, count: 5 }, makeExec())
  // fixture 里第 2 题没有 analysis
  const r = await getSolution.execute({ bank_name: bankName6, ids: [taken.questions[1].id] }, makeExec())
  if (r.solutions.length > 0) {
    assert.equal(r.solutions[0].analysis, '', '没解析就该是空串')
    assert.equal(r.solutions[0].analysis_kind, '无', `没解析时 kind 应为"无"，实际 ${r.solutions[0].analysis_kind}`)
    const text = getSolution.output.render({}, r).map((x) => x.text).join('\n')
    assert.match(text, /没有/, '渲染里要明说没有解析（并提示用自己的推理，别编）')
  }
})

await check('查不到的 id 进 missing，并如实告知', async () => {
  const r = await getSolution.execute({ bank_name: bankName6, ids: ['q-000000000000'] }, makeExec())
  assert.deepEqual(r.missing, ['q-000000000000'])
  const text = getSolution.output.render({}, r).map((x) => x.text).join('\n')
  assert.match(text, /没查到|没有查到/, '渲染里要如实说没查到')
})

await check('ids 缺省或为空时报错（不静默返回空）', () => {
  // 用 `assert.throws` 而不是 `assert.rejects`：这个工具的参数校验是**同步抛**的
  // （和 submit_answer 等一样）。写错断言工具会让失败信息变成"抛出的原始错误"，
  // 看不出到底哪条断言不成立。
  assert.throws(() => getSolution.execute({ bank_name: bankName6, ids: [] }, makeExec()), /ids/)
  assert.throws(() => getSolution.execute({ bank_name: bankName6 }, makeExec()), /ids/)
})

console.log('\n══ 12. 作答历史：本次作答**之后**才告诉学习者"这题你做过" ══')

// 作者的要求：*"我想让学习者知道这道题做过、上次自己选了什么答案，
// **但是是在本次作答之后**"*。
// 两个要点都要守住：① 只在判分之后给（取题时绝不带）；
// ② "上一次"必须**排除刚写进去的这一次**，否则会显示"上次你选了 C"而 C 正是他刚选的。
//
// ⚠ 这一节必须用**一个全新的题库**：前面几节已经答过 `bankName6` 里的题了，
// 直接拿它验"第一次做"会看到 8 次历史（第一版就是这么错的——断言期望 0、实际 8）。
// **测试夹具的状态要显式造，不能指望它是干净的。**

// ⚠ 这一节必须用**没被答过的题**：历史的键是**题目 id**，而 id 由
// (来源根|来源文件|题号|题干前 40 字) 派生 —— 把同一份材料再导入一个新题库，
// 得到的是**同一批 id**，于是前面几节答过的记录仍然挂着（第一版就是 8 次历史）。
// 这不是 bug，是正确行为（**历史跟着题目走，不跟着题库走**）；
// 但它意味着"想验第一次做"就必须造**新的题干**。
const historyQuestions = [
  { number: 901, stem: '【历史测试·夹具1】下列哪一项属于宪法规定的公民基本权利？', options: ['受教育权', '纳税', '服兵役', '遵守纪律'], answer: 'A', kind: 'single_choice', analysis: '受教育权是宪法规定的公民基本权利。' },
  { number: 902, stem: '【历史测试·夹具2】我国的根本政治制度是____。', answer: '人民代表大会制度', kind: 'fill_blank' },
  { number: 903, stem: '【历史测试·夹具3】下列哪一项不是行政处罚？', options: ['警告', '罚款', '拘役', '没收违法所得'], answer: 'C', kind: 'single_choice' },
  { number: 904, stem: '【历史测试·夹具4】我国现行宪法颁布于哪一年？', options: ['1954年', '1975年', '1978年', '1982年'], answer: 'D', kind: 'single_choice' },
]
const historyFile = join(sandbox, '历史测试题目.json')
writeFileSync(historyFile, JSON.stringify(historyQuestions, null, 2), 'utf8')

const historyBank = '历史测试题库'
await import6.execute({
  bank_name: historyBank,
  file_path: historyFile,
  source_root: FIXTURE_SOURCE_ROOT,
  source_file: '行测/历史测试.pdf',
}, makeExec())

// 一次取全部题目，后面**每条用例各用一道自己的题**。
//
// ⚠ 为什么要这么分：第一版三条用例共用同一道题，于是后一条会看到前一条留下的历史
// （"第一次做"那条报 1 次而不是 0 次）。**用例之间共享可变状态**会让失败信息指向
// 错误的原因——那条红说明的其实是"上一条用例跑过了"，而不是"功能坏了"。
const histQuestions = (await getQ6.execute({ bank_name: historyBank, count: 10 }, makeExec())).questions

await check('这一节用的题确实是"没做过"的（夹具自检）', async () => {
  // 先确认前提成立，再去验行为。否则后面"第一次做"的断言可能只是因为
  // 夹具不干净而红 —— 那会把人引到错误的结论上（这一节已经踩过一次）。
  const r = await submit6.execute({ bank_name: historyBank, question_id: histQuestions[0].id, response: 'A' }, makeExec())
  assert.equal(r.history_attempts, 0, `夹具不干净：这道"新题"已经有了 ${r.history_attempts} 次历史`)
})

await check('★ 第一次做：history_attempts=0，渲染里说"这是第一次"', async () => {
  const q = histQuestions[1]
  const r = await submit6.execute({ bank_name: historyBank, question_id: q.id, response: '人民代表大会制度' }, makeExec())
  assert.equal(r.history_attempts, 0, `第一次做应当是 0，实际 ${r.history_attempts}`)
  assert.equal(r.history_last_response, null)
  assert.equal(r.history_last_correct, null)
  const text = submit6.output.render({}, r).map((x) => x.text).join('\n')
  assert.match(text, /第一次/, '第一次做要说清"第一次"（不然学习者不知道这是新题）')
})

await check('★★ 第二次做：上一次答的必须是**上一次**，不是刚写进去的这一次', async () => {
  // 这是这段代码唯一容易写错的地方：若在 append **之后**统计，
  // "上一次"就是刚写进去的那条 —— 界面会显示"上次你选了 X"，而 X 正是他刚选的。
  // 顺序错误不报错，只给出一个**看起来合理的错答案**，所以必须有断言。
  const q = histQuestions[2] // 正确答案是 C

  const first = await submit6.execute({ bank_name: historyBank, question_id: q.id, response: 'A' }, makeExec())
  assert.equal(first.history_attempts, 0, '第一次做之前应当没有历史')
  assert.equal(first.correct, false, '夹具：选 A 对这道题（答案 C）应当是错的')

  const second = await submit6.execute({ bank_name: historyBank, question_id: q.id, response: 'B' }, makeExec())
  assert.equal(second.history_attempts, 1, `本次之前应做过 1 次，实际 ${second.history_attempts}`)
  assert.equal(second.history_last_response, 'A', `"上一次"应当是 A，实际 ${second.history_last_response}（若是 B 就说明在 append 之后统计了）`)
  assert.ok(typeof second.history_last_at === 'string' && second.history_last_at !== '', '要带上上一次的时间')
  // 上次对错也要带上——否则学习者看不出自己有没有长进
  assert.equal(second.history_last_correct, false, '上一次选 A 是错的，last_correct 应当是 false')
  const text = submit6.output.render({}, second).map((x) => x.text).join('\n')
  assert.match(text, /之前做过 1 次/, '渲染里要报出做过几次')
  assert.match(text, /答错/, '渲染里要报出上次对错')
})

await check('★★ 取题的返回里**绝不带**历史（结构上不可能先看历史再作答）', async () => {
  // 这是"不能先看"的实现方式：不是提醒模型别说，而是**数据不在那条路上**。
  const taken = await getQ6.execute({ bank_name: bankName6, count: 2 }, makeExec())
  const text = JSON.stringify(taken)
  for (const forbidden of ['history_attempts', 'history_last_response', 'last_response', 'history']) {
    assert.ok(!text.includes(forbidden), `get_questions 的返回里出现了「${forbidden}」—— 那会泄露"做过/答过什么"`)
  }
})

await check('get_solution（只读查题解）里也不带历史（它只该给题解，不给学习者的作答史）', async () => {
  const taken = await getQ6.execute({ bank_name: bankName6, count: 1 }, makeExec())
  const r = await getSolution.execute({ bank_name: bankName6, ids: [taken.questions[0].id] }, makeExec())
  assert.ok(!JSON.stringify(r).includes('history'), 'get_solution 的返回里出现了 history')
})

// ── 本节的夹具：一个题库，里面有两道**打了知识点**的题 ──
// 为什么必须真打标签：本节守的是"词表外的写法能不能筛到规范名那批题"，
// 没有标签就只会得到 0 道，而那会让"归一化生效了"与"根本没归一化"看起来一样。
reset()
const { ctx: ctxP, tools: toolsP, contexts: contextsP } = makeFakeCtx()
plugin.apply(ctxP)
const importP = toolsP.get('import_questions')
const getQP = toolsP.get('get_questions')
const startPracticeP = toolsP.get('start_practice')

const bankNameP = '选择与知识点测试'
await importP.execute(
  {
    bank_name: bankNameP,
    source_root: FIXTURE_SOURCE_ROOT,
    source_file: '行测/片段阅读.pdf',
    questions: [
      { number: 1, stem: '第一道：这段文字旨在说明什么？', options: ['甲', '乙'], answer: 'A', topics: ['主旨概括', '言语理解'] },
      { number: 2, stem: '第二道：以下哪项最能削弱？', options: ['丙', '丁'], answer: 'B', topics: ['削弱质疑', '逻辑判断'] },
      { number: 3, stem: '第三道：没有知识点的题', options: ['戊', '己'], answer: 'A' },
    ],
  },
  makeExec(),
)

console.log('\n══ 13. 刷题走哪条路：运行时上下文 + 知识点归一化（2026-09-19 晚实测的产物）══')

// ═══ 背景（这不是"顺手补的测试"）═══
// 实测：学习者说"按知识点出题"，agent 调了 `get_questions` **两次**，
// `start_practice` **一次都没调**（工具调用记录在 data/events.jsonl 的 lh/trace/observed）。
// 于是对话里没有卡片、题被念成文本、做完没有作答记录。
//
// 而 `get_questions` 的描述里早就写了一段"什么时候不要用它"。**它没被遵守。**
// 所以这一节守的不是"文案写得好不好"，而是：
//   ① 那段"走哪条路"的规则**必须进运行时上下文**（计划阶段就能看到，而不是用到工具才看到）；
//   ② 两条路的 topic **必须归一到同一批题**（否则卡片那条路筛不到题）。

await check('★ apply 注册了 lh:practice-routing 上下文，且 order 排在 lh:model-tiers 之后', async () => {
  // systemPrompt **刻意不进硬 inject**（2026-10-13，与 course-tree/schedule 对齐）：
  // 硬 inject 缺任一项 = 整行不激活 = 10 个题库工具一起静默消失（ADR-025 反对的形状）。
  // 上下文走软 `ctx.inject(['systemPrompt'])` 注册：服务缺席只是不注入，插件仍在——
  // 下面 def 能被找到，就证明软注册这条路走通了。
  assert.ok(!plugin.inject.includes('systemPrompt'), 'systemPrompt 不许进硬 inject（服务缺席会让整行不激活、10 个工具静默消失）')
  assert.ok(plugin.inject.includes('tools') && plugin.inject.includes('subagents'), '硬 inject 只声明真硬依赖：tools 与 subagents')
  const def = contextsP.find((c) => c.name === 'lh:practice-routing')
  assert.ok(def !== undefined, `没注册 lh:practice-routing；实际注册了：${contextsP.map((c) => c.name).join(', ')}`)
  assert.equal(def.order, 117, 'order 取 117（宿主的政策类在 110/115，lh:model-tiers 在 116）')
  assert.equal(typeof def.text, 'function', 'text 必须是每次组装求值的函数，不是固定字符串')
})

await check('★★ 上下文把"两条路"与**后果**都写清了（这是它能起作用的前提）', async () => {
  const def = contextsP.find((c) => c.name === 'lh:practice-routing')
  const text = def.text({ agent: {} })
  assert.match(text, /start_practice/, '必须点名"进入刷题"要走哪个工具')
  assert.match(text, /get_questions/, '必须点名另一条路是哪个工具')
  // 后果是这条规则的全部说服力：只说"该用 A"是命令，说了"不用 A 会丢什么"才是判断依据
  assert.match(text, /不写事件日志|不写作答记录|留不下/, `要讲清走错那条路的代价：${text}`)
  assert.match(text, /错题本/, '要举出具体会丢的东西，不能只说"没有记录"')
  assert.match(text, /selection_applied/, '要提醒照 selection_applied 复述，否则学习者无法确认选择对不对')
})

await check('上下文在"没有 agent"时返回空串（诊断性组装不带 agent）', async () => {
  const def = contextsP.find((c) => c.name === 'lh:practice-routing')
  assert.equal(def.text({}), '', '没有 agent 时不该注入这段')
  assert.equal(def.text({ agent: undefined }), '')
})

await check('★★ 两条路的 topic 归一到同一批题（否则卡片那条路筛不到题）', async () => {
  // 判据：用**词表外的写法**去筛，卡片（start_practice）与对话（get_questions）
  // 必须指向同一批题。归一化要是没生效，这里就是 0 道。
  const viaTool = await getQP.execute({ bank_name: bankNameP, count: 99, topic: '主旨概括' }, makeExec())
  assert.ok(viaTool.question_count > 0, `归一化之后必须真能取到题，实际 ${viaTool.question_count} 道`)
  await startPracticeP.execute({ bank_name: bankNameP, topic: '主旨概括', count: 5 }, makeExec())
  const sig = readPracticeSignal()
  assert.equal(sig.selection?.topic, '中心理解', `信号里必须是规范名，实际 ${JSON.stringify(sig.selection)}`)
  assert.equal(sig.selection?.topic_asked, '主旨概括', '要留下原写法，才能如实告诉学习者"你说的被理解成了什么"')
  assert.match(viaTool.note, /归一到词表名「中心理解」/, `取题的说明里要讲清归一化：${viaTool.note}`)
})

await check('归一化覆盖"领域"轴（言语理解 → 片段阅读）', async () => {
  const r = await getQP.execute({ bank_name: bankNameP, count: 99, topic: '言语理解' }, makeExec())
  assert.equal(r.question_count, 1, `实际 ${r.question_count} 道`)
  assert.match(r.note, /片段阅读/)
})

await check('★ 认不出的知识点：取题时**点名说"不在词表里"**，而不是含糊地说"已按它筛选"', async () => {
  // 判据很具体：0 道题 + "已按知识点筛选"这句话会让模型把"词写错了"
  // 读成"题库里没有这样的题"——两者要采取的行动完全相反。
  const r = await getQP.execute({ bank_name: bankNameP, count: 5, topic: '火星知识点' }, makeExec())
  assert.match(r.note, /不在词表里/, `必须点名"不在词表里"：${r.note}`)
  assert.match(r.note, /import_questions/, '要指向能查到可用值的地方')
})

await check('★ start_practice 的选择说明会带上"原说法"（学习者才认得出那是他说的）', async () => {
  const r = await startPracticeP.execute({ bank_name: bankNameP, topic: '主旨概括', count: 3 }, makeExec())
  assert.match(r.selection_applied, /知识点「中心理解」（原说法「主旨概括」）/, `实际：${r.selection_applied}`)
})

await check('★★ get_questions 的返回里必须提醒"本工具不写作答记录"', async () => {
  // 工具描述是**调用前**读的；这句话是**调用后**读的——
  // 而"刚才那次是不是该走卡片"在拿到结果那一刻最容易判断。
  const r = await getQP.execute({ bank_name: bankNameP, count: 1 }, makeExec())
  const text = getQP.output.render({}, r).map((x) => x.text).join('\n')
  assert.match(text, /不写作答记录/, '要说明这条路留不下记录')
  assert.match(text, /start_practice/, '要给出改走哪条路的动作')
})

await check('★ start_practice 的返回要交代"卡没出现时怎么办"', async () => {
  const r = await startPracticeP.execute({ bank_name: bankNameP, count: 2 }, makeExec())
  const text = startPracticeP.output.render({}, r).map((x) => x.text).join('\n')
  // 宿主对 keyed 插槽的既有语义是"键写错就只是不渲染"，所以必须有话说
  assert.match(text, /没看到卡片/, '要预设"卡片可能没出现"这一情形')
  assert.match(text, /右下角/, '要指向那个兜底入口的位置')
})

console.log('\n══ 14. 模型白名单硬闸（T4.1 堵漏：agent 不得自选计费模型）══')

// 事故 B 的形状就在这几条里：agent 自传 provider/model（或只传 model）
// 去跑按量计费的抽取。判据不是“报了错”这么宽，而是：
//   1）报的必须是白名单的错（不是别的错）——说明它在**正确的位置**被拦下；
//   2）拦截发生在读题/读页/派子 agent **之前**——计费出口一个字都不许发出去；
//   3）拒绝必须留下 lh/security/rejected-model 审计事件。

reset()
const fromSourceTool = tools2.get('import_questions_from_source')

await check('★ 非法 provenance_model 在读题之前被拒（连题都不看就拒）', async () => {
  await assert.rejects(
    async () => importTool.execute({ bank_name: '闸门测试', provenance_model: 'gpt-4o' }, makeExec()),
    (e) => {
      assert.match(e.message, /模型不在白名单/)
      assert.match(e.message, /须由使用者改配置，agent 不得自选计费模型/)
      assert.ok(!/必须提供 file_path/.test(e.message), `不该走到读题那一步：${e.message}`)
      return true
    },
  )
})

await check('★ 拒绝写进事件日志：lh/security/rejected-model 带 requested_model 与 tool', () => {
  const evs = readSandboxEvents().filter((e) => e.type === 'lh/security/rejected-model')
  assert.equal(evs.length, 1)
  assert.equal(evs[0].data.tool, 'import_questions')
  assert.equal(evs[0].data.requested_model, 'gpt-4o')
})

await check('白名单内的 provenance_model 放行（走到读题校验才报错）', async () => {
  await assert.rejects(
    async () => importTool.execute({ bank_name: '闸门测试', provenance_model: 'deepseek-flash' }, makeExec()),
    (e) => {
      assert.match(e.message, /必须提供 file_path/, `报的不是读题校验的错，说明闸门误伤了合法入参：${e.message}`)
      return true
    },
  )
})

await check('★ from_source 跨档混搭（deepseek-official + mimo-v2.5）在读页之前被拒', async () => {
  await assert.rejects(
    async () =>
      fromSourceTool.execute(
        { bank_name: '闸门测试', question_pages: [join(sandbox, 'no-such-page.json')], provider: 'deepseek-official', model: 'mimo-v2.5' },
        makeExec(),
      ),
    (e) => {
      assert.match(e.message, /模型不在白名单/)
      assert.ok(!/页文件不存在/.test(e.message), `不该走到读页那一步：${e.message}`)
      return true
    },
  )
})

await check('from_source 白名单内组合放行，且默认参数同样过闸（走到读页才报错）', async () => {
  // 白名单内的组合 + 完全不给 model/provider（走默认值）两条路都必须过闸——
  // 否则“默认模型被自己的闸拒掉”会让 from_source 整个不可用。
  const rejectedBefore = readSandboxEvents().filter((e) => e.type === 'lh/security/rejected-model').length
  for (const args of [
    { provider: 'xiaomi-token-plan-ams', model: 'mimo-v2.5' },
    {},
  ]) {
    await assert.rejects(
      async () =>
        fromSourceTool.execute(
          { bank_name: '闸门测试', question_pages: [join(sandbox, 'no-such-page.json')], ...args },
          makeExec(),
        ),
      (e) => {
        assert.match(e.message, /页文件不存在/, `闸门误伤了合法入参：${e.message}`)
        return true
      },
    )
  }
  const rejectedAfter = readSandboxEvents().filter((e) => e.type === 'lh/security/rejected-model').length
  assert.equal(rejectedAfter, rejectedBefore, '放行路径不该新增拒绝事件')
})

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
  process.exit(1)
}
console.log('全部通过。\n')
