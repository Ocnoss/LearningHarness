# LearningHarness（LH）

dsh（`@deepseek-ai/dsh`）上的学习辅助系统：题库管理、刷题、作答事件日志、学习日程、
课程目录，以及一层"模型作答/断言"能力。13 个插件（`plugins/@lh/*`）+ 安装/同步脚本（`scripts/`）。

## 别人 clone 之后怎么对接 dsh

仓库**不带**机器本地状态（安装配置、副本、运行数据都不入库，见 `.gitignore` 的取舍说明）。
对接一次、之后 `git pull` 即可：

```bash
git clone <本仓库>
cd LearningHarness

# 1. 依赖（workspace 软链 + 公网依赖，一条命令）
pnpm install

# 2. 安装配置：模板复制成真文件（真文件不入库，是机器本地配置）
cp lh-install.json.example lh-install.json
#    把 workspace 改成你的学习资料工作区（内含 lh-questions/ 的目录）；
#    repo_root 写 "." 即可，跟着仓库走，任何机器不用改。

# 3. 把插件同步进 dsh 的 profile，并按**当前机器**对齐配置里的路径
node scripts/sync-lh-deps.mjs

# 4. 重启 dsh（插件在启动时装载；不重启看到的永远是旧代码）
```

装完在 dsh 里选 **「LH 学习模式」** preset；面板（题库管理/刷题/日程/课程）在侧栏与中央区。

### 两条接入路线

| 路线 | 适用 | 入口 |
|---|---|---|
| **dsh bundle**（面向使用者） | 把 LH 作为 bundle 装进你自己下载的 dsh | `cd bundle && pnpm install && pnpm pack`，再在 dsh 的 plugin_manager `install_bundle`（target = 生成的 tgz 或本目录），见 `bundle/README.md` |
| **仓库自持家**（面向开发） | 用 `<仓库>/.dsh` 当 DSH_HOME 完整开发 | `node scripts/lh-dev.mjs`，见 `docs/WORKFLOW.md` |

### 验证

```bash
node scripts/check-all.mjs    # 13 道闸门 + 全部自测
```

`check-restart.mjs` 红是**应然**的（提醒你重启 dsh），其余应全绿。

## 仓库纪律（一句话版）

- **只把"人写的东西"放进版本控制**（ADR-023）：派生物、依赖、机器本地配置、学习数据都不入库。
- 插件里**不许写死绝对路径**（`docs/PLUGIN_CONTRACT.md` §10，`check-hardcoded-paths.mjs` 守着）；
  数据目录/工作区从 `lh-install.json` 或环境变量（`LH_DATA_DIR` / `LH_WORKSPACE`）取。
- 事件日志是唯一事实源，可派生的不进日志（`docs/ARCHITECTURE.md`）。

文档：`docs/ARCHITECTURE.md`（架构）· `docs/WORKFLOW.md`（协作与提交纪律）· `LH内核契约-v0.1.md`（内核契约）。
