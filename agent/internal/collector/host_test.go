package collector

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"syscall"
	"testing"
)

// pi5Root copies testdata/pi5 into a temporary directory and adds the
// firmware throttle file. That file is created here rather than committed
// because Go module zips reject ':' in file names.
func pi5Root(t *testing.T, throttled string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.CopyFS(dir, os.DirFS("testdata/pi5")); err != nil {
		t.Fatal(err)
	}
	if throttled != "" {
		writeFile(t, filepath.Join(dir, "sys", throttledPath), throttled)
	}
	return dir
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func testConfig(root string, mounts ...string) HostConfig {
	return HostConfig{
		Procfs: filepath.Join(root, "proc"),
		Sysfs:  filepath.Join(root, "sys"),
		Rootfs: filepath.Join(root, "root"),
		Mounts: mounts,
	}
}

func newTestHost(t *testing.T, root string, mounts ...string) *Host {
	t.Helper()
	t.Setenv("PATH", "") // never pick up a real vcgencmd
	h := NewHost(testConfig(root, mounts...))
	h.mailbox = []string{filepath.Join(t.TempDir(), "vcio")} // nor a real mailbox device
	return h
}

func TestHostReadPi5(t *testing.T) {
	root := pi5Root(t, "50005\n")
	h := newTestHost(t, root, "/")
	if err := h.Check(); err != nil {
		t.Fatalf("Check: %v", err)
	}
	r := h.Read(context.Background())

	if len(r.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", r.Errors)
	}
	if r.Time.IsZero() {
		t.Error("Time not set")
	}
	if r.Hostname != "picloud" {
		t.Errorf("Hostname = %q", r.Hostname)
	}
	wantPlatform := Platform{
		Model:  ptr("Raspberry Pi 5 Model B Rev 1.0"),
		OS:     ptr("Debian GNU/Linux 12 (bookworm)"),
		Kernel: ptr("6.6.51+rpt-rpi-2712"),
		Arch:   runtime.GOARCH,
	}
	if !reflect.DeepEqual(r.Platform, wantPlatform) {
		t.Errorf("Platform = %s, want %s", fmtPlatform(r.Platform), fmtPlatform(wantPlatform))
	}
	if r.CPU == nil || len(r.CPU.PerCore) != 4 || r.CPU.Total.User != 1530880 {
		t.Errorf("CPU = %+v", r.CPU)
	}
	if want := (LoadAverage{0.42, 0.35, 0.30}); r.Load == nil || *r.Load != want {
		t.Errorf("Load = %v, want %v", r.Load, want)
	}
	wantMem := MemInfo{TotalBytes: 8443211776, AvailableBytes: 6000000000, SwapTotalBytes: 536866816, SwapFreeBytes: 524283904}
	if r.Memory == nil || *r.Memory != wantMem {
		t.Errorf("Memory = %+v, want %+v", r.Memory, wantMem)
	}
	if r.Uptime == nil || *r.Uptime != 90922.47 {
		t.Errorf("Uptime = %v", r.Uptime)
	}
	if r.Temperature == nil || *r.Temperature != 51.25 {
		t.Errorf("Temperature = %v", r.Temperature)
	}
	if r.FrequencyMHz == nil || *r.FrequencyMHz != 2400 {
		t.Errorf("FrequencyMHz = %v", r.FrequencyMHz)
	}
	if r.Throttled == nil || *r.Throttled != 0x50005 {
		t.Errorf("Throttled = %v", r.Throttled)
	}
	// Host view from /proc/1/net/dev, not the container's /proc/net/dev.
	wantNet := []NetCounters{
		{Interface: "eth0", RxBytes: 9876543210, TxBytes: 1234567890},
		{Interface: "wlan0"},
	}
	if !reflect.DeepEqual(r.Network, wantNet) {
		t.Errorf("Network = %+v, want %+v", r.Network, wantNet)
	}
	if len(r.Filesystems) != 1 || r.Filesystems[0].Mountpoint != "/" || r.Filesystems[0].TotalBytes == 0 {
		t.Errorf("Filesystems = %+v", r.Filesystems)
	}
}

func TestHostReadMinimal(t *testing.T) {
	h := newTestHost(t, "testdata/minimal")
	r := h.Read(context.Background())

	if len(r.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", r.Errors)
	}
	if r.CPU == nil || len(r.CPU.PerCore) != 2 || r.CPU.Total.Steal != 120 {
		t.Errorf("CPU = %+v", r.CPU)
	}
	if r.Load == nil || r.Memory == nil || r.Uptime == nil {
		t.Errorf("procfs basics missing: load=%v mem=%v uptime=%v", r.Load, r.Memory, r.Uptime)
	}
	if r.Temperature != nil || r.FrequencyMHz != nil || r.Throttled != nil {
		t.Errorf("sysfs values should be nil: temp=%v freq=%v throttled=%v", r.Temperature, r.FrequencyMHz, r.Throttled)
	}
	if r.Platform.Model != nil || r.Platform.Kernel != nil || r.Platform.OS != nil {
		t.Errorf("Platform = %s, want all nil", fmtPlatform(r.Platform))
	}
	// Falls back to /proc/net/dev when /proc/1/net/dev is absent.
	if want := []NetCounters{{Interface: "enp0s3", RxBytes: 73400320, TxBytes: 5242880}}; !reflect.DeepEqual(r.Network, want) {
		t.Errorf("Network = %+v, want %+v", r.Network, want)
	}
	// Falls back to os.Hostname when /etc/hostname is absent.
	if want, _ := os.Hostname(); r.Hostname != want {
		t.Errorf("Hostname = %q, want %q", r.Hostname, want)
	}
}

func TestHostReadEmptyRoot(t *testing.T) {
	h := newTestHost(t, t.TempDir())
	if err := h.Check(); err == nil {
		t.Error("Check succeeded without procfs")
	}
	r := h.Read(context.Background())
	if len(r.Errors) != 0 {
		t.Errorf("missing sources must not count as errors: %v", r.Errors)
	}
	if r.CPU != nil || r.Load != nil || r.Memory != nil || r.Uptime != nil || r.Network != nil {
		t.Errorf("expected nil sources, got %+v", r)
	}
	s := BuildSample(nil, r)
	if s.Available != (Availability{}) || s.Snapshot.Throttling.Supported {
		t.Errorf("Sample claims support: %+v", s.Available)
	}
}

func TestHostReadErrors(t *testing.T) {
	root := pi5Root(t, "not-hex\n")
	writeFile(t, filepath.Join(root, "proc/meminfo"), "garbage\n")
	h := newTestHost(t, root, "/", "/no/such/mount")
	r := h.Read(context.Background())

	for _, name := range []string{CollectorThrottled, CollectorMemory, CollectorFilesystem} {
		if r.Errors[name] == nil {
			t.Errorf("Errors[%q] = nil", name)
		}
	}
	if r.Memory != nil || r.Throttled != nil {
		t.Errorf("failed sources must be nil: mem=%v throttled=%v", r.Memory, r.Throttled)
	}
	if len(r.Filesystems) != 1 || r.Filesystems[0].Mountpoint != "/" {
		t.Errorf("good mounts must still be reported: %+v", r.Filesystems)
	}
}

func TestHostThrottledSources(t *testing.T) {
	fakeVcgencmd := func(t *testing.T, script string) {
		t.Helper()
		if runtime.GOOS == "windows" {
			t.Skip("shell script fixture")
		}
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "vcgencmd"), "#!/bin/sh\n"+script)
		if err := os.Chmod(filepath.Join(dir, "vcgencmd"), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", dir)
	}

	t.Run("glob for soc node with unit address", func(t *testing.T) {
		root := pi5Root(t, "")
		writeFile(t, filepath.Join(root, "sys/devices/platform/soc@107c000000/soc@107c000000:firmware/get_throttled"), "e0000\n")
		h := newTestHost(t, root)
		if v, err := h.readThrottled(context.Background()); err != nil || v != 0xe0000 {
			t.Errorf("got %#x, %v", v, err)
		}
	})
	t.Run("vcgencmd fallback", func(t *testing.T) {
		fakeVcgencmd(t, "echo throttled=0x50005\n")
		h := NewHost(testConfig(pi5Root(t, "")))
		if v, err := h.readThrottled(context.Background()); err != nil || v != 0x50005 {
			t.Errorf("got %#x, %v", v, err)
		}
	})
	t.Run("vcgencmd failure is an error", func(t *testing.T) {
		fakeVcgencmd(t, "exit 1\n")
		h := NewHost(testConfig(pi5Root(t, "")))
		if _, err := h.readThrottled(context.Background()); err == nil {
			t.Error("want error")
		}
	})
	t.Run("sysfs wins over vcgencmd", func(t *testing.T) {
		fakeVcgencmd(t, "echo throttled=0x50005\n")
		h := NewHost(testConfig(pi5Root(t, "0\n")))
		if v, err := h.readThrottled(context.Background()); err != nil || v != 0 {
			t.Errorf("got %#x, %v", v, err)
		}
	})
	t.Run("no source is unsupported, not an error", func(t *testing.T) {
		r := newTestHost(t, pi5Root(t, "")).Read(context.Background())
		if r.Throttled != nil || r.Errors[CollectorThrottled] != nil {
			t.Errorf("Throttled = %v, error = %v; want nil, nil", r.Throttled, r.Errors[CollectorThrottled])
		}
	})
	t.Run("mailbox device", func(t *testing.T) {
		// A regular file in place of /dev/vcio: Linux rejects the ioctl
		// (ENOTTY), so this exercises the syscall path and its error.
		h := newTestHost(t, pi5Root(t, ""))
		writeFile(t, h.mailbox[0], "")
		_, err := h.readThrottled(context.Background())
		switch {
		case runtime.GOOS != "linux":
			if !errors.Is(err, errors.ErrUnsupported) {
				t.Errorf("err = %v, want errors.ErrUnsupported", err)
			}
		case !errors.Is(err, syscall.ENOTTY):
			t.Errorf("err = %v, want ENOTTY from the ioctl", err)
		}
	})
}

func TestStatFilesystem(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := statFilesystem(dir, "/data")
	if err != nil {
		t.Fatal(err)
	}
	if f.Mountpoint != "/data" {
		t.Errorf("Mountpoint = %q, want it reported as given", f.Mountpoint)
	}
	if f.TotalBytes == 0 || f.UsedBytes > f.TotalBytes || f.AvailableBytes > f.TotalBytes {
		t.Errorf("implausible sizes: %+v", f)
	}
	if f.UsagePercent < 0 || f.UsagePercent > 100 {
		t.Errorf("UsagePercent = %v", f.UsagePercent)
	}
	if _, err := statFilesystem(dir, "/missing"); err == nil {
		t.Error("want error for missing mountpoint")
	}
}

func fmtPlatform(p Platform) string {
	s := func(v *string) string {
		if v == nil {
			return "<nil>"
		}
		return *v
	}
	return "{model=" + s(p.Model) + " os=" + s(p.OS) + " kernel=" + s(p.Kernel) + " arch=" + p.Arch + "}"
}
