package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

func lockPath(installDir string) string {
	return filepath.Join(installDir, "data", "app.lock")
}

// acquireSingleInstanceLock records this PID and refuses to start when a live
// instance already holds the lock.
//
// Without it, the startup task and a desktop double-click each produce a tray
// icon, a window, and a Telegram poller — and two pollers fight over the same bot
// token, so neither works reliably.
func acquireSingleInstanceLock(installDir string) (release func(), err error) {
	path := lockPath(installDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir: %w", err)
	}

	if data, readErr := os.ReadFile(path); readErr == nil {
		if pid, convErr := strconv.Atoi(string(data)); convErr == nil && pid > 0 {
			if pid != os.Getpid() && isProcessAlive(pid) {
				return nil, fmt.Errorf("already running (pid %d)", pid)
			}
		}
		// Stale lock from a crash or a hard power-off; fall through and take it.
	}

	if err := os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		return nil, fmt.Errorf("write lock: %w", err)
	}

	return func() {
		// Only remove a lock that is still ours, so a takeover cannot delete the
		// new owner's entry.
		if data, err := os.ReadFile(path); err == nil && string(data) == strconv.Itoa(os.Getpid()) {
			_ = os.Remove(path)
		}
	}, nil
}

func readLockPID(installDir string) int {
	data, err := os.ReadFile(lockPath(installDir))
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}
