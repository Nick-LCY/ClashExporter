# ClashExporter

mihomo（clash.meta 内核）流量 Prometheus exporter。单二进制、无外部依赖（除 Go 标准库、prometheus 客户端与 YAML 解析库），以 systemd 方式常驻。

## 一、简介与工作原理

### 要解决的问题

mihomo 的 `/connections` 接口只暴露**当前活跃连接**的列表，每条连接带上它自身生命周期内的累计字节数；连接一旦关闭就从列表里消失，接口不提供任何历史累计值，也不提供「某台设备到某网站累计用了多少字节」这种聚合口径。

要回答「每台机器、每个网站、在每个代理节点上各消耗了多少流量」，exporter 必须在本地维护一份**有状态的账本**，把每条连接上不断增长的累计字节数换算成增量累加进去，再以 Prometheus 计数器的形式对外暴露。

### 数据流向

```
mihomo API  ──GET /connections──▶  轮询协程  ──▶  账本（增量归账 + 标签归一化）
                                                          │
                                                     Export()│
                                                          ▼
              Prometheus  ◀──GET /metrics──  HTTP 服务  ◀──  采集器
                                                          ▲
                                        快照 JSON  ──定时写盘 / 启动恢复──  账本
```

### 工作原理要点

- **增量归账**：默认每 5 秒拉一次 `/connections`。每条连接记录上次读数，按差值累加进账本；首次出现的连接把历史累计值一次性计入；计数器回退（内核重启）时增量记 0 并重置基线，绝不出现负值；连接消失时把残余差值补进账本后再从活跃表删除。
- **标签归一化**：`device` 取连接的源 IP（可配别名），`site` 取嗅探到的域名（空或 IP 字面量归 `unresolved`，绝不拿目标 IP 冒充站点），`proxy` 取代理链首元素即真实出口节点（`DIRECT` / `REJECT` 归一化为 `direct` / `reject`）。
- **计数器只增不减**：导出值取自账本里的「已导出值」这一单调量。跨进程重启由快照保证不归零；某组合长时间无流量被淘汰后再次出现时，重锚续报，Prometheus 端 `increase()` 跨空洞零丢失。
- **失败只降级不误判**：拉取失败仅把 `clash_up` 置 0，**绝不执行消失检测**。网络抖动若把活连接误判为消失，会重复计入其累计值造成流量虚高。
- **不做什么**：不落时序数据库、不做本地历史存储、不做可视化看板、不改造 mihomo 鉴权、不做流量控制。一个 exporter 实例只对应一台 mihomo。

### 快速开始

```bash
go build -o bin/clash-exporter .
./bin/clash-exporter -config config.example.yml
curl -s localhost:9095/metrics | grep '^clash_'
```

## 二、指标表

| 指标 | 类型 | 标签 | 含义 |
|---|---|---|---|
| `clash_traffic_bytes_total` | counter | `device`、`site`、`proxy`、`direction` | 核心指标：设备 × 站点 × 出口节点 的累计流量字节数，`direction` 取 `upload` / `download` |
| `clash_traffic_total_bytes_total` | counter | `direction` | 全局对账指标：mihomo 上报的总流量字节数，取历史最大值防止内核重启导致回退 |
| `clash_active_connections` | gauge | — | 最近一轮观察到的活跃连接数 |
| `clash_up` | gauge | — | mihomo 内核可达性，`1` 可达、`0` 不可达 |
| `clash_scrape_duration_seconds` | gauge | — | 最近一轮采集 `/connections` 的耗时（秒） |
| `clash_exporter_state_entries` | gauge | — | 账本当前的条目数（含已淘汰但数据仍保留的条目） |

核心指标是**单张全维度表**，exporter 不预聚合、不产出交叉表；所有维度切片统计交给 Prometheus 查询时聚合：

| 想回答的问题 | PromQL |
|---|---|
| 每台设备总流量 | `sum by (device) (increase(clash_traffic_bytes_total[1h]))` |
| 每个网站总流量 | `sum by (site) (increase(clash_traffic_bytes_total[1h]))` |
| 每个代理节点总流量 | `sum by (proxy) (increase(clash_traffic_bytes_total[1h]))` |
| 设备 × 网站 | `sum by (device, site) (increase(clash_traffic_bytes_total[1h]))` |
| 设备 × 节点 | `sum by (device, proxy) (increase(clash_traffic_bytes_total[1h]))` |
| 站点 × 节点 | `sum by (site, proxy) (increase(clash_traffic_bytes_total[1h]))` |
| 上行 / 下行拆分 | `sum by (direction) (increase(clash_traffic_bytes_total[1h]))` |
| 单个组合的趋势 | `increase(clash_traffic_bytes_total{device="192.168.2.100", site="youtube.com", proxy="🇭🇰 E-香港2"}[5m])` |

### 标签取值规则

| 标签 | 来源 | 规则 |
|---|---|---|
| `device` | 连接源 IP | 命中 `device_aliases` 用别名，否则用原始 IP；缺失时为 `unknown` |
| `site` | 连接的 `host` | 空、或为 IP 字面量（含 fake-ip 保留段 `198.18.0.0/15`）归 `unresolved`；命中 `site_group_rules` 的首条规则用归组名；否则用小写域名 |
| `proxy` | 代理链 `chains` 首元素 | 真实出口节点名；`DIRECT` → `direct`，`REJECT` → `reject`，空链 → `unknown` |
| `direction` | 流量方向 | `upload` / `download` |

## 三、配置说明

配置文件是单个 YAML，通过 `-config` 指定；未出现的字段使用默认值，未知字段直接报错。完整示例见仓库根目录的 `config.example.yml`。

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `api_url` | string | `http://192.168.2.2:9090` | mihomo API 基础地址（不含 `/connections`），scheme 必须是 `http` 或 `https` |
| `api_secret` | string | 空 | mihomo 鉴权密钥；非空时带 `Authorization: Bearer` 头，为空时不带鉴权头 |
| `poll_interval` | duration | `5s` | 轮询间隔，取值范围 `[1s, 60s]`；支持 `"5s"` / `"24h"` 字符串与整数秒 |
| `evict_ttl` | duration | `24h` | 淘汰时间：某组合连续该时长没有新增字节即停止导出（数据保留，再次来流量时自动重锚续报） |
| `snapshot_interval` | duration | `30s` | 快照写盘间隔 |
| `site_label_cap` | int | `10000` | 站点标签去重上限，超出的新站点归入 `other` 桶（`other` 本身不占配额） |
| `snapshot_path` | string | `./data/state.json` | 快照文件路径，父目录自动创建 |
| `listen_addr` | string | `:9095` | HTTP 监听地址，暴露 `/metrics`、`/`、`/healthz` |
| `device_aliases` | map | `{}` | 源 IP → 设备别名，例如 `"198.18.0.1": "旁路由本机"` |
| `site_group_rules` | list | `[]` | 站点归组规则，按顺序匹配，首条命中的规则生效 |

配置示例（节选）：

```yaml
api_url: "http://192.168.2.2:9090"
api_secret: ""
poll_interval: 5s
evict_ttl: 24h
snapshot_interval: 30s
site_label_cap: 10000
snapshot_path: "./data/state.json"
listen_addr: ":9095"

# 路由器本机自身发起的流量源 IP 是 TUN 网关地址，起个别名即可单独归类
device_aliases:
  "198.18.0.1": "旁路由本机"

# 按域名归组，首条命中的规则生效
site_group_rules:
  - pattern: "(?i)\\.google\\.com$"
    group: "google"
```

### HTTP 端点

| 端点 | 说明 |
|---|---|
| `GET /metrics` | Prometheus 抓取端点 |
| `GET /` | 纯文本说明页 |
| `GET /healthz` | 健康检查，返回 `ok` |

## 四、systemd 部署示例

目标机：局域网内的 7640HS 主机（与 mihomo 旁路由同网段）。二进制放 `/usr/local/bin`，配置放 `/etc/clash-exporter`，快照放 `/var/lib/clash-exporter`，使用专用低权限用户运行。

### 1. 准备目录与用户

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin clash-exporter
sudo mkdir -p /etc/clash-exporter /var/lib/clash-exporter
sudo chown clash-exporter:clash-exporter /var/lib/clash-exporter
```

### 2. 安装二进制与配置

```bash
sudo install -m 0755 bin/clash-exporter /usr/local/bin/clash-exporter
sudo install -m 0644 config.example.yml /etc/clash-exporter/config.yml
sudo vi /etc/clash-exporter/config.yml   # 按需修改 api_url / listen_addr / device_aliases
```

配置里把快照路径指向 systemd 管理的目录：

```yaml
snapshot_path: "/var/lib/clash-exporter/state.json"
```

### 3. systemd 单元

`/etc/systemd/system/clash-exporter.service`：

```ini
[Unit]
Description=ClashExporter - mihomo traffic Prometheus exporter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=clash-exporter
Group=clash-exporter
ExecStart=/usr/local/bin/clash-exporter -config /etc/clash-exporter/config.yml
Restart=always
RestartSec=5s

# 快照目录可写，其余只读
StateDirectory=clash-exporter
ReadWritePaths=/var/lib/clash-exporter
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

### 4. 启动与自启

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now clash-exporter
sudo systemctl status clash-exporter
journalctl -u clash-exporter -f
```

### 5. Prometheus 抓取配置

```yaml
scrape_configs:
  - job_name: clash-exporter
    scrape_interval: 15s
    static_configs:
      - targets: ["192.168.2.x:9095"]
```

### 6. 升级与卸载

```bash
# 升级：替换二进制后重启即可，快照会被恢复，计数器不归零
sudo install -m 0755 bin/clash-exporter /usr/local/bin/clash-exporter
sudo systemctl restart clash-exporter

# 卸载
sudo systemctl disable --now clash-exporter
sudo rm /etc/systemd/system/clash-exporter.service
sudo rm -rf /etc/clash-exporter /var/lib/clash-exporter
```

## 兼容性说明（实测结论）

以下结论来自 2026-10-26 对真实 mihomo 实例（`http://192.168.2.2:9090`，旁路由 NanoPi R2S，TUN 透明网关，已开 sniffer 与 fake-ip）的实测，代码实现与之一致。

1. **接口与字段**：内核为 **mihomo v1.19.30**（`/version` 返回 `{"meta":true,"version":"v1.19.30"}`）。`/connections` 的 `upload` / `download` 是 **JSON 数字**（不是字符串），客户端按 `uint64` 直接解析；`metadata.host` **存在但可能为空字符串**（无法识别域名时），空值归入 `unresolved` 站点桶；接口**无需鉴权头**，`api_secret` 留空即可（保留为兼容位，非空时发送 `Authorization: Bearer`）。

2. **`chains` 顺序为 `[出口节点, 策略组]`**：`chains` 数组的排列是「真实出口节点在前、策略组在后」，实测样本为 `["🇭🇰 E-香港2", "KyCloud"]`、`["🇭🇰 E-香港5", "KyCloud"]`、`["DIRECT"]`。因此 `proxy` 标签取**首元素**（真实出口节点），末元素的策略组名（如 `KyCloud`）不单独暴露。取末元素会把全部代理流量归到策略组名下，破坏按节点统计。

3. **设备维度的源 IP**：LAN 客户端的转发连接（`type=Redir`）**保留真实客户端 IP**，实测样例为 `192.168.2.135`、`192.168.2.187`、`192.168.2.33`；`198.18.0.1` 是 TUN 网关地址，**仅出现在路由器本机自身发起的流量**（`type=Tun`）上。因此建议在配置里给 `198.18.0.1` 起别名，把本机流量与局域网设备流量分开归类：

   ```yaml
   device_aliases:
     "198.18.0.1": "旁路由本机"
   ```

## 开发

```bash
go build ./...        # 编译
go vet ./...          # 静态检查
go test ./...         # 单元测试
gofmt -l .            # 格式检查（无输出即合规）
go mod tidy           # 依赖整理（直接依赖只有 prometheus/client_golang 与 gopkg.in/yaml.v3）
```
