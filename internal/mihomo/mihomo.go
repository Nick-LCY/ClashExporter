// Package mihomo 提供 mihomo 内核 /connections API 的只读客户端与响应数据结构。
//
// 实测结论（mihomo v1.19.30，meta:true）：upload / download 为 JSON 数字，
// metadata.host 存在但可能为空字符串（无法识别时），接口无需鉴权头。
package mihomo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// maxResponseBytes 限制单次响应体的读取上限（64MB），避免异常响应撑爆内存。
	maxResponseBytes int64 = 64 << 20

	// minTimeout 是客户端超时的下限，防止轮询间隔很短时请求被过早掐断。
	minTimeout = 10 * time.Second
)

// responseLimit 是实际生效的读取上限，正常等于 maxResponseBytes；
// 单元测试会临时调小它，避免搬运 64MB 数据。
var responseLimit = maxResponseBytes

// ConnectionMetadata 是单条连接的元信息。
type ConnectionMetadata struct {
	Network         string `json:"network"`
	Type            string `json:"type"`
	SourceIP        string `json:"sourceIP"`
	SourcePort      string `json:"sourcePort"`
	DestinationIP   string `json:"destinationIP"`
	DestinationPort string `json:"destinationPort"`
	Host            string `json:"host"`
}

// Connection 是单条活跃连接及其生命周期内的累计字节数。
type Connection struct {
	ID       string             `json:"id"`
	Metadata ConnectionMetadata `json:"metadata"`
	Upload   uint64             `json:"upload"`
	Download uint64             `json:"download"`
	Start    string             `json:"start"`
	Chains   []string           `json:"chains"`
	Rule     string             `json:"rule"`
}

// ConnectionsResponse 是 /connections 的响应体。
type ConnectionsResponse struct {
	DownloadTotal uint64       `json:"downloadTotal"`
	UploadTotal   uint64       `json:"uploadTotal"`
	Connections   []Connection `json:"connections"`
}

// Client 是 mihomo API 的只读客户端。
type Client struct {
	baseURL string
	secret  string
	http    *http.Client
}

// NewClient 创建客户端，不发起任何网络请求。
//
// timeout 小于 10s 时按 10s 处理；调用方应传入轮询间隔的 2 倍，
// 使实际超时等于 max(10s, 2×poll_interval)，从而避免轮询重叠。
func NewClient(baseURL, secret string, timeout time.Duration) *Client {
	if timeout < minTimeout {
		timeout = minTimeout
	}
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		secret:  secret,
		http:    &http.Client{Timeout: timeout},
	}
}

// Timeout 返回客户端实际使用的请求超时。
func (c *Client) Timeout() time.Duration {
	return c.http.Timeout
}

// FetchConnections 拉取当前活跃连接列表。
func (c *Client) FetchConnections(ctx context.Context) (*ConnectionsResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/connections", nil)
	if err != nil {
		return nil, fmt.Errorf("构造 /connections 请求失败: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if c.secret != "" {
		req.Header.Set("Authorization", "Bearer "+c.secret)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求 mihomo API 失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("mihomo API 返回非 2xx 状态码: %s", resp.Status)
	}

	// 多读 1 字节：读到的长度超过上限就能判定超限，而不是把截断后的半个 JSON
	// 当成解析错误报出去。
	body, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit+1))
	if err != nil {
		return nil, fmt.Errorf("读取 mihomo 响应体失败: %w", err)
	}
	if int64(len(body)) > responseLimit {
		return nil, fmt.Errorf("响应体超过 %s 上限", humanSize(responseLimit))
	}

	var out ConnectionsResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("解析 mihomo 响应 JSON 失败: %w", err)
	}
	return &out, nil
}

// humanSize 把字节数格式化成便于阅读的容量字符串（64MB / 1KB / 512B）。
func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.0f%cB", float64(n)/float64(div), "KMGTPE"[exp])
}
