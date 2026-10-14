# LH 插件契约 —— Cordis / dsh 的注册 schema 与验证闸门

> **这份文件是写插件与 review 插件的唯一权威依据。**
> 作者的判断：*"我认为之前遇到的一些插件问题的重要原因一部分在于没有严格遵循 cordis 内核的
> 插件注册 schema，这个 schema 是必须提到每个插件开发任务中的，无论是开始写之前还是 review 的时候，
> 出现了问题再找这个 schema 来 debug 效率太低了。"*
>
> **所以它的用法是**：写之前先读第一、二节；写完之后用第七节的清单自查；
> review 别人（或另一个 agent）写的插件时，逐条对照。
>
> **每条规则都标了来源**：
> `[实测]` = 我们踩过、有报错原文；`[宿主源码]` = 从宿主自己的包读出的权威样本；
> `[闸门]` = 有脚本能自动发现。
> **凡我没有验证过的，我写"未验证"而不是猜。**

---

## 〇、先说最重要的一条

**插件的加载失败会让整棵插件树加载失败 —— dsh 完全无法启动。**

这不是"某个功能不可用"，而是**学习者连入口都没有**。三次事故的症状各不相同，
代价是同一个（见 `docs/experience/插件开发者/2026-09-18`）。

**所以顺序是：先证明"不会起不来"，再证明"逻辑对"。顺序不能反。**

### 但"起不来"有四种形态，代价与查法都不一样（2026-09-20 补）

| 形态 | 症状 | 谁在挡 | 怎么先发现 |
|---|---|---|---|
| **① 宿主起不来** | 界面显示加载失败，整棵插件树全废 | profile 插件的 `apply()` / 导入链 | `check-profile-apply`、`check-plugin-imports` |
| **② preset 用不了** | **该 preset 的所有会话都建不起来**（别的 preset 正常） | preset 行未激活（等一个不存在的服务、包名写错、组/realm 关系错） | `check-preset-mount` |
| **③ 界面卡在启动屏** | 浏览器 console 报 `Failed to load plugins` | 客户端 bundle（漏 `exports.inject`、list 插槽漏 `options.id`、抢跑别的包声明的插槽） | `check-client-inject`、`check-client-slot-timing` |
| **④ 静默少一个功能** | 什么都不报，只是某个入口不出现 | keyed 插槽的 key 写错（宿主"只是不渲染"）、`try/catch` 兜住的注册失败 | 只靠**兜底入口**与真使用 |

**②③④ 的共同点是"看起来像别的病了"**：②像"LH 坏了"，③像"页面卡了"，
④像"我根本没做那个功能"。所以它们的排查要靠"在哪一层加载"这条线索分开，
而不是靠猜（见 §五之六 的排查表）。

---

## 一、服务端插件（profile 行 / preset 行）

```js
export const name = 'lh-xxx'        // 插件名
export const inject = ['tools']     // 需要的**宿主服务名**数组；没有就省略
export function apply(ctx) { … }    // 必须导出；宿主在服务就绪后调用
```

### 1.1 `inject` 写的是**服务名**，不是包名 `[实测]`

| 名字 | 谁提供 | 在 preset 作用域可用吗 |
|---|---|---|
| `tools` / `sessions` / `llm` / `systemPrompt` | 宿主 | ✅ 实测可用 |
| `sessionProjections` | 宿主 | ✅（`lh-event-store` 在用） |
| **`webServer`** | 宿主（`dsh-host-webserver` 行，含于 `dsh-web-app` bundle） | ❌ **profile 层才能用** |

**易错点**：preset 是 **agent 作用域**，够不着 host 面服务。
所以需要 `webServer`、且要在 profile 里跑的东西，**必须放在 profile 行**（如 `lh-practice`）。

### 1.2 工具注册的 schema `[实测]`

注册表要的是**字面 JSON Schema**，**支持的关键字是一个封闭子集**：

```
type / oneOf / properties / required / additionalProperties / items / enum / const
+ 注释类：description / title
```

- **`required` 是根级数组**，不是每个属性上的布尔。
  第一方插件用的 `defineTool({ parameters: { x: { type, required: true } } })` 那种 DSL
  **不能照抄** —— 那是 `defineTool` 内部编译掉的。
- **少一个关键字都不行**：`format`、`pattern`、`minimum` 都会让**注册失败**。
  有闸门可查：`node scripts/check-preset-mount.mjs`（用宿主的 `assertSupportedJsonSchema`）。
- **输出 schema 里可能为 `null` 的字段必须写 `oneOf: [{type:'string'},{type:'null'}]`。**
  `[实测]` 一次真实报错：
  ```
  tool "list_question_banks" returned invalid output:
    "value.banks[1].source_root" must be a string
  ```
  根因是 schema 写成 `type:'string'`，而真实数据里那个字段可以是 `null`。

### 1.3 HTTP 路由 `[宿主源码]`

```js
ctx.webServer.register({
  kind: 'prefix' | 'exact',
  path: '/lh/xxx',                       // 绝对路径，无尾斜杠
  handler: async (req, res) => { … },    // 自己负责整个响应生命周期
})
```

- 同一 `(kind, path)` 重复注册会**抛错**。
- 返回它给的 disposer，并在 `ctx.effect` 里注册，这样卸载时路由会被摘掉。

---

## 二、客户端插件（浏览器半）

```js
window.__ModuleLoader__.load({
  id: '@lh/xxx',                    // 必须与 package.json 的 name 一致
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    exports.apply = (ctx) => { … }
    exports.inject = ['slots']      // ← **漏了它，启动屏就卡住**
    return exports
  },
})
```

### 2.1 必须在**模块里导出** `inject`，不是写在 package.json 里 `[实测]`

| 声明位置 | 宿主读不读 |
|---|---|
| `package.json` 的 `dsh.client.inject`（**包名**数组） | 只进 boot manifest，**不拿它装配 fiber 的 inject** |
| 模块导出的 `exports.inject`（**服务名**数组） | ✅ **门禁认这个** |

`[实测]` 报错原文（启动屏 `Failed to load plugins`）：
```
cannot get property "slots" without inject
```
`[宿主源码]` 权威样本 `dsh-session-log-export/lib/client.js`：
```js
const inject = ["slots", "locale"]     // 服务名
function apply(ctx) { … }
exports.apply = apply
exports.inject = inject
```

### 2.2 访问 `ctx.<服务>` 前，服务必须在 `exports.inject` 里 `[实测]`

cordis 的 inject 门禁：**没声明就访问会抛**。
`ctx.effect` / `ctx.provide` / `ctx.on` / `ctx.get` 等是 **cordis 自带成员**，**不需要**声明。

### 2.3 插槽注册的 schema `[实测]` `[宿主源码]`

```js
ctx.slots.register({ name: '<插槽名>' }, Component)                       // single 型
ctx.slots.register({ name: '<插槽名>', id: '<唯一 id>' }, Component)       // **list 型必须给 id**
```

- `[实测]` list 型缺 `id` 的报错原文：
  ```
  list slot "sidebar.footer.action" requires options.id
  ```
- `[宿主源码]` 权威样本（`dsh-client-ui-jobs`）：
  ```js
  ctx.slots.inject("conversation.session.header.actions", () =>
    ctx.slots.register({ name: "conversation.session.header.actions", id: "job-list", order: 20, locale: "job" },
      JobListAction))
  ```
- **推荐用 `ctx.slots.inject(key, cb)` 包一层**：它等到该插槽的**声明存在**再注册，
  比直接 `register` 稳（`[宿主源码]`，这是宿主自己的惯用法）。回调返回 disposer。
- 其它可选字段（见宿主样本）：`order`、`locale`、`children`（声明子插槽）、`key`（tool view 类）。
  **`inject` 作为 register 参数在宿主包里也出现过，但我未查明其语义 —— 不要照抄，用上面的写法。**
- 组件可用的组件库：`require('@deepseek-ai/dsh-client-ui-primitives')`（104 项，含 `Button` 等）。
- **不要用 JSX**：手工 bundle 没有转译步骤，JSX 直接语法错。用 `React.createElement`。

### 2.4 客户端 bundle 的投放是**白拿的** `[宿主源码]`

`dsh-client-modules` 会扫描 Loader 里声明了 `dsh.client` 的包，
自动 serve `/plugins/<包名>/client.js` 并把 boot 图注入 index.html。
**所以只需要一行服务端入口让服务端半加载**，不需要自己注册 `/plugins/` 路由或注入 script 标签。

但 `package.json` 的 `exports` **必须包含 `"./client"` 与 `"./package.json"`**，否则客户端半不被发现。

---

## 三、模块导入：跨插件引用只能用包名

**这是第一次恶性事故的根因。** `[实测]`

```js
import { … } from '../lh-question-bank/index.js'   // ❌ 只在源码目录成立
import { … } from '@lh/question-bank'              // ✅ 装到哪都能解析
```

**为什么相对路径会断**：pnpm 把 profile 的 `file:` 依赖**复制**（不是软链），
而且**目录名由包名派生**（`@lh/question-bank` → 目录 `@lh/question-bank/`）。
所以 `../lh-question-bank/index.js` 要找的 `@lh/lh-question-bank/` **永远不存在**。

**修法（缺一不可）**：
1. 被引用的包**必须有 `package.json`**（含 `name` 与 `exports`）；
2. 引用方在自己的 `package.json` 里用 **`file:` 声明依赖**：
   ```json
   "dependencies": { "@lh/question-bank": "file:../lh-question-bank" }
   ```
3. 工作区根也要声明（否则源码目录里的测试解析不到）。

**有闸门可查**：`node scripts/check-plugin-imports.mjs`（它 `import()` 的是 **profile 里的副本**，
所以走的是生产路径）。

**注意一份依赖的两处形态** `[实测]`：

| 环境 | pnpm 形态 | 改源码后 |
|---|---|---|
| 工作区根 `node_modules` | **软链**回 `plugins/` | 立即生效 |
| profile 的 `node_modules` | **复制** | **需要重装**（`pnpm add` 会说 `Already up to date`，得先删目录） |

**所以"改了没生效"与"改错了"现象相同** —— 用 **hash 比对**源码与副本，不要看时间戳。

---

## 四、环境变量必须惰性求值

```js
export const LOG = process.env.LH_EVENT_LOG ?? 'D:\\…'        // ❌ import 时固化
export function logPath() { return process.env.LH_EVENT_LOG ?? 'D:\\…' }   // ✅
```

`[实测]` 后果不是"不方便"，是**测试把假数据写进了真实学习史**——
调用方在 import 之后设环境变量，被静默忽略。

---

## 五、写入文件的规矩（保护自己与学习者）

- **原子替换**：先写 `.tmp` 再 `renameSync`。直接写会在中断时留下半截 JSON，
  **下一次读取会解析失败，于是数据看起来消失了**。
- **读入容忍 BOM**：任何文本都可能被别的工具加上 BOM，读取端必须免疫。
- **不要用 shell 重定向写文本文件**（PowerShell 的 `>` 默认写 **UTF-16LE**）。
  用 Node 写。
- **改文本文件用 `edit` 工具，不用 shell**（`Set-Content` 会把多字节字符写成 `U+FFFD`，
  实测把文件改到连读都读不出来）。

---

## 五之二、`apply()` **绝对不许抛错**（2026-09-18 新增，血的教训）`[实测]`

这是本契约里**唯一一条会让宿主彻底起不来**的规则，所以它独立成节。

**profile 插件（以及客户端插件）的 `apply()` 抛错 = 整棵插件树加载失败 = dsh 起不来。**
学习者面对的是一个加载失败的界面，**连"该配什么"这句话都看不到**——
而那恰恰是他最需要那句话的时刻。

所以：
- `apply()` 里**不做**任何"可能因为环境没配好而失败"的操作（解析数据目录、读工作区、连服务）。
- 配置缺失 → **装载照常完成**，把错误留到**真正用到它的那一刻**再响亮地拒绝
  （路由返回 503 + 修法；工具返回错误 + 修法）。
- 装载期可以**打日志**（stderr），因为"装载成功"与"配置就绪"是两件事，
  事后排查必须能区分——**但不能安静，也不能把门锁上**。

```js
export function apply(ctx) {
  // ❌ const root = resolveWorkspace()      // 没配就抛 → dsh 起不来
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/lh/x',
    handler: (req, res) => {
      const root = resolveWorkspace()       // ✅ 用的时候解析
      if (root === null) return sendJson(res, 503, { error: '…', fix: ['…'] })
      …
    },
  }))
}
```

`[实测]` 原始形态：`@lh/practice` 的 `apply()` 里 `resolveWorkspace()` 直接抛
`lh-practice: 没有配置工作区`；`@lh/event-store` 的 `apply()` 里 `dataDir()` 抛
`lh-paths: 找不到 LH 仓库根`。两者都会让 dsh 完全起不来。

**推论（这条比规则本身更重要）**：把装载期的抛错改成"用的时候拒绝"，
等于**拆掉了一个警报器**。所以必须有另一道闸门直接问底层问题，
而不是依赖"apply 抛不抛错"来间接发现——
见 `scripts/check-paths-resolution.mjs`（它直接问"每个加载位置解析出的路径是否一致"）。

---

## 五之三、`package.json` 必须声明 `files`（运行时文件集）`[闸门]`

`files` 是**运行时会真正被加载的文件集**，不是"目录里有什么"。两个用途：

1. pnpm 按它决定 `file:` 依赖拷贝哪些文件；
2. `scripts/check-installed-copies.mjs` 按它比对**源码与已安装副本**。

**新增运行时文件必须同时加进 `files`**，否则副本里不会有它——
而那会以"某个 import 找不到模块"的形式，在**下一次重启**才炸。

为什么不让闸门自动推断：**推断不出来**。"目录里所有文件"会把测试与日志算进去；
`exports` 只列入口，真正被 import 的模块（如 `paths.js`）不在里面。
**靠猜的闸门会漏，而漏掉的闸门比没有闸门更坏。**

---

## 五之四、装了副本就要同步，且**只有一条同步路径**`[实测]`

pnpm 对 `file:` **目录**依赖是**拷贝快照**，不是软链：

| 位置 | 形态 | 改源码后 |
|---|---|---|
| 仓库根 `node_modules/@lh/x` | **workspace 软链** → `plugins/lh-x`（`pnpm-workspace.yaml` + `workspace:*`） | 立即生效 |
| profile `node_modules/@lh/x` | **真实目录，拷贝** | **不动，要同步** |

于是"改了源码"之后有三种可能，**从外面看一模一样**：
① 离线测试跑的是旧代码（"测过了"是假的）；② 生产跑的是旧代码（"改了没生效"）；③ 真的生效了。

- 查：`node scripts/check-installed-copies.mjs`
- 修：`node scripts/sync-lh-deps.mjs`（覆盖前自动备份到 `.lh-sync-backup/`）
- **不要用 `pnpm install` 来同步**：规格没变它认为"已是最新"直接跳过，
  而且它会在 dsh 自己的 profile 安装根里跑包管理器（副作用半径太大）。

---

## 五之五、安装期配置 `lh-install.json`（**别让运行时的路径靠环境变量**）`[实测]`

插件装进 `profiles/<名>/node_modules/@lh/<包>/` 之后，**它的上方没有 LH 仓库**。
所以"从模块位置往上找仓库根"必然失败——这条链的终点是
`dataDir()` 抛错 → `apply()` 抛错 → **dsh 起不来**（见 §五之二）。

`lh-install.json` 是**装的时候写下、运行时只读**的配置，放在包的上方某一级：

```json
{ "repo_root": "<LH 仓库的绝对路径>", "workspace": "<工作区的绝对路径>" }
```

- 仓库根那一份：手工维护；
- `profiles/<名>/` 那一份：由 `sync-lh-deps.mjs` 生成（写在 `node_modules` 的上一级，
  所以不会和 `files` 清单、闸门的"多余文件"检查打架）。

`paths.js` 的解析顺序：**环境变量 → `lh-install.json` → `lh-workspace` 包标记 → 抛错**。

### 五之五之二、`DSH_HOME`：dsh 的家可以搬家，而**闸门必须跟着搬**（2026-09-20）`[实测]` `[宿主源码]`

**事实**（`[宿主源码]` `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome`）：

```
显式配置 > $DSH_HOME > ~/.dsh        （空白值的 DSH_HOME 按未设置处理）
```

挂在这个根下面的东西：**`.agent-presets/`、`profiles/<名>/`、`sessions/`、`attachments/`、
`.credentials.yaml`、`settings.yaml`**。所以**一个环境变量就能把整个"家"搬走**——
本仓库就是这么做的（`node scripts/lh-dev.mjs`，见 ADR-031）。

**对插件的含义**：`lh-install.json` 的定位链要能跨家工作。
`sync-lh-deps.mjs` 会往**当前 `DSH_HOME`** 下的每个 profile 写一份，所以搬家后
**必须重跑一次 `pnpm install` + `sync-lh-deps.mjs`**，否则新家的副本找不到仓库根。

**对闸门的含义（这条是踩出来的）**：闸门不许写死 `USERPROFILE/.dsh`。
`check-plugin-imports` / `check-profile-apply` 的全部价值是"**import 的是生产那份副本**"；
一旦它们看的是另一个家，它们证明的就是**另一份代码**——
**闸门指着错的目录比闸门红更糟**：它会让人去修一个没坏的东西。

所以：所有需要知道"家在哪儿"的脚本都走 `scripts/lib/dsh-home.mjs`，
并**打印它看的是哪个家**（`describeHome()`）。迁移期最危险的状态不是"哪个家错了"，
而是"**脚本 A 看新家、脚本 B 看旧家，而两边都给出结果**"。

**为什么不让环境变量当唯一来源**：忘了设就起不来，学习者被困在没有入口的界面里。
**为什么不让运行时猜**：猜错会去读别人的工作区，表现只是"题库是空的"（静默错误）。
配置文件两头都避开了：它是**显式写下的**，又不是**每次启动都要记得设的**。

---

## 五之六、`cordis.yml` 组合文件的规矩（2026-09-20 新增）`[实测]` `[宿主源码]`

这一节管的是**preset / profile 的组合文件本身**——它是"加一行就让全部会话不可用"的那类编辑。

### 5.6.1 `isolate` realm：只有"发布服务"的行需要它

`[宿主源码]` standard preset 顶部原文：

> A service row here MUST sit inside a group carrying an `isolate` realm.
> Without one it publishes into the root realm, where it is process-global —
> another preset publishing the same name collides, and a host reader would resolve
> one preset's instance for every session; `dsh-agent-presets` rejects that at mount.

**所以加行之前先问一句：这一行 `provide` 东西吗？**

| 行的类型 | 需要 realm 吗 | 例子 |
|---|---|---|
| **只注册进宿主注册表**（工具行） | ❌ 不需要，直接加普通行 | `tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-jobs` / `tool-ask-user` / `tool-todo` / `tool-web` |
| **发布服务** | ✅ 需要，包在带 `isolate` 的 `cordis:group` 里 | `planning`（`planMode`）、`compaction`（`compaction` + `toolResultPruner`）、`delegation`（`workflowEngine`） |

**错误形态**：把需要 realm 的行直接写成普通行 → 挂载时被拒 → **整个 preset 的所有会话都建不起来**。
**另一种错**：给不需要 realm 的行硬套一个 group → 多一层结构，排查时多一层噪声（本次就按这条把第一批 8 行直接加成普通行）。

### 5.6.2 `!!js` 表达式可用，且应该用它

`[宿主源码]` standard preset 用平台判断决定 bash/pwsh 二选一：

```yaml
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
```

**照抄这个形状，不要靠人记住"哪个平台用哪个"。**

### 5.6.3 裸包名由**宿主**解析，路径要写对它自己那一份

`[实测]` 组合文件里的 `name` 有两种：

| 写法 | 谁解析 | 说明 |
|---|---|---|
| `name: '@deepseek-ai/dsh-tool-pwsh'` | **宿主**加载器 | 宿主包，实测住在 **dsh 安装根自己的 `node_modules`** 里：`…/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-pwsh` |
| `name: 'D:\…\plugins\lh-x\index.js'` | Node 的 file: URL | 绝对路径**在 preset 行里可用**（宿主的 Include 会转换，见 §一）。**相对路径不可用** |

**推论（省得再查）**：闸门要核对"宿主包在不在"时，得去上面那个位置找，
而不是全局 npm 根那一层（本次先查错了，8 行全报"找不到"）。

### 5.6.4 解析出 0 行 = 红灯，不是"没事"

`[实测]` 组合文件被改坏（缩进/引号）时，行解析器会**安静地得到 0 行**。
而 0 行的真实后果就是 §〇 形态 ②。所以任何组合文件的检查都必须显式断言"至少解析出一行"。

### 5.6.5 加行是"会影响所有人"的编辑，所以顺序是固定的

1. **备份**（原样复制一份到仓库的备份目录）；
2. **闸门**（`check-preset-mount`）必须绿，且**闸门自己要先对坏状态红过**（见 §八）；
3. 加行；
4. **真会话验证**（发一句"你能用哪些工具"看清单）；
5. 失败则**回滚备份 + 重启**。

---

## 五之七、插件"自己说清自己"：`package.json` 的 `lh` 字段 `[闸门]`（ADR-024）

每个插件的 `package.json` 里必须有一段**声明式**的自我描述：

```json
"lh": {
  "kind": "kernel" | "recorder" | "capability" | "ui" | "dev",
  "summary": "一句话说它做什么",
  "inject": ["tools"],
  "provides": { "tools": ["get_questions"], "contexts": ["lh:model-tiers"] },
  "depends_on": ["@lh/event-store"],
  "loads_at": "preset" | "profile",
  "verified": { "gates": true, "live": false }
}
```

**它为什么必须有**：agent 要回答"现在有哪些插件、各自能干什么、**验过什么**"时，
需要一个**机械可枚举、不会过期**的来源。读 `package.json` 比读文档可靠——
文档会忘更新，而它是包的一部分。

**它会漂移，所以有闸门**：`check-plugin-contract.mjs` **真跑一次 `apply()`**，
把注册到的工具名与 `provides.tools` 对照、把 `inject` 与模块导出的 `inject` 对照。
不一致就红。缺这一段也红。
（本次闸门第一次跑就抓到一处自己写错的声明：`lh.inject` 写了 `sessionProjections`，实际导出的是 `sessions`。）

---

## 六、写代码之前要问清的**五**件事

一个插件在这五处**各自只有一种正确写法**，问错了就会以"起不来"或"静默失效"的形式暴露：

1. **它挂在哪一层？** agent preset 作用域，还是 profile/host 作用域？（决定能用哪些服务）
2. **它需要哪些宿主服务？** → 写进 `inject`（服务名）。
3. **它要引用别的插件吗？** → 只能用**包名** + `file:` 依赖声明。
4. **它以什么形态注册？** 工具 / 插槽 / HTTP 路由 / 运行时上下文 —— 各自有 schema，见上。
5. **（2026-09-20 补）它 `provide` 东西吗？** → 那它必须坐在带 `isolate` 的组里（见 §五之六）。

**这五问的答案都要写进 `package.json` 的 `lh` 字段**（见 §五之七）——
写下来的那一刻就是一次自检，而闸门会核对它与实现是否一致。

---

## 七、Review 清单（写完自查 / 审别人的插件）

**致命级（会让 dsh 起不来或功能静默缺失）**

- [ ] 服务端：导出了 `name` 与 `apply`
- [ ] 服务端：**`apply()` 不会因为"没配好"而抛错**（见 §五之二）
- [ ] 服务端：`inject` 里的服务名**在它所在的层真的可用**
- [ ] 服务端：**跨插件引用用包名**，且被引用方有 `package.json`、引用方声明了 `file:` 依赖
- [ ] 服务端：`package.json` 有 `files`，且**每一个运行时文件都在里面**（见 §五之三）
- [ ] 路径：**没有从"模块位置往上找仓库根"来定位数据目录**——
      装进 profile 后那条路必然失败；走 `lh-install.json` 或环境变量（见 §五之五）
- [ ] 客户端：**导出了 `exports.inject`**（不是只写在 package.json）
- [ ] 客户端：每个 `ctx.<服务>` 都在 `exports.inject` 里
- [ ] 客户端：`package.json` 的 `exports` 含 `"./client"` 与 `"./package.json"`
- [ ] 插槽注册：list 型**给了 `id`**
- [ ] 工具 schema：只用了那 8 个关键字；`required` 是根级数组
- [ ] 输出 schema：可能为 `null` 的字段写成 `oneOf: [type, 'null']`
- [ ] HTTP 路由：`(kind, path)` 不与已有路由重复
- [ ] **`package.json` 有 `lh` 自我描述**，且 `provides.tools` / `inject` 与实现一致（见 §五之七）
- [ ] **（组合文件）** `provide` 东西的行坐在带 `isolate` 的组里；只注册工具的行不要硬套组（见 §五之六）
- [ ] **（组合文件）** 加行前有备份、闸门绿、且闸门自己对着坏状态红过
- [ ] **（组合文件）** 加行后**在真会话里**看过一次工具清单（发一句"你能用哪些工具"）

**严重级（功能不可用/数据风险）**

- [ ] 环境变量惰性求值
- [ ] 写文件用原子替换；读文件容忍 BOM
- [ ] 破坏性操作只做白名单，且先备份
- [ ] **改完源码跑过 `sync-lh-deps.mjs`**，且 `check-installed-copies.mjs` 是绿的
      （否则"测过的"和"要跑的"不是同一份代码）
- [ ] 工具/中间件的**返回值里带纠错信息**（被忽略的字段名、可用值），别让调用方瞎猜（§一.2、ADR-026 决定 5）
- [ ] 写入的字段**不是"声明了却不生效"的**（那比没有这个字段更糟：调用方以为生效了）
- [ ] 处理"模型/外部输入的枚举值"时，**认不出的如实回报**而不是静默丢弃或抛错（ADR-019 决定 4、ADR-021 结论七）

**一般级**

- [ ] 边界情况有断言（空输入、缺字段、超大输入）
- [ ] `render` 不把大内容塞进对话（实测踩过：8,400 tokens 每轮重发）
- [ ] 判定器/断言的口径与它要衡量的东西一致（**不写死"当时的数量"**）
- [ ] **改动会让"行为选择"出错时（用哪个工具/走哪条路），约束放在"每次组装都会出现"的位置**，
      而不是某个工具的描述里（实测：写在描述里的规则被忽略两轮 —— ADR-019 修订 10）

---

## 八、闸门清单（每条规则背后的自动检查）

| 脚本 | 拦什么 | 关键设计 |
|---|---|---|
| `scripts/check-plugin-imports.mjs` | 安装后的包**能否被 import** | `import()` 的是 **profile 里的副本** → 走生产路径 |
| `scripts/check-profile-apply.mjs` | 插件的 **`apply()` 会不会抛错** | 记账式假 ctx 真跑一遍，列出注册的工具/路由/上下文 |
| `scripts/check-client-inject.mjs` | 客户端 bundle 的 `ctx.<服务>` 是否都声明了 | **手写状态机**剥注释与字符串（正则会把注释里的 `ctx.x` 误当访问） |
| `scripts/check-client-slot-timing.mjs` | 客户端插件**抢跑**别的包声明的插槽 | 用"什么都不声明"的假 slots 真跑 apply：不许抛错、必须零注册 |
| `scripts/check-preset-mount.mjs` | preset 行能否加载、工具 schema 是否合规、**宿主包在不在**、**解析出 0 行** | 宿主包去 dsh 安装根自己的 `node_modules` 里核对；0 行 = 红灯 |
| `scripts/check-plugin-contract.mjs` | 契约里的**形状**规则 + **`lh` 自我描述与实现是否一致** | 真跑一次 `apply()` 对照注册到的工具名 |
| `scripts/check-installed-copies.mjs` | **副本是不是旧的**（"测过了"是不是真的） | 要求每个包声明 `files`；**拒绝自动推断**；活链如实标注 |
| `scripts/check-paths-resolution.mjs` | **同一个问题从每个加载位置问，答案一不一样** | 子进程 + 干净环境；答案不一致比答案错更难发现 |
| `scripts/check-hardcoded-paths.mjs` | 写死的盘符 | 例外要**带理由**，且一处一个，不能撒 |
| `scripts/check-restart.mjs` | 当前 dsh 进程是不是在最新改动之前启动的 | 它红 = "需要重启"（**学习者的动作**，不是脚本出错） |
| `scripts/check-text-encoding.mjs` | 文本文件里的 **BOM** 与 **U+FFFD**（编码转换丢字符的化石） | 规矩犯过四次 → 改成闸门；例外要在文件里写 `bom-ok` 并说明理由 |
| `scripts/compare-homes.mjs` | 两个 dsh 家的 preset/副本是否已经分叉 | 只读对照（同一判据跑两个 DSH_HOME 取值） |

**它们的边界（必须知道，否则会变成假的安全感）**：
它们证明的是"能 import / apply 不抛错 / 声明齐全 / 副本是新的 / 路径一致 / 声明与实现一致"。
**它们不能证明宿主真的会这样调度，也不能证明逻辑对。**
**最终仍需要一次真启动。**

**而且：闸门自己要先对着"已知坏的状态"红一次，才算被验证过。** 现有自检：

| 自检 | 验的是什么 |
|---|---|
| `scripts/selftest-installed-copies.mjs` | 副本比对器（造假仓库，连良性误报一起断言） |
| `scripts/selftest-plugin-contract.mjs` | 契约闸门：files 漏登记 / 幽灵文件 / `lh` 声明漂移 / 缺 `lh` 段 / 正常 |
| `scripts/selftest-preset-mount.mjs` | preset 闸门：正确配置 / 包名写错 / 路径写错 / 空 preset |
| `scripts/selftest-memory-sampler.mjs` | 内存量具本身（基线 / 明显增大 / 短命进程"没量到"） |

**⚠ 一条反直觉的推论（2026-09-18 得出）**：
把"装载期抛错"改成"用的时候拒绝"会让某道闸门**变绿，而底层仍然是坏的**。
**改掉一个错误行为时，要同时问"原来是谁在替我报警"，并把这个警报器补回来。**

---

## 九、未验证 / 待查（不要当成规则用）

- 插槽注册参数里的 **`inject`** 语义（宿主包里出现过，未查明）。
- 客户端插件之间 `ctx.provide` / `ctx.inject` 的依赖解析（`dsh.client.inject` 里那份**包名**数组
  到底影响什么）。
- `ctx.remote` 那条路需要**构建期生成**的 `./typert`，而生成器
  `@deepseek-ai/dsh-typert-generator` **没有随发行版发布**（实测不存在）。
  **所以不要试图用它**；需要服务端数据时走自注册的 HTTP 路由。
- **（2026-09-20 补）组 + realm 的真实挂载行为**：§五之六 的规则是从 standard preset
  的注释读出来的（`[宿主源码]`），**我们自己的 preset 还没挂过任何带 `isolate` 的组**。
  所以"包在组里就一定能挂上"这句话**未实测**——第二批（planning/compaction/delegation）落地时要单独验。
- **（2026-09-20 补）技能（skill）的可用根**：`skill-filesystem` 认
  `<项目根>/.dsh/skills`（rank 100）／`<dshHome>/skills`（400）／`~/.agents/skills`（500）／
  `customSkillDirs`（300），`[宿主源码]` 来自该包的 README；但**我们自己的 preset 没挂过它**，
  所以"LH 自己的技能放哪、能不能被发现"**未实测**。
- **（2026-09-20 补）`ctx.tools.register` 的 `output.schema` 校验时机**：
  契约 §一.2 的两条形状规则（`required` 是根级数组、可能为 null 的字段用 `oneOf`）
  是**实测**得出的，但"宿主到底在校验什么、什么时候校验"未读完源码。
  现有闸门用 `check-preset-mount` 间接覆盖（借宿主的 `assertSupportedJsonSchema`）。

---

## 更新纪律

- 新增一条规则时，**必须**标明来源（`[实测]` 带报错原文 / `[宿主源码]` 带包名与文件 /
  `[闸门]` 带脚本名）。
- **没验证的写"未验证"**，不要写成规则 —— 一份把猜测当规则的契约，
  比没有契约更危险，因为它会让人**停止怀疑**。
