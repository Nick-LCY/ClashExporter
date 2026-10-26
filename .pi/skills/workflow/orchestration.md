# 协作编排

> 本文件是 `workflow` skill 的下钻页。只有在编排多步任务、不确定该用哪个 agent 时才需要读。日常决策看 `SKILL.md` 的速查表即可。

## 典型开发工作流

一个完整的功能开发，你按以下顺序编排（**每一步都委派，自己不碰代码**）：

```
需求澄清（主进程）
   └─> scout      侦察代码现状，返回压缩上下文
         └─> planner    基于上下文 + 需求，产出实施计划
               └─> worker      按计划执行，改代码
                     └─> reviewer    审查改动
                           └─> archivist   流转任务状态、更新 current-state、沉淀决策
```

并非每次都走全链路，按需裁剪：
- **小改动**：`scout → worker → archivist`
- **只需理解代码**：`scout`（然后你汇报给用户）
- **只需审查现有代码**：`reviewer`
- **需求明确、改动机械**：跳过 scout/planner，直接 `worker`

## 每个 agent 详解

> 工具权限以 `.pi/agents/<name>.md` 的 frontmatter `tools` 为准；下方为摘要。

### scout — 侦察兵
- **用途**：快速摸清代码，把关键文件、类型、依赖压缩成结构化笔记交给下游，避免它们重复读全文。
- **能力**：`read` / `bash`(只读) / `grep` / `find` / `ls`
- **产出**：文件清单(带行号) + 关键代码 + 架构脉络 + "从哪里开始"
- **不能**：修改任何文件
- **调用**：`subagent` `agent=scout`，任务里说清侦察目标与彻底度（quick / medium / thorough）

### planner — 计划员
- **用途**：拿到 scout 的上下文 + 用户需求，产出分步、可执行、具体的实施计划。worker 会"逐字执行"该计划。
- **能力**：`read` / `grep` / `find` / `ls`（只读，不改）
- **产出**：目标 + 编号步骤 + 待改文件清单 + 新建文件 + 风险
- **不能**：修改任何文件
- **调用**：`subagent` `agent=planner`，把 scout 产出与需求一起传入

### worker — 执行者
- **用途**：在隔离上下文中实际写 / 改 / 删代码。全能，无工具限制。
- **能力**：全部工具
- **产出**：完成摘要 + 改动文件清单 + handoff 信息（如要交给 reviewer）
- **调用**：`subagent` `agent=worker`，把 planner 的计划传入；或直接给明确任务

### reviewer — 审查员
- **用途**：审查代码的质量、安全、可维护性。
- **能力**：`read` / `grep` / `find` / `bash`
- **约束**：**bash 仅只读**（`git diff` / `git log` / `git show`），不跑构建、不改文件
- **产出**：按严重度分级的问题清单（Critical / Warning / Suggestion）+ `文件:行号` + 总结
- **调用**：`subagent` `agent=reviewer`，附上 worker 改动的文件路径

### archivist — 文档管理员
- **用途**：维护 `docs/` 准确与最新；流转任务状态；沉淀架构决策(ADR)与约定。
- **能力**：`read` / `write` / `edit` / `ls` / `grep` / `find`
- **约束**：**只改 `docs/` 下的文件**，不碰业务代码；状态字段严格用 `todo | doing | done | blocked`
- **产出**：current-state / task 状态更新 + 新增 ADR/约定 + 待人确认项
- **调用**：`subagent` `agent=archivist`，告知 worker/reviewer 产出与当前 current-state

## handoff 协议

subagent 之间**不共享上下文**，靠你传递产出：
1. **顺序链**：用 `subagent` 的 `chain` 模式，`{previous}` 占位符自动填入上游产出。
2. **手动转交**：把上一个 agent 的输出（或关键摘要）粘进下一个 agent 的 task。
3. 转交时务必包含：改动的**确切文件路径**、关键的**类型/函数名**、上游的**结论与风险**。

## 决策：这个活该给谁？

| 你想…… | 给谁 |
|---|---|
| 知道某段代码怎么实现的 | `scout` |
| 把需求拆成可执行步骤 | `planner` |
| 真的去改代码 | `worker` |
| 检查改得对不对 | `reviewer` |
| 更新文档 / 任务状态 / 沉淀决策 | `archivist` |
| 只读 `docs/` 了解项目 | **自己读**（允许，无需委派） |
