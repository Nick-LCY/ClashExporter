package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/sankabox/clash-exporter/internal/ledger"
	"github.com/sankabox/clash-exporter/internal/mihomo"
)

// mockMihomo 是可编程的 mihomo /connections 模拟端点：
// 可切换「返回 500」与「返回正常 JSON」两种行为。
type mockMihomo struct {
	mu      sync.Mutex
	fail    bool
	payload string
	calls   int
}

func (m *mockMihomo) setFail(fail bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.fail = fail
}

func (m *mockMihomo) setPayload(payload string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.payload = payload
}

func (m *mockMihomo) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

func (m *mockMihomo) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		m.calls++
		fail, payload := m.fail, m.payload
		m.mu.Unlock()

		if r.URL.Path != "/connections" {
			http.NotFound(w, r)
			return
		}
		if fail {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(payload))
	}
}

// connPayload 构造单条连接的 /connections 响应体。
func connPayload(id, sourceIP, host string, upload, download uint64) string {
	resp := mihomo.ConnectionsResponse{
		UploadTotal:   upload,
		DownloadTotal: download,
		Connections: []mihomo.Connection{
			{
				ID:       id,
				Metadata: mihomo.ConnectionMetadata{Type: "Redir", SourceIP: sourceIP, Host: host},
				Upload:   upload,
				Download: download,
				Chains:   []string{"node-a"},
			},
		},
	}
	data, err := json.Marshal(resp)
	if err != nil {
		panic(err)
	}
	return string(data)
}

// newTestLedger 创建一个测试用账本。
func newTestLedger(t *testing.T) *ledger.Ledger {
	t.Helper()
	book, err := ledger.New(ledger.Options{SiteCap: 100, EvictTTL: 24 * time.Hour, PruneTTL: 168 * time.Hour})
	if err != nil {
		t.Fatalf("创建账本失败: %v", err)
	}
	return book
}

// TestScrapeRoundFailureLeavesLedgerUntouched 校验拉取失败（HTTP 500）时：
// up 置为 false，账本条目数、活跃连接数与导出值完全不变。
func TestScrapeRoundFailureLeavesLedgerUntouched(t *testing.T) {
	mock := &mockMihomo{fail: true}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	book := newTestLedger(t)
	client := mihomo.NewClient(srv.URL, "", time.Second)

	// 先成功一轮，建立基线
	mock.setFail(false)
	mock.setPayload(connPayload("c1", "192.168.2.10", "example.com", 100, 200))
	if ok := scrapeRound(context.Background(), client, book); !ok {
		t.Fatal("首轮拉取应当成功")
	}

	entriesBefore := book.EntryCount()
	activeBefore := book.ActiveConnections()
	before := book.Export()
	if len(before) == 0 {
		t.Fatal("首轮成功后应有导出序列")
	}

	// 失败一轮
	mock.setFail(true)
	if ok := scrapeRound(context.Background(), client, book); ok {
		t.Error("拉取失败时应当返回 false")
	}
	if book.Up() {
		t.Error("拉取失败后 up 应当为 false")
	}
	if got := book.EntryCount(); got != entriesBefore {
		t.Errorf("失败后条目数 = %d, 期望 %d（账本不得被触碰）", got, entriesBefore)
	}
	if got := book.ActiveConnections(); got != activeBefore {
		t.Errorf("失败后活跃连接数 = %d, 期望 %d（不得做消失检测）", got, activeBefore)
	}

	after := book.Export()
	if len(after) != len(before) {
		t.Fatalf("失败后导出序列数 = %d, 期望 %d", len(after), len(before))
	}
	for i := range before {
		if after[i] != before[i] {
			t.Errorf("失败后序列 %d = %+v, 期望 %+v（导出值不得变化）", i, after[i], before[i])
		}
	}
}

// TestScrapeRoundRecoveryCountsOnlyIncrement 校验失败→恢复后，同一连接只计增量，不重复全量计入。
func TestScrapeRoundRecoveryCountsOnlyIncrement(t *testing.T) {
	mock := &mockMihomo{fail: true}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	book := newTestLedger(t)
	client := mihomo.NewClient(srv.URL, "", time.Second)

	// 第一轮：失败，账本不得有任何变化
	if ok := scrapeRound(context.Background(), client, book); ok {
		t.Error("失败轮应当返回 false")
	}
	if got := book.EntryCount(); got != 0 {
		t.Errorf("失败后条目数 = %d, 期望 0", got)
	}
	if got := book.ActiveConnections(); got != 0 {
		t.Errorf("失败后活跃连接数 = %d, 期望 0", got)
	}
	if series := book.Export(); len(series) != 0 {
		t.Errorf("失败后导出序列数 = %d, 期望 0", len(series))
	}

	// 第二轮：恢复，同一连接首次出现（历史累计值全量计入）
	mock.setFail(false)
	mock.setPayload(connPayload("c1", "192.168.2.10", "example.com", 100, 200))
	if ok := scrapeRound(context.Background(), client, book); !ok {
		t.Fatal("恢复轮应当成功")
	}
	series := book.Export()
	if len(series) != 2 {
		t.Fatalf("恢复后导出序列数 = %d, 期望 2", len(series))
	}
	if got := seriesValue(series, "192.168.2.10", "example.com", "node-a", ledger.DirectionUpload); got != 100 {
		t.Errorf("恢复后上行 = %d, 期望 100", got)
	}

	// 第三轮：同一连接计数增长，只计增量 50（不是重新全量计入 150）
	mock.setPayload(connPayload("c1", "192.168.2.10", "example.com", 150, 260))
	if ok := scrapeRound(context.Background(), client, book); !ok {
		t.Fatal("第三轮应当成功")
	}
	series = book.Export()
	if got := seriesValue(series, "192.168.2.10", "example.com", "node-a", ledger.DirectionUpload); got != 150 {
		t.Errorf("恢复后上行累计 = %d, 期望 150（100 + 增量 50）", got)
	}
	if got := seriesValue(series, "192.168.2.10", "example.com", "node-a", ledger.DirectionDownload); got != 260 {
		t.Errorf("恢复后下行累计 = %d, 期望 260（200 + 增量 60）", got)
	}
}

// TestScrapeRoundCancelledContextKeepsUpStatus 校验上下文取消（退出流程）时不把 up 置为 false。
func TestScrapeRoundCancelledContextKeepsUpStatus(t *testing.T) {
	mock := &mockMihomo{}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	book := newTestLedger(t)
	client := mihomo.NewClient(srv.URL, "", time.Second)

	mock.setPayload(connPayload("c1", "192.168.2.10", "example.com", 100, 200))
	if ok := scrapeRound(context.Background(), client, book); !ok {
		t.Fatal("首轮拉取应当成功")
	}
	if !book.Up() {
		t.Fatal("首轮成功后 up 应当为 true")
	}

	// 取消的上下文：请求直接失败，但这是退出流程而不是拉取失败
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if ok := scrapeRound(ctx, client, book); ok {
		t.Error("取消的上下文不应返回成功")
	}
	if !book.Up() {
		t.Error("上下文取消时不得把 up 置为 false")
	}
}

// seriesValue 在导出结果中查找指定维度的序列值。
func seriesValue(series []ledger.Series, device, site, proxy, direction string) uint64 {
	for _, s := range series {
		if s.Device == device && s.Site == site && s.Proxy == proxy && s.Direction == direction {
			return s.Value
		}
	}
	return 0
}
