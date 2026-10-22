// Package exporter exposes the latest collector.Sample as Prometheus
// metrics. It reads cached samples only, so a scrape never reads the host
// sources directly.
package exporter

import (
	"runtime"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/Reec1e33/proj2-raspPI-ai-server/agent/internal/collector"
)

// Source provides the data to export. *collector.Sampler implements it.
type Source interface {
	Latest() (collector.Sample, bool)
	ErrorCounts() map[string]uint64
}

// Exporter is a prometheus.Collector. Metrics whose source is unsupported
// on this host are omitted rather than reported as zero.
type Exporter struct {
	src     Source
	version string

	cpuUsage, cpuTemp, cpuFreq, load       *prometheus.Desc
	memTotal, memAvail, swapTotal, swapUse *prometheus.Desc
	fsSize, fsAvail, fsUsed                *prometheus.Desc
	netRx, netTx                           *prometheus.Desc
	throttled, uptime                      *prometheus.Desc
	buildInfo, collectErrors               *prometheus.Desc
}

// New returns an Exporter. version is reported in pi_agent_build_info.
func New(src Source, version string) *Exporter {
	d := func(name, help string, labels ...string) *prometheus.Desc {
		return prometheus.NewDesc(name, help, labels, nil)
	}
	return &Exporter{
		src:     src,
		version: version,

		cpuUsage: d("pi_cpu_usage_ratio", "CPU busy time over the last sample interval (0-1)."),
		cpuTemp:  d("pi_cpu_temperature_celsius", "SoC temperature in degrees Celsius."),
		cpuFreq:  d("pi_cpu_frequency_hertz", "Current clock speed of CPU 0 in hertz."),
		load:     d("pi_load_average", "System load average.", "window"),

		memTotal:  d("pi_memory_total_bytes", "Total usable RAM in bytes."),
		memAvail:  d("pi_memory_available_bytes", "RAM available for new workloads in bytes (MemAvailable)."),
		swapTotal: d("pi_swap_total_bytes", "Total swap space in bytes."),
		swapUse:   d("pi_swap_used_bytes", "Swap space in use in bytes."),

		fsSize:  d("pi_filesystem_size_bytes", "Filesystem size in bytes.", "mountpoint"),
		fsAvail: d("pi_filesystem_avail_bytes", "Filesystem space available to unprivileged users in bytes.", "mountpoint"),
		fsUsed:  d("pi_filesystem_used_bytes", "Filesystem space in use in bytes.", "mountpoint"),

		netRx: d("pi_network_receive_bytes_total", "Bytes received on the interface.", "interface"),
		netTx: d("pi_network_transmit_bytes_total", "Bytes transmitted on the interface.", "interface"),

		throttled: d("pi_throttled", "Raspberry Pi firmware throttle flag (1 = set).", "condition", "scope"),
		uptime:    d("pi_uptime_seconds", "Seconds since the host booted."),

		buildInfo:     d("pi_agent_build_info", "Build information for pi-agent. Always 1.", "version", "go_version"),
		collectErrors: d("pi_agent_collect_errors_total", "Failed reads per collector.", "collector"),
	}
}

// Describe implements prometheus.Collector.
func (e *Exporter) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{
		e.cpuUsage, e.cpuTemp, e.cpuFreq, e.load,
		e.memTotal, e.memAvail, e.swapTotal, e.swapUse,
		e.fsSize, e.fsAvail, e.fsUsed, e.netRx, e.netTx,
		e.throttled, e.uptime, e.buildInfo, e.collectErrors,
	} {
		ch <- d
	}
}

// Collect implements prometheus.Collector.
func (e *Exporter) Collect(ch chan<- prometheus.Metric) {
	emit := func(d *prometheus.Desc, t prometheus.ValueType, v float64, labels ...string) {
		m, err := prometheus.NewConstMetric(d, t, v, labels...)
		if err != nil {
			// A label value that is not valid UTF-8 (interface names are
			// arbitrary bytes) must fail the scrape, not panic the process.
			m = prometheus.NewInvalidMetric(d, err)
		}
		ch <- m
	}
	gauge := func(d *prometheus.Desc, v float64, labels ...string) { emit(d, prometheus.GaugeValue, v, labels...) }
	counter := func(d *prometheus.Desc, v float64, labels ...string) { emit(d, prometheus.CounterValue, v, labels...) }

	gauge(e.buildInfo, 1, e.version, runtime.Version())
	for name, n := range e.src.ErrorCounts() {
		counter(e.collectErrors, float64(n), name)
	}

	s, ok := e.src.Latest()
	if !ok {
		return
	}
	snap := s.Snapshot

	if s.Available.CPU {
		gauge(e.cpuUsage, float64(snap.CPU.UsagePercent)/100)
	}
	if t := snap.CPU.TemperatureCelsius; t != nil {
		gauge(e.cpuTemp, *t)
	}
	if f := snap.CPU.FrequencyMHz; f != nil {
		gauge(e.cpuFreq, *f*1e6)
	}
	if s.Available.LoadAverage {
		l := snap.CPU.LoadAverage
		gauge(e.load, l.One, "1m")
		gauge(e.load, l.Five, "5m")
		gauge(e.load, l.Fifteen, "15m")
	}
	if s.Available.Memory {
		m := snap.Memory
		gauge(e.memTotal, float64(m.TotalBytes))
		gauge(e.memAvail, float64(m.AvailableBytes))
		gauge(e.swapTotal, float64(m.SwapTotalBytes))
		gauge(e.swapUse, float64(m.SwapUsedBytes))
	}
	if s.Available.Uptime {
		gauge(e.uptime, snap.UptimeSeconds)
	}
	for _, f := range snap.Filesystems {
		gauge(e.fsSize, float64(f.TotalBytes), f.Mountpoint)
		gauge(e.fsAvail, float64(f.AvailableBytes), f.Mountpoint)
		gauge(e.fsUsed, float64(f.UsedBytes), f.Mountpoint)
	}
	for _, n := range snap.Network {
		counter(e.netRx, float64(n.RxBytesTotal), n.Interface)
		counter(e.netTx, float64(n.TxBytesTotal), n.Interface)
	}
	if th := snap.Throttling; th.Supported {
		for _, c := range []struct {
			condition     string
			now, occurred bool
		}{
			{"under_voltage", th.UnderVoltageNow, th.UnderVoltageOccurred},
			{"frequency_capped", th.FrequencyCappedNow, th.FrequencyCappedOccurred},
			{"throttled", th.ThrottledNow, th.ThrottledOccurred},
			{"soft_temp_limit", th.SoftTempLimitNow, th.SoftTempLimitOccurred},
		} {
			gauge(e.throttled, flag(c.now), c.condition, "now")
			gauge(e.throttled, flag(c.occurred), c.condition, "occurred")
		}
	}
}

func flag(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
