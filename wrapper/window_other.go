//go:build !windows

package main

import (
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
)

// macOS and Linux get a Chromium app-mode window rather than WebView2, which is
// Windows-only. `--app=` produces a chromeless window with no tab strip or
// address bar, and an isolated profile keeps it out of the user's own browser
// session — so it reads as an application, not a tab.
//
// Falls back to the default browser only when no Chromium-family browser exists.

func WebView2Available() bool { return false }

func RunWindowHost(installDir, dashboardURL, readyPath string) bool { return false }

func OpenWindow(installDir, dashboardURL string) bool {
	browser := resolveChromium()
	if browser == "" {
		log.Printf("window: no Chrome/Chromium/Edge found — using the default browser")
		return openTarget(dashboardURL) == nil
	}

	profile := filepath.Join(installDir, "data", "window")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		log.Printf("window: profile dir: %v", err)
		return false
	}

	cmd := exec.Command(browser,
		"--app="+dashboardURL,
		"--user-data-dir="+profile,
		"--window-size=1180,820",
		"--no-first-run",
		"--no-default-browser-check",
	)
	cmd.Dir = installDir
	if err := cmd.Start(); err != nil {
		log.Printf("window: launch app window: %v — using the default browser", err)
		return openTarget(dashboardURL) == nil
	}
	trackWindowProcess(cmd.Process)
	return true
}

func resolveChromium() string {
	var candidates []string
	if runtime.GOOS == "darwin" {
		candidates = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		}
	} else {
		for _, name := range []string{"google-chrome", "chromium", "chromium-browser", "microsoft-edge"} {
			if path, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, path)
			}
		}
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

func isAllowedExternalURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	switch u.Scheme {
	case "http", "https", "mailto":
		return u.Host != "" || u.Scheme == "mailto"
	default:
		return false
	}
}

var windowPIDs struct {
	mu   sync.Mutex
	pids []int
}

func trackWindowProcess(process *os.Process) {
	windowPIDs.mu.Lock()
	windowPIDs.pids = append(windowPIDs.pids, process.Pid)
	windowPIDs.mu.Unlock()
	go func() {
		_, _ = process.Wait()
		windowPIDs.mu.Lock()
		for i, pid := range windowPIDs.pids {
			if pid == process.Pid {
				windowPIDs.pids = append(windowPIDs.pids[:i], windowPIDs.pids[i+1:]...)
				break
			}
		}
		windowPIDs.mu.Unlock()
	}()
}

func closeWindows() {
	windowPIDs.mu.Lock()
	pids := append([]int(nil), windowPIDs.pids...)
	windowPIDs.pids = nil
	windowPIDs.mu.Unlock()
	for _, pid := range pids {
		killProcessTree(pid)
	}
}
