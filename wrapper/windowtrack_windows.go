//go:build windows

package main

import (
	"os"
	"sync"
)

// Window host processes this wrapper spawned. Tracked so Quit can close them —
// otherwise quitting from the tray leaves an orphaned window whose Node backend
// has just been shut down, i.e. a dead app the user has to close by hand.
var windowPIDs struct {
	mu   sync.Mutex
	pids []int
}

func trackWindowProcess(process *os.Process) {
	windowPIDs.mu.Lock()
	windowPIDs.pids = append(windowPIDs.pids, process.Pid)
	windowPIDs.mu.Unlock()

	// Reap on exit so a closed window's PID does not linger in this list and get
	// "killed" later, after the OS has recycled the number for something else.
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
