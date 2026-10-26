package mihomo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const samplePayload = `{
  "downloadTotal": 30409922790,
  "uploadTotal": 95528824902,
  "connections": [
    {
      "id": "6b046dcb-5453-4622-9ea2-7032b50b6e82",
      "metadata": {
        "network": "tcp",
        "type": "Redir",
        "sourceIP": "192.168.2.135",
        "sourcePort": "10058",
        "destinationIP": "149.102.98.28",
        "destinationPort": "36447",
        "host": "example.com"
      },
      "upload": 77,
      "download": 1234,
      "start": "2026-10-26T15:11:11.961663113+08:00",
      "chains": ["🇭🇰 E-香港2", "KyCloud"],
      "rule": "Match"
    },
    {
      "id": "908dc504-4e8f-41c2-80e7-8a09199414b2",
      "metadata": {
        "network": "tcp",
        "type": "Tun",
        "sourceIP": "198.18.0.1",
        "sourcePort": "40129",
        "destinationIP": "202.175.67.170",
        "destinationPort": "11011",
        "host": ""
      },
      "upload": 0,
      "download": 0,
      "start": "2026-10-26T15:11:12.665800157+08:00",
      "chains": [],
      "rule": "Match"
    }
  ]
}`

func TestFetchConnectionsParsesPayload(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/connections" {
			t.Errorf("请求路径 = %q, 期望 /connections", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(samplePayload))
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "", time.Second)
	resp, err := client.FetchConnections(context.Background())
	if err != nil {
		t.Fatalf("拉取连接失败: %v", err)
	}

	if resp.UploadTotal != 95528824902 {
		t.Errorf("uploadTotal = %d, 期望 95528824902", resp.UploadTotal)
	}
	if resp.DownloadTotal != 30409922790 {
		t.Errorf("downloadTotal = %d, 期望 30409922790", resp.DownloadTotal)
	}
	if len(resp.Connections) != 2 {
		t.Fatalf("连接数 = %d, 期望 2", len(resp.Connections))
	}

	first := resp.Connections[0]
	if first.ID != "6b046dcb-5453-4622-9ea2-7032b50b6e82" {
		t.Errorf("id = %q", first.ID)
	}
	if first.Upload != 77 || first.Download != 1234 {
		t.Errorf("字节数解析错误: upload=%d download=%d", first.Upload, first.Download)
	}
	if first.Metadata.SourceIP != "192.168.2.135" {
		t.Errorf("sourceIP = %q", first.Metadata.SourceIP)
	}
	if first.Metadata.Host != "example.com" {
		t.Errorf("host = %q", first.Metadata.Host)
	}
	if first.Metadata.Type != "Redir" {
		t.Errorf("type = %q", first.Metadata.Type)
	}
	if len(first.Chains) != 2 || first.Chains[1] != "KyCloud" {
		t.Errorf("chains = %v", first.Chains)
	}

	second := resp.Connections[1]
	if second.Metadata.Host != "" {
		t.Errorf("host = %q, 期望空字符串", second.Metadata.Host)
	}
	if len(second.Chains) != 0 {
		t.Errorf("chains = %v, 期望空", second.Chains)
	}
}

func TestFetchConnectionsSendsBearerWhenSecretSet(t *testing.T) {
	var gotAuth string
	var gotPresent bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPresent = r.Header.Get("Authorization"), true
		_, _ = w.Write([]byte(`{"uploadTotal":1,"downloadTotal":2,"connections":[]}`))
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "s3cret", time.Second)
	if _, err := client.FetchConnections(context.Background()); err != nil {
		t.Fatalf("拉取连接失败: %v", err)
	}
	if !gotPresent {
		t.Fatal("请求未发出")
	}
	if gotAuth != "Bearer s3cret" {
		t.Errorf("Authorization = %q, 期望 %q", gotAuth, "Bearer s3cret")
	}
}

func TestFetchConnectionsOmitsAuthWhenSecretEmpty(t *testing.T) {
	var authValues [][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authValues = append(authValues, r.Header.Values("Authorization"))
		_, _ = w.Write([]byte(`{"uploadTotal":1,"downloadTotal":2,"connections":[]}`))
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "", time.Second)
	if _, err := client.FetchConnections(context.Background()); err != nil {
		t.Fatalf("拉取连接失败: %v", err)
	}
	if len(authValues) != 1 {
		t.Fatalf("请求数 = %d, 期望 1", len(authValues))
	}
	if len(authValues[0]) != 0 {
		t.Errorf("Authorization = %v, 期望不发送鉴权头", authValues[0])
	}
}

func TestFetchConnectionsServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "", time.Second)
	_, err := client.FetchConnections(context.Background())
	if err == nil {
		t.Fatal("非 2xx 响应应当返回错误")
	}
	if got := err.Error(); !strings.Contains(got, "500") {
		t.Errorf("错误信息 = %q, 期望包含状态码 500", got)
	}
}

func TestFetchConnectionsInvalidJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"connections": [`))
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "", time.Second)
	if _, err := client.FetchConnections(context.Background()); err == nil {
		t.Fatal("非法 JSON 应当返回错误")
	}
}

func TestNewClientAppliesTimeoutFloor(t *testing.T) {
	if got := NewClient("http://127.0.0.1:9090", "", time.Second).Timeout(); got != 10*time.Second {
		t.Errorf("超时下限 = %s, 期望 10s", got)
	}
	if got := NewClient("http://127.0.0.1:9090", "", 30*time.Second).Timeout(); got != 30*time.Second {
		t.Errorf("超时 = %s, 期望 30s", got)
	}
}

func TestNewClientStripsTrailingSlash(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"connections":[]}`))
	}))
	defer srv.Close()

	client := NewClient(srv.URL+"/", "", time.Second)
	if _, err := client.FetchConnections(context.Background()); err != nil {
		t.Fatalf("拉取连接失败: %v", err)
	}
	if gotPath != "/connections" {
		t.Errorf("请求路径 = %q, 期望 /connections", gotPath)
	}
}
