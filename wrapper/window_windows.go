//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
)

const (
	appUserModelID = "AutomaticInboxMachine.Desktop"
	windowTitle    = "Automatic Inbox Machine"
	windowIconID   = 2
)

// External links must leave the app window and open in the real browser.
// Without this, clicking a t.me or console.anthropic.com link navigates the app
// itself away from the dashboard and the user is stranded with no back button.
const externalLinkScript = `
function aimRouteExternal(event) {
  var anchor = event.target && event.target.closest
    ? event.target.closest("a[target='_blank'], a[href^='http']")
    : null;
  if (!anchor || !anchor.href || typeof window.aimOpenExternal !== "function") return;
  if (anchor.href.indexOf("http://127.0.0.1") === 0) return;
  event.preventDefault();
  window.aimOpenExternal(anchor.href).catch(function () {});
}
document.addEventListener("click", aimRouteExternal, true);
document.addEventListener("auxclick", aimRouteExternal, true);
var aimOriginalOpen = window.open.bind(window);
window.open = function (url, target, features) {
  if (url && url !== "about:blank" && typeof window.aimOpenExternal === "function") {
    window.aimOpenExternal(String(url)).catch(function () {});
    return null;
  }
  return aimOriginalOpen(url, target, features);
};`

var (
	shell32                = syscall.NewLazyDLL("shell32.dll")
	procSetAppUserModelID  = shell32.NewProc("SetCurrentProcessExplicitAppUserModelID")
	user32                 = syscall.NewLazyDLL("user32.dll")
	procIsWindow           = user32.NewProc("IsWindow")
	procGetWindowThreadPID = user32.NewProc("GetWindowThreadProcessId")
	procShowWindow         = user32.NewProc("ShowWindow")
	procSetForeground      = user32.NewProc("SetForegroundWindow")
)

type windowMarker struct {
	PID  int    `json:"pid"`
	HWND uint64 `json:"hwnd"`
	URL  string `json:"url"`
}

// WebView2Available reports whether the shared runtime is installed. The
// installer provisions it, but a user who copied the folder by hand may not have
// it, and a clear message beats a window that never appears.
func WebView2Available() bool {
	version, err := webviewloader.GetInstalledVersion()
	return err == nil && strings.TrimSpace(version) != ""
}

// OpenWindow shows the app window, raising an existing one if present.
//
// The window lives in a CHILD process of this same exe, not in this one. WebView2
// needs to own a Win32 message loop pinned to one OS thread, and so does the
// system tray — they cannot both have the main thread. Splitting them is how AMM
// solved it, and it has the side benefit that the taskbar sees AIM.exe rather
// than msedge.exe, so pinning and grouping use our own identity.
func OpenWindow(installDir, dashboardURL string) bool {
	if !isLoopbackURL(dashboardURL) {
		log.Printf("window: refusing non-loopback URL %q", dashboardURL)
		return false
	}
	if raiseExistingWindow(installDir, dashboardURL) {
		log.Printf("window: raised the existing window")
		return true
	}

	readyPath, err := newReadyPath(installDir)
	if err != nil {
		log.Printf("window: readiness path: %v", err)
		return false
	}
	defer os.Remove(readyPath)

	exe, err := os.Executable()
	if err != nil {
		log.Printf("window: locate own exe: %v", err)
		return false
	}

	cmd := exec.Command(exe,
		"--window-host",
		"--window-url="+dashboardURL,
		"--window-ready-file="+readyPath,
		"--install-dir="+installDir,
	)
	cmd.Dir = installDir
	if err := cmd.Start(); err != nil {
		log.Printf("window: start host: %v", err)
		return false
	}
	trackWindowProcess(cmd.Process)

	// Wait for the child to signal that its window is actually up. Reporting
	// success before that leaves the user with a tray icon and no window.
	for attempt := 0; attempt < 150; attempt++ {
		if _, err := os.Stat(readyPath); err == nil {
			return true
		}
		if !isProcessAlive(cmd.Process.Pid) {
			_, _ = cmd.Process.Wait()
			_ = os.Remove(markerPath(installDir))
			log.Printf("window: host exited before it was ready")
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
	killProcessTree(cmd.Process.Pid)
	_ = os.Remove(markerPath(installDir))
	log.Printf("window: host timed out")
	return false
}

// RunWindowHost is the --window-host child mode. Blocks until the window closes.
func RunWindowHost(installDir, dashboardURL, readyPath string) bool {
	if !isLoopbackURL(dashboardURL) {
		log.Printf("window-host: invalid URL %q", dashboardURL)
		return false
	}
	if !WebView2Available() {
		log.Printf("window-host: WebView2 runtime is not installed")
		return false
	}

	// WebView2 plus its message loop must stay on a single OS thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := setAppUserModelID(appUserModelID); err != nil {
		// Only affects taskbar grouping; not worth failing the window over.
		log.Printf("window-host: AppUserModelID: %v", err)
	}

	dataPath := filepath.Join(installDir, "data", "window")
	if err := os.MkdirAll(dataPath, 0o755); err != nil {
		log.Printf("window-host: data dir: %v", err)
		return false
	}

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		DataPath:  dataPath,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  windowTitle,
			Width:  1180,
			Height: 820,
			IconId: windowIconID,
			// go-webview2 centers using unsigned subtraction, which puts an
			// 820px-tall window off-screen on a 768px display.
			Center: false,
		},
	})
	if w == nil {
		log.Printf("window-host: WebView2 init failed")
		return false
	}
	defer w.Destroy()

	if err := w.Bind("aimOpenExternal", func(raw string) error {
		if !isAllowedExternalURL(raw) {
			return fmt.Errorf("refusing unsupported URL")
		}
		return openTarget(raw)
	}); err != nil {
		log.Printf("window-host: bind external opener: %v", err)
		return false
	}
	w.Init(externalLinkScript)
	w.SetSize(880, 620, webview2.HintMin)
	w.Navigate(dashboardURL)

	marker := windowMarker{PID: os.Getpid(), HWND: uint64(uintptr(w.Window())), URL: dashboardURL}
	if err := writeMarker(installDir, marker); err != nil {
		log.Printf("window-host: write marker: %v", err)
	}
	defer removeMarker(installDir, marker)

	if readyPath != "" {
		if err := os.WriteFile(readyPath, []byte("ready\n"), 0o600); err != nil {
			log.Printf("window-host: signal readiness: %v", err)
			return false
		}
	}

	w.Run()
	return true
}

/* -------------------------------------------------------------------------- */

func raiseExistingWindow(installDir, dashboardURL string) bool {
	marker, err := readMarker(installDir)
	if err != nil || marker.URL != dashboardURL || marker.PID <= 0 || marker.HWND == 0 || !isProcessAlive(marker.PID) {
		return false
	}
	hwnd := uintptr(marker.HWND)
	if valid, _, _ := procIsWindow.Call(hwnd); valid == 0 {
		return false
	}
	// Confirm the handle still belongs to the recorded process: HWNDs are reused,
	// and raising a stranger's window would be a bizarre thing to do.
	var windowPID uint32
	_, _, _ = procGetWindowThreadPID.Call(hwnd, uintptr(unsafe.Pointer(&windowPID)))
	if int(windowPID) != marker.PID {
		return false
	}
	const swRestore = 9
	_, _, _ = procShowWindow.Call(hwnd, swRestore)
	_, _, _ = procSetForeground.Call(hwnd)
	return true
}

func setAppUserModelID(id string) error {
	ptr, err := syscall.UTF16PtrFromString(id)
	if err != nil {
		return err
	}
	hr, _, callErr := procSetAppUserModelID.Call(uintptr(unsafe.Pointer(ptr)))
	if hr != 0 {
		return fmt.Errorf("HRESULT 0x%08x (%v)", uint32(hr), callErr)
	}
	return nil
}

func newReadyPath(installDir string) (string, error) {
	dir := filepath.Join(installDir, "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, ".window-ready-*")
	if err != nil {
		return "", err
	}
	name := f.Name()
	if err := f.Close(); err != nil {
		return "", err
	}
	return name, os.Remove(name)
}

func markerPath(installDir string) string {
	return filepath.Join(installDir, "data", "window-host.json")
}

func readMarker(installDir string) (windowMarker, error) {
	var marker windowMarker
	data, err := os.ReadFile(markerPath(installDir))
	if err != nil {
		return marker, err
	}
	return marker, json.Unmarshal(data, &marker)
}

func writeMarker(installDir string, marker windowMarker) error {
	data, err := json.Marshal(marker)
	if err != nil {
		return err
	}
	return os.WriteFile(markerPath(installDir), data, 0o600)
}

func removeMarker(installDir string, owned windowMarker) {
	if current, err := readMarker(installDir); err == nil && current.PID == owned.PID {
		_ = os.Remove(markerPath(installDir))
	}
}

func isLoopbackURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if u.Path != "" && u.Path != "/" {
		return false
	}
	host := u.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return false
	}
	port := u.Port()
	if port == "" {
		return false
	}
	n, err := strconv.Atoi(port)
	return err == nil && n >= 1 && n <= 65535
}

// isAllowedExternalURL gates what the page can ask the OS to open. The page is
// ours, but this is the one bridge from web content to ShellExecute and it should
// not be able to launch arbitrary schemes.
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
