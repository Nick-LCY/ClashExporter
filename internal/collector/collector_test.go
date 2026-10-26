package collector

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/sankabox/clash-exporter/internal/ledger"
	"github.com/sankabox/clash-exporter/internal/mihomo"
)

// baseTime 是所有测试的基准时间，避免依赖 wall clock。
var baseTime = time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)

// newTestLedger 创建一个测试用账本。
func newTestLedger(t *testing.T, opts ledger.Options) *ledger.Ledger {
	t.Helper()
	if opts.SiteCap == 0 {
		opts.SiteCap = 10000
	}
	if opts.EvictTTL == 0 {
		opts.EvictTTL = 24 * time.Hour
	}
	l, err := ledger.New(opts)
	if err != nil {
		t.Fatalf("创建账本失败: %v", err)
	}
	return l
}

// conn 构造一条测试连接。
func conn(id, sourceIP, host string, chains []string, upload, download uint64) mihomo.Connection {
	return mihomo.Connection{
		ID: id,
		Metadata: mihomo.ConnectionMetadata{
			Network:  "tcp",
			Type:     "Redir",
			SourceIP: sourceIP,
			Host:     host,
		},
		Upload:   upload,
		Download: download,
		Chains:   chains,
	}
}

// resp 构造一份拉取响应。
func resp(conns ...mihomo.Connection) *mihomo.ConnectionsResponse {
	return &mihomo.ConnectionsResponse{Connections: conns}
}

// seriesValue 是一条被采集到的样本。
type seriesValue struct {
	labels map[string]string
	value  float64
}

// gatherSamples 通过注册表采集一次，返回「指标名 -> 样本列表」。
func gatherSamples(t *testing.T, c prometheus.Collector) map[string][]seriesValue {
	t.Helper()

	reg := prometheus.NewPedanticRegistry()
	if err := reg.Register(c); err != nil {
		t.Fatalf("注册采集器失败: %v", err)
	}
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("采集指标失败: %v", err)
	}

	out := make(map[string][]seriesValue, len(families))
	for _, mf := range families {
		for _, m := range mf.GetMetric() {
			labels := make(map[string]string, len(m.GetLabel()))
			for _, lp := range m.GetLabel() {
				labels[lp.GetName()] = lp.GetValue()
			}
			value := m.GetGauge().GetValue()
			if m.Counter != nil {
				value = m.GetCounter().GetValue()
			}
			out[mf.GetName()] = append(out[mf.GetName()], seriesValue{labels: labels, value: value})
		}
	}
	return out
}

// singleValue 取出只含一个样本的指标族的取值。
func singleValue(t *testing.T, samples map[string][]seriesValue, name string) float64 {
	t.Helper()

	list, ok := samples[name]
	if !ok {
		t.Fatalf("指标 %s 缺失", name)
	}
	if len(list) != 1 {
		t.Fatalf("指标 %s 的样本数 = %d, 期望 1", name, len(list))
	}
	return list[0].value
}

// findSample 按标签集合查找样本。
func findSample(samples []seriesValue, want map[string]string) (seriesValue, bool) {
	for _, s := range samples {
		if len(s.labels) != len(want) {
			continue
		}
		match := true
		for k, v := range want {
			if s.labels[k] != v {
				match = false
				break
			}
		}
		if match {
			return s, true
		}
	}
	return seriesValue{}, false
}

func TestCollectEmitsAllMetrics(t *testing.T) {
	book := newTestLedger(t, ledger.Options{})
	book.Observe(baseTime, resp(conn("c1", "192.168.2.135", "example.com", []string{"🇭🇰 E-香港2", "KyCloud"}, 100, 200)))
	book.SetScrapeDuration(120 * time.Millisecond)

	c := New(book)
	samples := gatherSamples(t, c)

	wantNames := []string{
		NameTrafficBytes,
		NameTrafficTotalBytes,
		NameActiveConnections,
		NameUp,
		NameScrapeDuration,
		NameStateEntries,
	}
	for _, name := range wantNames {
		if _, ok := samples[name]; !ok {
			t.Errorf("指标 %s 缺失", name)
		}
	}

	// 类型必须是 counter / gauge
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(c)
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("采集指标失败: %v", err)
	}
	types := make(map[string]string, len(families))
	for _, mf := range families {
		types[mf.GetName()] = mf.GetType().String()
	}
	for _, name := range []string{NameTrafficBytes, NameTrafficTotalBytes} {
		if types[name] != "COUNTER" {
			t.Errorf("指标 %s 的类型 = %s, 期望 COUNTER", name, types[name])
		}
	}
	for _, name := range []string{NameActiveConnections, NameUp, NameScrapeDuration, NameStateEntries} {
		if types[name] != "GAUGE" {
			t.Errorf("指标 %s 的类型 = %s, 期望 GAUGE", name, types[name])
		}
	}

	// 核心指标产出 upload / download 两条序列
	if got := testutil.CollectAndCount(c, NameTrafficBytes); got != 2 {
		t.Errorf("%s 的序列数 = %d, 期望 2", NameTrafficBytes, got)
	}
	// 全局对账指标产出 upload / download 两条序列
	if got := testutil.CollectAndCount(c, NameTrafficTotalBytes); got != 2 {
		t.Errorf("%s 的序列数 = %d, 期望 2", NameTrafficTotalBytes, got)
	}
}

func TestCollectValuesMatchLedger(t *testing.T) {
	book := newTestLedger(t, ledger.Options{})
	book.Observe(baseTime, resp(
		conn("c1", "192.168.2.135", "example.com", []string{"🇭🇰 E-香港2", "KyCloud"}, 100, 200),
		conn("c2", "198.18.0.1", "stun.hitv.com", []string{"DIRECT"}, 50, 25),
	))
	book.SetScrapeDuration(80 * time.Millisecond)

	series := book.Export()
	c := New(book)
	samples := gatherSamples(t, c)

	for _, s := range series {
		got, ok := findSample(samples[NameTrafficBytes], map[string]string{
			"device":    s.Device,
			"site":      s.Site,
			"proxy":     s.Proxy,
			"direction": s.Direction,
		})
		if !ok {
			t.Fatalf("指标缺少序列 %s/%s/%s/%s", s.Device, s.Site, s.Proxy, s.Direction)
		}
		if got.value != float64(s.Value) {
			t.Errorf("序列 %s/%s/%s/%s 的值 = %v, 期望 %d", s.Device, s.Site, s.Proxy, s.Direction, got.value, s.Value)
		}
	}

	// 辅助指标
	if got := singleValue(t, samples, NameActiveConnections); got != 2 {
		t.Errorf("%s = %v, 期望 2", NameActiveConnections, got)
	}
	if got := singleValue(t, samples, NameUp); got != 1 {
		t.Errorf("%s = %v, 期望 1", NameUp, got)
	}
	if got := singleValue(t, samples, NameScrapeDuration); got != 0.08 {
		t.Errorf("%s = %v, 期望 0.08", NameScrapeDuration, got)
	}
	if got := singleValue(t, samples, NameStateEntries); got != 2 {
		t.Errorf("%s = %v, 期望 2", NameStateEntries, got)
	}
}

func TestCollectMonotonic(t *testing.T) {
	book := newTestLedger(t, ledger.Options{})
	c := New(book)

	book.Observe(baseTime, resp(conn("c1", "192.168.2.135", "example.com", []string{"node-a"}, 100, 200)))
	first := gatherSamples(t, c)

	book.Observe(baseTime.Add(5*time.Second), resp(conn("c1", "192.168.2.135", "example.com", []string{"node-a"}, 350, 900)))
	second := gatherSamples(t, c)

	labels := map[string]string{
		"device":    "192.168.2.135",
		"site":      "example.com",
		"proxy":     "node-a",
		"direction": ledger.DirectionDownload,
	}
	before, ok := findSample(first[NameTrafficBytes], labels)
	if !ok {
		t.Fatal("首轮缺少目标序列")
	}
	after, ok := findSample(second[NameTrafficBytes], labels)
	if !ok {
		t.Fatal("第二轮缺少目标序列")
	}
	if after.value < before.value {
		t.Errorf("连续采集出现下降: %v -> %v", before.value, after.value)
	}
	if after.value != 900 {
		t.Errorf("第二轮下行值 = %v, 期望 900", after.value)
	}
}

func TestCollectSkipsEvictedEntries(t *testing.T) {
	book := newTestLedger(t, ledger.Options{EvictTTL: 24 * time.Hour})
	book.Observe(baseTime, resp(conn("c1", "192.168.2.135", "example.com", []string{"node-a"}, 100, 200)))
	c := New(book)

	if got := testutil.CollectAndCount(c, NameTrafficBytes); got != 2 {
		t.Fatalf("淘汰前序列数 = %d, 期望 2", got)
	}

	// 超过 TTL 没有新增字节：条目被淘汰，不再导出
	book.Observe(baseTime.Add(25*time.Hour), resp())
	if got := testutil.CollectAndCount(c, NameTrafficBytes); got != 0 {
		t.Errorf("淘汰后序列数 = %d, 期望 0", got)
	}
	// 账本条目仍然保留
	if got := singleValue(t, gatherSamples(t, c), NameStateEntries); got != 1 {
		t.Errorf("%s = %v, 期望 1", NameStateEntries, got)
	}
}

// TestCollectExpositionFormat 校验对外的文本格式：指标名、标签与数值。
func TestCollectExpositionFormat(t *testing.T) {
	book := newTestLedger(t, ledger.Options{})
	book.Observe(baseTime, resp(conn("c1", "192.168.2.135", "example.com", []string{"🇭🇰 E-香港2", "KyCloud"}, 100, 200)))

	c := New(book)
	expected := fmt.Sprintf(`# HELP %s %s
# TYPE %s counter
%s{device="192.168.2.135",direction="download",proxy="🇭🇰 E-香港2",site="example.com"} 200
%s{device="192.168.2.135",direction="upload",proxy="🇭🇰 E-香港2",site="example.com"} 100
`,
		NameTrafficBytes, helpTrafficBytes, NameTrafficBytes,
		NameTrafficBytes, NameTrafficBytes)

	if err := testutil.CollectAndCompare(c, strings.NewReader(expected), NameTrafficBytes); err != nil {
		t.Errorf("指标文本与期望不一致: %v", err)
	}
}

// TestCollectGroupRulesAppliedThroughLedger 校验归组规则与别名在采集结果里生效。
func TestCollectGroupRulesAppliedThroughLedger(t *testing.T) {
	book := newTestLedger(t, ledger.Options{
		DeviceAliases: map[string]string{"198.18.0.1": "旁路由本机"},
		GroupRules: []ledger.GroupRule{
			{Pattern: regexp.MustCompile(`\.google\.com$`), Group: "google"},
		},
	})
	book.Observe(baseTime, resp(
		conn("c1", "192.168.2.135", "www.google.com", []string{"node-a"}, 10, 20),
		conn("c2", "198.18.0.1", "example.com", []string{"DIRECT"}, 30, 40),
	))

	c := New(book)
	samples := gatherSamples(t, c)

	if _, ok := findSample(samples[NameTrafficBytes], map[string]string{
		"device":    "192.168.2.135",
		"site":      "google",
		"proxy":     "node-a",
		"direction": ledger.DirectionUpload,
	}); !ok {
		t.Error("归组后的站点标签 google 未出现在指标中")
	}
	if _, ok := findSample(samples[NameTrafficBytes], map[string]string{
		"device":    "旁路由本机",
		"site":      "example.com",
		"proxy":     ledger.ProxyDirect,
		"direction": ledger.DirectionUpload,
	}); !ok {
		t.Error("别名设备标签未出现在指标中")
	}
}
