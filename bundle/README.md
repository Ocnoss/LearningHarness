# LH bundle —— 「LH 学习模式」的正路挂载点

这个目录是一个 **dsh bundle**：`package.json` 声明 `dsh.bundle.patch`，
`cordis.patch.yml` 里只有一条 `insert`——插一个 `preset-lh` 声明
（`@deepseek-ai/dsh-agent-preset`）。

## 它解决什么

本版 dsh（desktop-runtime 0.2.0-rc.2）里，旧式 preset 目录
`$DSH_HOME/.agent-presets/<id>/` **已经没有任何代码读它**。
宿主文档 `cordis-composition-reference` 的 "Migrate a legacy preset" 一节原话：

> Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/` ...
> **Nothing reads that directory any more.**

于是 `.agent-presets/lh/agent.cordis.yml` 里那 8 个 LH 插件（题库、索引器、记录器、
档位、断言器）在 app 里**一个都没挂上**——最后一条事件停在 2026-09-22。
这个 bundle 把那份声明搬到 declaration row。

## 装（一步）

**入口在左侧栏，不在「设置」里。**

1. 左侧栏点 **插件**（风车图标；面板 order 0，在侧栏图标列靠前）。
   页头写「插件 / 安装、启用和配置插件」。
   （「设置 → 内置插件」是**只读**清单，不是安装入口。）
2. 页面里的 **「添加插件」** 区，输入框标签「包名或地址」，
   提示语是"输入插件的包名、GitHub 仓库地址或本地目录路径"。
3. **必须装压缩包，不要装目录。**
   GUI 对"本地目录"用的是 pnpm 的 `link:`（软链），而**软链包的依赖不会被安装**——
   于是 `cordis.patch.yml` 里那 6 个 `@lh/*` 一个都进不了 profile，
   `preset-lh` 声明激活失败，选择器里就没有「LH 学习模式」。
   （2026-10-13 实测：pnpm.log 写的是 `+ @lh/bundle link:D:/...`，`node_modules/@lh` 里少了 5 个包。）

   先打包：

   ```
   pnpm pack --pack-destination D:\LearningHarnessv0.1
   ```

   再在「插件」页：

   - 已安装里若有旧的 `@lh/bundle`，先**卸载**；
   - 「添加插件」填 `D:\LearningHarnessv0.1\lh-bundle-0.1.0.tgz`，点「安装」。

   压缩包按普通包解析依赖，6 个 `@lh/*` 才会被装进 profile。
   **不要**手动改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录里跑 pnpm。

装完**重启应用**（新 bundle 可能需要一次重启才进 preset 花名册），然后在
**新建会话**里选「LH 学习模式」。

## 验证

新会话里应能看到：

- 20 个 LH 工具：题库 10（`import_questions` … `start_practice`）+ 课程 5 + 日程 4 + 索引 1；
- 上下文 `lh:course` `lh:agenda` `lh:model-tiers` `lh:practice-routing`；
- `list_question_banks` 能看到工作区里的 2 个题库（共 88 题）。

## 回滚

应用起不来时：删掉 `C:/Users/Administrator/.dsh/profiles/desktop/package.json` 的
`dsh.profile.bundles` 里的 `@lh/bundle` 一行（或整个删掉该依赖），重启。
配置文件改动前的原样在仓库的 `.lh-backup-lhbundle-2026-10-13/`。

## 刻意没做的事

- **course-tree 与 schedule 不在 preset 里**：它们当前挂在 profile 的 host 行上
  （所有会话可用）。同一个插件不能同时挂 host 与 preset（`tools.register` 撞名）。
  想收进 LH 模式：删掉 profile patch 里的 `lh-course-tree`/`lh-schedule` 两行，
  再把 `cordis.patch.yml` 里那两条注释打开。
- 界面插件（theme / practice / course-ui / workspace-ui / schedule-ui）留在 profile patch：
  它们 inject `webServer`，**preset 面够不着**，不能进 preset。
