package main

import (
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Supervisor owns the Node processes: the dashboard HTTP server, the mail
// watcher, and the Telegram bot.
//
// Unlike the previous Node-only launcher, these are real children of this
// process, so when the app quits they go with it and the user is never left with
// orphaned node.exe processes in Task Manager wondering what they are.
type Supervisor struct {
	installDir string
	nodeExe    string

	mu       sync.Mutex
	children map[string]*exec.Cmd
	stopping bool
}

// Scripts under scripts/ that this supervises, in start order.
const (
	procDashboard = "dashboard"
	procWatcher   = "watcher"
	procBot       = "bot"
)

var procScripts = map[string]string{
	procDashboard: "dashboard.mjs",
	procWatcher:   "watcher.mjs",
	procBot:       "telegram-bot.mjs",
}

func NewSupervisor(installDir string) *Supervisor {
	return &Supervisor{
		installDir: installDir,
		nodeExe:    resolveNode(installDir),
		children:   map[string]*exec.Cmd{},
	}
}

// resolveNode prefers the runtime bundled by the installer. A machine with no
// system Node must still work, which is the whole reason the installer ships one.
func resolveNode(installDir string) string {
	bundled := filepath.Join(installDir, "runtime", nodeBinaryName())
	if _, err := os.Stat(bundled); err == nil {
		return bundled
	}
	if found, err := exec.LookPath("node"); err == nil {
		return found
	}
	return bundled
}

func (s *Supervisor) NodePath() string { return s.nodeExe }

func (s *Supervisor) NodeAvailable() bool {
	_, err := os.Stat(s.nodeExe)
	if err == nil {
		return true
	}
	_, lookErr := exec.LookPath(s.nodeExe)
	return lookErr == nil
}

// Start launches one named process if it is not already running.
func (s *Supervisor) Start(name string) error {
	script, ok := procScripts[name]
	if !ok {
		return os.ErrInvalid
	}

	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil
	}
	if cmd, running := s.children[name]; running && cmd.Process != nil && isProcessAlive(cmd.Process.Pid) {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	cmd := exec.Command(s.nodeExe, filepath.Join(s.installDir, "scripts", script))
	cmd.Dir = s.installDir
	applyChildHideWindow(cmd)

	logFile, err := os.OpenFile(filepath.Join(s.installDir, "logs", name+"-stdio.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err == nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}

	if err := cmd.Start(); err != nil {
		log.Printf("supervisor: start %s: %v", name, err)
		if logFile != nil {
			_ = logFile.Close()
		}
		return err
	}

	s.mu.Lock()
	s.children[name] = cmd
	s.mu.Unlock()
	log.Printf("supervisor: started %s (pid %d)", name, cmd.Process.Pid)

	go func() {
		_ = cmd.Wait()
		if logFile != nil {
			_ = logFile.Close()
		}
		s.mu.Lock()
		if s.children[name] == cmd {
			delete(s.children, name)
		}
		stopping := s.stopping
		s.mu.Unlock()
		if !stopping {
			log.Printf("supervisor: %s exited", name)
		}
	}()

	return nil
}

func (s *Supervisor) Running(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cmd, ok := s.children[name]
	return ok && cmd.Process != nil && isProcessAlive(cmd.Process.Pid)
}

// Stop terminates one process. Graceful where the platform allows it.
func (s *Supervisor) Stop(name string) {
	s.mu.Lock()
	cmd := s.children[name]
	delete(s.children, name)
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = terminateProcess(cmd.Process)
	log.Printf("supervisor: stopped %s", name)
}

// StopAll brings everything down. Called on quit so nothing is orphaned.
func (s *Supervisor) StopAll() {
	s.mu.Lock()
	s.stopping = true
	names := make([]string, 0, len(s.children))
	for name := range s.children {
		names = append(names, name)
	}
	s.mu.Unlock()

	for _, name := range names {
		s.Stop(name)
	}

	// Give them a moment to exit cleanly, then insist.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		remaining := 0
		s.mu.Lock()
		for _, cmd := range s.children {
			if cmd.Process != nil && isProcessAlive(cmd.Process.Pid) {
				remaining++
			}
		}
		s.mu.Unlock()
		if remaining == 0 {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}

	s.mu.Lock()
	for _, cmd := range s.children {
		if cmd.Process != nil {
			killProcessTree(cmd.Process.Pid)
		}
	}
	s.children = map[string]*exec.Cmd{}
	s.mu.Unlock()
}

/* -------------------------------------------------------------------------- */
/* Dashboard readiness                                                        */
/* -------------------------------------------------------------------------- */

func (s *Supervisor) portFile() string {
	return filepath.Join(s.installDir, "data", "dashboard-port.txt")
}

// DashboardURL reads the port the dashboard actually bound to.
//
// Read from a file the dashboard writes rather than from config.json: if the
// configured port is taken the dashboard may bind elsewhere, and a wrapper that
// trusted config would open a window pointing at nothing.
func (s *Supervisor) DashboardURL() string {
	data, err := os.ReadFile(s.portFile())
	if err != nil {
		return ""
	}
	port := strings.TrimSpace(string(data))
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return ""
	}
	return "http://127.0.0.1:" + port
}

// WaitForDashboard blocks until the dashboard is accepting connections.
func (s *Supervisor) WaitForDashboard(timeout time.Duration) string {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if url := s.DashboardURL(); url != "" && portOpen(url) {
			return url
		}
		time.Sleep(200 * time.Millisecond)
	}
	return ""
}

func portOpen(rawURL string) bool {
	address := strings.TrimPrefix(rawURL, "http://")
	conn, err := net.DialTimeout("tcp", address, 800*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// ClearPortFile removes a stale port file so WaitForDashboard cannot be fooled
// by the previous run's value.
func (s *Supervisor) ClearPortFile() {
	_ = os.Remove(s.portFile())
}
