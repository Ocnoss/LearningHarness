# LH 插件清单 · 迁移前后 · pending 关系

- 日期：2026-10-11
- 范围：仓库 `plugins/` 下全部 LH 插件包、两个 dsh 家的 preset 与 profile 配置、运行中的事件日志。
- 证据来源（都可复跑）：`node scripts/compare-homes.mjs`、`node scripts/check-preset-mount.mjs`、
  `node scripts/check-profile-apply.mjs`、`<仓库>/data/events.jsonl`、
  宿主 app.asar 内的 `cordis-composition-reference`（"Migrate a legacy preset" 一节）、
  每个包的 `package.json` 的 `lh` 段。
- 凡标 **实测** 的是查过的；标 **推断** 的写了依据。没有第三条。

---

## 0. 三句话结论

1. **现在有两条挂载路并存，而只有一条是活的。**
   旧的 `.agent-presets/lh/agent.cordis.yml`（agent/preset 作用域）在本机 **已经不被读取**；
   实际在跑的是 profile/host 层的 `cordis.patch.yml` 里的 `insert` 行。

2. **日常用的 desktop 上只有 4 个 LH 插件行真的挂着**：
   `lh-course-tree` / `lh-schedule` / `lh-workspace-ui` / `lh-schedule-ui`。
   其余 5 个（`lh-question-bank`、`lh-resource-indexer`、`lh-recorder-trace`、
   `lh-model-tier`、`lh-asserter`）**哪一层都没有行**——它们在事件日志里的最后一条写入
   停在 **2026-09-22**（见 §4）。也就是说：题库/作答/索引能力现在**静默不存在**。

3. **pending**（界面里显示「等待依赖」）= Cordis 的 fiber 停在 `pending`：
   插件声明了 `inject`，但**提供者不在同一层**，于是 `apply()` 永不执行、能力静默消失。
   当前挂着的 4 行都不是 pending（它们的 inject 只有 `tools` / `webServer`）；
   真正的 pending 风险在"把 preset-only 插件硬搬到 host 层"这一步（§5.4）。

---

## 1. 「迁移」指哪两件事（先消歧）

这个项目里叫"迁移"的有两件，别混：

| # | 迁移 | 方向 | 现状 |
|---|---|---|---|
| A | **家迁移**（ADR-031，2026-09-20） | `~/.dsh` → `<仓库>/.dsh`（`DSH_HOME`） | 两个家现在都在、内容一致（§3.3） |
| B | **preset 迁移**（宿主这次升级带来的） | 旧 `$DSH_HOME/.agent-presets/<id>/` 目录 → bundle 里的 **declaration row** | **没做**；现在靠 host 行凑合（本文重点） |

### 1.1 旧 preset 目录\"死\"了的实测证据

- 宿主文档原话（app.asar 内 `cordis-composition-reference`）：
  > Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/`
  > holding `preset.yml` ... and `agent.cordis.yml` ... **Nothing reads that directory any more.**

- **实测**：本机 app.asar 的 `@deepseek-ai/` 下只有 `dsh-agent-preset` 与
  `dsh-agent-preset-registry`（新机制），**没有 `dsh-agent-presets`**（旧目录扫描器）。
  `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-agent-presets` 那份是上一版留下的**残留依赖**，
  不是应用在跑的实现。
- **旁证**（比文档更硬）：如果该目录还生效，`lh-question-bank` 的工具就该在 LH 会话里；
  实际本会话**没有** `import_questions` / `record_attempt` / `start_practice` 等 11 个工具（§2.2）。

### 1.2 正路 vs 现在走的路

| | 正路（宿主文档给的） | 现在实际在走的 |
|---|---|---|
| 是什么 | 做一个 **bundle**：`package.json` 声明 `dsh.bundle.patch`，patch 里插一行 `@deepseek-ai/dsh-agent-preset`，`config.id/name/description/order/plugins` | 把插件拆成两半：`profiles/<p>/cordis.patch.yml` 的 `insert` 行（host 层）+ `package.json` 的 `file:` 依赖 |
| 挂在哪 | 仍然给**用了该 preset 的会话** | **所有会话**都能看见（scope 变了） |
| 恢复什么 | 8 行 LH 插件原样（含题库、索引器、记录器、档位、断言器） | 只有被显式加行的那 4 个 |
| 代价 | 要一次 `plugin_manager install_bundle`（需 full access） | scope 错误 + 丢功能：见 §4 |

---

## 2. 插件总表（13 个）

「注入」= 模块导出的 `inject`（Cordis 服务依赖，决定 pending）；「作用域」= `lh.loads_at`。
「现在挂在哪」= **实测**的活跃挂载点（见 §3 矩阵）。

| 包 | 版本 | kind | 作用域 | 注入 | 主要提供 | 现在挂在哪 |
|---|---|---|---|---|---|---|
| `@lh/event-store` | 0.0.4 | kernel | preset | `sessions`（另动态 `ctx.inject(['sessionProjections'])`） | 服务 `lhEvents`；`store`/`paths` 模块 | ⛔ 无行（但被别的插件直接 import） |
| `@lh/recorder-trace` | 0.0.1 | recorder | preset | `sessions` | 事件 `lh/trace/observed` | ⛔ 无 |
| `@lh/resource-indexer` | 0.0.1 | capability | preset | `tools` | 工具 `index_learning_resources`；事件 `lh/resource/indexed` | ⛔ 无 |
| `@lh/model-tier` | 0.0.2 | capability | preset | `llm`, `systemPrompt` | 上下文 `lh:model-tiers`；`model`/`tier` 模块 | ⛔ 无 |
| `@lh/question-bank` | 0.0.4 | capability | preset | `tools`, `systemPrompt`, `subagents` | 10 个工具；上下文 `lh:practice-routing`；2 类事件 | ⛔ 有包装、无行 |
| `@lh/course-tree` | 0.3.0 | capability | preset | `tools` | 5 个工具；上下文 `lh:course`；5 类事件 | ✅ desktop host 行 |
| `@lh/asserter` | 0.0.1 | capability | preset | `llm`, `sessions` | 事件 `lh/assertion/made` | ⛔ 无（且 preset 里本就 `disabled`） |
| `@lh/schedule` | 0.1.0 | capability | preset | `tools` | 4 个工具；上下文 `lh:agenda`；5 类事件 | ✅ desktop host 行 |
| `@lh/theme` | 0.0.1 | ui | profile | — | 客户端模块 `@lh/theme/client` | ✅ web host 行 |
| `@lh/practice` | 0.0.2 | ui | profile | `webServer` | 3 条路由；2 个插槽；客户端模块 | ✅ web host 行 |
| `@lh/course-ui` | 0.0.1 | ui | profile | `webServer` | 3 条路由；2 个插槽；客户端模块 | ⏸ web host 行（`disabled: true`，2026-10-08 退役） |
| `@lh/workspace-ui` | 0.3.1 | ui | profile | `webServer` | 6 条路由；3 个插槽；客户端模块 | ✅ web + desktop host 行 |
| `@lh/schedule-ui` | 0.1.0 | ui | profile | `webServer` | 6 条路由；4 个插槽；客户端模块 | ✅ web + desktop host 行 |

### 2.1 声明的能力总量

- 工具共 **20** 个：course-tree 5 + schedule 4 + question-bank 10 + resource-indexer 1。
- 运行时上下文共 **4** 个：`lh:course`(117) / `lh:agenda`(118) / `lh:model-tiers` / `lh:practice-routing`。
- HTTP 路由共 **18** 条（practice 3 + course-ui 3 + workspace-ui 6 + schedule-ui 6）。

### 2.2 本会话（desktop）实际能拿到的 LH 能力（实测）

**工具 9/20**：`create_course` `list_courses` `rename_course` `enter_course` `delete_course`
+ `create_schedule` `list_schedule` `update_schedule` `cancel_schedule`。

**缺失 11 个**：question-bank 全部 10 个（`import_questions` … `start_practice`）
+ `index_learning_resources`。

**上下文 2/4**：`lh:agenda` 出现在本会话运行时上下文里（今天 20:00 复习逻辑填空、验收期倒计时）；
`lh:course` 由 course-tree 注册。**缺** `lh:model-tiers`、`lh:practice-routing`。

---

## 3. 迁移前后对照

### 3.1 迁移前：旧 preset 是唯一挂载点

`$DSH_HOME/.agent-presets/lh/agent.cordis.yml`，**两个家哈希一致**
（`5BB44AAF…`；`preset.yml` = `2B0CF1F3…`），共 **16 行**：

| 类别 | 行 |
|---|---|
| 宿主基础能力 8 行 | `tool-bash` `tool-pwsh` `tool-fs` `tool-fs-search` `tool-jobs` `tool-ask-user` `tool-todo` `tool-web` |
| LH 插件 8 行 | `lh-event-store` `lh-recorder-trace` `lh-resource-indexer` `lh-model-tier` `lh-question-bank` `lh-course-tree` `lh-asserter`(**disabled**) `lh-schedule` |

> ⚠ `preset.yml` 的描述还写着"当前挂载 **7** 个 LH 插件"，而实际是 8 行（10-09 加了 `lh-schedule`）。
> 这是陈旧描述，迁移时以 `agent.cordis.yml` 为准。

更早的一次快照（`.lh-backup-preset-2026-10-08-232830/`，10-08 覆盖前的活的那份）只有 **5 个 LH 行**：
event-store / recorder-trace / resource-indexer / model-tier / question-bank——没有 course-tree、asserter、schedule。

### 3.2 迁移后：实际挂载矩阵

✅ = 有行且在跑；⛔ = 没有行；⏸ = 有行但 disabled；📦 = 只装了包（没有行）。

| 插件 | 旧 preset 行 | web `cordis.patch.yml` | desktop `cordis.patch.yml` | web 已装包 | desktop 已装包 |
|---|:--:|:--:|:--:|:--:|:--:|
| `lh-event-store` | ✅(死的) | ⛔ | ⛔ | 📦 | 📦 |
| `lh-recorder-trace` | ✅(死的) | ⛔ | ⛔ | ⛔ | ⛔ |
| `lh-resource-indexer` | ✅(死的) | ⛔ | ⛔ | ⛔ | ⛔ |
| `lh-model-tier` | ✅(死的) | ⛔ | ⛔ | ⛔ | ⛔ |
| `lh-question-bank` | ✅(死的) | ⛔ | ⛔ | 📦 | ⛔ |
| `lh-course-tree` | ✅(死的) | ⛔ | ✅ | 📦 | 📦 |
| `lh-asserter` | ⏸(死的) | ⛔ | ⛔ | ⛔ | ⛔ |
| `lh-schedule` | ✅(死的) | ⛔ | ✅ | 📦 | 📦 |
| `lh-theme` | ⛔ | ✅ | ⛔ | 📦 | ⛔ |
| `lh-practice` | ⛔ | ✅ | ⛔ | 📦 | ⛔ |
| `lh-course-ui` | ⛔ | ⏸ | ⛔ | 📦 | ⛔ |
| `lh-workspace-ui` | ⛔ | ✅ | ✅ | 📦 | 📦 |
| `lh-schedule-ui` | ⛔ | ✅ | ✅ | 📦 | 📦 |

**读法**：唯一"两边都活"的是 `workspace-ui` 与 `schedule-ui`；`course-tree`/`schedule` 只在 **desktop** 活；
`theme`/`practice` 只在 **web** 活；剩下的 5 个**哪儿都没有活行**。

> 不一致点（值得单独处理）：
> 1. web 的 `package.json` 装了 `course-tree` 与 `schedule`，但 web 的 patch **没有它们的 insert 行**
>    → 包在、插件不在（agent 工具在 web 会话里也没有）。
> 2. desktop 装了 `event-store` 包但没行；不过 course-tree/schedule 是**直接 import** `store.js`，
>    所以事件照写——只是 `lhEvents` 服务与 `lh/trace/observed` 没了。

### 3.3 家迁移（ADR-031）的现状

`node scripts/compare-homes.mjs`（2026-10-11 实测）：

| | 老家 `C:\Users\Administrator\.dsh` | 新家 `<仓库>/.dsh` |
|---|---|---|
| preset 行数 | 16 | 16 |
| preset 哈希 | `5bb44aaf` | `5bb44aaf` |
| `profiles/web` 已装 `@lh` | 9 | 9 |
| 各包 `index.js` 哈希 | 与源码逐包一致 | 与源码逐包一致 |
| 学习数据 | 共用 `D:\learning Harness test` | 同 |

→ **两边一致 ✅**。差别只在 profile：老家另有 `desktop`（装了 5 个：course-tree / event-store / schedule / schedule-ui / workspace-ui）
与 `dev`、`headless`（没有 LH 包）；新家只有 `web`。
（10-01 的 `.lh-backup-2026-10-01-001422/` 显示当时老家只装了 4 个、新家 7 个——那时两边是不同步的。）

---

## 4. 经验证据：谁还在往事件日志里写

`data/events.jsonl` 共 **1197** 条，按 `provenance.plugin` 分组、取最后写入时刻：

| 插件 | 条数 | 最后一条 |
|---|---:|---|
| `@lh/schedule` | 158 | **2026-10-11**（今天） |
| `@lh/course-tree` | 19 | 2026-10-08 |
| `@lh/recorder-trace` | 981 | **2026-09-22** |
| `@lh/question-bank` | 26 | **2026-09-22** |
| `@lh/asserter` | 8 | 2026-09-21 |
| `@lh/resource-indexer` | 5 | 2026-09-21 |

**这是本文最硬的一条证据**：题库、记录器、索引器、断言器的最后活动都在 **9 月 21–22 日**——
正好是旧 preset 失效之前。它们不是"最近没用"，是**已经挂不上了**。
（`model-tier` 不写事件，无法用日志判断；但 `lh:model-tiers` 上下文已不在，结论一致。）

---

## 5. pending 关系

### 5.1 pending 是什么（宿主源码口径）

- Cordis 的 fiber 状态：`pending` / `loading` / `active` / `failed` / `unloading` / `null`
  （`@deepseek-ai/dsh-host-plugin-inventory/lib/index.js` 的 `FIBER_STATE`）。
- GUI 文案把它写成 **「等待依赖」**（`dsh-client-ui-plugin-manager`：
  `rowPhasePending: "等待依赖"` / `"Waiting for dependencies"`）。
- 触发条件就是本仓库 `scripts/check-preset-mount.mjs` 一直在盯的那件事：
  **`inject` 声明了，但同一层没有提供者** → apply 永不执行、能力静默消失。

### 5.2 两层各提供什么（白名单口径）

| 服务 | agent/preset 层 | host/profile 层 |
|---|:--:|:--:|
| `tools` `sessions` `llm` `systemPrompt` `sessionProjections` `subagents` | ✅ | ✅ |
| `webServer` | ⛔ **够不着** | ✅ |
| `jobs` `skills` `commands` `approval` `fs` `shell` `invariants` `storage` `settings` `workspaces` | 未逐一实测 | ✅ |

依据：`ARCHITECTURE §0.1 约束 5`、`check-profile-apply.mjs` 的 `HOST_SERVICES` 白名单、
`PLUGIN_CONTRACT` 的 `webServer` 行（"profile 层才能用"）。

### 5.3 目前挂着的行：**没有 pending**

| 行 | inject | 提供者 | 结论 |
|---|---|---|---|
| `lh-course-tree` | `tools` | host | active |
| `lh-schedule` | `tools` | host | active |
| `lh-workspace-ui` | `webServer` | host | active |
| `lh-schedule-ui` | `webServer` | host | active |
| `lh-theme` | — | — | active |
| `lh-practice` | `webServer` | host | active |
| `lh-course-ui` | `webServer` | host | 有意 disabled |

**一条顺带被证实的事**：course-tree/schedule 的 `systemPrompt` 上下文（`lh:course`/`lh:agenda`）
**在 host 层真的注册上了**——本会话运行时上下文里就有 `lh:agenda`。
所以源码注释里那句"host 层还提供不提供 `systemPrompt` 我没有实测过"现在有答案了：**提供**。

### 5.4 真正的 pending 风险：把 preset-only 插件硬搬去 host 层

如果为了"先恢复功能"把这些插件直接加成 host 行，要逐条看 inject：

| 插件 | inject | 风险 |
|---|---|---|
| `lh-question-bank` | `tools`, `systemPrompt`, `subagents` | `systemPrompt`/`subagents` 是**硬依赖**：任一层拿不到 → 整行 pending → **10 个工具一起消失**（`lh:practice-routing` 也没了） |
| `lh-model-tier` | `llm`, `systemPrompt` | 硬依赖 `systemPrompt`；pending 后 `lh:model-tiers` 消失 |
| `lh-asserter` | `llm`, `sessions` | 本就在 preset 里 disabled；搬过去前先想清"绑课即花 token" |
| `lh-event-store` | `sessions`（+ 动态 `sessionProjections`） | 动态那步在 host 层是提供者（`check-profile-apply` 默认它可选） |
| `lh-recorder-trace` | `sessions` | 低 |
| `lh-resource-indexer` | `tools` | 低 |
| `lh-course-tree` / `lh-schedule` | 只剩 `tools` | **正面例子**：2026-10-08 已把 `systemPrompt` 从硬依赖改成 `ctx.inject` 可选（拿不到只是不注入，插件仍在） |

> 结论：**"硬 inject"决定 pending，而 LH 里三个插件还带着硬 `systemPrompt`**
> （question-bank / model-tier；course-tree 与 schedule 已改）。搬层之前先把这三个的 inject 改软。

### 5.5 未决：`inject:['subagents']` 与 HMR 的对照实验

`.dsh/profiles/web/cordis.patch.yml` 里 `hmr` 被**临时**改成 `disabled: true`，注释写明：
之前"选 LH 弹回创造模式"疑为 HMR 半重载所致，关掉它 + 完全重启做对照——
若 preset 能挂载则证明是 HMR 的锅、`inject` 无罪。**这个实验还没有结论**，所以它是当前唯一的
"待判 pending"：`lh-question-bank` 的 `subagents` 到底有没有罪。

---

## 6. 建议（每条带后果）

**A. 走正路：做一个 LH bundle，声明 `preset-lh`（推荐）**
把 `agent.cordis.yml` 的 16 行原样搬成 declaration row 的 `plugins`，
`id/name/description/order` 取自 `preset.yml`（`id=lh`），用 `plugin_manager install_bundle` 装。
- 收益：一次恢复 5 个 preset-only 插件（题库、索引器、记录器、档位、断言器）；
  这也是宿主文档 `cordis-composition-reference` 明确写的那条路（"Migrate a legacy preset"）。
- 代价/前置：安装要 full access 或审批；文档警告
  "**packages renamed since the preset was written fail at activation**"——装前拿
  `cordis-composition-reference` 逐条核包名；`lh-asserter` 保持 disabled；
  旧 preset 目录在验证通过后再删（现在删也没有损失，因为它已经不生效）。

**B. 只补 host 行（缓解，不推荐长期）**
给缺的插件补 `cordis.patch.yml` 的 `insert` + `package.json` 依赖（两个 profile 都要）。
- 收益：不用 bundle、马上能用。
- 代价：**scope 变了**——这些本该只属于 LH 会话的贡献会变成所有会话可见；
  且必须先按 §5.4 把硬 `systemPrompt` 改软，否则会 pending 而非报错。

**C. 先测 pending，别先改**
在 GUI「设置 → 插件」看每行的 fiber 相位（`pending` = 等待依赖），与 §3.2 矩阵对照。
这一步零成本，能把"我以为是 X"变成"看到是 X"。上面 §3.2/§4 的结论都来自静态与日志；
`plugin_manager list_plugins` 给的是活值。

---

## 附：一句话记住

> **旧 preset 目录已经没人读了；现在活的是 host 行。**
> desktop 上活 4 个（course-tree / schedule / workspace-ui / schedule-ui），
> 另外 5 个插件从 2026-09-22 起就没再工作过。
> pending = `inject` 的提供者不在同一层，症状是"能力静默消失"，不是报错。
