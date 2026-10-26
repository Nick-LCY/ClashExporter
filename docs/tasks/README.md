# 任务

需求拆分出的开发任务。**按 PRD 分组**：`tasks/<feature>/<NN>-<短名>.md`。每个 task 是一个可独立领取、独立完成的单元。

## Task 文件格式

```
---
prd: prds/<feature>.md
status: todo        # todo | doing | done | blocked
---
# 任务：<标题>

## 目标
（来自 PRD 的拆分项）

## 完成标准
- [ ] ...

## 依赖
- 无 / 或依赖其他 task
```

## 状态约定
- `todo` — 待领取
- `doing` — 正在执行中
- `done` — 完成
- `blocked` — 阻塞

## 看板
任务状态汇总见 [[current-state.md]]，由人维护。
