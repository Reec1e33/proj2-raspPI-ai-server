//go:build linux

package collector

import (
	"fmt"
	"syscall"
	"unsafe"
)

// iocMboxProperty is IOCTL_MBOX_PROPERTY, _IOWR(100, 0, char *), from the
// Raspberry Pi vcio driver. Its size field is the pointer size, so the value
// differs between arm and arm64; the kernel accepts both.
const iocMboxProperty = 3<<30 | unsafe.Sizeof(uintptr(0))<<16 | 100<<8

// gencmd runs a firmware text command through the first mailbox device in
// devices that exists, and returns the reply.
func gencmd(devices []string, command string) (string, error) {
	f, err := openFirst(devices)
	if err != nil {
		return "", err
	}
	defer f.Close()

	msg := gencmdRequest(command)
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), iocMboxProperty, uintptr(unsafe.Pointer(&msg[0])))
	if errno != 0 {
		return "", fmt.Errorf("mailbox ioctl on %s: %w", f.Name(), errno)
	}
	return parseGencmdResponse(msg)
}
