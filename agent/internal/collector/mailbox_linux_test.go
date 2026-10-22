//go:build linux

package collector

import (
	"testing"
	"unsafe"
)

// The vcio driver matches the exact ioctl number, so check it against the
// values that _IOWR(100, 0, char *) gives on 32- and 64-bit ARM.
func TestIocMboxProperty(t *testing.T) {
	want := map[uintptr]uintptr{4: 0xc0046400, 8: 0xc0086400}[unsafe.Sizeof(uintptr(0))]
	if iocMboxProperty != want {
		t.Errorf("iocMboxProperty = %#x, want %#x", uintptr(iocMboxProperty), want)
	}
}
