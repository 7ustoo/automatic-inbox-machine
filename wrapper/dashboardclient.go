package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Talking to our own dashboard rather than editing config.json directly.
//
// The tray could rewrite config.json itself, but the Node side writes it through
// an atomic temp-and-rename helper and two writers would race. Going through the
// HTTP API means there is exactly one code path that mutates config, whoever asked.
//
// Auth: the dashboard's browser-facing CSRF token is generated per process and
// injected into the page, so this process cannot know it. Instead the dashboard
// writes a token to data/dashboard-token.txt with 0600 permissions and accepts it
// as an `x-aim-token` header. The server is bound to loopback and the file is
// readable only by this user, so possession of the file is the proof of local
// ownership — which is exactly what is being asserted.
func (t *trayState) postDashboardAction(action string) error {
	url := t.supervisor.DashboardURL()
	if url == "" {
		return fmt.Errorf("dashboard is not running")
	}
	token, err := readDashboardToken(t.installDir)
	if err != nil {
		return fmt.Errorf("read token: %w", err)
	}

	request, err := http.NewRequest(http.MethodPost, url+"/api/action/"+action, strings.NewReader("{}"))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-aim-token", token)

	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("dashboard answered %d", response.StatusCode)
	}
	return nil
}

func readDashboardToken(installDir string) (string, error) {
	data, err := os.ReadFile(filepath.Join(installDir, "data", "dashboard-token.txt"))
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", fmt.Errorf("token file is empty")
	}
	return token, nil
}
