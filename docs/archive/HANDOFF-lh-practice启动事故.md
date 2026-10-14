# 交接：lh-practice 启动失败事故（2026-09-17 晚）

> 这份文件是为"对话可能中断"准备的。**如果上下文丢失，从这份开始读。**
> 写完这份时我的 shell 不可用（所有子进程返回 `0xC0000142`），所以**下面标 ⬜ 的步骤全部未执行**。

## 一、当前状态

| 项 | 状态 |
|---|---|
| dsh 能否启动 | **能**（`lh-practice` 行已被 `disabled: true` 挡住） |
| 我的 shell / 子进程 | **不可用**：`0xC0000142`（DLL 初始化失败）。文件读写工具正常 |
| 原因推测 | 有另一个 dsh 实例（从 Kimi Code 终端启动）占着资源；用户已关 Kimi Code 但进程未退出 |
| 代码修好了吗 | **改好了但未验证**（见第三节） |
| 测试套件 | **未跑**（shell 不可用） |

## 二、事故根因（已确证，是我的架构错误）

`plugins/lh-practice/index.js` 原来有：

```js
import { … } from '../lh-question-bank/index.js'
import { LhEventStore, eventLogPath } from '../lh-event-store/store.js'
```

**相对路径导入只在源码目录成立。** pnpm 把包装进
`profiles/web/node_modules/@lh/practice` 后，兄弟目录不再相对可达，
Node 按 ESM 规则把 `../lh-question-bank/index.js` 解析成 `@lh/lh-question-bank`，
抛 `ERR_MODULE_NOT_FOUND`。

**为什么代价是"dsh 完全起不来"**：插件的导入失败会让**整棵插件树加载失败**，
而这是 profile 层（host 树），不是 agent preset 层。

**为什么其他插件没这个毛病**：`lh-question-bank` / `lh-event-store` /
`lh-recorder-trace` / `lh-resource-indexer` / `lh-model-tier` **全部由 agent preset
按绝对路径加载**，从不经过 `node_modules`。
`lh-practice` 是**第一个通过 profile 包机制加载、又需要跨插件引用**的插件。
—— 这个差异我当时没有对齐，离线 18 项断言全绿是因为它们跑在源码目录里。

## 三、已改好的修法（⬜ 未验证）

思路：不是"让相对路径生效"，而是**让它成为真正可解析的依赖**。

| 文件 | 改动 |
|---|---|
| `plugins/lh-question-bank/package.json` | **新建**（原来根本没有）。包名 `@lh/question-bank`，导出 `.` `./question` `./attempt` `./bank` `./practice` `./package.json` |
| `plugins/lh-event-store/package.json` | 包名 `lh-event-store` → `@lh/event-store`（对齐 `@lh/model-tier`、`@lh/theme` 的约定），加 `./package.json` 导出 |
| `plugins/lh-practice/package.json` | 加 `dependencies`：`"@lh/event-store": "file:../lh-event-store"`、`"@lh/question-bank": "file:../lh-question-bank"` |
| `plugins/lh-practice/index.js` | 两处导入改为包名：`from '@lh/question-bank'`、`from '@lh/event-store/store'` |

**注意**：`@lh/event-store` 会因此**有两份实例**（preset 按绝对路径加载一份、
profile 按包名加载一份）。已评估：**不是问题** —— `LhEventStore` 是围绕
append-only 文件的**无状态薄封装**（append 时构造信封并追加一行，读时每次重读文件），
不持有内存状态，两份不会漂移。

## 四、⬜ 待执行的步骤（shell 恢复后按序做）

```powershell
# ── 0) 先看清端口占用（**不要直接杀**，先确认哪个是服务本 GUI 的）──
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 3080,3081 } |
  Select-Object LocalAddress, LocalPort, OwningProcess,
    @{n='Proc';e={ (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName }},
    @{n='StartTime';e={ (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).StartTime }} |
  Format-Table -AutoSize

# ── 1) 确认后在干净终端里杀掉占用者 ──
#   ⚠ 如果那个 PID 就是服务当前 GUI 的 dsh，杀了这个对话会断。
Stop-Process -Id <PID> -Force

# ── 2) 重新装依赖（让 @lh/question-bank 与 @lh/event-store 进入 profile 的 node_modules）──
pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" add `
  "file:D:/LearningHarnessv0.1/plugins/lh-question-bank" `
  "file:D:/LearningHarnessv0.1/plugins/lh-event-store"

# ── 3) ★ 关键：用 profile 的解析上下文验依赖真的可解析 ──
#   这一步才是"本应拦住这次事故"的检查（原先缺的就是它）。
node --input-type=module -e "
await import('file:///C:/Users/Administrator/.dsh/profiles/web/node_modules/@lh/practice/index.js');
console.log('lh-practice 服务端半可从 profile 解析 —— OK');
"

# ── 4) 恢复那一行：删掉 profiles/web/cordis.patch.yml 里 lh-practice 的 disabled: true ──

# ── 5) 跑完整测试套件，确认没有别的东西被动过 ──
node plugins/lh-question-bank/selftest.mjs          # 期望 56 通过
node plugins/lh-question-bank/selftest-plugin.mjs   # 期望 71 通过
node plugins/lh-question-bank/verify-real-bank.mjs "D:\learning Harness test\lh-questions\考公刷题-片段阅读与逻辑判断.json"  # 期望 16 通过
node plugins/lh-practice/selftest-routes.mjs        # 期望 18 通过（注意：它 import './index.js'，现在会走包名解析，可能需要在源码目录能解析到）
node scripts/check-preset-mount.mjs
```

**⚠ 第 5 步里 `selftest-routes.mjs` 有个已知问题**：
它 `import('./index.js')`，而现在 `index.js` 用**包名**导入
`@lh/question-bank` —— 在**源码目录**里跑会解析不到（那里没有 node_modules 提供这两个名字）。
修法二选一：
· 在工作区根 `D:\LearningHarnessv0.1\` 的 `package.json` 里也加上这两个 `file:` 依赖；
· 或把自测改成从 profile 的已安装副本上跑。

**推荐第一种**：工作区根本来就该能解析自己的包。

## 五、⬜ 建议补的检查（这次的真正教训）

写一个 `scripts/check-plugin-imports.mjs`：对**每个装进 profile 的 LH 包**，
用 **profile 的解析上下文** `import()` 一次它的服务端半，失败就报。

**为什么必须有**：这次"离线全绿、真实一用就炸"的根因是
**测试跑在源码目录、生产跑在 install 后的副本里**，两者的**模块解析路径不同**。
只要这两条路径还会分叉，就需要一道"按生产路径验一遍"的闸。

## 六、环境层面的提醒

用户反馈：`.dsh` 与工作区**被 Kimi Code 动过手脚，具体做了什么不清楚**。
我核对过的：

- ✅ `agent.cordis.yml`（preset）完好，5 行，未被改动
- ✅ `plugins/lh-practice/index.js`、`client.js` 完好（未被格式化或改引号）
- ⚠ `profiles/web/cordis.patch.yml` 里 lh-practice 的 `disabled: true` **是对方加的**
  （注释写得很准，处置正确）

**仍需核对**：`plugins/lh-theme/client.js`（手写 bundle，最易被"修正"）、
`data/model-tiers.json`、`docs/` 下是否有别处被改。
最省事的办法就是跑第五节的完整测试套件。

## 七、本轮之前已完成、未受事故影响的东西

- 题库 **49 题**（片段阅读 20 + 逻辑判断 29），装在
  `D:\learning Harness test\lh-questions\考公刷题-片段阅读与逻辑判断.json`
  —— **原 20 题的 id 20/20 保持不变**，历史作答记录仍对得上
- 49 题 LLM 预处理：一致率 42/49（86%），平均 2,316 token/题
- `docs/decisions/020`、`021` 已冻结
- `plugins/lh-practice/client.js`：侧栏"刷题"按钮 + `shell.overlay` 浮层面板（**未在浏览器验证**）
