# lh-plugin-development（草案）

> **这是草案，不是已挂载的技能。** 命名与结构先按宿主的技能约定摆好，
> 等 LH 挂上 `skill-filesystem` + `tool-skill` 之后（见 `docs/decisions/030` 的第二批），
> 这份目录可以整体搬成一份可发现、可加载的 skill。
>
> **为什么先写它**：作者 2026-09-20 定的方向是——
> `lh-plugin-development` 本质上是 **cordis/dsh × LH** 的三层叠加：
>
> | 层 | 内容 | 现在的载体 |
> |---|---|---|
> | ① 通用插件开发 | Cordis 的注册 schema、生命周期、可逆副作用 | `docs/PLUGIN_CONTRACT.md`、宿主自带的 `cordis-plugin-development` 技能 |
> | ② 宿主（dsh）兼容 | 加载层差异、路径解析、包解析、启动顺序、schema 校验 | **`references/host-compat.md`（本次归拢的产物）** |
> | ③ LH 自己的编排与表达 | vibecoding 套壳简化（对非开发者可控可用）、学习插件开发技能、把学习流程落成插件 | 本目录 + `docs/decisions/024`（部署与开发类插件） |
>
> **产品立场**（作者）：**在 LH 里开发，而不是在 dsh 里开发**。
> 对非专业开发者，LH 要把 dsh 的开发表达方式**隐藏**起来，
> 让他专注"把自己的学习习惯/方法/流程落地为插件"。

## 这个技能要解决的问题

一个非专业开发者（就是 LH 的用户）说："我想让 LH 在我做题前先问我上次卡在哪。"
他需要的不是"读 `cordis.yml` 的 isolate 规则"，而是**把这句话落成插件**。
中间的落差就是本技能要填的：

1. **把意图翻译成 LH 的既有部件**（事件 / 资源 / 工具 / 上下文 / 插槽），而不是让他发明结构；
2. **把"开发"这件事的词汇换掉**（不是"写个 plugin 行"，而是"让 LH 多一个动作"）；
3. **让他可验证**：每一步都有"能不能用"的可观察结果（借用 `PLUGIN_CONTRACT §八` 的闸门）；
4. **不让他踩我们已经踩过的坑**（`references/host-compat.md` 里那张排查表）。

## 阅读顺序（给将来加载这份技能的 agent）

1. 先读 `docs/PLUGIN_CONTRACT.md` 的**第一节到第二节**（写在哪个层、怎么注册）——
   那是唯一权威依据，本技能不重复它；
2. 动笔前过一遍 `PLUGIN_CONTRACT §六` 的**五问**，并把答案写进 `package.json` 的 `lh` 字段；
3. 遇到"不像坏了但其实坏了"的症状，查 `references/host-compat.md` 的排查表；
4. 交付前跑 `node scripts/check-all.mjs`，并按 `PLUGIN_CONTRACT §七` 的清单自查。

## 与 `docs/PLUGIN_CONTRACT.md` 的分工（别重复写两遍）

| | 回答什么 | 形态 |
|---|---|---|
| `docs/PLUGIN_CONTRACT.md` | **写插件时的唯一权威依据**（规则 + 来源标记 + 闸门） | 一份长文档，随实测更新 |
| 本目录（将来的 skill） | **教一个非专业开发者把他的学习流程落成插件**：怎么问、怎么拆、怎么验、坑在哪 | 技能目录（`SKILL.md` + `references/`） |

**同一条规则只写一处**。本目录引用契约，不抄契约。
