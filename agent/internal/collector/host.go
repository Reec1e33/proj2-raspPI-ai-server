package collector

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// HostConfig locates the host's pseudo-filesystems. In a container they are
// bind-mounted from the host, e.g. Procfs "/host/proc".
type HostConfig struct {
	Procfs string
	Sysfs  string
	Rootfs string
	// Mounts are mountpoints as seen on the host. They are resolved under
	// Rootfs for statfs and reported as given.
	Mounts []string
}

// Host is a Source that reads the real machine.
type Host struct {
	cfg      HostConfig
	vcgencmd string   // absolute path, or "" when not on PATH
	mailbox  []string // firmware mailbox devices, the last throttle source
}

// NewHost returns a Host source. It looks up vcgencmd once, as a fallback
// for hosts whose sysfs does not expose the firmware throttle state.
func NewHost(cfg HostConfig) *Host {
	vcgencmd, _ := exec.LookPath("vcgencmd")
	return &Host{cfg: cfg, vcgencmd: vcgencmd, mailbox: mailboxDevices}
}

// Check reports whether procfs is readable. Without it the agent has
// nothing useful to serve, so callers should treat an error as fatal.
func (h *Host) Check() error {
	_, err := os.ReadFile(h.proc("stat"))
	return err
}

// Read implements Source. Missing files mean "unsupported" and leave the
// field nil; any other failure is also recorded in Reading.Errors.
func (h *Host) Read(ctx context.Context) Reading {
	r := Reading{Time: time.Now(), Errors: map[string]error{}}
	record := func(collector string, err error) bool {
		if err == nil {
			return true
		}
		if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, errors.ErrUnsupported) {
			r.Errors[collector] = errors.Join(r.Errors[collector], err)
		}
		return false
	}

	// Rates are computed against r.Time, so read the counters first, before
	// slower sources such as a vcgencmd exec or statfs.
	if v, err := readFile(h.proc("stat"), parseCPUStat); record(CollectorCPU, err) {
		r.CPU = &v
	}
	if v, err := h.readNetDev(); record(CollectorNetwork, err) {
		r.Network = v
	}
	if v, err := readFile(h.proc("loadavg"), parseLoadAverage); record(CollectorLoad, err) {
		r.Load = &v
	}
	if v, err := readFile(h.proc("meminfo"), parseMemInfo); record(CollectorMemory, err) {
		r.Memory = &v
	}
	if v, err := readFile(h.proc("uptime"), parseUptime); record(CollectorUptime, err) {
		r.Uptime = &v
	}
	if v, err := readFile(h.sys("class/thermal/thermal_zone0/temp"), parseInt); record(CollectorThermal, err) {
		r.Temperature = ptr(float64(v) / 1000) // millidegrees
	}
	if v, err := readFile(h.sys("devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"), parseInt); record(CollectorCPUFreq, err) {
		r.FrequencyMHz = ptr(float64(v) / 1000) // kHz
	}
	if v, err := h.readThrottled(ctx); record(CollectorThrottled, err) {
		r.Throttled = &v
	}

	for _, m := range h.cfg.Mounts {
		fsys, err := statFilesystem(h.cfg.Rootfs, m)
		switch {
		case err == nil:
			r.Filesystems = append(r.Filesystems, fsys)
		case !errors.Is(err, errors.ErrUnsupported):
			// A configured mountpoint that is missing is a misconfiguration,
			// not an unsupported source, so ErrNotExist counts here too.
			r.Errors[CollectorFilesystem] = errors.Join(r.Errors[CollectorFilesystem], err)
		}
	}

	r.Platform.Arch = runtime.GOARCH
	if v, err := readFile(h.sys("firmware/devicetree/base/model"), asString); record(CollectorPlatform, err) {
		r.Platform.Model = nonEmpty(v)
	}
	if v, err := readFile(h.proc("sys/kernel/osrelease"), asString); record(CollectorPlatform, err) {
		r.Platform.Kernel = nonEmpty(v)
	}
	if v, err := h.readOSName(); record(CollectorPlatform, err) {
		r.Platform.OS = nonEmpty(v)
	}
	r.Hostname = h.hostname()
	return r
}

// Throttle state locations in sysfs. Only Raspberry Pi kernels before 6.12
// have this file. The glob covers device trees that give the soc node a unit
// address (e.g. "soc@107c000000").
const (
	throttledPath = "devices/platform/soc/soc:firmware/get_throttled"
	throttledGlob = "devices/platform/*/*:firmware/get_throttled"
)

// readThrottled tries sysfs, then vcgencmd if it is on PATH, then the
// firmware mailbox. When none is present the error wraps fs.ErrNotExist (or
// errors.ErrUnsupported off Linux).
func (h *Host) readThrottled(ctx context.Context) (uint32, error) {
	path := h.sys(throttledPath)
	if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
		if matches, _ := filepath.Glob(h.sys(throttledGlob)); len(matches) > 0 {
			path = matches[0]
		}
	}
	v, err := readFile(path, func(b []byte) (uint32, error) { return parseThrottled(string(b)) })
	if !errors.Is(err, fs.ErrNotExist) {
		return v, err
	}

	if h.vcgencmd == "" {
		out, err := gencmd(h.mailbox, "get_throttled")
		if err != nil {
			return 0, err
		}
		return parseThrottled(out)
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, h.vcgencmd, "get_throttled").Output()
	if err != nil {
		return 0, fmt.Errorf("vcgencmd get_throttled: %w", err)
	}
	return parseThrottled(string(out))
}

// readNetDev reads PID 1's view of /proc/net/dev. /proc/net follows the
// reader's network namespace, so in a container with the host's /proc
// bind-mounted, <procfs>/1/net/dev is the host's view (PIDs resolve in the
// mount's PID namespace) and <procfs>/net/dev is the container's.
func (h *Host) readNetDev() ([]NetCounters, error) {
	v, err := readFile(h.proc("1/net/dev"), parseNetDev)
	if errors.Is(err, fs.ErrNotExist) {
		return readFile(h.proc("net/dev"), parseNetDev)
	}
	return v, err
}

// readOSName returns PRETTY_NAME, checking both os-release locations that
// os-release(5) defines.
func (h *Host) readOSName() (string, error) {
	v, err := readFile(h.root("etc/os-release"), asOSName)
	if errors.Is(err, fs.ErrNotExist) {
		return readFile(h.root("usr/lib/os-release"), asOSName)
	}
	return v, err
}

func (h *Host) hostname() string {
	if v, err := readFile(h.root("etc/hostname"), asString); err == nil && v != "" {
		return v
	}
	name, _ := os.Hostname()
	return name
}

func (h *Host) proc(name string) string { return filepath.Join(h.cfg.Procfs, name) }
func (h *Host) sys(name string) string  { return filepath.Join(h.cfg.Sysfs, name) }
func (h *Host) root(name string) string { return filepath.Join(h.cfg.Rootfs, name) }

// statFilesystem reports capacity for mountpoint, resolved under rootfs.
func statFilesystem(rootfs, mountpoint string) (Filesystem, error) {
	total, free, avail, err := statfs(filepath.Join(rootfs, mountpoint))
	if err != nil {
		return Filesystem{}, fmt.Errorf("statfs %s: %w", mountpoint, err)
	}
	used := total - min(free, total)
	f := Filesystem{Mountpoint: mountpoint, TotalBytes: total, UsedBytes: used, AvailableBytes: avail}
	if used+avail > 0 {
		f.UsagePercent = Percent(100 * float64(used) / float64(used+avail))
	}
	return f, nil
}

// readFile reads path and parses it, prefixing errors with the path.
func readFile[T any](path string, parse func([]byte) (T, error)) (T, error) {
	var zero T
	data, err := os.ReadFile(path)
	if err != nil {
		return zero, err // *fs.PathError already names the path
	}
	v, err := parse(data)
	if err != nil {
		return zero, fmt.Errorf("parse %s: %w", path, err)
	}
	return v, nil
}

func asString(data []byte) (string, error) { return trimValue(data), nil }
func asOSName(data []byte) (string, error) { return parseOSRelease(data), nil }

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func ptr[T any](v T) *T { return &v }
