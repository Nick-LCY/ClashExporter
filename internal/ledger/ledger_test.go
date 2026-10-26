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
	if opts.PruneTTL == 0 {
		opts.PruneTTL = 168 * time.Hour
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

// TestDisappearedConnectionRemovedWithoutResidual 校验连接消失后的真实可观测行为：
// ① 活跃连接表归零；② 账本条目数与累计值不变；③ 不出现任何负值或异常值；
// ④ 同 ID 连接稍后重现时沿用消失前的基线，只计新增量，不重复计入已计过的部分。
func TestDisappearedConnectionRemovedWithoutResidual(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	first := l.Export()
	uploadBefore := mustValue(t, first, "192.168.2.10", "example.com", "node-a", DirectionUpload)
	downloadBefore := mustValue(t, first, "192.168.2.10", "example.com", "node-a", DirectionDownload)
	entriesBefore := l.EntryCount()

	// 连接消失：只从活跃表移除，账本不做任何补账
	l.Observe(baseTime.Add(5*time.Second), resp())

	if got := l.ActiveConnections(); got != 0 {
		t.Errorf("连接消失后活跃连接数 = %d, 期望 0", got)
	}
	if got := len(l.Connections()); got != 0 {
		t.Errorf("连接消失后活跃连接表长度 = %d, 期望 0", got)
	}
	if got := l.EntryCount(); got != entriesBefore {
		t.Errorf("连接消失后条目数 = %d, 期望 %d（不应增删）", got, entriesBefore)
	}

	series := l.Export()
	uploadAfter := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionUpload)
	downloadAfter := mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionDownload)
	if uploadAfter != uploadBefore {
		t.Errorf("连接消失后上行 = %d, 期望保持 %d", uploadAfter, uploadBefore)
	}
	if downloadAfter != downloadBefore {
		t.Errorf("连接消失后下行 = %d, 期望保持 %d", downloadAfter, downloadBefore)
	}
	// 导出值不得下降（不得出现负值或回绕）
	for _, s := range series {
		if s.Value > uploadBefore+downloadBefore {
			t.Errorf("序列 %s/%s/%s/%s 的值 %d 超过消失前的累计值，疑似重复计入",
				s.Device, s.Site, s.Proxy, s.Direction, s.Value)
		}
	}

	// 同 ID 连接稍后重现：沿用消失前的基线（100/200），只计新增的 80/60
	l.Observe(baseTime.Add(10*time.Second), resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 180, 260)))

	if got := l.ActiveConnections(); got != 1 {
		t.Errorf("重现后活跃连接数 = %d, 期望 1", got)
	}
	series = l.Export()
	uploadAfter = mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionUpload)
	downloadAfter = mustValue(t, series, "192.168.2.10", "example.com", "node-a", DirectionDownload)
	if uploadAfter != uploadBefore+80 {
		t.Errorf("同 ID 重现后上行 = %d, 期望 %d（基线 100 + 新增 80，不得全量重复计入 180）",
			uploadAfter, uploadBefore+80)
	}
	if downloadAfter != downloadBefore+60 {
		t.Errorf("同 ID 重现后下行 = %d, 期望 %d（基线 200 + 新增 60，不得全量重复计入 260）",
			downloadAfter, downloadBefore+60)
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
		// 实测顺序为 [实际出口节点, 策略组]：代理标签取首元素
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
	if got := mustValue(t, series, "192.168.2.10", "d.com", "🇭🇰 节点", DirectionUpload); got != 10 {
		t.Errorf("取链首元素上行 = %d, 期望 10", got)
	}
	if _, ok := findSeries(series, "192.168.2.10", "d.com", "KyCloud", DirectionUpload); ok {
		t.Error("代理标签不应取策略组名（chains 末元素）")
	}
}

// TestProxyMultiLevelChainTakesFirstElement 覆盖多级链：chains 顺序为 [实际出口节点, 策略组...]，
// 代理标签必须取首元素（实际出口），不得被策略组名覆盖。
func TestProxyMultiLevelChainTakesFirstElement(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(
		conn("c1", "192.168.2.10", "a.com", []string{"节点A", "组B", "组C"}, 100, 200),
	))

	series := l.Export()
	if got := mustValue(t, series, "192.168.2.10", "a.com", "节点A", DirectionUpload); got != 100 {
		t.Errorf("多级链上行 = %d, 期望 100", got)
	}
	if got := mustValue(t, series, "192.168.2.10", "a.com", "节点A", DirectionDownload); got != 200 {
		t.Errorf("多级链下行 = %d, 期望 200", got)
	}
	for _, group := range []string{"组B", "组C"} {
		if _, ok := findSeries(series, "192.168.2.10", "a.com", group, DirectionUpload); ok {
			t.Errorf("代理标签不应为策略组名 %q", group)
		}
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

// TestPruneRemovesExpiredEvictedEntry 校验过期淘汰条目会被从账本删除（快照随之不再包含）。
func TestPruneRemovesExpiredEvictedEntry(t *testing.T) {
	l := newTestLedger(t, Options{EvictTTL: 24 * time.Hour, PruneTTL: 168 * time.Hour})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	l.Export() // 清空待导出增量

	// 静默 25h：条目被淘汰，但未到 prune_ttl，不得删除
	l.Observe(baseTime.Add(25*time.Hour), resp())
	if got := l.EntryCount(); got != 1 {
		t.Errorf("未到 prune_ttl 的淘汰条目不应删除, EntryCount = %d, 期望 1", got)
	}

	// 静默超过 prune_ttl（168h）：条目从账本删除
	l.Observe(baseTime.Add(169*time.Hour), resp())
	if got := l.EntryCount(); got != 0 {
		t.Errorf("过期淘汰条目应当被清理, EntryCount = %d, 期望 0", got)
	}
	if series := l.Export(); len(series) != 0 {
		t.Errorf("被清理的条目不应导出, 实际导出 %d 条", len(series))
	}
	// 快照随之不再包含该条目
	if got := len(l.Snapshot().Entries); got != 0 {
		t.Errorf("快照中的条目数 = %d, 期望 0", got)
	}
}

// TestPruneKeepsEntryWithPendingIncrement 校验带待导出增量的条目不被清理。
func TestPruneKeepsEntryWithPendingIncrement(t *testing.T) {
	l := newTestLedger(t, Options{EvictTTL: 24 * time.Hour, PruneTTL: 168 * time.Hour})

	// 观察后不导出：待导出增量保持非零
	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))

	l.Observe(baseTime.Add(169*time.Hour), resp())
	if got := l.EntryCount(); got != 1 {
		t.Errorf("带待导出增量的条目不应被清理, EntryCount = %d, 期望 1", got)
	}
}

// TestPruneKeepsRecentEntry 校验未到淘汰时限的活跃条目不被清理。
func TestPruneKeepsRecentEntry(t *testing.T) {
	l := newTestLedger(t, Options{EvictTTL: 24 * time.Hour, PruneTTL: 168 * time.Hour})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	l.Export()

	// 刚产生过流量：既未淘汰也未到 prune_ttl
	l.Observe(baseTime.Add(1*time.Hour), resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 150, 260)))
	if got := l.EntryCount(); got != 1 {
		t.Errorf("活跃条目不应被清理, EntryCount = %d, 期望 1", got)
	}
}

// TestRestoreRestoresActiveConnections 校验恢复快照后活跃连接表被完整恢复。
func TestRestoreRestoresActiveConnections(t *testing.T) {
	l := newTestLedger(t, Options{})
	l.Observe(baseTime, resp(
		conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200),
		conn("c2", "192.168.2.11", "other.com", []string{"node-b"}, 50, 60),
	))

	state := l.Snapshot()

	restored := newTestLedger(t, Options{})
	restored.Restore(state)

	conns := restored.Connections()
	if len(conns) != 2 {
		t.Fatalf("恢复后活跃连接表长度 = %d, 期望 2", len(conns))
	}
	if conns[0].ID != "c1" || conns[1].ID != "c2" {
		t.Errorf("恢复后的连接 ID = %q/%q, 期望 c1/c2", conns[0].ID, conns[1].ID)
	}
	if conns[0].Upload != 100 || conns[0].Download != 200 {
		t.Errorf("恢复后 c1 的累计值 = %d/%d, 期望 100/200", conns[0].Upload, conns[0].Download)
	}
	if conns[1].Device != "192.168.2.11" || conns[1].Site != "other.com" || conns[1].Proxy != "node-b" {
		t.Errorf("恢复后 c2 的维度 = %+v, 期望 device=192.168.2.11 site=other.com proxy=node-b", conns[1])
	}
	if got := restored.ActiveConnections(); got != 2 {
		t.Errorf("恢复后活跃连接数 = %d, 期望 2", got)
	}
}

// TestCounterResetToZeroResetsBaseline 校验计数器回退到 0 时基线被重置。
func TestCounterResetToZeroResetsBaseline(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	first := mustValue(t, l.Export(), "192.168.2.10", "example.com", "node-a", DirectionUpload)

	// 计数器回退到 0（内核重启）：增量记 0，导出值不得下降
	l.Observe(baseTime.Add(5*time.Second), resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 0, 0)))
	second := mustValue(t, l.Export(), "192.168.2.10", "example.com", "node-a", DirectionUpload)
	if second != first {
		t.Errorf("计数器回退到 0 后导出值 = %d, 期望保持 %d", second, first)
	}

	// 基线已重置为 0：之后的增量按新基线计算
	l.Observe(baseTime.Add(10*time.Second), resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 30, 40)))
	third := mustValue(t, l.Export(), "192.168.2.10", "example.com", "node-a", DirectionUpload)
	if third != first+30 {
		t.Errorf("基线重置后的导出值 = %d, 期望 %d", third, first+30)
	}
}

// TestEmptySourceIPFallsBackToUnknownDevice 校验源 IP 为空时 device 标签为 unknown。
func TestEmptySourceIPFallsBackToUnknownDevice(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(conn("c1", "", "example.com", []string{"node-a"}, 100, 200)))

	series := l.Export()
	if got := mustValue(t, series, DeviceUnknown, "example.com", "node-a", DirectionUpload); got != 100 {
		t.Errorf("源 IP 为空时上行 = %d, 期望 100", got)
	}
	if _, ok := findSeries(series, "", "example.com", "node-a", DirectionUpload); ok {
		t.Error("源 IP 为空时不应以空串作为 device 标签")
	}
}

// TestObserveNilResponseIsSafe 校验 Observe 收到空响应时安全提前返回。
func TestObserveNilResponseIsSafe(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	before := l.Export()
	uploadBefore := mustValue(t, before, "192.168.2.10", "example.com", "node-a", DirectionUpload)
	entriesBefore := l.EntryCount()
	activeBefore := l.ActiveConnections()

	// 空响应：不得 panic，不得改动账本
	l.Observe(baseTime.Add(5*time.Second), nil)

	if got := l.EntryCount(); got != entriesBefore {
		t.Errorf("空响应后条目数 = %d, 期望 %d", got, entriesBefore)
	}
	if got := l.ActiveConnections(); got != activeBefore {
		t.Errorf("空响应后活跃连接数 = %d, 期望 %d", got, activeBefore)
	}
	after := l.Export()
	if got := mustValue(t, after, "192.168.2.10", "example.com", "node-a", DirectionUpload); got != uploadBefore {
		t.Errorf("空响应后导出值 = %d, 期望 %d", got, uploadBefore)
	}
}

// TestObserveClampsClockRollback 校验时钟回拨时按上次时间处理。
func TestObserveClampsClockRollback(t *testing.T) {
	l := newTestLedger(t, Options{})

	l.Observe(baseTime, resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 100, 200)))
	l.Export()

	// 时钟回拨：注入的时间早于上一次
	l.Observe(baseTime.Add(-time.Hour), resp(conn("c1", "192.168.2.10", "example.com", []string{"node-a"}, 150, 260)))

	state := l.Snapshot()
	if !state.UpdatedAt.Equal(baseTime) {
		t.Errorf("时钟回拨后的账本时间 = %s, 期望 %s（不得倒退）", state.UpdatedAt, baseTime)
	}
	if len(state.Entries) != 1 {
		t.Fatalf("条目数 = %d, 期望 1", len(state.Entries))
	}
	if !state.Entries[0].LastActivity.Equal(baseTime) {
		t.Errorf("条目最后活动时间 = %s, 期望 %s（不得随时钟回拨倒退）",
			state.Entries[0].LastActivity, baseTime)
	}
	// 增量仍被正常计入
	if got := mustValue(t, l.Export(), "192.168.2.10", "example.com", "node-a", DirectionUpload); got != 150 {
		t.Errorf("时钟回拨后的导出值 = %d, 期望 150", got)
	}
}

// TestZeroTrafficConnectionDoesNotConsumeSiteQuota 校验零流量连接不占用站点配额。
func TestZeroTrafficConnectionDoesNotConsumeSiteQuota(t *testing.T) {
	l := newTestLedger(t, Options{SiteCap: 1})

	// 零流量连接：站点不进入站点集合，不占配额
	l.Observe(baseTime, resp(conn("c0", "192.168.2.10", "idle.com", []string{"node-a"}, 0, 0)))

	// 之后有流量的新站点仍能拿到自己的名字（未被挤进 other 桶）
	l.Observe(baseTime.Add(time.Second), resp(conn("c1", "192.168.2.10", "real.com", []string{"node-a"}, 20, 0)))

	series := l.Export()
	if got := mustValue(t, series, "192.168.2.10", "real.com", "node-a", DirectionUpload); got != 20 {
		t.Errorf("有流量的站点上行 = %d, 期望 20（站点名不应被零流量连接挤掉）", got)
	}
	if _, ok := findSeries(series, "192.168.2.10", SiteOther, "node-a", DirectionUpload); ok {
		t.Error("不应出现 other 桶：零流量连接不应占用站点配额")
	}
}
