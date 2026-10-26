// Package config 提供 ClashExporter 的配置结构、默认值、YAML 加载与校验。
//
// 配置文件是单个 YAML 文件，未出现的字段使用 Default() 的取值；
// 未知字段、非法取值在加载期直接报错，避免错误配置带到运行期。
package config

import (
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Duration 是可由 YAML 直接书写的时间间隔类型，支持 "5s"/"24h" 字符串与整数秒。
type Duration time.Duration

// UnmarshalYAML 解析 YAML 标量：字符串按 time.ParseDuration 解析，
// 整数按秒解释，浮点数按秒解释。
func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	var raw any
	if err := node.Decode(&raw); err != nil {
		return fmt.Errorf("解析时长失败: %w", err)
	}
	switch v := raw.(type) {
	case nil:
		*d = 0
		return nil
	case int:
		*d = Duration(time.Duration(v) * time.Second)
		return nil
	case int64:
		*d = Duration(time.Duration(v) * time.Second)
		return nil
	case uint64:
		*d = Duration(time.Duration(v) * time.Second)
		return nil
	case float64:
		*d = Duration(time.Duration(v * float64(time.Second)))
		return nil
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			*d = 0
			return nil
		}
		if parsed, err := time.ParseDuration(s); err == nil {
			*d = Duration(parsed)
			return nil
		}
		if seconds, err := strconv.ParseFloat(s, 64); err == nil {
			*d = Duration(time.Duration(seconds * float64(time.Second)))
			return nil
		}
		return fmt.Errorf("无法解析时长 %q（示例：\"5s\"、\"24h\" 或整数秒）", v)
	default:
		return fmt.Errorf("无法解析时长 %v（示例：\"5s\"、\"24h\" 或整数秒）", raw)
	}
}

// MarshalYAML 把时长写回可读的字符串形式。
func (d Duration) MarshalYAML() (any, error) {
	return time.Duration(d).String(), nil
}

// Duration 返回底层的时间间隔。
func (d Duration) Duration() time.Duration {
	return time.Duration(d)
}

// SiteGroupRule 是一条站点归组规则：host 命中 Pattern 时归入 Group。
type SiteGroupRule struct {
	Pattern string `yaml:"pattern"`
	Group   string `yaml:"group"`
}

// Config 是 ClashExporter 的完整配置。
type Config struct {
	APIURL           string            `yaml:"api_url"`
	APISecret        string            `yaml:"api_secret"`
	PollInterval     Duration          `yaml:"poll_interval"`
	EvictTTL         Duration          `yaml:"evict_ttl"`
	SnapshotInterval Duration          `yaml:"snapshot_interval"`
	SiteLabelCap     int               `yaml:"site_label_cap"`
	SnapshotPath     string            `yaml:"snapshot_path"`
	ListenAddr       string            `yaml:"listen_addr"`
	DeviceAliases    map[string]string `yaml:"device_aliases"`
	SiteGroupRules   []SiteGroupRule   `yaml:"site_group_rules"`
}

// Default 返回默认配置，取值与 config.example.yml 的注释保持一致。
func Default() *Config {
	return &Config{
		APIURL:           "http://192.168.2.2:9090",
		APISecret:        "",
		PollInterval:     Duration(5 * time.Second),
		EvictTTL:         Duration(24 * time.Hour),
		SnapshotInterval: Duration(30 * time.Second),
		SiteLabelCap:     10000,
		SnapshotPath:     "./data/state.json",
		ListenAddr:       ":9095",
		DeviceAliases:    map[string]string{},
		SiteGroupRules:   []SiteGroupRule{},
	}
}

// Load 读取并校验配置文件。path 为空时返回默认配置。
//
// 加载期即校验：未知字段、文件缺失、非法取值（含无法编译的正则）都会返回错误。
func Load(path string) (*Config, error) {
	if strings.TrimSpace(path) == "" {
		return Default(), nil
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("打开配置文件 %s 失败: %w", path, err)
	}
	defer f.Close()

	cfg := Default()
	dec := yaml.NewDecoder(f)
	dec.KnownFields(true)
	if err := dec.Decode(cfg); err != nil {
		if errors.Is(err, io.EOF) {
			// 空文件等价于全默认配置
			return cfg, nil
		}
		return nil, fmt.Errorf("解析配置文件 %s 失败: %w", path, err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("配置文件 %s 校验失败: %w", path, err)
	}
	return cfg, nil
}

// Validate 校验配置的取值是否合法。
func (c *Config) Validate() error {
	if c == nil {
		return errors.New("配置为空")
	}

	poll := c.PollInterval.Duration()
	if poll < time.Second || poll > 60*time.Second {
		return fmt.Errorf("poll_interval 必须落在 [1s, 60s]，当前为 %s", poll)
	}
	if c.EvictTTL.Duration() <= 0 {
		return fmt.Errorf("evict_ttl 必须大于 0，当前为 %s", c.EvictTTL.Duration())
	}
	if c.SnapshotInterval.Duration() <= 0 {
		return fmt.Errorf("snapshot_interval 必须大于 0，当前为 %s", c.SnapshotInterval.Duration())
	}
	if c.SiteLabelCap <= 0 {
		return fmt.Errorf("site_label_cap 必须大于 0，当前为 %d", c.SiteLabelCap)
	}
	if strings.TrimSpace(c.APIURL) == "" {
		return errors.New("api_url 不能为空")
	}
	u, err := url.Parse(c.APIURL)
	if err != nil {
		return fmt.Errorf("api_url 无法解析: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("api_url 的 scheme 必须是 http 或 https，当前为 %q", u.Scheme)
	}
	if u.Host == "" {
		return errors.New("api_url 缺少主机名")
	}
	if strings.TrimSpace(c.ListenAddr) == "" {
		return errors.New("listen_addr 不能为空")
	}
	if strings.TrimSpace(c.SnapshotPath) == "" {
		return errors.New("snapshot_path 不能为空")
	}
	for i, rule := range c.SiteGroupRules {
		if _, err := regexp.Compile(rule.Pattern); err != nil {
			return fmt.Errorf("site_group_rules[%d] 的 pattern %q 无法编译: %w", i, rule.Pattern, err)
		}
		if strings.TrimSpace(rule.Group) == "" {
			return fmt.Errorf("site_group_rules[%d] 的 group 不能为空", i)
		}
	}
	return nil
}
