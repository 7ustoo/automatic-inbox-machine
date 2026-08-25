//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
)

func nodeBinaryName() string { return "node" }

// No console-window concept outside Windows.
func applyChildHideWindow(cmd *exec.Cmd) {}

func openTarget(target string) error {
	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	return exec.Command(opener, target).Start()
}

// SIGTERM here is a real graceful stop: the watcher closes its mail connections
// and the bot flushes its poll offset.
func terminateProcess(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

func isCurrentExecutable(pid int) bool {
	actual, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
	if err != nil {
		// macOS and some Unix systems do not expose /proc. Preserve the existing
		// lock behaviour there rather than allowing duplicate tray instances.
		return true
	}
	expected, err := os.Executable()
	if err != nil {
		return true
	}
	return actual == expected
}

func killProcessTree(pid int) {
	// Negative pid targets the process group, taking supervised children with it.
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	if proc, err := os.FindProcess(pid); err == nil {
		_ = proc.Kill()
	}
}
