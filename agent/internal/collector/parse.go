package collector

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

// parseCPUStat parses the cpu lines of /proc/stat. The aggregate "cpu" line
// becomes Total; "cpuN" lines become PerCore in file order.
func parseCPUStat(data []byte) (CPUStat, error) {
	var (
		stat     CPUStat
		hasTotal bool
	)
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 0 || !strings.HasPrefix(fields[0], "cpu") {
			continue
		}
		times, err := parseCPUTimes(fields[1:])
		if err != nil {
			return CPUStat{}, fmt.Errorf("%s: %w", fields[0], err)
		}
		if fields[0] == "cpu" {
			stat.Total, hasTotal = times, true
		} else {
			stat.PerCore = append(stat.PerCore, times)
		}
	}
	if err := sc.Err(); err != nil {
		return CPUStat{}, err
	}
	if !hasTotal {
		return CPUStat{}, errors.New("no aggregate cpu line")
	}
	return stat, nil
}

// parseCPUTimes parses the counters after the "cpuN" label. Kernels before
// 2.6.11 print only four columns, so trailing columns default to zero.
func parseCPUTimes(fields []string) (CPUTimes, error) {
	if len(fields) < 4 {
		return CPUTimes{}, fmt.Errorf("want at least 4 counters, got %d", len(fields))
	}
	var v [8]uint64
	for i := 0; i < len(v) && i < len(fields); i++ {
		n, err := strconv.ParseUint(fields[i], 10, 64)
		if err != nil {
			return CPUTimes{}, err
		}
		v[i] = n
	}
	return CPUTimes{
		User: v[0], Nice: v[1], System: v[2], Idle: v[3],
		IOWait: v[4], IRQ: v[5], SoftIRQ: v[6], Steal: v[7],
	}, nil
}

// parseMemInfo parses /proc/meminfo. MemTotal and MemAvailable are
// required; swap fields default to zero when absent.
func parseMemInfo(data []byte) (MemInfo, error) {
	kb := make(map[string]uint64, 4)
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		key, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		switch key {
		case "MemTotal", "MemAvailable", "SwapTotal", "SwapFree":
			fields := strings.Fields(rest)
			if len(fields) == 0 {
				return MemInfo{}, fmt.Errorf("%s: missing value", key)
			}
			n, err := strconv.ParseUint(fields[0], 10, 64)
			if err != nil {
				return MemInfo{}, fmt.Errorf("%s: %w", key, err)
			}
			kb[key] = n
		}
	}
	if err := sc.Err(); err != nil {
		return MemInfo{}, err
	}
	for _, key := range []string{"MemTotal", "MemAvailable"} {
		if _, ok := kb[key]; !ok {
			return MemInfo{}, fmt.Errorf("%s not found", key)
		}
	}
	return MemInfo{
		TotalBytes:     kb["MemTotal"] * 1024,
		AvailableBytes: kb["MemAvailable"] * 1024,
		SwapTotalBytes: kb["SwapTotal"] * 1024,
		SwapFreeBytes:  kb["SwapFree"] * 1024,
	}, nil
}

// parseLoadAverage parses /proc/loadavg ("0.42 0.35 0.30 2/412 18734").
func parseLoadAverage(data []byte) (LoadAverage, error) {
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return LoadAverage{}, fmt.Errorf("want at least 3 fields, got %d", len(fields))
	}
	var v [3]float64
	for i := range v {
		f, err := strconv.ParseFloat(fields[i], 64)
		if err != nil {
			return LoadAverage{}, err
		}
		v[i] = f
	}
	return LoadAverage{One: v[0], Five: v[1], Fifteen: v[2]}, nil
}

// parseUptime parses the first field of /proc/uptime (seconds since boot).
func parseUptime(data []byte) (float64, error) {
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, errors.New("empty")
	}
	return strconv.ParseFloat(fields[0], 64)
}

// parseNetDev parses /proc/net/dev and returns the counters of physical and
// overlay interfaces, sorted by name. Loopback and container plumbing
// (docker*, veth*, br-*) are skipped.
func parseNetDev(data []byte) ([]NetCounters, error) {
	var out []NetCounters
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue // the two header lines have no colon
		}
		name = strings.TrimSpace(name)
		if ignoredInterface(name) {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 16 {
			return nil, fmt.Errorf("%s: want 16 counters, got %d", name, len(fields))
		}
		rx, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%s: rx bytes: %w", name, err)
		}
		tx, err := strconv.ParseUint(fields[8], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%s: tx bytes: %w", name, err)
		}
		out = append(out, NetCounters{Interface: name, RxBytes: rx, TxBytes: tx})
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	slices.SortFunc(out, func(a, b NetCounters) int { return strings.Compare(a.Interface, b.Interface) })
	return out, nil
}

func ignoredInterface(name string) bool {
	return name == "lo" ||
		strings.HasPrefix(name, "docker") ||
		strings.HasPrefix(name, "veth") ||
		strings.HasPrefix(name, "br-")
}

// parseOSRelease returns PRETTY_NAME from an os-release(5) file, or "" if
// the key is absent.
func parseOSRelease(data []byte) string {
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		key, value, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if !ok || key != "PRETTY_NAME" {
			continue
		}
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		return value
	}
	return ""
}

// parseThrottled parses the firmware throttle bit field. It accepts the
// sysfs form ("50005") and the vcgencmd form ("throttled=0x50005").
func parseThrottled(s string) (uint32, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "throttled=")
	s = strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil {
		return 0, fmt.Errorf("throttle state %q: %w", s, err)
	}
	return uint32(v), nil
}

// parseInt parses a single integer sysfs value such as "51250\n".
func parseInt(data []byte) (int64, error) {
	return strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
}

// trimValue strips the NUL terminator that device-tree strings carry and
// any surrounding whitespace.
func trimValue(data []byte) string {
	return strings.TrimFunc(string(data), func(r rune) bool { return r == 0 || unicode.IsSpace(r) })
}
