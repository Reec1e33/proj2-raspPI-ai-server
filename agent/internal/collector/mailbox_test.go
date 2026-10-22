package collector

import (
	"errors"
	"io/fs"
	"path/filepath"
	"testing"
)

func TestGencmdRequest(t *testing.T) {
	msg := gencmdRequest("get_throttled")
	// Same layout as vcgencmd: 6 header words, 4096 bytes of text, end tag.
	if len(msg) != 1031 || msg[0] != 4124 || msg[1] != 0 || msg[2] != 0x00030080 || msg[3] != 4096 || msg[4] != 0 || msg[5] != 0 {
		t.Errorf("header = %#x, len %d", msg[:6], len(msg))
	}
	if got := getString(msg[6:]); got != "get_throttled" {
		t.Errorf("command = %q", got)
	}
	if msg[len(msg)-1] != 0 {
		t.Error("missing end tag")
	}
}

func TestParseGencmdResponse(t *testing.T) {
	// reply returns the request as the firmware answers it, after edit.
	reply := func(text string, edit func(m []uint32)) []uint32 {
		msg := gencmdRequest("get_throttled")
		msg[1], msg[4], msg[5] = mailboxSuccess, mailboxResponse|uint32(len(text)+1), 0
		clear(msg[6:])
		putString(msg[6:], text)
		if edit != nil {
			edit(msg)
		}
		return msg
	}
	tests := []struct {
		name    string
		msg     []uint32
		want    string
		wantErr bool
	}{
		{name: "answered", msg: reply("throttled=0x50005", nil), want: "throttled=0x50005"},
		{name: "empty reply", msg: reply("", nil), want: ""},
		{name: "call failed", msg: reply("", func(m []uint32) { m[1] = 0x80000001 }), wantErr: true},
		{name: "tag not answered", msg: reply("", func(m []uint32) { m[4] = 0 }), wantErr: true},
		{name: "gencmd error", msg: reply("error=1 error_msg=\"Command not registered\"", func(m []uint32) { m[5] = 1 }), wantErr: true},
		{name: "short buffer", msg: make([]uint32, 3), wantErr: true},
	}
	for _, tt := range tests {
		got, err := parseGencmdResponse(tt.msg)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("%s: got %q, %v; want %q, wantErr %v", tt.name, got, err, tt.want, tt.wantErr)
		}
	}
	if v, err := parseThrottled(getString(reply("throttled=0xe0000", nil)[6:])); err != nil || v != 0xe0000 {
		t.Errorf("parseThrottled of a gencmd reply = %#x, %v", v, err)
	}
}

func TestPutString(t *testing.T) {
	words := make([]uint32, 2)
	putString(words, "abcdefghij") // longer than the buffer: keep a NUL
	if got := getString(words); got != "abcdefg" {
		t.Errorf("got %q, want the text cut to 7 bytes plus NUL", got)
	}
	if words[0] != 0x64636261 { // "abcd", little-endian
		t.Errorf("words[0] = %#x", words[0])
	}
}

func TestOpenFirst(t *testing.T) {
	dir := t.TempDir()
	existing := filepath.Join(dir, "vcio")
	writeFile(t, existing, "")
	missing := filepath.Join(dir, "vcio_gencmd")
	notDir := filepath.Join(existing, "child") // ENOTDIR: exists-but-unusable

	f, err := openFirst([]string{missing, existing})
	if err != nil || f.Name() != existing {
		t.Fatalf("got %v, %v; want %s", f, err, existing)
	}
	f.Close()

	for _, paths := range [][]string{nil, {missing}, {missing, missing}} {
		if _, err := openFirst(paths); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%q: err = %v, want fs.ErrNotExist", paths, err)
		}
	}
	for _, paths := range [][]string{{notDir, missing}, {missing, notDir}} {
		if _, err := openFirst(paths); err == nil || errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%q: err = %v, want the error of the path that exists", paths, err)
		}
	}
}
