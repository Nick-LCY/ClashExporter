# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- [[prds/clash-exporter.md]] — ClashExporter：mihomo 流量 Prometheus exporter（设计已定稿，待实现）

## 任务看板
| Task | 状态 | 备注 |
|------|------|------|
| [[tasks/clash-exporter/01-implement-exporter.md]] | todo | 阶段 0–8 全部待执行；阶段 0 的 API schema 已预验证，实现时复核并采集流量样本 |

## TODO / 阻塞
- [ ] Prometheus 服务端尚未部署（用户后续自行规划），exporter 不做历史存储，不受影响
- [x] 阶段 0 的 mihomo API schema 实测已于 2026-10-26 完成预验证：`upload`/`download` 为 JSON 数字、`metadata.host` 存在但可能为空字符串、无需鉴权头、内核 v1.19.30（meta:true）
- [x] proxy 标签语义的 `chains` 顺序已于 2026-10-26 实测确认：首元素 = 实际出口节点，末元素 = 策略组
- [x] 代码已取首元素：`internal/ledger/ledger.go` 的 `resolveProxy` 已改取 `chains` 首元素并同步注释与单元测试（提交 b7e4b02，2026-10-26）
- [ ] 冒烟阶段用真实流量样本确认：LAN 客户端转发流量的 `sourceIP` 保留真实客户端 IP，`198.18.0.1`（TUN 网关）仅出现在路由器本机流量

## 环境就绪
- Go 工具链 go1.26.8 已安装（apt）
- mihomo API 可达：`http://192.168.2.2:9090`，无鉴权 secret；TUN 透明网关，已开 sniffer + fake-ip；内核 v1.19.30（meta:true），已实测 `/connections` 响应

## 最近变更
- 2026-10-26 proxy 标签语义实测修正：`chains` 顺序为 `[真实出口节点, 策略组]`，首元素才是实际出口节点（末元素是策略组名，不单独暴露）；任务计划与 PRD 已改为取首元素口径，代码取首元素的改动已落地（提交 b7e4b02）
- 2026-10-26 mihomo API 预验证：内核 v1.19.30，字节数为 JSON 数字、`host` 可为空、无需鉴权头；发现路由器本机流量 `sourceIP` 为 TUN 网关 `198.18.0.1`
- 2026-10-26 文档初始化：首份 PRD、任务拆分、架构总览与 3 份 ADR 落库，设计定稿
