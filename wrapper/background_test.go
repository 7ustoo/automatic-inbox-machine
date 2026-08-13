package main

import "testing"

func TestBackgroundRolesMapToExpectedScripts(t *testing.T) {
	want := map[string]string{
		"watcher":  "watcher.mjs",
		"bot":      "telegram-bot.mjs",
		"watchdog": "watchdog.mjs",
	}
	for role, script := range want {
		if got := backgroundScripts[role]; got != script {
			t.Fatalf("background role %s: got %q, want %q", role, got, script)
		}
	}
	if _, exists := backgroundScripts["terminal"]; exists {
		t.Fatal("terminal must never be a schedulable background role")
	}
}
