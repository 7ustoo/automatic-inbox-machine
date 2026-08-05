//go:build !windows

package main

import "os"

// No native dialog dependency outside Windows; these builds are launched from a
// terminal or a .desktop entry where stderr is visible.
func showErrorDialog(title, message string) {
	_, _ = os.Stderr.WriteString(title + ": " + message + "\n")
}
