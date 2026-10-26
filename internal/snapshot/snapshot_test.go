package snapshot

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sankabox/clash-exporter/internal/ledger"
)

func sampleState() *ledger.State {
	base := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	return &ledger.State{
		Version:   ledger.StateVersion,
		UpdatedAt: base,
		Entries: []ledger.EntryState{
			{
				Entry: ledger.Entry{
					TotalUpload:          1000,
					TotalDownload:        2000,
					LastExportedUpload:   900,
					LastExportedDownload: 1800,
					PendingUpload:        100,
					PendingDownload:      200,
					LastActivity:         base,
					Evicted:              false,
					Reanchored:           true,
				},
				Key: ledger.Key{Device: "192.168.2.10", Site: "example.com", Proxy: "node-a"},
			},
		},
		Sites: []string{"example.com", "unresolved"},
		Connections: []ledger.ConnState{
			{
				ID:                "c1",
				Device:            "192.168.2.10",
				Site:              "example.com",
				Proxy:             "node-a",
				Upload:            500,
				Download:          700,
				AccountedUpload:   500,
				AccountedDownload: 700,
			},
		},
		GlobalUploadTotal:        10000,
		GlobalDownloadTotal:      20000,
		GlobalUploadMax:          10000,
		GlobalDownloadMax:        20000,
		Up:                       true,
		LastScrapeDurationSecond: 0.25,
		LastActiveConnections:    1,
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "state.json")
	want := sampleState()

	if err := Save(path, want); err != nil {
		t.Fatalf("保存快照失败: %v", err)
	}

	got, err := Load(path)
	if err != nil {
		t.Fatalf("加载快照失败: %v", err)
	}
	if got == nil {
		t.Fatal("加载快照返回空")
	}

	if got.Version != want.Version {
		t.Errorf("version = %d, 期望 %d", got.Version, want.Version)
	}
	if !got.UpdatedAt.Equal(want.UpdatedAt) {
		t.Errorf("updated_at = %s, 期望 %s", got.UpdatedAt, want.UpdatedAt)
	}
	if len(got.Entries) != 1 {
		t.Fatalf("entries 条数 = %d, 期望 1", len(got.Entries))
	}
	e := got.Entries[0]
	if e.Key != want.Entries[0].Key {
		t.Errorf("key = %+v, 期望 %+v", e.Key, want.Entries[0].Key)
	}
	if e.TotalUpload != want.Entries[0].TotalUpload || e.TotalDownload != want.Entries[0].TotalDownload {
		t.Errorf("累计值 = %d/%d, 期望 %d/%d", e.TotalUpload, e.TotalDownload,
			want.Entries[0].TotalUpload, want.Entries[0].TotalDownload)
	}
	if e.LastExportedUpload != want.Entries[0].LastExportedUpload || e.LastExportedDownload != want.Entries[0].LastExportedDownload {
		t.Errorf("已导出值 = %d/%d, 期望 %d/%d", e.LastExportedUpload, e.LastExportedDownload,
			want.Entries[0].LastExportedUpload, want.Entries[0].LastExportedDownload)
	}
	if e.PendingUpload != want.Entries[0].PendingUpload || e.PendingDownload != want.Entries[0].PendingDownload {
		t.Errorf("待导出值 = %d/%d, 期望 %d/%d", e.PendingUpload, e.PendingDownload,
			want.Entries[0].PendingUpload, want.Entries[0].PendingDownload)
	}
	if !e.LastActivity.Equal(want.Entries[0].LastActivity) {
		t.Errorf("last_activity = %s, 期望 %s", e.LastActivity, want.Entries[0].LastActivity)
	}
	if !e.Reanchored {
		t.Error("reanchored 应当被保留")
	}
	if len(got.Sites) != len(want.Sites) {
		t.Errorf("sites = %v, 期望 %v", got.Sites, want.Sites)
	}
	if len(got.Connections) != 1 {
		t.Fatalf("connections 条数 = %d, 期望 1", len(got.Connections))
	}
	if got.Connections[0] != want.Connections[0] {
		t.Errorf("connection = %+v, 期望 %+v", got.Connections[0], want.Connections[0])
	}
	if got.GlobalUploadTotal != want.GlobalUploadTotal || got.GlobalDownloadTotal != want.GlobalDownloadTotal {
		t.Errorf("全局原值 = %d/%d, 期望 %d/%d", got.GlobalUploadTotal, got.GlobalDownloadTotal,
			want.GlobalUploadTotal, want.GlobalDownloadTotal)
	}
	if got.GlobalUploadMax != want.GlobalUploadMax || got.GlobalDownloadMax != want.GlobalDownloadMax {
		t.Errorf("全局最大值 = %d/%d, 期望 %d/%d", got.GlobalUploadMax, got.GlobalDownloadMax,
			want.GlobalUploadMax, want.GlobalDownloadMax)
	}
	if !got.Up {
		t.Error("up 应当被保留")
	}
	if got.LastScrapeDurationSecond != want.LastScrapeDurationSecond {
		t.Errorf("last_scrape_duration_second = %v, 期望 %v", got.LastScrapeDurationSecond, want.LastScrapeDurationSecond)
	}
	if got.LastActiveConnections != want.LastActiveConnections {
		t.Errorf("last_active_connections = %d, 期望 %d", got.LastActiveConnections, want.LastActiveConnections)
	}
}

func TestLoadMissingFileReturnsNil(t *testing.T) {
	st, err := Load(filepath.Join(t.TempDir(), "not-exist.json"))
	if err != nil {
		t.Fatalf("缺失文件应当返回 (nil, nil), 实际错误: %v", err)
	}
	if st != nil {
		t.Errorf("缺失文件应当返回 nil, 实际 %+v", st)
	}
}

func TestLoadCorruptFileReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"entries":[`), 0o644); err != nil {
		t.Fatalf("写入损坏快照失败: %v", err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("损坏的快照应当返回错误")
	}
}

func TestLoadUnsupportedVersionReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte(`{"version":999}`), 0o644); err != nil {
		t.Fatalf("写入快照失败: %v", err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("版本不支持的快照应当返回错误")
	}
}

func TestSaveLeavesNoTempFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	if err := Save(path, sampleState()); err != nil {
		t.Fatalf("保存快照失败: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读取目录失败: %v", err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Errorf("残留临时文件: %s", e.Name())
		}
	}
	if len(entries) != 1 {
		t.Errorf("目录内文件数 = %d, 期望 1", len(entries))
	}
}

func TestSaveKeepsOldSnapshotOnFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	if err := Save(path, sampleState()); err != nil {
		t.Fatalf("首次保存快照失败: %v", err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取快照失败: %v", err)
	}

	// 用同名目录占住临时文件路径，使写入必然失败
	if err := os.Mkdir(path+".tmp", 0o755); err != nil {
		t.Fatalf("创建占位目录失败: %v", err)
	}

	changed := sampleState()
	changed.GlobalUploadTotal = 999999
	if err := Save(path, changed); err == nil {
		t.Fatal("写入失败时应当返回错误")
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取快照失败: %v", err)
	}
	if string(before) != string(after) {
		t.Error("写入失败后旧快照被破坏")
	}
}
