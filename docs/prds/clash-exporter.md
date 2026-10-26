# ClashExporter — mihomo 流量 Prometheus Exporter

## 背景

mihomo 的 `/connections` API 只暴露**当前活跃连接**的列表，每条连接带有它自身生命周期内的累计字节数；连接一旦关闭就从列表里消失，接口不提供任何历史累计值，也不提供「某台设备到某网站累计用了多少字节」这种聚合口径。要回答用户的核心问题——「每台机器、每个网站，在每个代理节点上各消耗了多少流量」——exporter 必须在本地维护一份**有状态的账本**，把每条连接上不断增长的累计值转换成增量累加进去。

运行环境已就绪：mihomo 跑在局域网旁路由 NanoPi R2S 上（`192.168.2.2:9090`，无鉴权 secret，TUN 透明网关，全局域网设备的网关都指向它），开启了 sniffer 与 fake-ip，因此连接元数据里的 `host` 基本是真实域名，可直接用作站点标签。已实测该实例内核为 mihomo v1.19.30（meta:true），`/connections` 返回的字节数为 JSON 数字，`metadata.host` 存在但可能为空字符串（无法识别时）。路由器本机自身发起的流量（如 EasyTier 隧道，`type=Tun`）的 `sourceIP` 是 TUN 网关地址 `198.18.0.1` 而非某个局域网客户端 IP，因此 `device` 维度会自然出现一个「旁路由本机」设备；用户在配置的 `device_aliases` 里把 `198.18.0.1` 起别名为「旁路由本机」即可归类，无需改设计。Prometheus 基础设施尚未部署，由用户后续自行规划，因此 exporter 只负责暴露指标，不做历史存储。

## 目标

- 导出单表全维度计数器 `clash_traffic_bytes_total{device, site, proxy, direction}`（`direction` 取 `upload` 或 `download`），使下列查询全部可在 Prometheus 侧用 PromQL 直接得出：

  | 想回答的问题 | PromQL 示例 |
  |---|---|
  | 每台设备总流量 | `sum by (device) (increase(clash_traffic_bytes_total[1h]))` |
  | 每个网站总流量 | `sum by (site) (increase(clash_traffic_bytes_total[1h]))` |
  | 每个代理节点总流量 | `sum by (proxy) (increase(clash_traffic_bytes_total[1h]))` |
  | 设备 × 网站 | `sum by (device, site) (increase(clash_traffic_bytes_total[1h]))` |
  | 设备 × 节点 | `sum by (device, proxy) (increase(clash_traffic_bytes_total[1h]))` |
  | 站点 × 节点 | `sum by (site, proxy) (increase(clash_traffic_bytes_total[1h]))` |
  | 上行 / 下行拆分 | `sum by (direction) (increase(clash_traffic_bytes_total[1h]))` |
  | 单个组合的趋势 | `increase(clash_traffic_bytes_total{device="192.168.2.100", site="youtube.com", proxy="us-node"}[5m])` |

- 附带导出辅助指标：`clash_up`（mihomo 可达性）、`clash_active_connections`（活跃连接数）、`clash_scrape_duration_seconds`（本轮采集耗时）、`clash_exporter_state_entries`（账本条目数），以及与核心指标不同名的全局对账指标 `clash_traffic_total_bytes_total{direction}`。
- 计数器语义可靠：跨 exporter 重启不归零，跨序列淘汰间隙不丢数（Prometheus 端 `increase()` 结果零丢失）。
- 标签基数有界：长期运行不会因为历史站点堆积而无界增长。
- 交付形态为单二进制 + systemd，部署在局域网另一台主机（7640HS），配置为单个 YAML 文件。

## 非目标

- 不做历史存储：不落时序数据库、不做本地时序文件、不做数据保留策略。
- 不做可视化：不提供 Grafana 看板、不提供 Web 页面（仅提供 `/metrics`、`/` 说明页、`/healthz`、`/readyz`）。
- 不自动部署 Prometheus / Pushgateway / Alertmanager，不负责 Prometheus 服务端配置。
- 不改造 mihomo 的鉴权：配置项 `api_secret` 只作兼容位保留，当前仅内网使用。
- 不做多实例聚合：一个 exporter 实例只对应一台 mihomo。
- 不做规则命中维度分析：暂不把 mihomo 的 `rule` 作为标签维度。
- 不做流量整形/限速/阻断等控制面能力，exporter 只读。

## 方案

### 指标模型

核心指标为**单表全维度计数器** `clash_traffic_bytes_total{device, site, proxy, direction}`，每个账本条目产出 upload / download 两条序列。所有维度切片统计交给 Prometheus 查询时的 `sum by` / `increase` 完成，exporter 不预聚合、不产出交叉表。详见 [[architecture/decisions/0001-单表全维度计数器.md]]。

全局对账指标独立命名为 `clash_traffic_total_bytes_total{direction}`，取值取「本轮 API 值与历史最大值的较大者」，既避免用户朴素求和时与核心指标双算，也防止 mihomo 重启导致数值回退。

### 标签归一化

| 标签 | 来源 | 归一化规则 |
|---|---|---|
| `device` | 连接的 `sourceIP` | TUN 旁路由模式下即局域网客户端真实 IP（EasyTier 远程设备为其 VPN 网段 IP）；路由器本机自身发起的流量（`type=Tun`）源 IP 为 TUN 网关地址 `198.18.0.1`，通过 `device_aliases` 起别名（如「旁路由本机」）归入独立设备，不视为设计变更；配置支持 IP → 别名映射，命中别名则用别名，否则用原始 IP |
| `site` | 连接的 `host`（嗅探到的域名） | 空、或为 IP 字面量（含 fake-ip 保留段 `198.18.0.0/15`）一律归入 `unresolved` 桶；**绝不**用 `destinationIP` 充当站点标签；支持正则归组规则，按顺序取首条命中的规则归组名 |
| `proxy` | 连接的代理链 `chains` 首元素 | 取第一个元素作为真实出口节点（2026-10-26 实测：顺序为 `[真实出口节点, 策略组]`，末元素是策略组名，不单独暴露）；`DIRECT` / `REJECT` 归一化为小写 `direct` / `reject`；空链归 `unknown` |

站点标签集合去重上限默认 10000，超限的新站点归入 `other` 桶，`other` 本身不占配额。

### 增量归账

默认每 5 秒（1–60 秒可调）轮询一次 `/connections`，exporter 为每条连接记录上次读数，按差值累加进账本：

- 首次出现的连接，把它的历史累计值一次性计入（它在此之前的流量已经发生，必须补上）。
- 计数器回退（mihomo 重启导致累计值变小）时，增量记 0 并重置基线，绝不产生负值。
- 连接消失时**不做任何补账**，只把连接从活跃表移除：每轮归账中「已入账量」与「最后观测值」同步推进，两者恒等，残余差值恒为 0。真实损失边界是「最后一次轮询到连接关闭之间」产生的字节——内核不保留已关闭连接的历史累计值，这段流量不可观测，**上限约为一个轮询间隔**（默认 5s）；除此之外的流量都不丢。
- 轮询失败只把 `clash_up` 置 0，**绝不执行消失检测**——网络抖动不能把活连接误判为消失，否则会重复计入其累计值造成流量虚高。

### 无损淘汰与重锚

某组合连续 24 小时（可调）没有新增字节时停止导出该序列，但账本数据保留。将来该组合再来流量时重锚恢复：恢复后第一次导出的值恰好等于上次导出的值，之后各轮再在此基础上累加新增量。恢复点取值与消失前一致，因此 Prometheus 端跨 stale 间隙的 `increase()` 零丢失。详见 [[architecture/decisions/0002-无损淘汰与重锚.md]]。

### 账本有界化（prune_ttl）

停导只是不导出，账本条目本身仍会随历史组合无限累积，因此再加一道清理：条目**已淘汰、无待导出增量、且静默超过 `prune_ttl`**（默认 168h，可调）后从账本删除，快照随之不再包含它。

这项删除是无损的：条目被淘汰时已连续 24 小时没有新增字节，待导出增量为 0 意味着累计值已经完整导出（`total == lastExported`），删除只丢掉一段此后没有变化的历史值；该组合日后重现时以新基线重新计数，Prometheus 端按新序列处理，没有任何已观测字节丢失。带待导出增量的条目一律保留——那些字节还没报出去，删掉就是真丢。

### 连接基线墓碑

连接从活跃表移除时保留它的基线（内存态墓碑）：同 ID 连接稍后重现时沿用旧基线只计新增量，避免把已计入账本的部分重复计入造成流量虚高。墓碑不参与导出、不写入快照（重启后重现的连接按首次出现处理），超过 `prune_ttl` 后随清理一并删除。

### 快照持久化

账本全部字段（含**活跃连接表**、站点集合、全局对账值）默认每 30 秒原子写盘：同目录临时文件 → 写 JSON → `fsync` → `rename` → 父目录 `fsync`。收到 SIGTERM / SIGINT 时强制写一次，启动时恢复。快照必须含活跃连接表，否则重启后现存连接的累计值会被当作首次出现重复计入，导致流量虚高。详见 [[architecture/decisions/0003-JSON快照持久化.md]]。

### 配置、依赖与部署

- 依赖取向最少化：仅 `prometheus/client_golang` + `gopkg.in/yaml.v3` + Go 标准库；不使用 Web 框架、不使用 cobra、不使用 cgo、不使用数据库。
- 模块路径 `github.com/sankabox/clash-exporter`。
- HTTP 暴露 `/metrics`、`/`（说明页）、`/healthz`、`/readyz`（按 mihomo 可达性返回 200/503），监听地址默认 `:9095`。
- 配置为单个 YAML 文件，通过 `-config` 指定；未知字段直接报错。
- 部署形态：局域网另一台主机（7640HS）上的单二进制 + systemd，快照默认路径 `./data/state.json`。

## 验收标准

- [x] `go build ./...`、`go vet ./...`、`go test ./...` 全绿，`gofmt -l .` 无输出。
- [x] 配置加载：`Duration` 支持 `"5s"` / `"24h"` 字符串与整数秒；未知字段报错；文件缺失报错；`Validate` 拒绝越界轮询间隔、非正 TTL（含 `prune_ttl`）、非正上限、非法正则、空监听地址。
- [x] mihomo 客户端：解析 `/connections` 载荷；`api_secret` 非空时带 `Authorization: Bearer` 头，为空时不带鉴权头；非 2xx 返回带状态码的错误；非法 JSON 返回错误。
- [x] 增量归账：同一连接连续两轮按差值累加；首次出现全量计入；计数器回退不出现负值；连接消失时不做补账（残余差值恒为 0），已知损失仅为「最后一次轮询到连接关闭之间」的字节、上限约一个轮询间隔；轮询失败不触发消失检测且账本状态完全不变。
- [x] 标签归一化：`host` 缺失归 `unresolved`；IP 字面量（含 `198.18.0.0/15`）归 `unresolved`；设备别名命中；归组规则首条命中；`DIRECT` / `REJECT` / 空链分别归一化为 `direct` / `reject` / `unknown`。
- [x] 设备维度：路由器本机流量（`type=Tun`）的 `sourceIP` 为 `198.18.0.1`，经 `device_aliases` 起别名后归入「旁路由本机」设备；LAN 客户端转发流量（`type=Redir`）保留真实源 IP（已实测：`192.168.2.135`、`192.168.2.187`、`192.168.2.33`）。
- [x] 基数保护：站点去重上限溢出时归入 `other` 桶，`other` 不占配额。
- [x] 淘汰与重锚：24 小时无增量的条目不再出现在 `/metrics`；重锚后第一次导出的值等于上次导出值，第二次导出等于累计值；导出值单调不减。
- [x] 账本有界化：条目被淘汰、无待导出增量且静默超过 `prune_ttl` 后从账本删除、快照不再包含；带待导出增量或未到时限的条目不被删除；删除后该组合重现以新基线计，不丢已观测字节。
- [x] 连接基线墓碑：同 ID 连接重现时只计新增量、不重复计入已计部分；墓碑不导出、不入快照，超过 `prune_ttl` 后清理。
- [x] 全局对账：`clash_traffic_total_bytes_total` 单调不减，取历史最大值防 mihomo 重启回退。
- [x] 快照：`Save` / `Load` 往返数据一致；快照文件不存在时 `Load` 返回空结果；损坏 JSON 返回错误；写盘后不残留临时文件。
- [x] 采集器：`/metrics` 输出全部 6 个指标，数值与账本一致，连续采集不降，淘汰条目不出现，`clash_up` 为 1。
- [x] HTTP：`/healthz` 返回 ok；`/` 返回说明页；`/metrics` 可被 Prometheus 正常抓取。
- [x] 冒烟：连接真实 mihomo（`192.168.2.2:9090`）或 mock 服务，`curl /metrics` 确认指标齐全，且在产生流量后计数器增长。
- [x] `go mod tidy` 后 `go.mod` 只剩两个直接依赖。
- [x] README 覆盖四节（简介与工作原理 / 指标表 / 配置说明 / systemd 部署示例）与兼容性说明。
