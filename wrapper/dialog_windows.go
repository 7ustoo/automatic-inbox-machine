//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var procMessageBoxW = user32.NewProc("MessageBoxW")

// showErrorDialog puts a startup failure on screen.
//
// This binary is built with -H windowsgui, which means it has no console: an
// os.Exit(1) with a log line is completely invisible to someone who just
// double-clicked a shortcut. They see nothing happen and conclude the app is
// broken. A message box is the only way to tell them what went wrong.
func showErrorDialog(title, message string) {
	titlePtr, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	messagePtr, err := syscall.UTF16PtrFromString(message)
	if err != nil {
		return
	}
	const mbIconError = 0x00000010
	const mbSetForeground = 0x00010000
	_, _, _ = procMessageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(messagePtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		mbIconError|mbSetForeground,
	)
}
