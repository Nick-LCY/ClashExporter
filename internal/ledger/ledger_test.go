package ledger

import (
	"regexp"
	"testing"
	"time"

	"github.com/sankabox/clash-exporter/internal/mihomo"
)

// baseTime 是所有测试的基准时间，避免依赖 wall clock。
var baseTime = time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)

func newTestLedger(t *testing.T, opts Options) *Ledger {
	t.Helper()
	if opts.SiteCap == 0 {
		opts.SiteCap = 10000
	}
	if opts.EvictTTL == 0 {
		opts.EvictTTL = 24 * time.Hour
	}
	l, err := New(opts)
	if err != nil {
		t.Fatalf("创建账本失败: %v", err)
	}
	return l
}

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

func resp(conns ...mihomo.Connection) *mihomo.ConnectionsResponse {
	return &mihomo.ConnectionsResponse{Connections: conns}
}

// findSeries 在导出结果中查找指定维度的序列值。
func findSeries(series []Series, device, site, proxy, direction string) (uint64, bool) {
	for _, s := range series {
		if s.Device == device && s.Site == site && s.Proxy == proxy && s.Direction == direction {
			return s.Value, true
		}
	}
	return 0, false
}

func mustValue(t *testing.T, series []Series, device, site, proxy, direction string) uint64 {
	t.Helper()
	v, ok := findSeries(series, device, site, proxy, direction)
	if !ok {
		t.Fatalf("未找到序列 %s/%s/%s/%s", device, site, proxy, direction)
	}
	return v
}

func TestObserveAccumulatesDeltaPerConnection(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"DIRECT"}, 100, 200)))
	first := l.Export()
	if got := mustValue(t, first, "192.168.2.10", "example.com", "direct", DirectionUpload); got != 100 {
		t.Errorf("首轮上行 = %d, 期望 100", got)
	}

	l.Observe(baseTime.Add(5*time.Second), resp(conn("c1", "192.168.2.10", "example.com", []string{"DIRECT"}, 150, 260)))

	series := l.Export()
	// 导出值是累加型计数器：第二轮 = 首轮 100 + 本轮增量 50
	if got := mustValue(t, series, "192.168.2.10", "example.com", "direct", DirectionUpload); got != 150 {
		t.Errorf("上行累计值 = %d, 期望 150", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "example.com", "direct", DirectionDownload); got != 260 {
		t.Errorf("下行累计值 = %d, 期望 260", got)
	}
}

func TestObserveFirstSightCountsWholeCounter(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 1000, 2000)))

	series := l.Export()
	if got := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionUpload); got != 1000 {
		t.Errorf("首次出现上行 = %d, 期望 1000（全量计入）", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionDownload); got != 2000 {
		t.Errorf("首次出现下行 = %d, 期望 2000（全量计入）", got)
	}
}

func TestObserveCounterResetDoesNotGoNegative(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	first := mustValue(t, l.Export(), "192.168.2.10", "example.com", "node-a", DirectionUpload)

	// 计数器回退：增量必须为 0，不得出现负值
	l.Observe(baseTime.Add(5*time.Second), resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 40, 150)))
	second := mustValue(t, l.Export(), "192.168.2.10", "example.com", "node-a", DirectionUpload)
	if second < first {
		t.Errorf("计数器回退后导出值下降: %d -> %d", first, second)
	}
	if second != first {
		t.Errorf("计数器回退后导出值 = %d, 期望保持 %d", second, first)
	}

	// 基线已重置，后续增量按新基线计算
	l.Observe(baseTime.Add(10*time.Second), resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 60, 170)))
	third := mustValue(t, l.Export(), "192.168.2.10", "example.com", "node-a", DirectionUpload)
	if third != first+20 {
		t.Errorf("重置基线后的导出值 = %d, 期望 %d", third, first+20)
	}
}

func TestDisappearedConnectionResidualFlushed(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	mustValue(t, l.Export(), "192.168.2.10", "example.com", "node-a", DirectionUpload)

	// 模拟「连接计数继续增长但尚未入账」的状态：观测值前进，已入账量落后
	l.mu.Lock()
	l.conns["c1"].Upload = 180
	l.conns["c1"].Download = 260
	l.mu.Unlock()

	// 连接消失：残余必须被补账
	l.Observe(baseTime.Add(5*time.Second), resp())

	series := l.Export()
	if got := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionUpload); got != 180 {
		t.Errorf("补账后上行 = %d, 期望 180", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionDownload); got != 260 {
		t.Errorf("补账后下行 = %d, 期望 260", got)
	}
	if len(l.conns) != 0 {
		t.Errorf("消失的连接应当从活跃表删除, 剩余 %d 条", len(l.conns))
	}
}

func TestEvictedEntryNotExported(t *testing.T) {
	l := newTestLedger(t, Options{EvictTTL: 24 * time.Hour})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	mustValue(t, l.Export(), "192.168.2.10", "example.com", "node-a", DirectionUpload)

	// 超过 TTL 没有新增字节：条目被淘汰
	l.Observe(baseTime.Add(25*time.Hour), resp())

	if series := l.Export(); len(series) != 0 {
		t.Errorf("淘汰条目不应导出, 实际导出 %d 条", len(series))
	}
	if l.EntryCount() != 1 {
		t.Errorf("淘汰后条目数据应当保留, EntryCount = %d", l.EntryCount())
	}
}

func TestReanchorFirstExportEqualsLastExported(t *testing.T) {
	l := newTestLedger(t, Options{EvictTTL: 24 * time.Hour})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	first := l.Export()
	lastUploaded := mustValue(t, first, "192.168.2.10", "example.com", "node-a", DirectionUpload)
	lastDownloaded := mustValue(t, first, "192.168.2.10", "example.com", "node-a", DirectionDownload)

	// 超过 TTL 后条目被淘汰
	l.Observe(baseTime.Add(25*time.Hour), resp())
	if len(l.Export()) != 0 {
		t.Fatal("淘汰条目不应导出")
	}

	// 同一组合再次产生流量：重锚
	l.Observe(baseTime.Add(26*time.Hour), resp(conn("c2", "192.168.2.10", "example.com", []string{"node-a"}, 150, 260)))

	series := l.Export()
	if got := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionUpload); got != lastUploaded {
		t.Errorf("重锚后第一次导出上行 = %d, 期望等于上次导出值 %d", got, lastUploaded)
	}
	if got := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionDownload); got != lastDownloaded {
		t.Errorf("重锚后第一次导出行 = %d, 期望等于上次导出值 %d", got, lastDownloaded)
	}
}

func TestReanchorSecondExportCatchesUp(t *testing.T) {
	l := newTestLedger(t, Options{EvictTTL: 24 * time.Hour})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	l.Export()

	l.Observe(baseTime.Add(25*time.Hour), resp())
	l.Observe(baseTime.Add(26*time.Hour), resp(conn("c2", "192.168.2.10", "example.com", []string{"node-a"}, 150, 260)))

	l.Export() // 重锚后的第一次导出
	series := l.Export()

	if got := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionUpload); got != 250 {
		t.Errorf("重锚后第二次导出上行 = %d, 期望 250（累计值）", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionDownload); got != 460 {
		t.Errorf("重锚后第二次导出行 = %d, 期望 460（累计值）", got)
	}
}

func TestExportedValueNeverDecreases(t *testing.T) {
	l := newTestLedger(t, Options{})

	var last uint64
	for i := 0; i < 10; i++ {
		l.Observe(baseTime.Add(time.Duration(i)*5*time.Second),
			resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, uint64(100*(i+1)), uint64(50*(i+1)))))
		got := mustValue(t, l.Export(), "192.168.2.10", "example.com", "node-a", DirectionUpload)
		if got < last {
			t.Fatalf("导出值下降: %d -> %d", last, got)
		}
		last = got
	}
	if last != 1000 {
		t.Errorf("最终导出值 = %d, 期望 1000", last)
	}
}

func TestSiteCapOverflowsToOther(t *testing.T) {
	l := newTestLedger(t, Options{SiteCap: 2})

	l.Observe(baseTime, resp(
		conn("c1", "192.168.2.10", "a.com", []string{"node-a"}, 100, 0),
		conn("c2", "192.168.2.10", "b.com", []string{"node-a"}, 100, 0),
		conn("c3", "192.168.2.10", "c.com", []string{"node-a"}, 100, 0),
	))

	series := l.Export()
	if got := mustValue(t, series, "192.168.2.10", "a.com", "node-a", DirectionUpload); got != 100 {
		t.Errorf("a.com 上行 = %d, 期望 100", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "b.com", "node-a", DirectionUpload); got != 100 {
		t.Errorf("b.com 上行 = %d, 期望 100", got)
	}
	if got := mustValue(t, series, "192.168.2.10", SiteOther, "node-a", DirectionUpload); got != 100 {
		t.Errorf("溢出站点上行 = %d, 期望 100（归入 other 桶）", got)
	}
	if _, ok := findSeries(series, "192.168.2.10", "c.com", "node-a", DirectionUpload); ok {
		t.Error("超出配额的站点不应以原名导出")
	}

	// other 桶本身不占配额：再来一个新站点仍然归入 other
	l.Observe(baseTime.Add(5*time.Second), resp(conn("c4", "192.168.2.10", "d.com", []string{"node-a"}, 50, 0)))
	series = l.Export()
	if got := mustValue(t, series, "192.168.2.10", SiteOther, "node-a", DirectionUpload); got != 150 {
		t.Errorf("other 桶累计 = %d, 期望 150", got)
	}
}

func TestSiteUnresolvedWhenHostMissing(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "", []string{"node-a"}, 100, 0)))

	series := l.Export()
	if got := mustValue(t, series, "192.168.2.10", SiteUnresolved, "node-a", DirectionUpload); got != 100 {
		t.Errorf("host 缺失时上行 = %d, 期望 100", got)
	}
}

func TestSiteIPLiteralTreatedAsUnresolved(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(
		conn("c1", "192.168.2.10", "198.18.0.7", []string{"node-a"}, 100, 0),
		conn("c2", "192.168.2.10", "149.102.98.28", []string{"node-a"}, 50, 0),
	))

	series := l.Export()
	if got := mustValue(t, series, "192.168.2.10", SiteUnresolved, "node-a", DirectionUpload); got != 150 {
		t.Errorf("IP 字面量归入 unresolved 后上行 = %d, 期望 150", got)
	}
	if _, ok := findSeries(series, "192.168.2.10", "149.102.98.28", "node-a", DirectionUpload); ok {
		t.Error("IP 字面量不应以原名导出")
	}
}

func TestDeviceAliasApplied(t *testing.T) {
	l := newTestLedger(t, Options{DeviceAliases: map[string]string{"198.18.0.1": "旁路由本机"}})

	l.Observe(baseTime, resp(
		conn("c1", "198.18.0.1", "example.com", []string{"node-a"}, 100, 0),
		conn("c2", "192.168.2.10", "example.com", []string{"node-a"}, 50, 0),
	))

	series := l.Export()
	if got := mustValue(t, series, "旁路由本机", "example.com", "node-a", DirectionUpload); got != 100 {
		t.Errorf("别名设备上行 = %d, 期望 100", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionUpload); got != 50 {
		t.Errorf("未命中别名的设备上行 = %d, 期望 50", got)
	}
}

func TestSiteGroupRuleFirstMatchWins(t *testing.T) {
	l := newTestLedger(t, Options{GroupRules: []GroupRule{
		{Pattern: regexp.MustCompile(`\.google\.com$`), Group: "google"},
		{Pattern: regexp.MustCompile(`^ads\.`), Group: "ads"},
		{Pattern: regexp.MustCompile(`.*`), Group: "fallback"},
	}})

	l.Observe(baseTime, resp(
		conn("c1", "192.168.2.10", "www.google.com", []string{"node-a"}, 100, 0),
		conn("c2", "192.168.2.10", "ads.example.net", []string{"node-a"}, 50, 0),
		conn("c3", "192.168.2.10", "other.io", []string{"node-a"}, 25, 0),
	))

	series := l.Export()
	if got := mustValue(t, series, "192.168.2.10", "google", "node-a", DirectionUpload); got != 100 {
		t.Errorf("归组 google 上行 = %d, 期望 100", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "ads", "node-a", DirectionUpload); got != 50 {
		t.Errorf("归组 ads 上行 = %d, 期望 50", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "fallback", "node-a", DirectionUpload); got != 25 {
		t.Errorf("兜底归组上行 = %d, 期望 25", got)
	}
}

func TestProxyNormalization(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(
		conn("c1", "192.168.2.10", "a.com", []string{"DIRECT"}, 100, 0),
		conn("c2", "192.168.2.10", "b.com", []string{"REJECT"}, 50, 0),
		conn("c3", "192.168.2.10", "c.com", nil, 25, 0),
		conn("c4", "192.168.2.10", "d.com", []string{"🇭🇰 节点", "KyCloud"}, 10, 0),
	))

	series := l.Export()
	if got := mustValue(t, series, "192.168.2.10", "a.com", ProxyDirect, DirectionUpload); got != 100 {
		t.Errorf("DIRECT 归一化上行 = %d, 期望 100", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "b.com", ProxyReject, DirectionUpload); got != 50 {
		t.Errorf("REJECT 归一化上行 = %d, 期望 50", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "c.com", ProxyUnknown, DirectionUpload); got != 25 {
		t.Errorf("空链归一化上行 = %d, 期望 25", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "d.com", "KyCloud", DirectionUpload); got != 10 {
		t.Errorf("取链末端上行 = %d, 期望 10", got)
	}
}

func TestGlobalTotalsMonotonic(t *testing.T) {
	l := newTestLedger(t, Options{})

	first := &mihomo.ConnectionsResponse{UploadTotal: 1000, DownloadTotal: 2000}
	l.Observe(baseTime, first)
	if got := l.GlobalUpload(); got != 1000 {
		t.Errorf("全局上行 = %d, 期望 1000", got)
	}
	if got := l.GlobalDownload(); got != 2000 {
		t.Errorf("全局下行 = %d, 期望 2000", got)
	}

	// 内核重启导致总量回退：对账值取历史最大值，不得下降
	l.Observe(baseTime.Add(5*time.Second), &mihomo.ConnectionsResponse{UploadTotal: 10, DownloadTotal: 20})
	if got := l.GlobalUpload(); got != 1000 {
		t.Errorf("回退后全局上行 = %d, 期望保持 1000", got)
	}
	if got := l.GlobalDownload(); got != 2000 {
		t.Errorf("回退后全局下行 = %d, 期望保持 2000", got)
	}
}

func TestNewRejectsInvalidGroupRule(t *testing.T) {
	if _, err := New(Options{GroupRules: []GroupRule{{Pattern: nil, Group: "x"}}}); err == nil {
		t.Error("未编译的归组规则应当报错")
	}
	if _, err := New(Options{GroupRules: []GroupRule{{Pattern: regexp.MustCompile(".*"), Group: " "}}}); err == nil {
		t.Error("空归组名应当报错")
	}
}

func TestUpAndAccessors(t *testing.T) {
	l := newTestLedger(t, Options{})

	if l.Up() {
		t.Error("初始状态 up 应当为 false")
	}
	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "a.com", []string{"node-a"}, 100, 0)))
	if !l.Up() {
		t.Error("成功观察后 up 应当为 true")
	}
	if got := l.ActiveConnections(); got != 1 {
		t.Errorf("活跃连接数 = %d, 期望 1", got)
	}
	if got := l.EntryCount(); got != 1 {
		t.Errorf("条目数 = %d, 期望 1", got)
	}

	l.SetUp(false)
	if l.Up() {
		t.Error("SetUp(false) 之后 up 应当为 false")
	}
	l.SetScrapeDuration(120 * time.Millisecond)
	if got := l.LastScrapeDuration(); got != 120*time.Millisecond {
		t.Errorf("采集耗时 = %s, 期望 120ms", got)
	}
}
