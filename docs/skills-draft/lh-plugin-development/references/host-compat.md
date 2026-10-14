# 宿主兼容性排查表（cordis / dsh × LH）

> **这是给"已经出问题了"的时候查的**，不是写代码前读的设计文档。
> 每条都标了来源：`[实测]` 带报错原文或实测现象，`[宿主源码]` 带包名与文件。
> **没验证的写"未验证"**——一张把猜测当结论的排查表比没有更危险，因为它会让人停止怀疑。
>
> 规则本身在 `docs/PLUGIN_CONTRACT.md`；本表只负责**从症状找到那一条**。

## 怎么用

1. 先在"症状表"里找到最像的那一行；
2. 按"先查"那一格做**唯一一件**事（不要同时改两处）；
3. 修完回到 `PLUGIN_CONTRACT §七` 的清单自查，并跑 `node scripts/check-all.mjs`。

---

## 一、症状表（按"你会看到什么"索引）

| 你看到的 | 最可能在哪一层 | 先查（只做这一件） | 根因 |
|---|---|---|---|
| dsh **完全起不来**，界面显示加载失败 | profile 插件 | `node scripts/check-profile-apply.mjs` | `apply()` 抛错；或导入链断了（相对路径 / 文件不在 `files` 里） |
| **只有某个 preset 的会话建不起来**，别的正常 | preset 行 | `node scripts/check-preset-mount.mjs` | 该行未激活：等一个没人给的服务 / 包名写错 / 组与 realm 关系错 / 组合文件被改坏到解析出 0 行 |
| 浏览器**卡在启动屏**，console 报 `Failed to load plugins` | 客户端 bundle | `node scripts/check-client-inject.mjs` | `exports.inject` 没导出；或访问了未声明的 `ctx.<服务>` |
| 浏览器启动报 `list slot "…" requires options.id` | 客户端 bundle | `PLUGIN_CONTRACT §2.3` | list 型插槽注册漏 `options.id` |
| 浏览器报 `slot "X" is not declared` | 客户端 bundle | `node scripts/check-client-slot-timing.mjs` | **抢跑**：直接 `register` 了一个由别的包在它 `apply` 时才声明的插槽 |
| **什么都没报，但某个入口不出现** | 客户端 bundle | 看 console 有没有 `console.warn` | keyed 插槽的 key 写错（宿主"只是不渲染"）；或有 `try/catch` 把注册失败吞了 |
| 改了源码**没生效**，像没改一样 | profile 副本 | `node scripts/check-installed-copies.mjs` | pnpm 对 `file:` 是**拷贝快照**；必须跑 `sync-lh-deps.mjs`（`pnpm install` 会说"已是最新"并跳过） |
| 离线测试全绿，生产却坏 | 测试路径 | 把测试改成**跑生产那份副本** | 测试跑在源码目录，生产跑在安装后的副本里——两条路径不同构 |
| `Cannot find module '@lh/xxx'` | profile 副本 | `PLUGIN_CONTRACT §三` | 跨插件用了相对路径（`../lh-xxx/index.js`），而副本里目录名由包名派生 |
| 改了环境变量但代码读的还是旧值 | 插件代码 | 搜 `process.env` 是否在模块顶层 | 环境变量被写成模块级常量，import 时固化了 |
| 数据/工作区**指到了别人的目录**（题库是空的、进度是 0） | 路径解析 | `node scripts/check-paths-resolution.mjs` | 写死了盘符；或从"模块位置往上找仓库根"（装进 profile 后那条路必断） |
| 写出来的 JSON 读不回来 | 写文件 | 看有没有 `.tmp` + rename | 直接写会留半截；读侧必须容忍 BOM |
| Python 脚本报 `SyntaxError: invalid character '，'` | Python 源文件 | 文件头有没有 `# -*- coding: utf-8 -*-` | 本机 `miniconda\python.exe` 的 `locale.getpreferredencoding()` 是 **cp936**，它**用 GBK 解码源文件** |
| `python scripts/xxx-yyy.py` 报奇怪的语法错 | 命令行 | 给文件名**加引号** | 文件名里的连字符被 Python 当成减号（`xxx - yyy.py`） |
| 工具调用"成功"但字段没生效 | 工具返回值 | 看返回值里有没有 `ignored` | 静默忽略字段名，调用方会一直重复同一个错写法 |
| 输出被拒绝：`must be a string` 之类 | 工具输出 schema | `PLUGIN_CONTRACT §一.2` | 可能为 `null` 的字段要写 `oneOf: [{type:'string'},{type:'null'}]` |
| 工具注册直接失败 | 工具 schema | `node scripts/check-preset-mount.mjs` | 用了封闭子集之外的关键字（`format` / `pattern` / `minimum` 都会拒） |

---

## 二、四个加载层的对照（**最容易搞错的一件事**）

同一个写法在四个位置结果不同。**改之前先问"我这个文件装到哪一层"**：

| 位置 | 谁解析 `name` | 能否用相对路径 | 改完怎么生效 | 失败后果 |
|---|---|---|---|---|
| **host**（`base.cordis.yml`） | 宿主 | ❌ | 重启 | dsh 起不来 |
| **preset**（`.agent-presets/<id>/agent.cordis.yml`） | 宿主加载器 | ❌（要绝对路径或裸包名） | 重启 | **该 preset 所有会话建不起来** |
| **profile**（`profiles/<名>/cordis.patch.yml`） | 宿主 + pnpm 装包 | ❌ | 重启 | dsh 起不来 |
| **工作区源码**（`plugins/lh-x/`） | Node（`node_modules` 解析） | ✅ 但**只在源码目录成立** | 立即（软链） | 离线测试绿、生产炸 |

**两个必须分开记的形态**（`[实测]`）：

| 路径 | 形态 | 改源码后 |
|---|---|---|
| 仓库根 `node_modules/@lh/x` | workspace **软链** → `plugins/lh-x` | 立即生效 |
| profile `node_modules/@lh/x` | **真实目录，拷贝** | **不动，必须同步** |

---

## 三、宿主包与路径解析（写组合文件时查）

| 事实 | 值 / 位置 | 来源 |
|---|---|---|
| 组合文件里的裸包名由谁解析 | **宿主**加载器 | `[宿主源码]` standard preset 注释 |
| 宿主包实际住在哪 | `…/npm/node_modules/@deepseek-ai/dsh/node_modules/<包名>` | `[实测]` |
| preset 里的绝对路径 | **可用**（宿主会转成 `file:` URL） | `[宿主源码]` `dsh-agent-presets/lib/index.js:496` |
| profile 的 `cordis.patch.yml` 里的绝对路径 | **不可用**（那条路径上 `boot()` 不传 `bareModuleBaseUrl`） | `[宿主源码]` 同上，注释里写明 |
| 技能（skill）可用根 | `<项目根>/.dsh/skills`(100) / `<dshHome>/skills`(400) / `~/.agents/skills`(500) / `customSkillDirs`(300) | `[宿主源码]` `dsh-skill-filesystem` README |
| 技能包形状 | 目录 + `SKILL.md`（可带 `references/`、`scripts/`、`assets/`）；也支持扁平 `.md` | `[宿主源码]` 同上 |

**项目根怎么定**：最近的含 `.git` 的祖先目录；没有则用当前 cwd（`[宿主源码]`）。

---

## 四、写文件与编码（踩过三次的那一类）

| 规矩 | 为什么 | 代价（实测） |
|---|---|---|
| **改文本文件只用 `edit` 工具或编辑器，绝不用 shell** | `Set-Content` 会写 BOM、甚至把多字节字符写成 `U+FFFD` | 有一次把文件改到**连读都读不出来**，只能删掉重写；另一次写进了 BOM |
| 写文件用**原子替换**（`.tmp` + rename） | 中断会留下半截 JSON，下次读取解析失败 → 数据看起来"消失" | 题库读不回来 |
| 读文件**容忍 BOM** | 别的工具（PowerShell 的 `>` 是 UTF-16LE、`Set-Content` 是 UTF-8 BOM）会加 | 所有 ASCII 正则失配，表现得像"日志损坏" |
| 破坏性操作**只做白名单** | "删掉所有不匹配的"这种判据在猜 | 清掉过作者的两条真实数据 |
| PowerShell 的 `>` | 默认写 **UTF-16LE** | 日志读出来全是 `\u0000` 夹的字符 |
| Python 源文件带中文 | 加 `# -*- coding: utf-8 -*-` | 本机 cp936 环境下直接 `SyntaxError` |

---

## 五、"静默失败"的四种常见形状（**没有报错，但结果是错的**）

这一节单列，因为它们是**最贵的一类**：不会有人告诉你出了问题。

| 形状 | 例子 | 怎么发现 |
|---|---|---|
| **字段被丢掉** | `normalizeQuestion` 只搬它认识的字段，塞进 raw 的其它字段全丢 | 写完读回来核一遍（别信"我写进去了"） |
| **过滤/匹配悄悄不命中** | 用 `set1-q1` 这种资料内编号做键，两份资料都有它 | 用**稳定标识**（id / 文件名）；逐条看 3 条明细 |
| **声明与实现不一致** | `lh.provides.tools` 写多了/写少了 | `check-plugin-contract.mjs` 真跑 apply 对照 |
| **规则写在了读不到的地方** | "该用哪个工具"写在某个工具的描述里 → 被忽略两轮 | 放进**每次组装都会出现**的位置（运行时上下文） |

**共同纪律**：凡是"批量写入 / 批量匹配 / 声明式配置"，交付前
**逐条读 3 条明细**，并且**故意挑一条"看起来不该是这样"的**。

---

## 六、还没验证的（不要当结论用）

- 带 `isolate` 的组在**我们自己的** preset 里挂载的真实行为（规则是从 standard preset 注释读的，未实测）。
- 技能根与 `customSkillDirs` 在 LH preset 下的实际发现行为（我们还没挂 `skill-filesystem`）。
- 宿主对 `tools.register` 的 `output.schema` 究竟校验什么、何时校验。
- 动态 Cordis 插件（`cordis_*` 工具那一套）在 LH preset 下是否可用——
  它在创造模式里是宿主面提供的，LH preset 目前没挂。
