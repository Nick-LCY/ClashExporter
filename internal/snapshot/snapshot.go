// Package snapshot 负责账本状态的 JSON 持久化。
//
// 写入采用「同目录临时文件 → fsync → rename → 父目录 fsync」的原子替换，
// 保证任何时刻中断都不会读到半截 JSON；写失败时删除临时文件并保留旧快照。
package snapshot

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/sankabox/clash-exporter/internal/ledger"
)

// tempSuffix 是临时快照文件的后缀，最终文件名为 <快照文件名>.tmp。
const tempSuffix = ".tmp"

// Save 把账本状态原子写入 path。
func Save(path string, state *ledger.State) error {
	if path == "" {
		return errors.New("快照路径不能为空")
	}
	if state == nil {
		return errors.New("快照内容不能为空")
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建快照目录 %s 失败: %w", dir, err)
	}

	tmp := filepath.Join(dir, filepath.Base(path)+tempSuffix)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("创建临时快照文件 %s 失败: %w", tmp, err)
	}

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(state); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("写入快照失败: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("快照刷盘失败: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("关闭快照文件失败: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("替换快照文件失败: %w", err)
	}

	// 父目录 fsync：保证 rename 本身落盘
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// Load 读取快照。文件不存在时返回 (nil, nil)，表示无需恢复。
func Load(path string) (*ledger.State, error) {
	if path == "" {
		return nil, errors.New("快照路径不能为空")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取快照 %s 失败: %w", path, err)
	}

	var st ledger.State
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("解析快照 %s 失败: %w", path, err)
	}
	if st.Version != ledger.StateVersion {
		return nil, fmt.Errorf("快照 %s 版本不支持: %d（期望 %d）", path, st.Version, ledger.StateVersion)
	}
	return &st, nil
}
