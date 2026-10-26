// Package httpapi 封装对外的 HTTP 服务：/metrics、/ 说明页、/healthz。
//
// 服务只做暴露，不做鉴权与访问控制，部署在内网由防火墙或反向代理兜底。
package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// readHeaderTimeout 限制读取请求头的时间，避免慢连接占住服务。
const readHeaderTimeout = 10 * time.Second

// indexPage 是根路径的说明页（纯文本）。
const indexPage = `ClashExporter — mihomo 流量 Prometheus exporter

端点：
  /metrics   Prometheus 抓取端点（核心指标 clash_traffic_bytes_total 等）
  /healthz   健康检查，返回 ok
  /          本说明页

核心指标按 设备(device) × 站点(site) × 出口节点(proxy) × 方向(direction) 拆分，
所有维度切片统计交给 Prometheus 查询时的 sum by / increase 完成。
`

// Server 是 HTTP 服务。
type Server struct {
	addr string
	reg  *prometheus.Registry
	srv  *http.Server

	mu        sync.Mutex
	boundAddr string
}

// New 创建 HTTP 服务。addr 为监听地址，reg 为指标来源。
func New(reg *prometheus.Registry, addr string) *Server {
	s := &Server{
		addr: addr,
		reg:  reg,
	}
	s.srv = &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: readHeaderTimeout,
	}
	return s
}

// Handler 返回路由处理器，供测试直接驱动。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(s.reg, promhttp.HandlerOpts{}))

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(indexPage))
	})

	return mux
}

// Start 监听端口并在独立协程里提供服务，立即返回。
//
// 先建立监听再返回，端口被占用等问题在启动阶段就能暴露。
func (s *Server) Start() error {
	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return fmt.Errorf("监听 %s 失败: %w", s.addr, err)
	}

	s.mu.Lock()
	s.boundAddr = ln.Addr().String()
	s.mu.Unlock()

	go func() {
		if err := s.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("HTTP 服务异常退出: %v", err)
		}
	}()
	return nil
}

// Addr 返回实际绑定的监听地址；未启动时返回配置地址。
func (s *Server) Addr() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.boundAddr != "" {
		return s.boundAddr
	}
	return s.addr
}

// Shutdown 优雅关闭服务，等待在途请求处理完毕。
func (s *Server) Shutdown(ctx context.Context) error {
	if err := s.srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("关闭 HTTP 服务失败: %w", err)
	}
	return nil
}
