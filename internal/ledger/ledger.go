// Package ledger 维护 ClashExporter 的流量账本：把 mihomo 每条连接上不断增长的
// 累计字节数换算成增量，累加到「设备 × 站点 × 节点」三个维度组合上，
// 并负责标签归一化、淘汰与重锚、全局对账值。
//
// 账本是所有导出指标的唯一数据源，状态可完整快照与恢复。
//
// 已知损失边界：连接在最后一次轮询之后、关闭之前产生的流量不可观测，
// 属已知损失，上限约为一个轮询间隔。
package ledger

import (
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sankabox/clash-exporter/internal/mihomo"
)

const (
	// StateVersion 是快照格式版本，结构不兼容变更时递增。
	StateVersion = 1

	// SiteUnresolved 是站点标签无法判定时的占位标签（host 缺失或为 IP 字面量）。
	SiteUnresolved = "unresolved"

	// SiteOther 是站点数量超出上限后的兜底标签，本身不占配额。
	SiteOther = "other"

	// ProxyUnknown 是代理链为空时的占位标签。
	ProxyUnknown = "unknown"

	// ProxyDirect 是直连（chains 首元素为 DIRECT）的归一化标签。
	ProxyDirect = "direct"

	// ProxyReject 是拒绝（chains 首元素为 REJECT）的归一化标签。
	ProxyReject = "reject"

	// DeviceUnknown 是连接缺少源 IP 时的占位标签。
	DeviceUnknown = "unknown"

	// DirectionUpload / DirectionDownload 是流量方向标签。
	DirectionUpload   = "upload"
	DirectionDownload = "download"

	// defaultSiteCap 与 defaultEvictTTL 是未显式配置时的回落值。
	defaultSiteCap  = 10000
	defaultEvictTTL = 24 * time.Hour

	// defaultPruneTTL 是账本过期条目清理时限的回落值（7 天）。
	defaultPruneTTL = 168 * time.Hour
)

// Key 是一个账本条目的三个维度。
type Key struct {
	Device string `json:"device"`
	Site   string `json:"site"`
	Proxy  string `json:"proxy"`
}

// Entry 是单个组合的累计状态。
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

// ConnState 是活跃连接的状态：最后观测到的累计值与已并入账本的数量。
type ConnState struct {
	ID                string `json:"id"`
	Device            string `json:"device"`
	Site              string `json:"site"`
	Proxy             string `json:"proxy"`
	Upload            uint64 `json:"upload"`
	Download          uint64 `json:"download"`
	AccountedUpload   uint64 `json:"accounted_upload"`
	AccountedDownload uint64 `json:"accounted_download"`
}

// EntryState 是带维度的账本条目，用于快照。
type EntryState struct {
	Entry
	Key
}

// State 是账本的可持久化状态。
type State struct {
	Version                  int          `json:"version"`
	UpdatedAt                time.Time    `json:"updated_at"`
	Entries                  []EntryState `json:"entries"`
	Sites                    []string     `json:"sites"`
	Connections              []ConnState  `json:"connections"`
	GlobalUploadTotal        uint64       `json:"global_upload_total"`
	GlobalDownloadTotal      uint64       `json:"global_download_total"`
	GlobalUploadMax          uint64       `json:"global_upload_max"`
	GlobalDownloadMax        uint64       `json:"global_download_max"`
	Up                       bool         `json:"up"`
	LastScrapeDurationSecond float64      `json:"last_scrape_duration_second"`
	LastActiveConnections    int          `json:"last_active_connections"`
}

// Series 是一条待导出的时间序列。
type Series struct {
	Device    string
	Site      string
	Proxy     string
	Direction string
	Value     uint64
}

// GroupRule 是一条已编译的站点归组规则。
type GroupRule struct {
	Pattern *regexp.Regexp
	Group   string
}

// Options 是账本的构造参数。
type Options struct {
	SiteCap  int
	EvictTTL time.Duration
	// PruneTTL 是过期条目清理时限：条目被淘汰且静默超过该时长后从账本删除。
	PruneTTL      time.Duration
	DeviceAliases map[string]string
	GroupRules    []GroupRule
}

// goneConn 是已消失连接的基线记录。
type goneConn struct {
	state ConnState
	// lastSeen 是该连接最后一次出现在活跃表中的轮次时间（近似值，误差不超过一个轮询间隔）。
	lastSeen time.Time
}

// Ledger 是流量账本。所有方法都在同一把写锁下操作，锁内不做网络 IO。
type Ledger struct {
	mu   sync.Mutex
	opts Options

	entries map[Key]*Entry
	sites   map[string]struct{}
	conns   map[string]*ConnState

	// gone 保存已消失连接的基线（墓碑）：连接移出活跃表后仍保留它最后读到的累计值，
	// 这样同 ID 连接稍后重现时可以沿用旧基线只计新增量，不会把已计过的部分重复计入。
	// 墓碑不参与导出、不写入快照，超过 prune_ttl 后清理。
	gone map[string]goneConn

	globalUploadTotal   uint64
	globalDownloadTotal uint64
	globalUploadMax     uint64
	globalDownloadMax   uint64

	up                    bool
	lastScrapeDuration    time.Duration
	lastActiveConnections int
	lastNow               time.Time
}

// New 创建账本。归组规则必须已编译且非空，非法组合在构造期报错。
func New(opts Options) (*Ledger, error) {
	if opts.SiteCap <= 0 {
		opts.SiteCap = defaultSiteCap
	}
	if opts.EvictTTL <= 0 {
		opts.EvictTTL = defaultEvictTTL
	}
	if opts.PruneTTL <= 0 {
		opts.PruneTTL = defaultPruneTTL
	}

	aliases := make(map[string]string, len(opts.DeviceAliases))
	for k, v := range opts.DeviceAliases {
		aliases[k] = v
	}

	rules := make([]GroupRule, 0, len(opts.GroupRules))
	for i, r := range opts.GroupRules {
		if r.Pattern == nil {
			return nil, fmt.Errorf("归组规则[%d] 的正则未编译", i)
		}
		if strings.TrimSpace(r.Group) == "" {
			return nil, fmt.Errorf("归组规则[%d] 的归组名不能为空", i)
		}
		rules = append(rules, GroupRule{Pattern: r.Pattern, Group: r.Group})
	}

	return &Ledger{
		opts: Options{
			SiteCap:       opts.SiteCap,
			EvictTTL:      opts.EvictTTL,
			PruneTTL:      opts.PruneTTL,
			DeviceAliases: aliases,
			GroupRules:    rules,
		},
		entries: make(map[Key]*Entry),
		sites:   make(map[string]struct{}),
		conns:   make(map[string]*ConnState),
		gone:    make(map[string]goneConn),
	}, nil
}

// Observe 处理一轮拉取结果，顺序固定：
// ① 活跃连接增量入账 → ② 消失连接移出活跃表 → ③ 淘汰扫描与过期条目清理 → ④ 全局对账值更新。
//
// now 由调用方注入，便于测试与快照时间的一致性；出现时钟回拨时按上次时间处理。
func (l *Ledger) Observe(now time.Time, resp *mihomo.ConnectionsResponse) {
	l.mu.Lock()
	defer l.mu.Unlock()

	// 单调时钟保护：注入的时间若早于上一次（时钟回拨），沿用上一次的时间。
	// 否则「now - LastActivity」可能为负，条目永远达不到淘汰条件。
	if l.lastNow.IsZero() {
		l.lastNow = now
	} else if now.Before(l.lastNow) {
		now = l.lastNow
	}

	if resp == nil {
		return
	}

	seen := make(map[string]struct{}, len(resp.Connections))

	// ① 活跃连接增量入账
	for i := range resp.Connections {
		conn := &resp.Connections[i]
		device := l.resolveDevice(conn.Metadata.SourceIP)
		proxy := l.resolveProxy(conn.Chains)

		seen[conn.ID] = struct{}{}

		st, ok := l.conns[conn.ID]
		var deltaUpload, deltaDownload uint64
		switch {
		case ok:
			// 已知连接：按增量计入
			deltaUpload = saturatingSub(conn.Upload, st.Upload)
			deltaDownload = saturatingSub(conn.Download, st.Download)
		default:
			if tomb, existed := l.gone[conn.ID]; existed {
				// 该 ID 之前出现过但已离开活跃表：沿用消失前的基线，只计新增量，
				// 不把之前已经计入账本的部分重复计入。
				delete(l.gone, conn.ID)
				st = &tomb.state
				deltaUpload = saturatingSub(conn.Upload, st.Upload)
				deltaDownload = saturatingSub(conn.Download, st.Download)
			} else {
				// 首次出现：历史累计值一次性全量计入
				deltaUpload, deltaDownload = conn.Upload, conn.Download
				st = &ConnState{ID: conn.ID, Device: device, Proxy: proxy}
			}
			l.conns[conn.ID] = st
		}

		// 计数器回退时增量为 0 并重置基线，同时把已入账量对齐到新基线
		if conn.Upload >= st.Upload {
			st.AccountedUpload += deltaUpload
		} else {
			deltaUpload = 0
			st.AccountedUpload = conn.Upload
		}
		if conn.Download >= st.Download {
			st.AccountedDownload += deltaDownload
		} else {
			deltaDownload = 0
			st.AccountedDownload = conn.Download
		}

		st.Upload = conn.Upload
		st.Download = conn.Download
		st.Device, st.Proxy = device, proxy

		if deltaUpload == 0 && deltaDownload == 0 {
			// 本轮没有实际增量：不入账，也不占用站点配额（零流量连接不占配额）
			continue
		}

		// 只有本轮有实际增量的连接才占用站点配额
		site := l.admitSite(l.resolveSite(conn.Metadata.Host))
		st.Site = site
		l.creditLocked(Key{Device: device, Site: site, Proxy: proxy}, deltaUpload, deltaDownload, now)
	}

	// ② 消失连接：移出活跃表，不做任何补账。
	//
	// 每轮 Observe 中 st.AccountedUpload 与 st.Upload 同步推进（两者恒等是可归纳证明的不变式），
	// 因此「最后观测值 - 已入账值」的残余差值恒为 0，补账分支是不可达的死代码。
	//
	// 已知损失边界：连接在最后一次轮询之后、关闭之前产生的流量不可观测，
	// 属已知损失，上限约为一个轮询间隔（poll_interval）。
	//
	// 这里只保留连接的基线（墓碑），供同 ID 连接稍后重现时算增量用。
	for id, st := range l.conns {
		if _, ok := seen[id]; ok {
			continue
		}
		delete(l.conns, id)
		l.gone[id] = goneConn{state: *st, lastSeen: now}
	}

	// ③ 淘汰扫描：超过 TTL 没有新增字节的条目停止导出（数据保留）
	for _, e := range l.entries {
		if e.Evicted {
			continue
		}
		if now.Sub(e.LastActivity) >= l.opts.EvictTTL {
			e.Evicted = true
		}
	}

	// ③.2 过期条目清理：条目被淘汰、没有待导出增量、且静默超过 prune_ttl 后，
	// 直接从账本删除，快照随之不再包含它。
	//
	// 无损性依据：条目被淘汰时已连续 evict_ttl 没有新增字节，待导出增量为 0 说明
	// 累计值已经完整导出过（total == lastExported），删除只是丢掉一段「此后没有变化」的
	// 历史值；若该组合日后重现，会以新基线重新计数，Prometheus 端按新序列处理，
	// 没有任何已观测字节丢失。
	// 带待导出增量的条目不删：这些增量在组合重现后仍会被补报（重锚后第二次导出补齐）。
	for key, e := range l.entries {
		if !e.Evicted || e.PendingUpload != 0 || e.PendingDownload != 0 {
			continue
		}
		if now.Sub(e.LastActivity) < l.opts.PruneTTL {
			continue
		}
		delete(l.entries, key)
	}

	// ③.3 墓碑清理：超过 prune_ttl 的消失连接基线不再保留
	for id, g := range l.gone {
		if now.Sub(g.lastSeen) >= l.opts.PruneTTL {
			delete(l.gone, id)
		}
	}

	// ④ 全局对账值：记录原值，并维护历史最大值防止内核重启导致回退
	l.globalUploadTotal = resp.UploadTotal
	l.globalDownloadTotal = resp.DownloadTotal
	if resp.UploadTotal > l.globalUploadMax {
		l.globalUploadMax = resp.UploadTotal
	}
	if resp.DownloadTotal > l.globalDownloadMax {
		l.globalDownloadMax = resp.DownloadTotal
	}
	l.up = true
	l.lastActiveConnections = len(l.conns)
}

// Export 导出当前所有未被淘汰的序列。
//
// 导出是写操作：取值后推进「已导出值」并清空「待导出增量」。
// 重锚后的第一次导出取值等于上次导出值（保持 Prometheus 端计数器连续），待导出增量保留到下一次导出。
//
// 排序在锁外完成：锁内只拷贝序列并推进导出状态，避免长时间持锁阻塞采集协程。
func (l *Ledger) Export() []Series {
	series := l.collectSeriesLocked()

	sort.Slice(series, func(i, j int) bool {
		a, b := series[i], series[j]
		if a.Device != b.Device {
			return a.Device < b.Device
		}
		if a.Site != b.Site {
			return a.Site < b.Site
		}
		if a.Proxy != b.Proxy {
			return a.Proxy < b.Proxy
		}
		return a.Direction < b.Direction
	})
	return series
}

// collectSeriesLocked 在持锁状态下拷贝当前序列并推进导出状态。
func (l *Ledger) collectSeriesLocked() []Series {
	l.mu.Lock()
	defer l.mu.Unlock()

	series := make([]Series, 0, len(l.entries)*2)
	for key, e := range l.entries {
		if e.Evicted {
			continue
		}

		upload, download := e.LastExportedUpload, e.LastExportedDownload
		if e.Reanchored {
			// 重锚后的第一次导出：取值等于上次导出值，待导出增量保留
			e.Reanchored = false
		} else {
			upload = e.LastExportedUpload + e.PendingUpload
			download = e.LastExportedDownload + e.PendingDownload
			e.LastExportedUpload = upload
			e.LastExportedDownload = download
			e.PendingUpload = 0
			e.PendingDownload = 0
		}

		series = append(series,
			Series{Device: key.Device, Site: key.Site, Proxy: key.Proxy, Direction: DirectionUpload, Value: upload},
			Series{Device: key.Device, Site: key.Site, Proxy: key.Proxy, Direction: DirectionDownload, Value: download},
		)
	}
	return series
}

// Snapshot 返回账本状态的深拷贝。
func (l *Ledger) Snapshot() *State {
	l.mu.Lock()
	defer l.mu.Unlock()

	st := &State{
		Version:                  StateVersion,
		UpdatedAt:                l.lastNow,
		Entries:                  make([]EntryState, 0, len(l.entries)),
		Sites:                    make([]string, 0, len(l.sites)),
		Connections:              make([]ConnState, 0, len(l.conns)),
		GlobalUploadTotal:        l.globalUploadTotal,
		GlobalDownloadTotal:      l.globalDownloadTotal,
		GlobalUploadMax:          l.globalUploadMax,
		GlobalDownloadMax:        l.globalDownloadMax,
		Up:                       l.up,
		LastScrapeDurationSecond: l.lastScrapeDuration.Seconds(),
		LastActiveConnections:    l.lastActiveConnections,
	}

	for key, e := range l.entries {
		st.Entries = append(st.Entries, EntryState{Entry: *e, Key: key})
	}
	for site := range l.sites {
		st.Sites = append(st.Sites, site)
	}
	for _, c := range l.conns {
		st.Connections = append(st.Connections, *c)
	}

	sort.Slice(st.Entries, func(i, j int) bool {
		a, b := st.Entries[i], st.Entries[j]
		if a.Key.Device != b.Key.Device {
			return a.Key.Device < b.Key.Device
		}
		if a.Key.Site != b.Key.Site {
			return a.Key.Site < b.Key.Site
		}
		return a.Key.Proxy < b.Key.Proxy
	})
	sort.Strings(st.Sites)
	sort.Slice(st.Connections, func(i, j int) bool { return st.Connections[i].ID < st.Connections[j].ID })

	return st
}

// Restore 用快照覆盖账本状态。
//
// 必须恢复活跃连接表：否则重启后仍然存活的连接会被当作「首次出现」而全量计入，造成流量虚高。
func (l *Ledger) Restore(st *State) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if st == nil {
		return
	}

	l.entries = make(map[Key]*Entry, len(st.Entries))
	for _, es := range st.Entries {
		entry := es.Entry
		l.entries[es.Key] = &entry
	}

	l.sites = make(map[string]struct{}, len(st.Sites))
	for _, site := range st.Sites {
		l.sites[site] = struct{}{}
	}

	l.conns = make(map[string]*ConnState, len(st.Connections))
	for i := range st.Connections {
		conn := st.Connections[i]
		l.conns[conn.ID] = &conn
	}

	// 墓碑不入快照：恢复后按「首次出现」处理重现的连接 ID
	l.gone = make(map[string]goneConn)

	l.globalUploadTotal = st.GlobalUploadTotal
	l.globalDownloadTotal = st.GlobalDownloadTotal
	l.globalUploadMax = st.GlobalUploadMax
	l.globalDownloadMax = st.GlobalDownloadMax
	l.up = st.Up
	l.lastScrapeDuration = time.Duration(st.LastScrapeDurationSecond * float64(time.Second))
	l.lastActiveConnections = st.LastActiveConnections
	if !st.UpdatedAt.IsZero() {
		l.lastNow = st.UpdatedAt
	}
}

// Up 返回最近一次拉取是否成功。
func (l *Ledger) Up() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.up
}

// SetUp 设置 mihomo 可达性标记（拉取失败时置 false）。
func (l *Ledger) SetUp(up bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.up = up
}

// LastScrapeDuration 返回最近一轮采集耗时。
func (l *Ledger) LastScrapeDuration() time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastScrapeDuration
}

// SetScrapeDuration 记录最近一轮采集耗时。
func (l *Ledger) SetScrapeDuration(d time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lastScrapeDuration = d
}

// ActiveConnections 返回最近一轮观察到的活跃连接数。
func (l *Ledger) ActiveConnections() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastActiveConnections
}

// Connections 返回活跃连接表的副本（按 ID 排序），供只读检查与调试使用。
func (l *Ledger) Connections() []ConnState {
	l.mu.Lock()
	defer l.mu.Unlock()

	out := make([]ConnState, 0, len(l.conns))
	for _, c := range l.conns {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// EntryCount 返回账本条目数。
func (l *Ledger) EntryCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.entries)
}

// GlobalUpload 返回全局上行对账值（历史最大值，单调不减）。
func (l *Ledger) GlobalUpload() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.globalUploadMax
}

// GlobalDownload 返回全局下行对账值（历史最大值，单调不减）。
func (l *Ledger) GlobalDownload() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.globalDownloadMax
}

// creditLocked 把字节增量累加进账本条目，并处理淘汰状态下的重锚。
func (l *Ledger) creditLocked(key Key, upload, download uint64, now time.Time) {
	e, ok := l.entries[key]
	if !ok {
		e = &Entry{}
		l.entries[key] = e
	}

	e.TotalUpload += upload
	e.TotalDownload += download
	e.PendingUpload += upload
	e.PendingDownload += download
	e.LastActivity = now

	if e.Evicted {
		// 被淘汰的组合再次产生流量：重新启用并标记重锚，
		// 累计值与待导出增量都不清零。
		e.Evicted = false
		e.Reanchored = true
	}
}

// resolveDevice 把源 IP 归一化为设备标签：命中别名用别名，否则用原始 IP。
func (l *Ledger) resolveDevice(sourceIP string) string {
	ip := strings.TrimSpace(sourceIP)
	if ip == "" {
		return DeviceUnknown
	}
	if alias, ok := l.opts.DeviceAliases[ip]; ok && alias != "" {
		return alias
	}
	return ip
}

// resolveSite 把 host 归一化为站点标签。
//
// 空值归 unresolved；按顺序取首条命中的归组规则；否则取 host 小写去空格；
// IP 字面量（含 fake-ip 保留段 198.18.0.0/15）归 unresolved。
func (l *Ledger) resolveSite(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return SiteUnresolved
	}
	for _, rule := range l.opts.GroupRules {
		if rule.Pattern.MatchString(h) {
			return rule.Group
		}
	}
	if isIPLiteral(h) {
		return SiteUnresolved
	}
	return h
}

// resolveProxy 取代理链首元素作为实际出口节点：DIRECT / REJECT 归一化，空链归 unknown。
//
// 顺序依据（2026-10-26 对真实 mihomo v1.19.30（192.168.2.2:9090）的 /connections 实测）：
// chains 数组的排列是 [实际出口节点, 策略组]，例如
//
//	["🇭🇰 E-香港2", "KyCloud"]  6 条
//	["🇭🇰 E-香港5", "KyCloud"]  1 条
//	["DIRECT"]                23 条
//
// 即首元素是真实出口、末元素是策略组名。取末元素会把全部代理流量归到策略组名下，
// 破坏按节点统计的核心需求。改动此函数前请先复核真实数据，不要改回取末元素。
func (l *Ledger) resolveProxy(chains []string) string {
	if len(chains) == 0 {
		return ProxyUnknown
	}
	first := strings.TrimSpace(chains[0])
	if first == "" {
		return ProxyUnknown
	}
	switch strings.ToUpper(first) {
	case "DIRECT":
		return ProxyDirect
	case "REJECT":
		return ProxyReject
	}
	return first
}

// admitSite 维护站点集合并执行配额：超出上限的新站点归入 other 桶（other 不占配额）。
func (l *Ledger) admitSite(site string) string {
	if site == SiteOther {
		return SiteOther
	}
	if _, ok := l.sites[site]; ok {
		return site
	}
	if len(l.sites) >= l.opts.SiteCap {
		return SiteOther
	}
	l.sites[site] = struct{}{}
	return site
}

// isIPLiteral 判断字符串是否为 IP 字面量（含 IPv4、IPv6 与带方括号的 IPv6）。
func isIPLiteral(s string) bool {
	if net.ParseIP(s) != nil {
		return true
	}
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		return net.ParseIP(s[1:len(s)-1]) != nil
	}
	return false
}

// saturatingSub 做饱和减法：结果不为负。
func saturatingSub(a, b uint64) uint64 {
	if a <= b {
		return 0
	}
	return a - b
}
