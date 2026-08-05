package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"fyne.io/systray"
)

// The tray is the app's persistent presence. Closing the window leaves the agent
// running — which is the whole point of a background mail agent — so there has to
// be somewhere to click to get it back, and somewhere to genuinely quit from.

const trayPollInterval = 5 * time.Second

type trayState struct {
	installDir   string
	dashboardURL string
	supervisor   *Supervisor

	itemOpen    *systray.MenuItem
	itemStatus  *systray.MenuItem
	itemPause   *systray.MenuItem
	itemRestart *systray.MenuItem
	itemLogs    *systray.MenuItem
	itemQuit    *systray.MenuItem
}

func runTray(installDir, dashboardURL string, supervisor *Supervisor) {
	state := &trayState{installDir: installDir, dashboardURL: dashboardURL, supervisor: supervisor}
	systray.Run(state.onReady, state.onExit)
}

func (t *trayState) onReady() {
	systray.SetIcon(trayIcon())
	systray.SetTitle("")
	systray.SetTooltip("Automatic Inbox Machine")

	t.itemOpen = systray.AddMenuItem("Open Inbox Agent", "Show the app window")
	t.itemOpen.SetIcon(trayIcon())
	systray.AddSeparator()

	t.itemStatus = systray.AddMenuItem("Checking…", "Current state")
	t.itemStatus.Disable()

	t.itemPause = systray.AddMenuItem("Pause", "Stop sending and archiving")
	t.itemRestart = systray.AddMenuItem("Restart watcher", "Reconnect and resume watching mail")
	systray.AddSeparator()

	t.itemLogs = systray.AddMenuItem("Open logs folder", "Show log files in Explorer")
	t.itemQuit = systray.AddMenuItem("Quit", "Stop watching mail and exit")

	go t.loop()
}

func (t *trayState) onExit() {}

func (t *trayState) loop() {
	ticker := time.NewTicker(trayPollInterval)
	defer ticker.Stop()
	t.refresh()

	for {
		select {
		case <-t.itemOpen.ClickedCh:
			t.openWindow()

		case <-t.itemPause.ClickedCh:
			t.togglePause()

		case <-t.itemRestart.ClickedCh:
			log.Printf("tray: restarting watcher on request")
			t.supervisor.Stop(procWatcher)
			time.Sleep(400 * time.Millisecond)
			_ = t.supervisor.Start(procWatcher)
			t.refresh()

		case <-t.itemLogs.ClickedCh:
			_ = openTarget(filepath.Join(t.installDir, "logs"))

		case <-t.itemQuit.ClickedCh:
			systray.Quit()
			return

		case <-ticker.C:
			t.refresh()
		}
	}
}

func (t *trayState) openWindow() {
	url := t.supervisor.DashboardURL()
	if url == "" {
		url = t.dashboardURL
	}
	if !OpenWindow(t.installDir, url) {
		_ = openTarget(url)
	}
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

type heartbeat struct {
	At  string `json:"at"`
	PID int    `json:"pid"`
}

// watcherAlive mirrors the Node-side rule: a fresh heartbeat AND a live PID.
// A heartbeat file outlives the process that wrote it, so freshness alone would
// report a dead watcher as healthy.
func (t *trayState) watcherAlive() bool {
	data, err := os.ReadFile(filepath.Join(t.installDir, "data", "heartbeat.json"))
	if err != nil {
		return false
	}
	var beat heartbeat
	if json.Unmarshal(data, &beat) != nil {
		return false
	}
	stamp, err := time.Parse(time.RFC3339, beat.At)
	if err != nil {
		return false
	}
	return time.Since(stamp) < 3*time.Minute && isProcessAlive(beat.PID)
}

func (t *trayState) paused() bool {
	data, err := os.ReadFile(filepath.Join(t.installDir, "config.json"))
	if err != nil {
		return false
	}
	var config struct {
		Paused bool `json:"paused"`
	}
	// Strip a BOM: Notepad writes one, and it makes Unmarshal fail silently, which
	// would leave the tray permanently claiming the agent is not paused. Written as
	// an escape rather than the literal character — Go rejects a BOM in source.
	text := strings.TrimPrefix(string(data), "\ufeff")
	if json.Unmarshal([]byte(text), &config) != nil {
		return false
	}
	return config.Paused
}

func (t *trayState) refresh() {
	configured := isConfigured(t.installDir)
	paused := t.paused()
	alive := t.watcherAlive()

	switch {
	case !configured:
		t.setStatus("Setup not finished", "Automatic Inbox Machine — setup not finished")
		t.itemPause.Hide()
		t.itemRestart.Hide()
	case paused:
		t.setStatus("Paused", "Automatic Inbox Machine — paused")
		t.itemPause.SetTitle("Resume")
		t.itemPause.Show()
		t.itemRestart.Show()
	case alive:
		t.setStatus("Watching your inbox", "Automatic Inbox Machine — watching")
		t.itemPause.SetTitle("Pause")
		t.itemPause.Show()
		t.itemRestart.Show()
	default:
		t.setStatus("Not watching — watcher stopped", "Automatic Inbox Machine — watcher stopped")
		t.itemPause.SetTitle("Pause")
		t.itemPause.Show()
		t.itemRestart.Show()
	}

	// Bring the watcher back if it died while we were configured and unpaused.
	if configured && !paused && !alive && !t.supervisor.Running(procWatcher) {
		log.Printf("tray: watcher is down — restarting it")
		_ = t.supervisor.Start(procWatcher)
	}
}

func (t *trayState) setStatus(label, tooltip string) {
	t.itemStatus.SetTitle(label)
	systray.SetTooltip(tooltip)
}

// togglePause flips config.paused through the dashboard, so the change goes
// through the same atomic writer the rest of the app uses instead of this process
// racing it with its own JSON rewrite.
func (t *trayState) togglePause() {
	action := "pause"
	if t.paused() {
		action = "resume"
	}
	if err := t.postDashboardAction(action); err != nil {
		log.Printf("tray: %s failed: %v", action, err)
	}
	t.refresh()
}
