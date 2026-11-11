package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWatcherStartupRespectsSetupAndDisabledInboxes(t *testing.T) {
	cases := []struct {
		name   string
		config string
		want   bool
	}{
		{"new setup in progress", `{"dashboard":{"setupComplete":false},"accounts":[{"email":"user@example.com","enabled":true}]}`, false},
		{"all inboxes disabled", `{"dashboard":{"setupComplete":true},"accounts":[{"email":"user@example.com","enabled":false}]}`, false},
		{"new setup complete", `{"dashboard":{"setupComplete":true},"accounts":[{"email":"user@example.com","enabled":true}]}`, true},
		{"legacy config", `{"accounts":[{"email":"user@example.com"}]}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(tc.config), 0600); err != nil {
				t.Fatal(err)
			}
			if got := isConfigured(dir); got != tc.want {
				t.Fatalf("isConfigured() = %t, want %t", got, tc.want)
			}
		})
	}
}
