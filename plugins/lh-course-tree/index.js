/**
 * lh-course-tree —— 递归课程树（preset 作用域的功能性插件）。
 *
 * ═══ 它做什么 ═══
 * 注册三个模型可调用的工具，让 agent 在对话里维护课程树：
 *   · `create_course` 建课程/子课程；
 *   · `list_courses`  看整棵树；
 *   · `enter_course`  把**当前会话**绑到某个课程节点（"会话按课程分界"的落点）。
 * 另外把"当前会话属于哪门课"注入运行时上下文（R5：课程的级别与名字要进会话）——
 * 这一段是**每次组装都会出现的位置**，所以它同时也是"该用哪个工具"这类纪律的落点。
 *
 * 树本身不是这里存的——它是 `lh/course/*` 事件的投影（`tree.js`，ADR-032）。
 * 写入一律经 `commands.js`（唯一构造点）；界面那条路（`@lh/workspace-ui` 的 POST 路由）
 * 走的是同一批函数，所以"浏览器建的课"和"模型建的课"在日志里长得一模一样。
 *
 * ═══ 为什么挂 preset、inject 只要 tools ═══
 * 契约 §六五问之一"它挂在哪一层"：本插件要在对话里被模型调用 → preset（agent 作用域）。
 * 它写事件靠**直接构造** `LhEventStore`（同 lh-recorder-trace）——preset 够不着
 * host 面发布的 root-realm 服务，所以不走 `inject: ['lhEvents']`（那会让 preset 挂载失败）。
 * 读会话 id 靠工具执行上下文 `exec.agent.session.id`（契约约束 8），不需要 inject `sessions`。
 *
 * ═══ 装载期不抛错（契约 §五之二）═══
 * `apply()` 里**不解析数据目录、不读事件日志**——那些都可能因"没配好"而抛，
 * 而 preset/profile 插件的 apply 抛错会让整棵插件树加载失败、dsh 起不来。
 * 一切读写都留到工具被真正调用的那一刻（execute 里），失败就作为工具错误返回。
 */

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 事件存储与树投影都用**包名**引用（契约 §3：跨插件引用只能用包名 + file: 依赖）。
import { readEvents } from '@lh/event-store/store'
import { buildTree, resolveCourseRef } from './tree.js'
import { buildDirectoryView } from './directory.js'
// 写入一律经 commands.js：它是课程事件的**唯一构造点**，
// 工具与界面（@lh/workspace-ui 的 POST 路由）走同一条路，避免"同语义两种字节"。
import {
  ACTOR_AGENT,
  bindSession,
  cachedTree,
  coursePathText,
  createCourse,
  deleteCourse,
  previewDelete,
  renameCourse,
} from './commands.js'

/** 插件名。 */
export const name = 'lh-course-tree'

/**
 * 声明依赖。
 *
 * `tools`：注册五个模型可调用的工具。
 *
 * ⚠ `systemPrompt` **刻意不在这里声明**（2026-10-08 改）。
 *
 * 它原来是硬依赖（`inject: ['tools','systemPrompt']`），而 `inject` 的语义是
 * **"两个服务都就绪才激活这个插件"**。后果是一个很难查的失败形状：
 * 只要 `systemPrompt` 在这一层拿不到，**整个插件就不激活**——工具也跟着一起消失，
 * 而且**一声不吭**（fiber 一直等着，不报错、不上名单）。
 *
 * 本轮要把这个插件挂到**host 层**（为的是让五个工具在所有会话里可用，不只 LH 模式），
 * 而 host 层还提供不提供 `systemPrompt` 我没有实测过。所以：
 *   · `tools` 保持硬依赖（没有它这个插件毫无意义）；
 *   · 上下文注入改成**可选**——用 `ctx.inject(['systemPrompt'], …)` 等它的声明，
 *     拿不到就只是"不注入课程归属"，工具照常可用。
 *
 * 这条改动的收益与作用域无关：**让一个可选能力不至于把整块功能拖下水。**
 */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 记一条调试痕迹（与 LH 事件严格分开，同其它插件）。
 * @param line - 文本。
 */
function trace(line) {
  try {
    appendFileSync(join(HERE, 'trace.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 记不下来不该让插件崩掉 */
  }
}

/**
 * 从工具执行上下文里取当前会话 id（拿不到返回 null，不猜）。
 *
 * 两条取值路径都试：`session.id` 是工具执行上下文里的形状（契约约束 8 实测），
 * `session.header.id` 是宿主 Session 对象自己的形状（`agent.session.header.cwd` 与它同源）。
 * 宁可多试一条也不猜——猜错会把"这段对话"绑到别的会话上，而那是静默的。
 *
 * @param exec - 工具执行的第二参数。
 * @returns 会话 id 或 null。
 */
function sessionIdOf(exec) {
  const direct = exec?.agent?.session?.id
  if (typeof direct === 'string' && direct !== '') return direct
  const header = exec?.agent?.session?.header?.id
  return typeof header === 'string' && header !== '' ? header : null
}

/**
 * 插件体。
 * @param ctx - 插件上下文；注册的一切随插件卸载自动撤销。
 */
export function apply(ctx) {
  trace('APPLY_CALLED')
  ctx.on('dispose', () => trace('DISPOSED'))

  // ── 工具 1：建课程 / 子课程 ──
  ctx.tools.register({
    name: 'create_course',
    description:
      '建一个课程节点。不给 parent_course 就建在**顶层**（如"行测""申论"）；' +
      '给了 parent_course（父课程的 node_id 或标题）就建为它的**子课程**（如"行测"下的"资料分析"）。' +
      '课程树是递归的，可以一直往下建子课程。' +
      '\n\n建完之后，若要让**当前这段对话**归属到这门课（于是这段对话的输入会被这门课的断言器归纳），' +
      '再调 `enter_course`。建课程本身不会自动绑定当前会话。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', description: '课程名，如"资料分析"。' },
        parent_course: {
          type: 'string',
          description: '父课程的 node_id 或标题。省略=建在顶层。有歧义时会报错让你改用 node_id。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['node_id', 'title', 'level', 'parent_id', 'path'],
        properties: {
          node_id: { type: 'string', description: '新节点 id（后续 enter_course / 建子课程都用它引用）。' },
          title: { type: 'string' },
          level: { type: 'integer', description: '层级，顶层=1，逐层+1。' },
          parent_id: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '父节点 id；顶层为 null。' },
          path: { type: 'array', items: { type: 'string' }, description: '从根到本节点的标题链。' },
        },
      },
      render: (_args, value) => {
        const where = value.parent_id === null ? '顶层' : `"${value.path.slice(0, -1).join(' / ')}" 之下`
        return [{ type: 'text', text: `已建课程「${value.title}」（第 ${value.level} 层，位于${where}）。\nnode_id: ${value.node_id}` }]
      },
    },
    execute(args) {
      // 写入经唯一构造点（commands.js）：校验、解析父课程、算层级、拼信封都在那里。
      // 这里的 execute 只负责"把工具参数翻译成那个函数的参数"。
      trace(`CREATE_COURSE  title=${args?.title ?? ''} parent=${args?.parent_course ?? '(root)'}`)
      return Promise.resolve(createCourse({
        title: args?.title,
        parentRef: args?.parent_course,
        actor: ACTOR_AGENT,
      }))
    },
  })

  // ── 工具 2：看整棵树 ──
  ctx.tools.register({
    name: 'list_courses',
    description:
      '列出当前的课程树：层级、父子关系、每门课的 node_id，**以及每门课下挂着哪些对话**。' +
      '学习者问"我有哪些课""这门课在哪一层""这门课下有哪些对话""哪段对话还没归课"，' +
      '或你要引用某门课却不确定它的 node_id 时，都用它。',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['course_count', 'tree', 'unbound_session_ids'],
        properties: {
          course_count: { type: 'integer' },
          tree: {
            type: 'array',
            description: '拍平的节点列表（带 level，父子关系见 parent_id）。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['node_id', 'title', 'level', 'parent_id', 'session_ids'],
              properties: {
                node_id: { type: 'string' },
                title: { type: 'string' },
                level: { type: 'integer' },
                parent_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                // ⚠ 这两个字段是 2026-10-08 补的：在那之前 `list_courses` 只回节点，
                //   于是 agent **答不出"这门课下有哪些对话"**——不是它懒，是它拿不到。
                //   数据一直在（`delete_course` 的影响面里就带着 session_ids），
                //   只是没接到这个工具上。现在经 `buildDirectoryView`（唯一视图组装）取。
                session_ids: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '归到这门课下的对话 id（不含子课程的）。',
                },
              },
            },
          },
          unbound_session_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '曾归过课、但那门课已被删除的对话（现在算未归课；对话本身没被删）。',
          },
        },
      },
      render: (_args, value) => {
        if (value.course_count === 0) {
          return [{ type: 'text', text: '还没有任何课程。用 create_course 建第一门（如"行测"）。' }]
        }
        const lines = [`课程树（共 ${value.course_count} 门，括号内是归到该课的对话数）：`]
        // 用 flattenTreeLines 需要树，这里从拍平结果重建缩进即可。
        const byId = Object.create(null)
        for (const n of value.tree) byId[n.node_id] = n
        const kids = Object.create(null)
        for (const n of value.tree) {
          const key = n.parent_id ?? ''
          ;(kids[key] ??= []).push(n.node_id)
        }
        const walk = (parentId) => {
          for (const id of kids[parentId ?? ''] ?? []) {
            const n = byId[id]
            const sids = n.session_ids ?? []
            lines.push(`${'  '.repeat(Math.max(0, n.level - 1))}· ${n.title}  [${n.node_id}]${sids.length > 0 ? `  ${sids.length} 对话` : ''}`)
            walk(id)
          }
        }
        walk(null)
        if ((value.unbound_session_ids ?? []).length > 0) {
          lines.push('', `另有 ${value.unbound_session_ids.length} 段对话曾归过课、但那门课已被删除（现在算未归课）：`)
          for (const sid of value.unbound_session_ids) lines.push(`  · ${sid}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute() {
      // 经**唯一视图组装**（directory.js）取"每节点挂了哪些对话"，
      // 不再自己 map 一遍——那样迟早与界面看到的不是同一棵树。
      const view = buildDirectoryView(readEvents())
      const flat = view.nodes.map((n) => ({
        node_id: n.node_id,
        title: n.title,
        level: n.level,
        parent_id: n.parent_id,
        session_ids: n.sessions,
      }))
      trace(`LIST_COURSES  count=${flat.length} sessions=${view.session_count}`)
      return Promise.resolve({
        course_count: flat.length,
        tree: flat,
        unbound_session_ids: view.orphan_bindings,
      })
    },
  })

  // ── 工具 5：改课程名（2026-10-08 补）──
  //
  // ═══ 为什么现在才补 ═══
  // `commands.js` 的 `renameCourse` 早就写好了，但**只挂在界面那条路上**
  // （课程目录的 POST /rename）。于是出现一个荒唐的缺口：学习者能在界面上改名，
  // 却不能让 agent 改名——而"编辑课程"正是作者明确列出的三件事之一。
  // 能力实现了却没给 agent 开工具，是同一类疏漏的第三次（前两次是改名与读对话）。
  ctx.tools.register({
    name: 'rename_course',
    description:
      '改一门课程的名字（用 node_id 或标题指定）。' +
      '\n\n改名是**追加一条事件**（lh/course/renamed），旧名字留在日志里、历史不丢；' +
      '不需要重建课程，也不影响已经归到这门课下的对话。' +
      '\n\n只能改名字。**换父（把一门课挪到另一门下面）目前没有工具**——那需要 reparent 事件，' +
      '投影已支持但界面与工具都还没接，别用改名去凑。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['course', 'title'],
      properties: {
        course: { type: 'string', description: '要改的课程（node_id 或标题）。有歧义时会报错让你改用 node_id。' },
        title: { type: 'string', description: '新名字。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['node_id', 'title', 'level', 'parent_id', 'path'],
        properties: {
          node_id: { type: 'string' },
          title: { type: 'string', description: '改完之后的名字。' },
          level: { type: 'integer' },
          parent_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          path: { type: 'array', items: { type: 'string' }, description: '从根到本节点的标题链（含新名字）。' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已把「${value.path.slice(0, -1).join(' / ') || '顶层'}」下的课程改名为「${value.title}」（第 ${value.level} 层）。\nnode_id: ${value.node_id}`,
      }],
    },
    execute(args) {
      trace(`RENAME_COURSE  course=${args?.course ?? ''} → ${args?.title ?? ''}`)
      return Promise.resolve(renameCourse({
        nodeRef: args?.course,
        title: args?.title,
        actor: ACTOR_AGENT,
      }))
    },
  })

  // ── 工具 3：把当前会话绑到某课程 ──
  ctx.tools.register({
    name: 'enter_course',
    description:
      '把**当前这段对话**归属到某门课程（用 node_id 或标题指定）。' +
      '绑定之后：这段对话里学习者的输入，会被**该课程节点上绑定的断言器**归纳成断言，并沿课程树向上传递。' +
      '\n\n这就是"会话按课程分界"：一段对话属于哪门课，由它绑定到哪个节点决定。' +
      '换门课继续学，就再 enter_course 到另一个节点。未绑定课程的对话不会产生课程断言。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['course'],
      properties: {
        course: { type: 'string', description: '目标课程的 node_id 或标题。有歧义时会报错让你改用 node_id。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bound', 'node_id', 'title', 'level', 'session_id'],
        properties: {
          bound: { type: 'boolean', description: '是否绑定成功。' },
          node_id: { type: 'string' },
          title: { type: 'string' },
          level: { type: 'integer' },
          session_id: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '被绑定的会话；拿不到时为 null（此时 bound=false）。' },
        },
      },
      render: (_args, value) => {
        if (!value.bound) {
          return [{ type: 'text', text: '没能绑定当前会话：拿不到会话身份（session_id 为 null）。' }]
        }
        return [{ type: 'text', text: `当前对话已进入课程「${value.title}」（第 ${value.level} 层）。此后这段对话的输入会由它的断言器归纳并向上传递。` }]
      },
    },
    execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId === null) {
        // 拿不到会话身份就**不编**（坐标错比坐标缺更糟，同 recorder-trace 的判断）。
        // 但仍然把"你指的是哪门课"解析出来回报，否则调用方拿不到任何可用信息。
        const tree = buildTree(readEvents())
        const resolved = resolveCourseRef(tree, args?.course)
        if (resolved.node === null) {
          throw new Error(`找不到课程 "${args?.course}"。先用 list_courses 看看有哪些。`)
        }
        trace(`ENTER_COURSE_NO_SESSION  node=${resolved.node.id}`)
        return Promise.resolve({
          bound: false,
          node_id: resolved.node.id,
          title: resolved.node.title,
          level: resolved.node.level,
          session_id: null,
        })
      }

      // 写入经唯一构造点：解析课程、拼信封、报歧义都在那里，与界面那条路完全同一份代码。
      const r = bindSession({ nodeRef: args?.course, sessionId, actor: ACTOR_AGENT })
      trace(`ENTER_COURSE  node=${r.node_id} session=${sessionId}`)
      return Promise.resolve({
        bound: true,
        node_id: r.node_id,
        title: r.title,
        level: r.level,
        session_id: r.session_id,
      })
    },
  })

  // ── 工具 4：删除课程（**两段式**：先看影响面，再确认）──
  //
  // ═══ 为什么这个工具的形状与别的三个不一样 ═══
  // 项目规则 4「破坏性操作一律白名单」：只允许"明确列出要删什么"。
  // 而模型调工具是**一次一个回合**的，没法弹确认框。所以把"确认"做进**工具的参数**：
  //   · 不带 `confirm`（或 false）→ **什么都不改**，只回报影响面；
  //   · 带 `confirm: true` → 真的删。
  // 于是模型必须先把清单读出来、才能删；而那份清单会留在工具结果里，
  // 学习者事后看得见"它当时说要删的是什么"。
  ctx.tools.register({
    name: 'delete_course',
    description:
      '删除一门课程（连带它当前的全部子孙课程）。' +
      '\n\n**这是两段式的**：先**不带** confirm 调一次，它会返回将受影响的清单' +
      '（哪些子课程会消失、哪些会话会变成"未归课"），什么都不会改；' +
      '把这份清单讲给学习者听、得到同意之后，再带 confirm: true 调一次才真的删。' +
      '\n\n**会话本身不会被删**——LH 无权删宿主的对话。原来归在这门课下的对话只会变成"未归课"。' +
      '\n\n删除是追加一条事件，历史仍在日志里（旧事件一条不动）；要恢复就重新建一个同名课程。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['course'],
      properties: {
        course: { type: 'string', description: '要删的课程（node_id 或标题）。有歧义时会报错让你改用 node_id。' },
        confirm: {
          type: 'boolean',
          description: '省略或 false = 只回报影响面、不删。true = 真的删。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['deleted', 'node_id', 'title', 'level', 'sub_courses', 'session_ids', 'path'],
        properties: {
          deleted: { type: 'boolean', description: '这次调用有没有真的删。' },
          node_id: { type: 'string' },
          title: { type: 'string' },
          level: { type: 'integer' },
          path: { type: 'array', items: { type: 'string' }, description: '从根到本节点的标题链（删之前的位置）。' },
          sub_courses: {
            type: 'array',
            description: '会一起消失的后代课程。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['node_id', 'title', 'level'],
              properties: {
                node_id: { type: 'string' },
                title: { type: 'string' },
                level: { type: 'integer' },
              },
            },
          },
          session_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '会因此变成"未归课"的会话（不会被删除）。',
          },
        },
      },
      render: (_args, value) => {
        const where = value.path.slice(0, -1).join(' / ')
        const lines = [
          value.deleted
            ? `已删除课程「${value.title}」${where === '' ? '' : `（原在 ${where} 之下）`}。`
            : `**还没有删**（这是影响面预览）。课程「${value.title}」${where === '' ? '' : `（在 ${where} 之下）`}：`,
          `· 会一起消失的子课程：${value.sub_courses.length} 门`,
          ...value.sub_courses.map((n) => `    ${'  '.repeat(Math.max(0, n.level - value.level - 1))}· ${n.title}  [${n.node_id}]`),
          `· 会变成"未归课"的会话：${value.session_ids.length} 段`,
          ...value.session_ids.map((s) => `    · ${s}`),
        ]
        if (!value.deleted) {
          lines.push('', '把上面这份清单念给学习者听，得到同意后再带 confirm: true 调一次。')
        } else {
          lines.push('', '会话没有被删除，它们现在算"未归课"；要重新归类就 enter_course 或从课程目录里绑。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args) {
      const course = typeof args?.course === 'string' ? args.course : ''
      if (args?.confirm === true) {
        const impact = deleteCourse({ nodeRef: course, actor: ACTOR_AGENT })
        trace(`DELETE_COURSE  node=${impact.node_id} subs=${impact.sub_courses.length} sessions=${impact.session_ids.length}`)
        return Promise.resolve({ deleted: true, ...impact })
      }
      // 预览：**不写任何东西**。
      const impact = previewDelete({ nodeRef: course })
      trace(`PREVIEW_DELETE  node=${impact.node_id} subs=${impact.sub_courses.length} sessions=${impact.session_ids.length}`)
      return Promise.resolve({ deleted: false, ...impact })
    },
  })

  // ── 把"当前会话属于哪门课"写进运行时上下文（R5）──
  //
  // ═══ 为什么放在这里、而不是塞进每个工具的描述 ═══
  // 本项目实测过：写在工具描述里的规则会被忽略两轮（host-compat §五「规则写在了
  // 读不到的地方」）。运行时上下文是**每次组装都会出现的位置**，所以"课程的级别与名字"
  // 只有放这里才真的进了模型眼前的输入。
  //
  // ═══ 为什么 text 是函数 ═══
  // 每次组装时求值，所以它反映的是**当刻**的树——学习者刚在界面上建的子课程、
  // 刚绑的会话，下一次请求就生效，不需要重启任何东西。
  //
  // ═══ order 取 117 ═══
  // 宿主把档位可用性放在 116（lh-model-tier），课程归属是**比资源情况更强的前提**
  // （它决定这段对话该按哪门课的纪律来），排在它之后。
  //
  // ═══ 失败一律静默为"不注入" ═══
  // 数据目录没配好、日志坏了、会话拿不到 id——这些都不该让整轮模型调用崩掉。
  // 看不到课程说明是**降级**；把模型调用弄崩是**故障**，两者的代价不对等。
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'lh:course',
      order: 117,
      text: (context) => {
        try {
          const agent = context?.agent
          if (agent === undefined || agent === null) return ''
          const sessionId = agent.session?.header?.id ?? agent.session?.id ?? null
          if (typeof sessionId !== 'string' || sessionId === '') return ''
          const { tree } = cachedTree()
          if (tree === null) return ''
          const text = coursePathText(tree, sessionId)
          if (text === null) return ''
          return (
            '当前会话所属课程：' + text + '\n' +
            '（这段对话的学习者输入归这门课；要换课就在对话里说清换到哪门，' +
            '或让 agent 调 enter_course。未绑定的对话不属于任何课程。）'
          )
        } catch (error) {
          trace(`CONTEXT_TEXT_FAILED  ${error?.message ?? error}`)
          return ''
        }
      },
    })
    trace('CONTEXT_REGISTERED  name=lh:course  order=117')
  })

  trace('APPLY_DONE')
}
