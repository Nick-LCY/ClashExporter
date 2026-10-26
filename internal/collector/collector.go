// Package collector 把账本状态翻译成 Prometheus 指标。
//
// 采集器是只读出口：所有数值都来自账本的只读访问器与 Export()，
// 采集器自身不做任何加减，重锚与「已导出值」的推进完全由账本负责。
package collector

import (
	"github.com/prometheus/client_golang/prometheus"

	"github.com/sankabox/clash-exporter/internal/ledger"
)

// 指标名。名称原样写出（含 _total 后缀），与 Prometheus 抓取端看到的名字一致。
const (
	// NameTrafficBytes 是核心指标：设备 × 站点 × 出口节点 的累计流量字节数。
	NameTrafficBytes = "clash_traffic_bytes_total"
	// NameTrafficTotalBytes 是全局对账指标：mihomo 上报的总流量字节数。
	NameTrafficTotalBytes = "clash_traffic_total_bytes_total"
	// NameActiveConnections 是当前活跃连接数。
	NameActiveConnections = "clash_active_connections"
	// NameUp 是 mihomo 内核可达性。
	NameUp = "clash_up"
	// NameScrapeDuration 是最近一轮采集耗时（秒）。
	NameScrapeDuration = "clash_scrape_duration_seconds"
	// NameStateEntries 是账本条目数。
	NameStateEntries = "clash_exporter_state_entries"
)

// 指标帮助文本。与指标名一起构成对外契约，测试直接引用这些常量。
const (
	helpTrafficBytes      = "按 设备 × 站点 × 出口节点 拆分的累计流量字节数，direction 取 upload 或 download。"
	helpTrafficTotalBytes = "mihomo 内核上报的全局累计流量字节数，用于与分维度指标对账。"
	helpActiveConnections = "mihomo 当前活跃连接数。"
	helpUp                = "mihomo 内核可达性，1 表示可达，0 表示不可达。"
	helpScrapeDuration    = "最近一轮采集 /connections 的耗时（秒）。"
	helpStateEntries      = "账本当前的条目数（含已淘汰但数据仍保留的条目）。"
)

// Collector 是账本的 Prometheus 采集器，实现 prometheus.Collector 接口。
type Collector struct {
	book *ledger.Ledger

	trafficBytes      *prometheus.Desc
	trafficTotalBytes *prometheus.Desc
	activeConnections *prometheus.Desc
	up                *prometheus.Desc
	scrapeDuration    *prometheus.Desc
	stateEntries      *prometheus.Desc
}

// New 创建采集器。账本为 nil 时构造出的采集器不可用，调用方应保证非空。
func New(l *ledger.Ledger) *Collector {
	return &Collector{
		book: l,
		trafficBytes: prometheus.NewDesc(
			NameTrafficBytes,
			helpTrafficBytes,
			[]string{"device", "site", "proxy", "direction"},
			nil,
		),
		trafficTotalBytes: prometheus.NewDesc(
			NameTrafficTotalBytes,
			helpTrafficTotalBytes,
			[]string{"direction"},
			nil,
		),
		activeConnections: prometheus.NewDesc(
			NameActiveConnections,
			helpActiveConnections,
			nil,
			nil,
		),
		up: prometheus.NewDesc(
			NameUp,
			helpUp,
			nil,
			nil,
		),
		scrapeDuration: prometheus.NewDesc(
			NameScrapeDuration,
			helpScrapeDuration,
			nil,
			nil,
		),
		stateEntries: prometheus.NewDesc(
			NameStateEntries,
			helpStateEntries,
			nil,
			nil,
		),
	}
}

// Describe 描述采集器产出的全部指标。
func (c *Collector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.trafficBytes
	ch <- c.trafficTotalBytes
	ch <- c.activeConnections
	ch <- c.up
	ch <- c.scrapeDuration
	ch <- c.stateEntries
}

// Collect 采集全部指标。
//
// 核心序列的值直接取自账本导出结果，采集器不做任何加减；
// 被淘汰的条目由账本的 Export() 负责跳过。
func (c *Collector) Collect(ch chan<- prometheus.Metric) {
	for _, s := range c.book.Export() {
		ch <- prometheus.MustNewConstMetric(
			c.trafficBytes,
			prometheus.CounterValue,
			float64(s.Value),
			s.Device, s.Site, s.Proxy, s.Direction,
		)
	}

	ch <- prometheus.MustNewConstMetric(
		c.trafficTotalBytes,
		prometheus.CounterValue,
		float64(c.book.GlobalUpload()),
		ledger.DirectionUpload,
	)
	ch <- prometheus.MustNewConstMetric(
		c.trafficTotalBytes,
		prometheus.CounterValue,
		float64(c.book.GlobalDownload()),
		ledger.DirectionDownload,
	)

	ch <- prometheus.MustNewConstMetric(
		c.activeConnections,
		prometheus.GaugeValue,
		float64(c.book.ActiveConnections()),
	)
	ch <- prometheus.MustNewConstMetric(
		c.up,
		prometheus.GaugeValue,
		boolToFloat(c.book.Up()),
	)
	ch <- prometheus.MustNewConstMetric(
		c.scrapeDuration,
		prometheus.GaugeValue,
		c.book.LastScrapeDuration().Seconds(),
	)
	ch <- prometheus.MustNewConstMetric(
		c.stateEntries,
		prometheus.GaugeValue,
		float64(c.book.EntryCount()),
	)
}

// boolToFloat 把布尔值转成 1 / 0。
func boolToFloat(v bool) float64 {
	if v {
		return 1
	}
	return 0
}
