package collector

import (
	"math"
	"time"
)

// Sample is the result of one collection cycle.
type Sample struct {
	Snapshot Snapshot
	// Time is when the reading was taken. Unlike Snapshot.CollectedAt it
	// keeps the monotonic clock reading, so age checks are not fooled by
	// wall-clock steps.
	Time time.Time
	// Available reports which non-nullable Snapshot sections hold real
	// data. A section that is not available holds zeros and must not be
	// exported as a metric.
	Available Availability
}

// Availability flags the Snapshot sections that have no null encoding.
type Availability struct {
	CPU, LoadAverage, Memory, Uptime bool
}

// BuildSample turns the current reading into a Sample. CPU usage and network
// rates are computed against prev. Without prev, CPU usage is the average
// since boot (the counters start at zero) and network rates are zero.
func BuildSample(prev *Reading, cur Reading) Sample {
	snap := Snapshot{
		Hostname:    cur.Hostname,
		CollectedAt: cur.Time.UTC().Truncate(time.Millisecond),
		Platform:    cur.Platform,
		CPU: CPU{
			PerCorePercent:     []Percent{},
			TemperatureCelsius: cur.Temperature,
			FrequencyMHz:       cur.FrequencyMHz,
		},
		Filesystems: cur.Filesystems,
		Network:     make([]Interface, 0, len(cur.Network)),
	}
	if snap.Filesystems == nil {
		snap.Filesystems = []Filesystem{}
	}
	var avail Availability

	if cur.CPU != nil {
		avail.CPU = true
		var base CPUStat
		if prev != nil && prev.CPU != nil {
			base = *prev.CPU
		}
		snap.CPU.Cores = len(cur.CPU.PerCore)
		snap.CPU.UsagePercent = Percent(100 * busyFraction(base.Total, cur.CPU.Total))
		snap.CPU.PerCorePercent = make([]Percent, len(cur.CPU.PerCore))
		for i, core := range cur.CPU.PerCore {
			var prevCore CPUTimes // a core that just came online starts from zero
			if i < len(base.PerCore) {
				prevCore = base.PerCore[i]
			}
			snap.CPU.PerCorePercent[i] = Percent(100 * busyFraction(prevCore, core))
		}
	}
	if cur.Load != nil {
		avail.LoadAverage = true
		snap.CPU.LoadAverage = *cur.Load
	}
	if m := cur.Memory; m != nil {
		avail.Memory = true
		used := m.TotalBytes - min(m.AvailableBytes, m.TotalBytes)
		snap.Memory = Memory{
			TotalBytes:     m.TotalBytes,
			AvailableBytes: m.AvailableBytes,
			UsedBytes:      used,
			SwapTotalBytes: m.SwapTotalBytes,
			SwapUsedBytes:  m.SwapTotalBytes - min(m.SwapFreeBytes, m.SwapTotalBytes),
		}
		if m.TotalBytes > 0 {
			snap.Memory.UsagePercent = Percent(100 * float64(used) / float64(m.TotalBytes))
		}
	}
	if cur.Uptime != nil {
		avail.Uptime = true
		snap.UptimeSeconds = *cur.Uptime
	}
	if cur.Throttled != nil {
		snap.Throttling = DecodeThrottled(*cur.Throttled)
	}

	prevNet := map[string]NetCounters{}
	var elapsed float64
	if prev != nil {
		elapsed = cur.Time.Sub(prev.Time).Seconds()
		for _, n := range prev.Network {
			prevNet[n.Interface] = n
		}
	}
	for _, n := range cur.Network {
		iface := Interface{Interface: n.Interface, RxBytesTotal: n.RxBytes, TxBytesTotal: n.TxBytes}
		if p, ok := prevNet[n.Interface]; ok {
			iface.RxBytesPerSecond = rate(p.RxBytes, n.RxBytes, elapsed)
			iface.TxBytesPerSecond = rate(p.TxBytes, n.TxBytes, elapsed)
		}
		snap.Network = append(snap.Network, iface)
	}

	return Sample{Snapshot: snap, Time: cur.Time, Available: avail}
}

// busyFraction returns the share of non-idle CPU time between two readings,
// in [0, 1]. Like procps top, it clamps each per-field delta at zero:
// iowait is known to go backwards on some kernels, and a counter reset must
// not produce a negative or inflated value.
func busyFraction(prev, cur CPUTimes) float64 {
	idle := delta(prev.Idle, cur.Idle) + delta(prev.IOWait, cur.IOWait)
	busy := delta(prev.User, cur.User) + delta(prev.Nice, cur.Nice) +
		delta(prev.System, cur.System) + delta(prev.IRQ, cur.IRQ) +
		delta(prev.SoftIRQ, cur.SoftIRQ) + delta(prev.Steal, cur.Steal)
	if busy+idle == 0 {
		return 0
	}
	return busy / (busy + idle)
}

func delta(prev, cur uint64) float64 {
	if cur < prev {
		return 0
	}
	return float64(cur - prev)
}

// rate returns the per-second increase of a counter, rounded to 0.1. A
// counter that went backwards (wrap or interface reset) yields 0.
func rate(prev, cur uint64, seconds float64) float64 {
	if cur < prev || seconds <= 0 {
		return 0
	}
	return math.Round(float64(cur-prev)/seconds*10) / 10
}
