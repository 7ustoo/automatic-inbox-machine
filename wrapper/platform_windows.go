//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

var shellExecuteW = syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
var queryFullProcessImageNameW = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryFullProcessImageNameW")

// CREATE_NO_WINDOW. Without this every spawned node process flashes a black
// console window, which is the single biggest tell that something is a script
// rather than an application.
const createNoWindow = 0x08000000

func nodeBinaryName() string { return "node.exe" }

func applyChildHideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}

func openTarget(target string) error {
	operation, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	targetPtr, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	const swShowNormal = 1
	result, _, callErr := shellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(operation)),
		uintptr(unsafe.Pointer(targetPtr)),
		0,
		0,
		swShowNormal,
	)
	if result <= 32 {
		return fmt.Errorf("ShellExecuteW failed (%d): %v", result, callErr)
	}
	return nil
}

// terminateProcess: Windows has no real SIGTERM, and os.Process.Signal refuses
// arbitrary signals there, so Kill is the only option. The Node children install
// exit handlers that still run for their own cleanup.
func terminateProcess(p *os.Process) error {
	return p.Kill()
}

// isProcessAlive is a real Win32 liveness probe.
//
// The POSIX kill-0 idiom (os.Process.Signal(syscall.Signal(0))) is a lie on
// Windows: it always errors for a process we did not spawn. AMM shipped that bug
// and every live instance looked dead, so the single-instance lock treated its
// own lock as stale and happily started a second tray and a second bot — two
// pollers then fought over the Telegram token. OpenProcess with query-limited
// rights plus GetExitCodeProcess is the canonical check; a live process reports
// STILL_ACTIVE.
func isProcessAlive(pid int) bool {
	const processQueryLimitedInformation = 0x1000
	const stillActive = 259
	if pid <= 0 {
		return false
	}
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}

// isCurrentExecutable distinguishes a real existing AIM instance from a stale
// lock whose PID Windows has since recycled for an unrelated process.
func isCurrentExecutable(pid int) bool {
	const processQueryLimitedInformation = 0x1000
	if pid <= 0 {
		return false
	}
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)

	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	ok, _, _ := queryFullProcessImageNameW.Call(
		uintptr(h),
		0,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ok == 0 || size == 0 {
		return false
	}
	actual := syscall.UTF16ToString(buffer[:size])
	expected, err := os.Executable()
	if err != nil {
		return false
	}
	return strings.EqualFold(filepath.Clean(actual), filepath.Clean(expected))
}

// killProcessTree kills a process and its children. taskkill /T walks the tree,
// which matters because our node children may themselves have spawned helpers.
func killProcessTree(pid int) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	cmd := exec.Command(root+`\System32\taskkill.exe`, "/PID", strconv.Itoa(pid), "/T", "/F")
	applyChildHideWindow(cmd)
	_ = cmd.Run()
}
