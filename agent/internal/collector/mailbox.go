package collector

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// The VideoCore firmware answers "gencmd" text commands such as
// "get_throttled" through the vcio mailbox driver. This is how vcgencmd
// itself works (raspberrypi/utils), so the agent can read the throttle state
// on kernels without the sysfs file (6.12 and later) and in images without
// vcgencmd.

// mailboxDevices are tried in order, as vcgencmd does: the restricted gencmd
// node of newer kernels (group video), then the full mailbox device.
var mailboxDevices = []string{"/dev/vcio_gencmd", "/dev/vcio"}

const (
	tagGetGencmdResult = 0x00030080
	gencmdBufferSize   = 4096       // bytes for command and reply, as in vcgencmd
	mailboxSuccess     = 0x80000000 // buffer status after a successful call
	mailboxResponse    = 0x80000000 // set in a tag's length word when answered
)

// gencmdRequest builds a property buffer with one GET_GENCMD_RESULT tag,
// laid out word for word as vcgencmd does: buffer size, request code, tag,
// value buffer size, request length, error code, command text, end tag.
func gencmdRequest(command string) []uint32 {
	msg := make([]uint32, 6+gencmdBufferSize/4+1)
	msg[0] = uint32(len(msg) * 4)
	msg[2] = tagGetGencmdResult
	msg[3] = gencmdBufferSize
	putString(msg[6:6+gencmdBufferSize/4], command)
	return msg
}

// parseGencmdResponse returns the reply text from a buffer the firmware
// answered, e.g. "throttled=0x50005".
func parseGencmdResponse(msg []uint32) (string, error) {
	switch {
	case len(msg) < 7:
		return "", fmt.Errorf("mailbox reply of %d words is too short", len(msg))
	case msg[1] != mailboxSuccess:
		return "", fmt.Errorf("mailbox status %#x", msg[1])
	case msg[4]&mailboxResponse == 0:
		return "", errors.New("firmware did not answer GET_GENCMD_RESULT")
	case msg[5] != 0:
		return "", fmt.Errorf("gencmd error %d", msg[5])
	}
	return getString(msg[6:]), nil
}

// putString and getString copy NUL-terminated text to and from mailbox
// words. The mailbox exists only on little-endian ARM, so byte i of the
// text is byte i%4 (from the low end) of word i/4.
func putString(words []uint32, s string) {
	for i := 0; i < len(s) && i < len(words)*4-1; i++ {
		words[i/4] |= uint32(s[i]) << (8 * (i % 4))
	}
}

func getString(words []uint32) string {
	var b []byte
	for _, w := range words {
		for shift := 0; shift < 32; shift += 8 {
			c := byte(w >> shift)
			if c == 0 {
				return string(b)
			}
			b = append(b, c)
		}
	}
	return string(b)
}

// openFirst opens the first of paths that it can open, as vcgencmd does. If
// none opens, it returns the first error for a path that exists (such as a
// permission error), else an error that wraps fs.ErrNotExist.
func openFirst(paths []string) (*os.File, error) {
	var firstErr error
	for _, p := range paths {
		f, err := os.Open(p)
		if err == nil {
			return f, nil
		}
		if firstErr == nil || (errors.Is(firstErr, fs.ErrNotExist) && !errors.Is(err, fs.ErrNotExist)) {
			firstErr = err
		}
	}
	if firstErr == nil {
		firstErr = fs.ErrNotExist
	}
	return nil, firstErr
}
