---
prd: prds/clash-exporter.md
status: todo
---
# 任务：实现 ClashExporter 核心导出器

## 目标

按 [[prds/clash-exporter.md]] 的方案，用 Go 实现一个读取 mihomo `/connections` API、自带状态做增量归账、对外暴露 Prometheus 指标的 exporter：单表全维度计数器 `clash_traffic_bytes_total{device, site, proxy, direction}`、全局对账指标 `clash_traffic_total_bytes_total{direction}` 与 4 个辅助指标；包含配置加载、mihomo 客户端、账本、快照、采集器、HTTP 服务与 main 装配，以及单元测试、mock 端到端测试、冒烟验证与 README。

## 完成标准

- [ ] 阶段 0–8 的全部步骤完成，每步的验收项通过。
- [ ] `go build ./...`、`go vet ./...`、`go test ./...` 全绿，`gofmt -l .` 无输出。
- [ ] `go mod tidy` 后 `go.mod` 只有两个直接依赖：`prometheus/client_golang`、`gopkg.in/yaml.v3`。
- [ ] 冒烟通过：`/metrics` 输出 6 个指标，产生流量后核心计数器增长。
- [ ] README 四节 + 兼容性说明完成。

## 分阶段步骤

### 阶段 0：环境与骨架

1. 核对工具链与实测 API schema。
   - 已于 2026-10-26 预验证：`upload` / `download` 为 JSON 数字、`metadata.host` 存在但可能为空字符串（无法识别时）、无需鉴权头、内核 v1.19.30（meta:true）。
   - 实现时保留该步骤用于复核与采集更多流量样本，重点观察 LAN 客户端转发流量的 `sourceIP` 是否为真实客户端 IP（本机自身流量为 TUN 网关地址 `198.18.0.1`）。
   - 执行 `go version`、`go env GOPROXY`；用 `curl` 访问 `http://192.168.2.2:9090/connections` 与 `http://192.168.2.2:9090/version`，记录 `upload` / `download` 是数字还是字符串、`host` 字段是否存在、是否需要鉴权头。
   - API 不通时按已知 schema 实现并用 mock 覆盖；GOPROXY 不可达时执行 `go env -w GOPROXY=https://goproxy.cn,direct`。
   - 验收：实测结论落到 README 的兼容性说明小节，代码中的字段解析方式与结论一致。
2. 初始化模块：`go mod init github.com/sankabox/clash-exporter`。
   - 验收：`go.mod` 的 module 路径为 `github.com/sankabox/clash-exporter`。
3. 写 `.gitignore`，包含 `/bin/`、`/data/`、`/clash-exporter`、`*.test`、`*.out`。
   - 验收：`git status` 不出现构建产物与快照目录。
4. 写 `Makefile`，三个目标：
   - `build` → `go build -o bin/clash-exporter .`
   - `test` → `go test ./...`
   - `lint` → `go vet ./...` 加 `gofmt -l .`，输出非空即失败
   - 验收：`make lint` 在代码整洁时退出码为 0。
5. 写 `config.example.yml`，全字段带注释，注释中的默认值与 `config.Default()` 一致。
   - 验收：示例文件能被 `config.Load` 正常加载，且与默认值逐项一致。

### 阶段 1：配置（internal/config/config.go）

1. 定义类型与 YAML 标签：

   ```go
   type Duration time.Duration        // UnmarshalYAML 支持 "5s" / "24h" 字符串与整数秒；提供 MarshalYAML 与 Duration()
   type SiteGroupRule struct {
       Pattern string `yaml:"pattern"`
       Group   string `yaml:"group"`
   }
   type Config struct {
       APIURL           string            `yaml:"api_url"`
       APISecret        string            `yaml:"api_secret"`
       PollInterval     Duration          `yaml:"poll_interval"`
       EvictTTL         Duration          `yaml:"evict_ttl"`
       SnapshotInterval Duration          `yaml:"snapshot_interval"`
       SiteLabelCap     int               `yaml:"site_label_cap"`
       SnapshotPath     string            `yaml:"snapshot_path"`
       ListenAddr       string            `yaml:"listen_addr"`
       DeviceAliases    map[string]string `yaml:"device_aliases"`
       SiteGroupRules   []SiteGroupRule   `yaml:"site_group_rules"`
   }
   ```

2. 实现 `func Default() *Config`，默认值：`api_url=http://192.168.2.2:9090`、`secret=""`、`poll=5s`、`ttl=24h`、`cap=10000`、`snapshot=./data/state.json`、`snap-interval=30s`、`listen=:9095`。
   - 验收：`Default()` 的每一项与 `config.example.yml` 注释一致。
3. 实现 `func Load(path string) (*Config, error)`：`path == ""` 返回 `Default()`；文件不存在报错；使用 `yaml.Decoder` 且 `KnownFields(true)`，未知字段报错；缺省字段填默认值；正则规则在加载期完成编译校验。
   - 验收：未知字段、文件缺失两种输入都返回错误。
4. 实现 `func (c *Config) Validate() error`：`poll` 落在 `[1s, 60s]`；`evict_ttl > 0`；`snapshot_interval > 0`；`cap > 0`；`api_url` 可解析且 scheme 为 `http` 或 `https`；`listen_addr` 与 `snapshot_path` 非空；每条规则的 `pattern` 可编译且 `group` 非空。
   - 验收：每条非法取值都有对应测试用例。

### 阶段 2：mihomo 客户端（internal/mihomo/mihomo.go）

1. 定义数据结构与 JSON 标签：

   ```go
   type ConnectionMetadata struct {
       Network         string `json:"network"`
       Type            string `json:"type"`
       SourceIP        string `json:"sourceIP"`
       SourcePort      string `json:"sourcePort"`
       DestinationIP   string `json:"destinationIP"`
       DestinationPort string `json:"destinationPort"`
       Host            string `json:"host"`
   }
   type Connection struct {
       ID       string             `json:"id"`
       Metadata ConnectionMetadata `json:"metadata"`
       Upload   uint64             `json:"upload"`
       Download uint64             `json:"download"`
       Start    string             `json:"start"`
       Chains   []string           `json:"chains"`
       Rule     string             `json:"rule"`
   }
   type ConnectionsResponse struct {
       DownloadTotal uint64       `json:"downloadTotal"`
       UploadTotal   uint64       `json:"uploadTotal"`
       Connections   []Connection `json:"connections"`
   }
   ```

   字节数字段按实测结论（JSON 数字）直接用 `uint64` 解析；如需兼容字符串形式，可另写自定义 `UnmarshalJSON` 作防御性兼容，属可选项。

2. 实现 `func NewClient(baseURL, secret string, timeout time.Duration) *Client`。
   - 验收：构造出的客户端可用且不发起网络请求。
3. 实现 `func (c *Client) FetchConnections(ctx context.Context) (*ConnectionsResponse, error)`：`GET {baseURL}/connections`；`secret` 非空时带 `Authorization: Bearer` 头；`http.Client.Timeout = max(10s, 2×poll_interval)`；非 2xx 返回带状态码的错误；响应体用 `io.LimitReader` 限制在 64MB。
   - 验收：解析、Bearer 头、空 secret 不带鉴权头、500、非法 JSON 五个用例全通过。

### 阶段 3：账本（internal/ledger/ledger.go）

1. 定义类型：

   ```go
   type Key struct{ Device, Site, Proxy string }
   type Entry struct {
       TotalUpload          uint64    `json:"total_upload"`
       TotalDownload        uint64    `json:"total_download"`
       LastExportedUpload   uint64    `json:"last_exported_upload"`
       LastExportedDownload uint64    `json:"last_exported_download"`
       PendingUpload        uint64    `json:"pending_upload"`
       PendingDownload      uint64    `json:"pending_download"`
       LastActivity         time.Time `json:"last_activity"`
       Evicted              bool      `json:"evicted"`
       Reanchored           bool      `json:"reanchored"`
   }
   type ConnState struct {
       ID                string `json:"id"`
       Device            string `json:"device"`
       Site              string `json:"site"`
       Proxy             string `json:"proxy"`
       Upload            uint64 `json:"upload"`
       Download          uint64 `json:"download"`          // 最后观测到的累计值
       AccountedUpload   uint64 `json:"accounted_upload"`  // 已并入账本的数量
       AccountedDownload uint64 `json:"accounted_download"`
   }
   type EntryState struct {
       Entry
       Key
   }
   type State struct {
       Version                  int         `json:"version"`
       UpdatedAt                time.Time   `json:"updated_at"`
       Entries                  []EntryState `json:"entries"`
       Sites                    []string    `json:"sites"`
       Connections              []ConnState `json:"connections"`
       GlobalUploadTotal        uint64      `json:"global_upload_total"`
       GlobalDownloadTotal      uint64      `json:"global_download_total"`
       GlobalUploadMax          uint64      `json:"global_upload_max"`
       GlobalDownloadMax        uint64      `json:"global_download_max"`
       Up                       bool        `json:"up"`
       LastScrapeDurationSecond float64     `json:"last_scrape_duration_second"`
       LastActiveConnections    int         `json:"last_active_connections"`
   }
   type Series struct{ Device, Site, Proxy, Direction string; Value uint64 }
   type GroupRule struct {
       Pattern *regexp.Regexp
       Group   string
   }
   type Options struct {
       SiteCap       int
       EvictTTL      time.Duration
       DeviceAliases map[string]string
       GroupRules    []GroupRule
   }
   ```

2. 实现 `func New(opts Options) (*Ledger, error)`。
   - 验收：非法正则组合在构造期报错。
3. 实现三个归一化方法：
   - `resolveDevice`：别名命中用别名，否则用原始 IP。
   - `resolveSite`：空值归 `unresolved`；按顺序取首条命中的归组规则用其归组名；否则取 `host` 小写去空格；IP 字面量（含 `198.18.0.0/15` 段）归 `unresolved`。
   - `resolveProxy`：取 `chains` 末元素；`DIRECT` 归 `direct`；`REJECT` 归 `reject`；空链归 `unknown`。
   - 验收：别名命中、归组首条命中、`host` 缺失、IP 字面量、代理归一化各有测试。
4. 实现 `func (l *Ledger) Observe(now time.Time, resp *mihomo.ConnectionsResponse)`，顺序固定：
   - ① 活跃连接增量入账 → ② 消失连接残余补账 → ③ 淘汰扫描 → ④ 全局对账值更新。
   - 增量 = 当前值 − 上次值（饱和减，下限 0）；首次出现的连接全量计入；计数器回退时增量记 0 并重置基线；消失连接的残余 = 最后观测值 − 已入账量，并入账本后从活跃表删除。
   - 目标条目已淘汰时，置 `Evicted = false`、`Reanchored = true` 后照常入账，`Total` / `Pending` 不清零；`LastActivity` 仅在有新增字节时更新为 `now`；`now − LastActivity ≥ EvictTTL` 则置 `Evicted = true`（数据保留）。
   - 全局对账记录原值并更新 `Max = max(历史最大, 本轮)`；成功则 `Up = true`。
   - 验收：增量累加、首次全量计入、回退不负值、消失补账、淘汰不导出、重锚第一次等于上次导出值、重锚第二次等于累计值、导出单调不减、站点上限溢出归 `other`、`host` 缺失归 `unresolved`、IP 字面量归 `unresolved`、别名命中、归组首条命中、代理归一化、全局值单调，全部用例通过。
5. 实现 `func (l *Ledger) Export() []Series`：跳过 `Evicted` 条目；重锚后第一次导出取 `LastExported` 并把 `Reanchored` 置 false、保留 `Pending`；其余情况取值 = `LastExported + Pending`，然后 `LastExported = 取值`、`Pending = 0`；每个条目产出 upload / download 两条序列。
   - 验收：导出的值单调不减，淘汰条目不出现。
6. 实现 `func (l *Ledger) Snapshot() *State`（深拷贝）与 `func (l *Ledger) Restore(st *State)`（覆盖条目、站点集合、**活跃连接表**、全局值、`Up` 等；必须恢复活跃连接表，防止重启后重复计入导致流量虚高）。
   - 验收：快照往返后账本状态一致；恢复后存量连接不会被当作首次出现全量计入。
7. 实现只读访问器：`Up() bool`、`LastScrapeDuration() time.Duration`、`ActiveConnections() int`、`EntryCount() int`、`GlobalUpload() uint64`、`GlobalDownload() uint64`。
   - 验收：采集器与快照均通过访问器取数，不直接触碰内部字段。

### 阶段 4：快照（internal/snapshot/snapshot.go）

1. 实现 `func Save(path string, state *ledger.State) error`：`MkdirAll` 父目录 → 同目录临时文件 `state.json.tmp` → 写 JSON → `Sync` → `Close` → `rename` → 父目录 `fsync`；出错时删除临时文件，旧文件保持不变。
   - 验收：往返一致、无残留 `.tmp`、写入失败时旧快照完好。
2. 实现 `func Load(path string) (*ledger.State, error)`：文件不存在返回 `(nil, nil)`；校验 `Version`；文件损坏返回错误。
   - 验收：缺失文件、非法 JSON 两个用例通过。

### 阶段 5：采集器（internal/collector/collector.go）

1. 实现 `func New(l *ledger.Ledger) *Collector` 与 `Describe` / `Collect`。
2. 定义指标：
   - `clash_traffic_bytes_total`（CounterValue，标签 `device`、`site`、`proxy`、`direction`）
   - `clash_traffic_total_bytes_total`（CounterValue，标签 `direction`）
   - `clash_active_connections`、`clash_up`、`clash_scrape_duration_seconds`、`clash_exporter_state_entries`（均为 GaugeValue）
   - `NewDesc` 的名称原样写，含 `_total` 后缀。
3. `Collect` 先 `ledger.Export()` 再 `MustNewConstMetric`。
   - 验收：用 `testutil` 校验指标名齐全、数值一致、连续采集不降、淘汰条目不出现、`up = 1`。

### 阶段 6：HTTP 与入口

1. `internal/httpapi/httpapi.go`：`func New(reg *prometheus.Registry, addr string) *Server`；`Start()` 在独立协程里 `ListenAndServe`；`Shutdown(ctx)` 优雅关闭；路由 `/metrics` 用 `promhttp.HandlerFor(reg)`，`/` 返回 `text/plain` 说明页，`/healthz` 返回 `ok`。
   - 验收：三个端点各自可测。
2. `main.go` 装配顺序：解析 `-config` flag → `config.Load` → `ledger.New` → `snapshot.Load`（存在则 `Restore`）→ `prometheus.NewRegistry()` 并注册 collector + `NewGoCollector` + `NewProcessCollector` → 启动 HTTP → 启动轮询协程（定时器调 `FetchConnections`，成功则 `Observe` + 记录耗时 + `Up = true`，失败仅 `Up = false`，不做消失检测）→ 启动快照协程（定时 `Save`）→ 等待 SIGINT / SIGTERM。
   - 验收：进程可正常启动、响应 `/metrics`、收到信号后正常退出。
3. 退出顺序（`sync.Once` 保证只执行一次）：收到信号 → cancel ctx → 等待轮询与快照协程退出（WaitGroup）→ `httpapi.Shutdown`（5 秒超时）→ 最后写一次快照 → 退出码 0；收到第二个信号直接 `os.Exit(1)`。
   - 验收：退出后快照文件存在且可被下次启动加载。

### 阶段 7：验收

1. `go build ./... && go vet ./... && go test ./...` 全绿，`gofmt -l .` 无输出。
2. 手工冒烟：对着假 mihomo 或真实的 `192.168.2.2:9090` 跑起来，`curl /metrics` 确认 6 个指标齐全，产生流量后核心计数器增长。
   - 验收：计数器随流量单调增长；`clash_up` 为 1。
3. `go mod tidy` 后 `go.mod` 只剩两个直接依赖。
   - 验收：依赖列表与预期一致。

### 阶段 8：文档

1. 写 `README.md` 四节：简介与工作原理 / 指标表 / 配置说明 / systemd 部署示例——二进制放 `/usr/local/bin/clash-exporter`，配置放 `/etc/clash-exporter/config.yml`，快照放 `/var/lib/clash-exporter/state.json`，使用专用用户，`Restart=always`，目标机为 7640HS。
2. 补兼容性说明小节，写入阶段 0 的实测结论。
   - 验收：README 中的默认值与 `config.Default()` 一致；部署示例可直接照抄。

## 依赖

- 依赖其他 task：无。
- 依赖清单（初始化命令）：

  ```bash
  go mod init github.com/sankabox/clash-exporter
  go get github.com/prometheus/client_golang@v1.20.5
  go get gopkg.in/yaml.v3@v3.0.1
  go mod tidy
  ```

## 测试计划

| 文件 | 用例 |
|---|---|
| `config_test.go` | `TestDefaultConfig` / `TestLoadYAMLParsesDurationsAndRules` / `TestLoadUnknownFieldFails` / `TestLoadMissingFileFails` / `TestValidateRejectsBadValues` |
| `mihomo_test.go` | `TestFetchConnectionsParsesPayload` / `TestFetchConnectionsSendsBearerWhenSecretSet` / `TestFetchConnectionsOmitsAuthWhenSecretEmpty` / `TestFetchConnectionsServerError` / `TestFetchConnectionsInvalidJSON` |
| `ledger_test.go` | `TestObserveAccumulatesDeltaPerConnection` / `TestObserveFirstSightCountsWholeCounter` / `TestObserveCounterResetDoesNotGoNegative` / `TestDisappearedConnectionResidualFlushed` / `TestEvictedEntryNotExported` / `TestReanchorFirstExportEqualsLastExported` / `TestReanchorSecondExportCatchesUp` / `TestExportedValueNeverDecreases` / `TestSiteCapOverflowsToOther` / `TestSiteUnresolvedWhenHostMissing` / `TestSiteIPLiteralTreatedAsUnresolved` / `TestDeviceAliasApplied` / `TestSiteGroupRuleFirstMatchWins` / `TestProxyNormalization` / `TestGlobalTotalsMonotonic` |
| `integration_test.go`（包 `ledger_test`） | `TestEndToEndAgainstMockMihomo` |
| `snapshot_test.go` | `TestSaveLoadRoundTrip` / `TestLoadMissingFileReturnsNil` / `TestLoadCorruptFileReturnsError` / `TestSaveLeavesNoTempFile` |
| `collector_test.go` | `TestCollectEmitsAllMetrics` / `TestCollectValuesMatchLedger` / `TestCollectMonotonic` / `TestCollectSkipsEvictedEntries` |
| `httpapi_test.go` | `TestHealthz` / `TestIndexPage` / `TestMetricsEndpoint` |

## 风险与实现注意点

1. 账本用一把 `sync.Mutex`，`Observe` / `Export` / `Snapshot` 都拿写锁（`Export` 是写操作，不能用读锁），锁内不做网络 IO。
2. 重锚拆两半：重新启用在 `Observe` 中完成，第一次导出取上次导出值在 `Export` 中完成，采集器不得自行加减小计。
3. 快照原子性 = 同目录临时文件 + `fsync` + `rename` + 目录 `fsync`，且必须包含活跃连接表。
4. 站点标签只取 `host`，缺失或为 IP 字面量（含 `198.18.0.0/15`）一律归 `unresolved`，绝不用 `destinationIP`。
5. 计数器只增不减：核心序列值来自 `LastExported` 这一单调量，全局对账取历史最大值；用常量指标按账本值生成，而不是让注册表自加计数器。
6. 退出顺序 = 停协程 → 关 HTTP → 最后写快照。
7. 轮询失败只置 `Up = 0`，绝不做消失检测。
8. 客户端超时取 `max(10s, 2×poll_interval)`，防止轮询重叠。
9. `other` 桶不占配额，站点集合随快照持久化。
10. 时间全部以参数 `now` 注入，测试不使用 `time.Sleep`。
