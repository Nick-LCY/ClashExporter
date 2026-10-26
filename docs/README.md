# 项目文档库

这是项目的知识层。采用 **结构即导航**：本文件是总地图，每个领域有自己的 `README.md` 作为目录页。按需下钻，不要一次性全部加载（渐进式披露）。

## 地图

| 领域 | 何时来查 | 入口 |
|------|---------|------|
| 当前状态 | 开始任何工作前，先了解进度 / TODO | [[current-state.md]] |
| 架构 | 理解系统设计、查看架构决策 (ADR) | [[architecture/README.md]] |
| 约定 | 编码、提交、命名等规范 | [[conventions/README.md]] |
| 词汇表 | 统一文档库术语含义 | [[glossary.md]] |
| 需求 (PRD) | 了解某个需求的设计 | [[prds/README.md]] |
| 任务 | 领取 / 查看开发任务 | [[tasks/README.md]] |

## 生命周期

- **稳定层**（很少变）：`architecture/`、`conventions/`、`glossary`
- **流动层**（随开发变化）：`prds/`、`tasks/`、`current-state.md`

## 开发流

```
PRD → 拆分为任务 → tasks → 执行并更新状态 → current-state 汇总进度
```

详见 [[architecture/overview.md]]。