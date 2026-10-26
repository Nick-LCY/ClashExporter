# 系统总览

> 在此记录本项目的系统架构（稳定层，很少变更）。

## 概述

ClashExporter 是一个用 Go 编写的 mihomo（clash.meta 内核）Prometheus exporter：定时轮询 mihomo 的 `/connections` API，用本地账本把每条连接的累计字节数换算成增量流量，最终以单表全维度计数器的形式暴露给 Prometheus。

## 架构

数据流向（实线是主链路，虚线是旁路）：

```
   mihomo API (192.168.2.2:9090)
            │  GET /connections
            ▼
   ┌──────────────────┐   每轮拉取后调用
   │  轮询协程         │──────────────┐
   │ (main.go 启动)    │              ▼
   └──────────────────┘   ┌────────────────────┐
            ▲             │  账本 Ledger        │
            │             │  ·增量归账          │
            │             │  ·淘汰 + 重锚       │
            │             │  ·标签归一化        │
            │             └─────────┬──────────┘
            │                       │ Export()
   ┌────────┴─────────┐             ▼
   │  mihomo 客户端    │   ┌────────────────────┐
   │ (HTTP + JSON)     │   │  采集器 Collector   │
   └──────────────────┘   └─────────┬──────────┘
                                      │
   ┌──────────────┐                  ▼
   │  YAML 配置    │         ┌──────────────────┐
   │ (config)      │         │  /metrics (HTTP)  │
   └──────────────┘         └──────────────────┘
                                      │
   ┌──────────────┐                  ▼
   │  快照 JSON    │◀───────  Prometheus 抓取
   │ (持久化账本)  │         （历史存储不在本项目内）
   └──────────────┘
```

| 组件 | 输入 | 输出 | 职责要点 |
|---|---|---|---|
| mihomo API | — | 活跃连接列表 | 外部依赖，只读；连接关闭即消失，不提供历史累计值 |
| 轮询协程 | 定时器 | 轮询结果 | 默认 5 秒一轮；失败只置 `clash_up = 0`，绝不执行消失检测 |
| mihomo 客户端 | HTTP 请求 | `ConnectionsResponse` | 解析 JSON、鉴权头、限流读取、超时 `max(10s, 2×poll_interval)` |
| 账本 | 轮询结果 + 上一轮状态 | 账本条目 + 活跃连接表 | 增量归账、消失移出与基线墓碑、24 小时淘汰与 `prune_ttl` 无损裁剪、重锚续报、标签归一化、全局对账值 |
| 采集器 | 账本导出 | Prometheus 指标 | 单表全维度计数器 + 全局对账指标 + 4 个辅助指标 |
| HTTP 服务 | 采集器 + 注册表 | `/metrics`、`/`、`/healthz` | 默认监听 `:9095` |
| 快照 | 账本状态 | JSON 文件 | 30 秒原子写（临时文件 + fsync + rename），信号时强制写，启动时恢复 |
| YAML 配置 | 配置文件 | 配置对象 | 单文件、`-config` 指定、未知字段报错、加载期校验正则 |

## 核心模块

- `internal/config` — 配置结构、默认值、YAML 加载与校验（含 `Duration` 类型与站点归组规则）。
- `internal/mihomo` — mihomo `/connections` API 客户端与响应数据结构定义。
- `internal/ledger` — 流量账本：标签归一化、增量归账、消失移出与基线墓碑、淘汰与重锚、过期条目清理、导出、快照与恢复。
- `internal/snapshot` — 账本状态的 JSON 原子持久化与加载。
- `internal/collector` — 把账本状态翻译成 Prometheus 指标并实现 `Collect`。
- `internal/httpapi` — HTTP 服务封装与 `/metrics`、`/`、`/healthz` 路由。

## 关键决策

架构决策记录见 [[architecture/decisions/README.md]]。

- [[architecture/decisions/0001-单表全维度计数器.md]] — 核心指标只保留一张全维度表，维度切片交给 Prometheus 查询时聚合。
- [[architecture/decisions/0002-无损淘汰与重锚.md]] — 24 小时无增量即停导但保留数据，重锚时续报上次导出值保证 `increase()` 零丢失；`prune_ttl` 到期后无损裁剪过期条目。
- [[architecture/decisions/0003-JSON快照持久化.md]] — 账本每 30 秒原子落盘并在信号时强制写，启动时恢复，保证重启后计数器不归零。
