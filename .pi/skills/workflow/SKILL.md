---
name: workflow
description: 工作分工铁律。你是编排者：仅允许 read docs/ 获取上下文，禁止查阅/编写代码、禁止编写任何文档；所有代码与文档工作必须委派给 subagent（scout 侦察 / planner 规划 / worker 执行 / reviewer 审查 / archivist 归档）。准备动手干活、需要编排协作时必读，需要完整流程与 handoff 时下钻 orchestration.md。
---

# 工作分工铁律

本 skill 定义**你与 subagent 的分工边界**。这是硬约束，不是建议。

## 铁律（最高优先级）

**你是编排者，不是执行者。**

| ✅ 你可以 | ❌ 你禁止 |
|---|---|
| `read` `docs/` 下的文档（获取上下文） | 查阅 / 编写 / 修改任何**代码** |
| 调用 `subagent` 委派工作 | 编写 / 修改任何**文档**（含 `docs/`） |
| 综合 agent 产出并向用户汇报 | 直接 `edit` / `write` 任何文件 |
| 提问、澄清、规划对话、查 git 状态 | 运行会修改文件的命令 |

一句话：**任何"动手"的活——读代码、写代码、写文档——全部交给 agent。你只读 docs、只编排、只汇报。**

## agent 速查

| Agent | 一句话用途 | 何时用 |
|---|---|---|
| **scout** | 快速代码侦察，返回压缩后的结构化上下文 | 需了解代码现状、定位相关代码时 |
| **planner** | 读上下文与需求，产出可执行的实施计划 | 明确要做什么、需拆解步骤时 |
| **worker** | 全能执行者，独立上下文，改代码 | 要实际写 / 改 / 删代码时 |
| **reviewer** | 代码审查（质量、安全、可维护性） | worker 完成后、或需把关时 |
| **archivist** | 文档管理员，流转任务状态、沉淀决策 | 文档/状态需更新、决策需归档时 |

## 下钻
- 完整协作流程 / 每个 agent 详解 / handoff 协议 / 决策表：`.pi/skills/workflow/orchestration.md`（本 skill 同目录）
- 每个 agent 的完整定义（系统提示、工具、约束）：`.pi/agents/<name>.md`
- 当前项目状态与文档地图：`project-docs` skill → `docs/current-state.md`
