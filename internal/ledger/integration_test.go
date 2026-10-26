package ledger_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/sankabox/clash-exporter/internal/ledger"
	"github.com/sankabox/clash-exporter/internal/mihomo"
	"github.com/sankabox/clash-exporter/internal/snapshot"
)

// 实测样本中的代理链：chains 顺序为 [实际出口节点, 策略组]，
// 出口节点是首元素，策略组名是末元素。
const (
	exitNode = "🇭🇰 E-香港2"
	proxyGrp = "KyCloud"
)

// mockMihomo 是可编程的 mihomo /connections 模拟端点。
type mockMihomo struct {
	mu      sync.Mutex
	payload mihomo.ConnectionsResponse
	calls   int
}

func (m *mockMihomo) set(resp *mihomo.ConnectionsResponse) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.payload = *resp
}

func (m *mockMihomo) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		m.calls++
		payload := m.payload
		m.mu.Unlock()

		if r.URL.Path != "/connections" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(payload)
	}
}

func (m *mockMihomo) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

func seriesValue(t *testing.T, series []ledger.Series, device, site, proxy, direction string) (uint64, bool) {
	t.Helper()
	for _, s := range series {
		if s.Device == device && s.Site == site && s.Proxy == proxy && s.Direction == direction {
			return s.Value, true
		}
	}
	return 0, false
}

func mustSeriesValue(t *testing.T, series []ledger.Series, device, site, proxy, direction string) uint64 {
	t.Helper()
	v, ok := seriesValue(t, series, device, site, proxy, direction)
	if !ok {
		t.Fatalf("未找到序列 %s/%s/%s/%s", device, site, proxy, direction)
	}
	return v
}

func TestEndToEndAgainstMockMihomo(t *testing.T) {
	mock := &mockMihomo{}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	client := mihomo.NewClient(srv.URL, "", time.Second)
	book, err := ledger.New(ledger.Options{
		SiteCap:       100,
		EvictTTL:      24 * time.Hour,
		DeviceAliases: map[string]string{"198.18.0.1": "旁路由本机"},
	})
	if err != nil {
		t.Fatalf("创建账本失败: %v", err)
	}

	base := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)

	// 第一轮：连接首次出现，累计值全量计入
	mock.set(&mihomo.ConnectionsResponse{
		UploadTotal:   1000,
		DownloadTotal: 2000,
		Connections: []mihomo.Connection{
			{
				ID:       "c1",
				Metadata: mihomo.ConnectionMetadata{Type: "Redir", SourceIP: "192.168.2.135", Host: "example.com"},
				Upload:   100,
				Download: 200,
				Chains:   []string{exitNode, proxyGrp},
			},
			{
				ID:       "c2",
				Metadata: mihomo.ConnectionMetadata{Type: "Tun", SourceIP: "198.18.0.1", Host: "stun.hitv.com"},
				Upload:   50,
				Download: 25,
				Chains:   []string{"DIRECT"},
			},
		},
	})

	resp, err := client.FetchConnections(context.Background())
	if err != nil {
		t.Fatalf("拉取连接失败: %v", err)
	}
	book.Observe(base, resp)

	series := book.Export()
	if got := mustSeriesValue(t, series, "192.168.2.135", "example.com", exitNode, ledger.DirectionUpload); got != 100 {
		t.Errorf("首轮上行 = %d, 期望 100", got)
	}
	if got := mustSeriesValue(t, series, "旁路由本机", "stun.hitv.com", ledger.ProxyDirect, ledger.DirectionDownload); got != 25 {
		t.Errorf("别名设备下行 = %d, 期望 25", got)
	}
	if !book.Up() {
		t.Error("拉取成功后 up 应当为 true")
	}
	if got := book.ActiveConnections(); got != 2 {
		t.Errorf("活跃连接数 = %d, 期望 2", got)
	}

	// 第二轮：同一连接计数增长，只计增量
	mock.set(&mihomo.ConnectionsResponse{
		UploadTotal:   1500,
		DownloadTotal: 2600,
		Connections: []mihomo.Connection{
			{
				ID:       "c1",
				Metadata: mihomo.ConnectionMetadata{Type: "Redir", SourceIP: "192.168.2.135", Host: "example.com"},
				Upload:   150,
				Download: 260,
				Chains:   []string{exitNode, proxyGrp},
			},
		},
	})
	resp, err = client.FetchConnections(context.Background())
	if err != nil {
		t.Fatalf("拉取连接失败: %v", err)
	}
	book.Observe(base.Add(5*time.Second), resp)

	series = book.Export()
	// 导出值是累加型计数器：第二轮 = 首轮 100 + 本轮增量 50
	if got := mustSeriesValue(t, series, "192.168.2.135", "example.com", exitNode, ledger.DirectionUpload); got != 150 {
		t.Errorf("第二轮上行累计 = %d, 期望 150", got)
	}
	if got := mustSeriesValue(t, series, "192.168.2.135", "example.com", exitNode, ledger.DirectionDownload); got != 260 {
		t.Errorf("第二轮下行累计 = %d, 期望 260", got)
	}
	if got := book.GlobalUpload(); got != 1500 {
		t.Errorf("全局上行对账值 = %d, 期望 1500", got)
	}

	// 快照落盘并恢复（连接仍然存活时）：活跃连接表必须被恢复，
	// 存量连接不得被当作首次出现而全量计入
	snapshotPath := filepath.Join(t.TempDir(), "state.json")
	if err := snapshot.Save(snapshotPath, book.Snapshot()); err != nil {
		t.Fatalf("保存快照失败: %v", err)
	}
	state, err := snapshot.Load(snapshotPath)
	if err != nil {
		t.Fatalf("加载快照失败: %v", err)
	}
	if state == nil {
		t.Fatal("快照为空")
	}

	restored, err := ledger.New(ledger.Options{SiteCap: 100, EvictTTL: 24 * time.Hour})
	if err != nil {
		t.Fatalf("创建账本失败: %v", err)
	}
	restored.Restore(state)

	if got := restored.EntryCount(); got != book.EntryCount() {
		t.Errorf("恢复后条目数 = %d, 期望 %d", got, book.EntryCount())
	}
	if got := restored.GlobalUpload(); got != 1500 {
		t.Errorf("恢复后全局上行 = %d, 期望 1500", got)
	}

	// 恢复后同一连接继续增长：只应计入增量，而不是重新全量计入
	mock.set(&mihomo.ConnectionsResponse{
		UploadTotal:   1800,
		DownloadTotal: 3000,
		Connections: []mihomo.Connection{
			{
				ID:       "c1",
				Metadata: mihomo.ConnectionMetadata{Type: "Redir", SourceIP: "192.168.2.135", Host: "example.com"},
				Upload:   250,
				Download: 400,
				Chains:   []string{exitNode, proxyGrp},
			},
		},
	})
	resp, err = client.FetchConnections(context.Background())
	if err != nil {
		t.Fatalf("拉取连接失败: %v", err)
	}
	restored.Observe(base.Add(10*time.Second), resp)

	series = restored.Export()
	if got := mustSeriesValue(t, series, "192.168.2.135", "example.com", exitNode, ledger.DirectionUpload); got != 250 {
		t.Errorf("恢复后上行累计 = %d, 期望 250（150 + 增量 100，而非重新全量计入 400）", got)
	}
	if got := mustSeriesValue(t, series, "192.168.2.135", "example.com", exitNode, ledger.DirectionDownload); got != 400 {
		t.Errorf("恢复后下行累计 = %d, 期望 400（260 + 增量 140）", got)
	}

	// 连接全部消失：消失补账后总量不再增长
	mock.set(&mihomo.ConnectionsResponse{UploadTotal: 1800, DownloadTotal: 3000})
	resp, err = client.FetchConnections(context.Background())
	if err != nil {
		t.Fatalf("拉取连接失败: %v", err)
	}
	book.Observe(base.Add(10*time.Second), resp)

	series = book.Export()
	if got := mustSeriesValue(t, series, "192.168.2.135", "example.com", exitNode, ledger.DirectionUpload); got != 150 {
		t.Errorf("连接消失后上行 = %d, 期望保持 150", got)
	}
	if got := book.ActiveConnections(); got != 0 {
		t.Errorf("活跃连接数 = %d, 期望 0", got)
	}

	if mock.callCount() < 4 {
		t.Errorf("mock 调用次数 = %d, 期望至少 4", mock.callCount())
	}
}
