// Command clash-exporter 读取 mihomo 的 /connections API，用本地账本把连接的累计
// 字节数换算成增量流量，并以单表全维度计数器的形式暴露给 Prometheus。
//
// 装配顺序：解析配置 → 建账本 → 恢复快照 → 注册指标 → 启动 HTTP → 启动轮询与快照协程
// → 等待信号 → 优雅退出（停协程 → 关 HTTP → 写最后一次快照）。
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"

	"github.com/sankabox/clash-exporter/internal/collector"
	"github.com/sankabox/clash-exporter/internal/config"
	"github.com/sankabox/clash-exporter/internal/httpapi"
	"github.com/sankabox/clash-exporter/internal/ledger"
	"github.com/sankabox/clash-exporter/internal/mihomo"
	"github.com/sankabox/clash-exporter/internal/snapshot"
)

// shutdownTimeout 是关闭 HTTP 服务时等待在途请求的时限。
const shutdownTimeout = 5 * time.Second

func main() {
	configPath := flag.String("config", "", "配置文件路径（YAML）；留空使用内置默认配置")
	flag.Parse()

	log.SetFlags(log.LstdFlags)
	log.SetPrefix("[clash-exporter] ")

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		log.Fatalf("配置校验失败: %v", err)
	}

	// 账本：归组规则在此编译，编译失败直接退出，不带病运行。
	rules := make([]ledger.GroupRule, 0, len(cfg.SiteGroupRules))
	for i, rule := range cfg.SiteGroupRules {
		re, err := regexp.Compile(rule.Pattern)
		if err != nil {
			log.Fatalf("归组规则[%d] 的正则 %q 无法编译: %v", i, rule.Pattern, err)
		}
		rules = append(rules, ledger.GroupRule{Pattern: re, Group: rule.Group})
	}

	book, err := ledger.New(ledger.Options{
		SiteCap:       cfg.SiteLabelCap,
		EvictTTL:      cfg.EvictTTL.Duration(),
		DeviceAliases: cfg.DeviceAliases,
		GroupRules:    rules,
	})
	if err != nil {
		log.Fatalf("创建账本失败: %v", err)
	}

	// 快照恢复：必须在开始轮询之前完成，否则存量连接会被当作首次出现而重复计入。
	state, err := snapshot.Load(cfg.SnapshotPath)
	if err != nil {
		log.Fatalf("加载快照失败: %v", err)
	}
	if state != nil {
		book.Restore(state)
		log.Printf("已从快照恢复: 条目 %d, 活跃连接 %d", book.EntryCount(), book.ActiveConnections())
	}

	// 指标注册：只注册到独立注册表，不污染全局默认注册表。
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collector.New(book),
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)

	srv := httpapi.New(reg, cfg.ListenAddr)
	if err := srv.Start(); err != nil {
		log.Fatalf("启动 HTTP 服务失败: %v", err)
	}
	log.Printf("HTTP 服务已启动: %s", srv.Addr())

	// 客户端超时取 max(10s, 2×轮询间隔)，防止轮询重叠。
	client := mihomo.NewClient(cfg.APIURL, cfg.APISecret, 2*cfg.PollInterval.Duration())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(2)
	go pollLoop(ctx, &wg, client, book, cfg.PollInterval.Duration())
	go snapshotLoop(ctx, &wg, book, cfg.SnapshotPath, cfg.SnapshotInterval.Duration())

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	var shutdownOnce sync.Once
	shutdown := func() {
		shutdownOnce.Do(func() {
			log.Println("收到退出信号，开始优雅退出")

			// ① 停协程
			cancel()
			wg.Wait()

			// ② 关 HTTP
			shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), shutdownTimeout)
			defer shutdownCancel()
			if err := srv.Shutdown(shutdownCtx); err != nil {
				log.Printf("关闭 HTTP 服务失败: %v", err)
			}

			// ③ 最后写一次快照
			if err := snapshot.Save(cfg.SnapshotPath, book.Snapshot()); err != nil {
				log.Printf("写入最终快照失败: %v", err)
			}
			log.Println("已退出")
		})
	}

	<-sigCh
	// 第二个信号直接退出，不再等待优雅关闭。
	go func() {
		<-sigCh
		log.Println("再次收到退出信号，立即退出")
		os.Exit(1)
	}()
	shutdown()
}

// pollLoop 定时拉取 mihomo 的活跃连接并入账。
//
// 拉取失败只把可达性置为 false，绝不执行消失检测：网络抖动不能把活连接误判为消失，
// 否则会重复计入其累计值造成流量虚高。
func pollLoop(ctx context.Context, wg *sync.WaitGroup, client *mihomo.Client, book *ledger.Ledger, interval time.Duration) {
	defer wg.Done()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// 启动即先采一轮，避免启动后第一个周期内指标为空。
	scrape(ctx, client, book)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			scrape(ctx, client, book)
		}
	}
}

// scrape 执行一轮拉取与入账。
func scrape(ctx context.Context, client *mihomo.Client, book *ledger.Ledger) {
	start := time.Now()
	resp, err := client.FetchConnections(ctx)
	if err != nil {
		log.Printf("拉取 mihomo 连接失败: %v", err)
		book.SetUp(false)
		return
	}

	book.Observe(time.Now(), resp)
	book.SetScrapeDuration(time.Since(start))
	book.SetUp(true)
}

// snapshotLoop 定时把账本状态原子写盘。
func snapshotLoop(ctx context.Context, wg *sync.WaitGroup, book *ledger.Ledger, path string, interval time.Duration) {
	defer wg.Done()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := snapshot.Save(path, book.Snapshot()); err != nil {
				log.Printf("写入快照失败: %v", err)
			}
		}
	}
}
