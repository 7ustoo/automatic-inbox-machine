// AIM.exe — the application.
//
// This is what the Start Menu shortcut runs and what the taskbar shows. It owns
// the tray icon, supervises the three Node processes, and opens the dashboard in a
// native window. No browser, no console, no terminal.
//
// Process layout on Windows:
//
//	AIM.exe                        primary: tray + supervisor
//	 ├── AIM.exe --window-host     native WebView2 window (own message loop)
//	 ├── node scripts/dashboard.mjs
//	 ├── node scripts/watcher.mjs
//	 └── node scripts/telegram-bot.mjs
//
// The window is a child process because WebView2 and the system tray each need to
// own a Win32 message loop pinned to the main OS thread, and they cannot both have
// it. It also means the taskbar groups the window under AIM.exe rather than
// msedge.exe.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// AIMVersion is injected at build time via -ldflags "-X main.AIMVersion=...".
var AIMVersion = "dev"

func main() {
	var (
		windowHost    = flag.Bool("window-host", false, "internal: run the native window host")
		windowURL     = flag.String("window-url", "", "internal: dashboard URL for the window host")
		windowReady   = flag.String("window-ready-file", "", "internal: readiness file for the window host")
		installDirArg = flag.String("install-dir", "", "installation directory (defaults to the exe's parent)")
		showVersion   = flag.Bool("version", false, "print the version and exit")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println(AIMVersion)
		return
	}

	installDir := resolveInstallDir(*installDirArg)
	setupLogging(installDir, *windowHost)

	// Child mode: own a window and nothing else. Deliberately before the
	// single-instance lock — the child is not another instance.
	if *windowHost {
		if !RunWindowHost(installDir, *windowURL, *windowReady) {
			os.Exit(1)
		}
		return
	}

	release, err := acquireSingleInstanceLock(installDir)
	if err != nil {
		// Already running: this is a second double-click. Hand the request to the
		// live instance by raising its window, then exit quietly. Doing nothing
		// here is what makes an app feel broken.
		log.Printf("aim: %v — asking the running instance to show its window", err)
		handOffToRunningInstance(installDir)
		return
	}
	defer release()

	log.Printf("aim: starting v%s in %s", AIMVersion, installDir)

	supervisor := NewSupervisor(installDir)
	if !supervisor.NodeAvailable() {
		fatalDialog("Automatic Inbox Machine is missing its runtime.\n\n" +
			"Expected: " + supervisor.NodePath() + "\n\n" +
			"Reinstall from the latest release to fix this.")
		return
	}

	// A stale port file would make the window open against a dead server.
	supervisor.ClearPortFile()

	if err := supervisor.Start(procDashboard); err != nil {
		fatalDialog("Could not start the dashboard.\n\nSee logs\\app.log for details.")
		return
	}

	dashboardURL := supervisor.WaitForDashboard(25 * time.Second)
	if dashboardURL == "" {
		fatalDialog("The dashboard did not start.\n\nSee logs\\dashboard-stdio.log for details.")
		supervisor.StopAll()
		return
	}
	log.Printf("aim: dashboard ready at %s", dashboardURL)

	// The watcher and bot are started by the dashboard once setup is complete;
	// starting them here on a fresh install would only log config errors. On a
	// configured install they should come up immediately.
	if isConfigured(installDir) {
		_ = supervisor.Start(procWatcher)
		if hasTelegramToken(installDir) {
			_ = supervisor.Start(procBot)
		}
	}

	if !OpenWindow(installDir, dashboardURL) {
		log.Printf("aim: native window unavailable — opening the default browser instead")
		_ = openTarget(dashboardURL)
	}

	// Blocks on the tray event loop until Quit.
	runTray(installDir, dashboardURL, supervisor)

	log.Printf("aim: shutting down")
	closeWindows()
	supervisor.StopAll()
}

/* -------------------------------------------------------------------------- */

// resolveInstallDir finds the repo/install root: the parent of the directory
// holding the executable, since the binary lives in wrapper/dist/.
func resolveInstallDir(override string) string {
	if override != "" {
		if abs, err := filepath.Abs(override); err == nil {
			return abs
		}
		return override
	}

	exe, err := os.Executable()
	if err != nil {
		cwd, _ := os.Getwd()
		return cwd
	}
	dir := filepath.Dir(exe)

	// Walk up looking for the marker that identifies an install root. This copes
	// with both wrapper/dist/AIM.exe during development and whatever layout the
	// installer settles on.
	for i := 0; i < 4; i++ {
		if _, err := os.Stat(filepath.Join(dir, "scripts", "dashboard.mjs")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return filepath.Dir(filepath.Dir(exe))
}

func setupLogging(installDir string, isChild bool) {
	name := "app.log"
	if isChild {
		name = "window.log"
	}
	logDir := filepath.Join(installDir, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(logDir, name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	log.SetOutput(f)
	log.SetFlags(log.LstdFlags)
}

func isConfigured(installDir string) bool {
	data, err := os.ReadFile(filepath.Join(installDir, "config.json"))
	if err != nil {
		return false
	}
	// Good enough: a configured install has at least one account object in the
	// array. Parsing the whole schema here would duplicate config-rw.mjs.
	text := string(data)
	return strings.Contains(text, `"accounts"`) && strings.Contains(text, `"email"`)
}

func hasTelegramToken(installDir string) bool {
	data, err := os.ReadFile(filepath.Join(installDir, ".env"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "TG_TOKEN=") && len(trimmed) > len("TG_TOKEN=") {
			return true
		}
	}
	return false
}

// handOffToRunningInstance raises the live instance's window. If its window is
// gone but the process is alive, it reopens one at the recorded dashboard URL.
func handOffToRunningInstance(installDir string) {
	supervisor := NewSupervisor(installDir)
	url := supervisor.DashboardURL()
	if url == "" {
		log.Printf("aim: running instance has no dashboard port recorded")
		return
	}
	if OpenWindow(installDir, url) {
		return
	}
	log.Printf("aim: handoff could not open a window; opening the browser")
	_ = openTarget(url)
}

// fatalDialog surfaces a startup failure visibly. A GUI binary that exits
// silently is indistinguishable from a shortcut that does nothing, which is the
// worst possible failure mode for a double-clicked application.
func fatalDialog(message string) {
	log.Printf("aim: fatal: %s", strings.ReplaceAll(message, "\n", " "))
	showErrorDialog(windowTitleForDialogs(), message)
}

func windowTitleForDialogs() string { return "Automatic Inbox Machine" }
