# 文档瘦身整治实施计划（2026-09-22）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 docs/ 精简为三份重写后的活文档 + archive/ 归档，并把防通胀条款写进 WORKFLOW.md。

**Architecture:** 机械归档先执行（可回滚）；再用子代理通读归档内容提取仍然成立的结论作为重写素材；三份活文档逐份重写，每份由父代理审一遍、作者过目后才算完成。

**Tech Stack:** 纯 Markdown 文档操作；bash（Git Bash）；子代理（explore 做素材提取，coder 起草重写稿）。

**规格来源：** `docs/superpowers/specs/2026-09-22-docs-debloat-design.md`

## Global Constraints

- 不删除任何现有文档，只移动到 `docs/archive/`。
- 活文档每份目标 ≤100 行（现状 225 / 249 / 229）。
- 重写验收标准（规格 §2）：无本项目上下文的 agent 读完能直接干活，且作者能读懂。
- ADR 触发条件（写进新 WORKFLOW.md）：只有「推翻/修订一条已冻结决策」或「改变活文档里已写下的承诺」才写 ADR。
- 新建文档需自证：先回答「这份信息为什么不能并进现有文档」。
- git commit 只在用户明确要求时执行；默认只做工作区改动。
- `skills-draft/` 一律不动。

---

### Task 1: 归档移动

**Files:**
- Move: `docs/decisions/` → `docs/archive/decisions/`
- Move: `docs/experience/` → `docs/archive/experience/`
- Move: `docs/PLUGIN_CONTRACT.md` → `docs/archive/PLUGIN_CONTRACT.md`
- Move: `docs/HANDOFF-lh-practice启动事故.md` → `docs/archive/HANDOFF-lh-practice启动事故.md`

**Interfaces:**
- Consumes: 无（第一步）。
- Produces: `docs/` 根目录只剩 ARCHITECTURE.md、WORKFLOW.md、COLLABORATOR_MODEL.md、archive/、skills-draft/、superpowers/。

- [ ] **Step 1: 确认 git 状态干净**

Run: `cd D:/LearningHarnessv0.1 && git status --short`
Expected: 无未提交改动，或用户已知并接受当前改动。

- [ ] **Step 2: 执行移动**

Run:
```bash
cd D:/LearningHarnessv0.1/docs
mkdir -p archive
git mv decisions archive/decisions
git mv experience archive/experience
git mv PLUGIN_CONTRACT.md archive/PLUGIN_CONTRACT.md
git mv HANDOFF-lh-practice启动事故.md archive/HANDOFF-lh-practice启动事故.md
```
Expected: 4 条命令全部成功；`ls docs/` 只剩 ARCHITECTURE.md、WORKFLOW.md、COLLABORATOR_MODEL.md、archive、skills-draft、superpowers。

- [ ] **Step 3: 查残留引用**

Run: `grep -rn "docs/decisions\|docs/experience\|PLUGIN_CONTRACT\|HANDOFF-lh-practice" D:/LearningHarnessv0.1/docs --include="*.md" -l | grep -v archive/ | grep -v superpowers/`
Expected: 只列出三份活文档（它们将在 Task 3-5 中被重写修正）。把残留位置记下来，交给对应重写任务处理。

### Task 2: 提取「仍然成立的结论」素材

**Files:**
- Create: `docs/superpowers/plans/rewrite-source-digest.md`（工作素材，整治完成后删除）

**Interfaces:**
- Consumes: `docs/archive/decisions/`（34 条 ADR）、`docs/archive/experience/`（14 篇）、现 ARCHITECTURE.md、现 COLLABORATOR_MODEL.md。
- Produces: 一份按主题分组的结论清单，供 Task 3-5 的起草代理使用。每组结论标注出处（ADR 编号 / 经验文件名）。

- [ ] **Step 1: 派 explore 子代理通读归档并输出素材**

用 `Agent(subagent_type="explore")`，prompt 要点：
- 通读 `D:/LearningHarnessv0.1/docs/archive/decisions/*.md` 全部 34 条与 `archive/experience/**/*.md` 全部 14 篇。
- 输出按主题分组的「仍然成立、且属于项目级（非插件实现细节）的结论」清单：内核边界、事件系统、宿主关系、协作规则、开发纪律。
- 标注每条结论的出处与状态（冻结/被后续推翻/已被代码改变）。
- 明确指出哪些 ADR 之间相互矛盾、哪些已被后续 ADR 推翻。
- 把完整输出写入 `docs/superpowers/plans/rewrite-source-digest.md`。

Expected: 素材文件存在，含出处标注与矛盾清单。

### Task 3: 重写 ARCHITECTURE.md

**Files:**
- Modify: `docs/ARCHITECTURE.md`（整体重写）
- Read: `docs/superpowers/plans/rewrite-source-digest.md`、现 ARCHITECTURE.md、Task 1 记录的残留引用

**Interfaces:**
- Consumes: Task 2 素材；Task 1 Step 3 的引用清单。
- Produces: ≤100 行的新 ARCHITECTURE.md：开头一处术语表；插件契约注明出处为宿主 dsh/cordis（归 `archive/PLUGIN_CONTRACT.md` 参考）；与其他两份活文档不重叠。

- [ ] **Step 1: 派 coder 子代理起草重写稿**

prompt 要点：按规格 §2 验收标准重写；术语表集中开头；矛盾处以「代码现状 + 冻结 ADR」为准并显式注明；修掉 Task 1 发现的指向旧路径的引用；输出完整新文件内容（不落盘，返回给父代理）。

- [ ] **Step 2: 父代理对照标准审稿**

核对：≤100 行；无占位；与 WORKFLOW/COLLABORATOR_MODEL 无重复段落；术语表之外无未解释新词；行话密度是否低到作者可读。

- [ ] **Step 3: 落盘并交给作者过目**

落盘 `docs/ARCHITECTURE.md`，请作者确认「能读懂、没变薄」，不过目不算完成。

### Task 4: 重写 WORKFLOW.md（含防通胀条款）

**Files:**
- Modify: `docs/WORKFLOW.md`（整体重写）

**Interfaces:**
- Consumes: Task 2 素材中「协作规则、开发纪律」组；现 WORKFLOW.md 的修订记录。
- Produces: ≤100 行的新 WORKFLOW.md，保留 v0.1→v0.4 演化出的有效规则（分工、分段、破坏性白名单、反馈双通道、七条义务），新增两条防通胀条款（ADR 触发收窄、新建文档需自证），修订记录浓缩为一段。

- [ ] **Step 1-3:** 同 Task 3 的三步（起草→父代理审→作者过目）。

### Task 5: 重写 COLLABORATOR_MODEL.md

**Files:**
- Modify: `docs/COLLABORATOR_MODEL.md`（整体重写）

**Interfaces:**
- Consumes: Task 2 素材；现 COLLABORATOR_MODEL.md。
- Produces: ≤100 行的新 COLLABORATOR_MODEL.md：保留「带出处、带置信度、可审计、可争议」的断言模型与感知留痕纪律，压缩为断言列表 + 协作偏好两节。

- [ ] **Step 1-3:** 同 Task 3 的三步（起草→父代理审→作者过目）。

### Task 6: 收尾验证

**Files:**
- Delete: `docs/superpowers/plans/rewrite-source-digest.md`

- [ ] **Step 1: 结构与篇幅核验**

Run: `wc -l D:/LearningHarnessv0.1/docs/*.md`
Expected: 三份活文档各 ≤100 行。

- [ ] **Step 2: 悬空引用核验**

Run: `grep -rn "decisions/\|experience/" D:/LearningHarnessv0.1/docs/*.md`
Expected: 活文档中指向 archive 的引用均写成 `archive/...` 或已删除。

- [ ] **Step 3: 删除工作素材并总结**

删除 `rewrite-source-digest.md`；向作者汇报：归档清单、三份活文档的行数变化、新增防通胀条款位置；询问是否 git commit。
