package collector

import (
	"context"
	"time"
)

// Source produces Readings. Host reads the real machine; the demo package
// synthesises data. Read must not fail as a whole: a source that cannot be
// read leaves its field nil and, if the failure is unexpected, records an
// error under its collector name in Reading.Errors.
type Source interface {
	Read(ctx context.Context) Reading
}

// Reading is the raw state of the host at one instant. Counters are
// cumulative; the Sampler turns two Readings into rates. Nil pointers mean
// the source is unsupported on this host.
type Reading struct {
	// Time should come from time.Now so that it carries a monotonic clock
	// reading; rates then survive wall-clock jumps (a Pi has no RTC and
	// steps its clock when NTP syncs).
	Time         time.Time
	Hostname     string
	Platform     Platform
	CPU          *CPUStat
	Load         *LoadAverage
	Memory       *MemInfo
	Uptime       *float64
	Temperature  *float64 // °C
	FrequencyMHz *float64
	Throttled    *uint32 // raw get_throttled bit field
	Filesystems  []Filesystem
	Network      []NetCounters
	Errors       map[string]error // keyed by collector name
}

// CPUTimes holds the cumulative time counters of one "cpu" line in
// /proc/stat, in USER_HZ ticks. Guest time is already included in User and
// Nice, so it is not tracked separately.
type CPUTimes struct {
	User, Nice, System, Idle, IOWait, IRQ, SoftIRQ, Steal uint64
}

// CPUStat is the CPU section of /proc/stat.
type CPUStat struct {
	Total   CPUTimes
	PerCore []CPUTimes
}

// MemInfo holds the /proc/meminfo fields the agent uses, in bytes.
type MemInfo struct {
	TotalBytes     uint64
	AvailableBytes uint64
	SwapTotalBytes uint64
	SwapFreeBytes  uint64
}

// NetCounters holds cumulative byte counters for one network interface.
type NetCounters struct {
	Interface string
	RxBytes   uint64
	TxBytes   uint64
}

// Collector names, used as keys in Reading.Errors and as the "collector"
// label of pi_agent_collect_errors_total.
const (
	CollectorCPU        = "cpu"
	CollectorLoad       = "loadavg"
	CollectorMemory     = "memory"
	CollectorUptime     = "uptime"
	CollectorThermal    = "thermal"
	CollectorCPUFreq    = "cpufreq"
	CollectorThrottled  = "throttled"
	CollectorFilesystem = "filesystem"
	CollectorNetwork    = "network"
	CollectorPlatform   = "platform"
)

// Collectors lists every collector name in a stable order.
var Collectors = []string{
	CollectorCPU, CollectorLoad, CollectorMemory, CollectorUptime,
	CollectorThermal, CollectorCPUFreq, CollectorThrottled,
	CollectorFilesystem, CollectorNetwork, CollectorPlatform,
}
