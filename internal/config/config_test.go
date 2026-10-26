package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDefaultConfig(t *testing.T) {
	cfg := Default()

	if cfg.APIURL != "http://192.168.2.2:9090" {
		t.Errorf("api_url 默认值 = %q, 期望 %q", cfg.APIURL, "http://192.168.2.2:9090")
	}
	if cfg.APISecret != "" {
		t.Errorf("api_secret 默认值 = %q, 期望空字符串", cfg.APISecret)
	}
	if got := cfg.PollInterval.Duration(); got != 5*time.Second {
		t.Errorf("poll_interval 默认值 = %s, 期望 5s", got)
	}
	if got := cfg.EvictTTL.Duration(); got != 24*time.Hour {
		t.Errorf("evict_ttl 默认值 = %s, 期望 24h", got)
	}
	if got := cfg.SnapshotInterval.Duration(); got != 30*time.Second {
		t.Errorf("snapshot_interval 默认值 = %s, 期望 30s", got)
	}
	if cfg.SiteLabelCap != 10000 {
		t.Errorf("site_label_cap 默认值 = %d, 期望 10000", cfg.SiteLabelCap)
	}
	if cfg.SnapshotPath != "./data/state.json" {
		t.Errorf("snapshot_path 默认值 = %q, 期望 %q", cfg.SnapshotPath, "./data/state.json")
	}
	if cfg.ListenAddr != ":9095" {
		t.Errorf("listen_addr 默认值 = %q, 期望 %q", cfg.ListenAddr, ":9095")
	}
	if len(cfg.DeviceAliases) != 0 {
		t.Errorf("device_aliases 默认值应为空, 实际 %v", cfg.DeviceAliases)
	}
	if len(cfg.SiteGroupRules) != 0 {
		t.Errorf("site_group_rules 默认值应为空, 实际 %v", cfg.SiteGroupRules)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("默认配置应当通过校验: %v", err)
	}
}

func TestLoadYAMLParsesDurationsAndRules(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yml")
	content := `
api_url: "http://10.0.0.1:9090"
api_secret: "s3cret"
poll_interval: 10s
evict_ttl: 48h
snapshot_interval: 60
site_label_cap: 42
snapshot_path: "/var/lib/clash-exporter/state.json"
listen_addr: "127.0.0.1:19095"
device_aliases:
  "198.18.0.1": "旁路由本机"
site_group_rules:
  - pattern: "(?i)\\.google\\.com$"
    group: "google"
  - pattern: ".*"
    group: "other"
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("写入临时配置失败: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("加载配置失败: %v", err)
	}

	if cfg.APIURL != "http://10.0.0.1:9090" {
		t.Errorf("api_url = %q", cfg.APIURL)
	}
	if cfg.APISecret != "s3cret" {
		t.Errorf("api_secret = %q", cfg.APISecret)
	}
	if got := cfg.PollInterval.Duration(); got != 10*time.Second {
		t.Errorf("poll_interval = %s, 期望 10s", got)
	}
	if got := cfg.EvictTTL.Duration(); got != 48*time.Hour {
		t.Errorf("evict_ttl = %s, 期望 48h", got)
	}
	if got := cfg.SnapshotInterval.Duration(); got != 60*time.Second {
		t.Errorf("snapshot_interval = %s, 期望 60s（整数秒）", got)
	}
	if cfg.SiteLabelCap != 42 {
		t.Errorf("site_label_cap = %d, 期望 42", cfg.SiteLabelCap)
	}
	if cfg.SnapshotPath != "/var/lib/clash-exporter/state.json" {
		t.Errorf("snapshot_path = %q", cfg.SnapshotPath)
	}
	if cfg.ListenAddr != "127.0.0.1:19095" {
		t.Errorf("listen_addr = %q", cfg.ListenAddr)
	}
	if got := cfg.DeviceAliases["198.18.0.1"]; got != "旁路由本机" {
		t.Errorf("device_aliases[198.18.0.1] = %q, 期望 %q", got, "旁路由本机")
	}
	if len(cfg.SiteGroupRules) != 2 {
		t.Fatalf("site_group_rules 条数 = %d, 期望 2", len(cfg.SiteGroupRules))
	}
	if cfg.SiteGroupRules[0].Pattern != "(?i)\\.google\\.com$" || cfg.SiteGroupRules[0].Group != "google" {
		t.Errorf("site_group_rules[0] = %+v", cfg.SiteGroupRules[0])
	}
}

func TestLoadYAMLDefaultsFillMissingFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yml")
	if err := os.WriteFile(path, []byte("api_url: \"http://10.0.0.1:9090\"\n"), 0o644); err != nil {
		t.Fatalf("写入临时配置失败: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("加载配置失败: %v", err)
	}

	def := Default()
	if cfg.PollInterval != def.PollInterval {
		t.Errorf("缺省 poll_interval = %s, 期望 %s", cfg.PollInterval.Duration(), def.PollInterval.Duration())
	}
	if cfg.EvictTTL != def.EvictTTL {
		t.Errorf("缺省 evict_ttl = %s, 期望 %s", cfg.EvictTTL.Duration(), def.EvictTTL.Duration())
	}
	if cfg.SnapshotInterval != def.SnapshotInterval {
		t.Errorf("缺省 snapshot_interval = %s, 期望 %s", cfg.SnapshotInterval.Duration(), def.SnapshotInterval.Duration())
	}
	if cfg.SiteLabelCap != def.SiteLabelCap {
		t.Errorf("缺省 site_label_cap = %d, 期望 %d", cfg.SiteLabelCap, def.SiteLabelCap)
	}
	if cfg.SnapshotPath != def.SnapshotPath {
		t.Errorf("缺省 snapshot_path = %q, 期望 %q", cfg.SnapshotPath, def.SnapshotPath)
	}
	if cfg.ListenAddr != def.ListenAddr {
		t.Errorf("缺省 listen_addr = %q, 期望 %q", cfg.ListenAddr, def.ListenAddr)
	}
}

func TestLoadUnknownFieldFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yml")
	if err := os.WriteFile(path, []byte("api_url: \"http://10.0.0.1:9090\"\nunknown_field: 1\n"), 0o644); err != nil {
		t.Fatalf("写入临时配置失败: %v", err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("未知字段应当返回错误")
	}
}

func TestLoadMissingFileFails(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "not-exist.yml")); err == nil {
		t.Fatal("文件缺失应当返回错误")
	}
}

func TestLoadEmptyPathReturnsDefaults(t *testing.T) {
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("空路径加载失败: %v", err)
	}
	if cfg.APIURL != Default().APIURL {
		t.Errorf("空路径加载结果与默认值不一致: %+v", cfg)
	}
}

func TestLoadInvalidRegexFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yml")
	content := "site_group_rules:\n  - pattern: \"([\"\n    group: \"bad\"\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("写入临时配置失败: %v", err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("无法编译的正则应当返回错误")
	}
}

func TestValidateRejectsBadValues(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*Config)
	}{
		{"poll_interval 过小", func(c *Config) { c.PollInterval = Duration(500 * time.Millisecond) }},
		{"poll_interval 过大", func(c *Config) { c.PollInterval = Duration(90 * time.Second) }},
		{"evict_ttl 为零", func(c *Config) { c.EvictTTL = 0 }},
		{"evict_ttl 为负", func(c *Config) { c.EvictTTL = Duration(-time.Hour) }},
		{"snapshot_interval 为零", func(c *Config) { c.SnapshotInterval = 0 }},
		{"site_label_cap 为零", func(c *Config) { c.SiteLabelCap = 0 }},
		{"site_label_cap 为负", func(c *Config) { c.SiteLabelCap = -1 }},
		{"api_url 为空", func(c *Config) { c.APIURL = "" }},
		{"api_url scheme 非法", func(c *Config) { c.APIURL = "ftp://10.0.0.1:9090" }},
		{"api_url 缺少主机", func(c *Config) { c.APIURL = "http://" }},
		{"listen_addr 为空", func(c *Config) { c.ListenAddr = "" }},
		{"snapshot_path 为空", func(c *Config) { c.SnapshotPath = "  " }},
		{"规则正则非法", func(c *Config) {
			c.SiteGroupRules = []SiteGroupRule{{Pattern: "([", Group: "bad"}}
		}},
		{"规则 group 为空", func(c *Config) {
			c.SiteGroupRules = []SiteGroupRule{{Pattern: ".*", Group: ""}}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Default()
			tc.mut(cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatalf("%s: 期望返回错误", tc.name)
			}
		})
	}
}

// TestExampleFileMatchesDefaults 保证 config.example.yml 能被加载，且与默认值逐项一致。
func TestExampleFileMatchesDefaults(t *testing.T) {
	cfg, err := Load(filepath.Join("..", "..", "config.example.yml"))
	if err != nil {
		t.Fatalf("加载示例配置失败: %v", err)
	}

	def := Default()
	if cfg.APIURL != def.APIURL {
		t.Errorf("示例 api_url = %q, 期望 %q", cfg.APIURL, def.APIURL)
	}
	if cfg.APISecret != def.APISecret {
		t.Errorf("示例 api_secret = %q, 期望 %q", cfg.APISecret, def.APISecret)
	}
	if cfg.PollInterval != def.PollInterval {
		t.Errorf("示例 poll_interval = %s, 期望 %s", cfg.PollInterval.Duration(), def.PollInterval.Duration())
	}
	if cfg.EvictTTL != def.EvictTTL {
		t.Errorf("示例 evict_ttl = %s, 期望 %s", cfg.EvictTTL.Duration(), def.EvictTTL.Duration())
	}
	if cfg.SnapshotInterval != def.SnapshotInterval {
		t.Errorf("示例 snapshot_interval = %s, 期望 %s", cfg.SnapshotInterval.Duration(), def.SnapshotInterval.Duration())
	}
	if cfg.SiteLabelCap != def.SiteLabelCap {
		t.Errorf("示例 site_label_cap = %d, 期望 %d", cfg.SiteLabelCap, def.SiteLabelCap)
	}
	if cfg.SnapshotPath != def.SnapshotPath {
		t.Errorf("示例 snapshot_path = %q, 期望 %q", cfg.SnapshotPath, def.SnapshotPath)
	}
	if cfg.ListenAddr != def.ListenAddr {
		t.Errorf("示例 listen_addr = %q, 期望 %q", cfg.ListenAddr, def.ListenAddr)
	}
	if len(cfg.DeviceAliases) != len(def.DeviceAliases) {
		t.Errorf("示例 device_aliases 条数 = %d, 期望 %d", len(cfg.DeviceAliases), len(def.DeviceAliases))
	}
	if len(cfg.SiteGroupRules) != len(def.SiteGroupRules) {
		t.Errorf("示例 site_group_rules 条数 = %d, 期望 %d", len(cfg.SiteGroupRules), len(def.SiteGroupRules))
	}
}
