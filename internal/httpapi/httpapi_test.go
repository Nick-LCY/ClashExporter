package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// newTestServer 创建一个带测试指标的 HTTP 服务。
func newTestServer(t *testing.T) *Server {
	t.Helper()

	reg := prometheus.NewRegistry()
	reg.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "clash_up",
		Help: "mihomo 内核可达性。",
	}, func() float64 { return 1 }))

	return New(reg, "127.0.0.1:0")
}

// do 发起一次请求并返回响应。
func do(t *testing.T, s *Server, method, path string) *http.Response {
	t.Helper()

	req := httptest.NewRequest(method, path, nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec.Result()
}

func TestHealthz(t *testing.T) {
	s := newTestServer(t)

	resp := do(t, s, http.MethodGet, "/healthz")
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 %d", resp.StatusCode, http.StatusOK)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应体失败: %v", err)
	}
	if string(body) != "ok" {
		t.Errorf("响应体 = %q, 期望 %q", string(body), "ok")
	}
}

func TestIndexPage(t *testing.T) {
	s := newTestServer(t)

	resp := do(t, s, http.MethodGet, "/")
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 %d", resp.StatusCode, http.StatusOK)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type = %q, 期望以 text/plain 开头", ct)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应体失败: %v", err)
	}
	text := string(body)
	for _, want := range []string{"/metrics", "/healthz", "clash_traffic_bytes_total"} {
		if !strings.Contains(text, want) {
			t.Errorf("说明页缺少内容 %q", want)
		}
	}
}

func TestMetricsEndpoint(t *testing.T) {
	s := newTestServer(t)

	resp := do(t, s, http.MethodGet, "/metrics")
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 %d", resp.StatusCode, http.StatusOK)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应体失败: %v", err)
	}
	text := string(body)
	if !strings.Contains(text, "clash_up 1") {
		t.Errorf("/metrics 输出缺少 clash_up 指标:\n%s", text)
	}
}

// TestServerStartAndShutdown 校验真实监听端口上的服务可用，并能优雅关闭。
func TestServerStartAndShutdown(t *testing.T) {
	s := newTestServer(t)

	if err := s.Start(); err != nil {
		t.Fatalf("启动 HTTP 服务失败: %v", err)
	}
	addr := s.Addr()
	if addr == "127.0.0.1:0" {
		t.Fatal("启动后应当返回实际绑定的地址")
	}

	resp, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatalf("访问 /healthz 失败: %v", err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatalf("读取响应体失败: %v", err)
	}
	if string(body) != "ok" {
		t.Errorf("响应体 = %q, 期望 %q", string(body), "ok")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatalf("关闭 HTTP 服务失败: %v", err)
	}

	// 关闭后端口不再接受连接
	if _, err := http.Get("http://" + addr + "/healthz"); err == nil {
		t.Error("关闭后不应再能建立连接")
	}
}

// TestHandlerPromhttpMetrics 校验 /metrics 由 promhttp 提供，输出可被 Prometheus 解析。
func TestHandlerPromhttpMetrics(t *testing.T) {
	s := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	expected := `# HELP clash_up mihomo 内核可达性。
# TYPE clash_up gauge
clash_up 1
`
	if err := testutil.GatherAndCompare(s.reg, strings.NewReader(expected), "clash_up"); err != nil {
		t.Errorf("注册表内容与期望不一致: %v", err)
	}
}
