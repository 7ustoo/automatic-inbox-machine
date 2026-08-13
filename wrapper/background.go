package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

var backgroundScripts = map[string]string{
	"watcher":  "watcher.mjs",
	"bot":      "telegram-bot.mjs",
	"watchdog": "watchdog.mjs",
}

// startBackgroundWorker is the console-free Task Scheduler entry point.
// AIM.exe is built as a Windows GUI binary, then launches Node with
// CREATE_NO_WINDOW and waits. The worker registers its own PID, so updates,
// uninstall, and diagnostics can still stop or inspect it normally. Waiting
// also lets Task Scheduler accurately report whether a long-running worker is
// alive instead of marking the launcher complete while Node runs separately.
func startBackgroundWorker(installDir, role string) error {
	script, ok := backgroundScripts[role]
	if !ok {
		return fmt.Errorf("unknown background role %q", role)
	}

	nodeExe := resolveNode(installDir)
	if _, err := os.Stat(nodeExe); err != nil {
		return fmt.Errorf("missing bundled runtime: %s", nodeExe)
	}

	cmd := exec.Command(nodeExe, filepath.Join(installDir, "scripts", script))
	cmd.Dir = installDir
	applyChildHideWindow(cmd)

	logsDir := filepath.Join(installDir, "logs")
	_ = os.MkdirAll(logsDir, 0o700)
	logFile, err := os.OpenFile(filepath.Join(logsDir, role+"-scheduled.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err == nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}

	log.Printf("aim: scheduled %s started without a console window", role)
	err = cmd.Run()
	if err != nil {
		if logFile != nil {
			_ = logFile.Close()
		}
		return err
	}
	if logFile != nil {
		_ = logFile.Close()
	}
	return nil
}
