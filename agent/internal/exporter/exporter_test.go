package exporter

import (
	"fmt"
	"runtime"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/Reec1e33/proj2-raspPI-ai-server/agent/internal/collector"
)

type fakeSource struct {
	sample collector.Sample
	ok     bool
	errors map[string]uint64
}

func (f fakeSource) Latest() (collector.Sample, bool) { return f.sample, f.ok }
func (f fakeSource) ErrorCounts() map[string]uint64   { return f.errors }

func ptr[T any](v T) *T { return &v }

var pi5Sample = collector.Sample{
	Available: collector.Availability{CPU: true, LoadAverage: true, Memory: true, Uptime: true},
	Snapshot: collector.Snapshot{
		UptimeSeconds: 90922.47,
		CPU: collector.CPU{
			Cores:              4,
			UsagePercent:       12.5,
			LoadAverage:        collector.LoadAverage{One: 0.42, Five: 0.35, Fifteen: 0.3},
			TemperatureCelsius: ptr(51.25),
			FrequencyMHz:       ptr(2400.0),
		},
		Memory: collector.Memory{
			TotalBytes: 8443211776, AvailableBytes: 6000000000,
			SwapTotalBytes: 536866816, SwapUsedBytes: 12582912,
		},
		Filesystems: []collector.Filesystem{
			{Mountpoint: "/", TotalBytes: 1000, UsedBytes: 400, AvailableBytes: 550},
		},
		Network: []collector.Interface{
			{Interface: "eth0", RxBytesTotal: 9876543210, TxBytesTotal: 1234567890},
		},
		Throttling: collector.DecodeThrottled(0x50005),
	},
}

const pi5Metrics = `
# HELP pi_cpu_usage_ratio CPU busy time over the last sample interval (0-1).
# TYPE pi_cpu_usage_ratio gauge
pi_cpu_usage_ratio 0.125
# HELP pi_cpu_temperature_celsius SoC temperature in degrees Celsius.
# TYPE pi_cpu_temperature_celsius gauge
pi_cpu_temperature_celsius 51.25
# HELP pi_cpu_frequency_hertz Current clock speed of CPU 0 in hertz.
# TYPE pi_cpu_frequency_hertz gauge
pi_cpu_frequency_hertz 2.4e+09
# HELP pi_load_average System load average.
# TYPE pi_load_average gauge
pi_load_average{window="15m"} 0.3
pi_load_average{window="1m"} 0.42
pi_load_average{window="5m"} 0.35
# HELP pi_memory_total_bytes Total usable RAM in bytes.
# TYPE pi_memory_total_bytes gauge
pi_memory_total_bytes 8.443211776e+09
# HELP pi_memory_available_bytes RAM available for new workloads in bytes (MemAvailable).
# TYPE pi_memory_available_bytes gauge
pi_memory_available_bytes 6e+09
# HELP pi_swap_total_bytes Total swap space in bytes.
# TYPE pi_swap_total_bytes gauge
pi_swap_total_bytes 5.36866816e+08
# HELP pi_swap_used_bytes Swap space in use in bytes.
# TYPE pi_swap_used_bytes gauge
pi_swap_used_bytes 1.2582912e+07
# HELP pi_filesystem_size_bytes Filesystem size in bytes.
# TYPE pi_filesystem_size_bytes gauge
pi_filesystem_size_bytes{mountpoint="/"} 1000
# HELP pi_filesystem_avail_bytes Filesystem space available to unprivileged users in bytes.
# TYPE pi_filesystem_avail_bytes gauge
pi_filesystem_avail_bytes{mountpoint="/"} 550
# HELP pi_filesystem_used_bytes Filesystem space in use in bytes.
# TYPE pi_filesystem_used_bytes gauge
pi_filesystem_used_bytes{mountpoint="/"} 400
# HELP pi_network_receive_bytes_total Bytes received on the interface.
# TYPE pi_network_receive_bytes_total counter
pi_network_receive_bytes_total{interface="eth0"} 9.87654321e+09
# HELP pi_network_transmit_bytes_total Bytes transmitted on the interface.
# TYPE pi_network_transmit_bytes_total counter
pi_network_transmit_bytes_total{interface="eth0"} 1.23456789e+09
# HELP pi_throttled Raspberry Pi firmware throttle flag (1 = set).
# TYPE pi_throttled gauge
pi_throttled{condition="frequency_capped",scope="now"} 0
pi_throttled{condition="frequency_capped",scope="occurred"} 0
pi_throttled{condition="soft_temp_limit",scope="now"} 0
pi_throttled{condition="soft_temp_limit",scope="occurred"} 0
pi_throttled{condition="throttled",scope="now"} 1
pi_throttled{condition="throttled",scope="occurred"} 1
pi_throttled{condition="under_voltage",scope="now"} 1
pi_throttled{condition="under_voltage",scope="occurred"} 1
# HELP pi_uptime_seconds Seconds since the host booted.
# TYPE pi_uptime_seconds gauge
pi_uptime_seconds 90922.47
`

var allMetrics = []string{
	"pi_cpu_usage_ratio", "pi_cpu_temperature_celsius", "pi_cpu_frequency_hertz", "pi_load_average",
	"pi_memory_total_bytes", "pi_memory_available_bytes", "pi_swap_total_bytes", "pi_swap_used_bytes",
	"pi_filesystem_size_bytes", "pi_filesystem_avail_bytes", "pi_filesystem_used_bytes",
	"pi_network_receive_bytes_total", "pi_network_transmit_bytes_total",
	"pi_throttled", "pi_uptime_seconds", "pi_agent_build_info", "pi_agent_collect_errors_total",
}

func agentMetrics(version string, errors map[string]uint64) string {
	var b strings.Builder
	fmt.Fprintf(&b, `
# HELP pi_agent_build_info Build information for pi-agent. Always 1.
# TYPE pi_agent_build_info gauge
pi_agent_build_info{go_version=%q,version=%q} 1
# HELP pi_agent_collect_errors_total Failed reads per collector.
# TYPE pi_agent_collect_errors_total counter
`, runtime.Version(), version)
	for name, n := range errors {
		fmt.Fprintf(&b, "pi_agent_collect_errors_total{collector=%q} %d\n", name, n)
	}
	return b.String()
}

func TestExporter(t *testing.T) {
	errs := map[string]uint64{"cpu": 0, "thermal": 3}
	tests := []struct {
		name string
		src  fakeSource
		want string
	}{
		{
			name: "pi5",
			src:  fakeSource{sample: pi5Sample, ok: true, errors: errs},
			want: pi5Metrics + agentMetrics("1.2.3", errs),
		},
		{
			name: "no sample yet",
			src:  fakeSource{errors: errs},
			want: agentMetrics("1.2.3", errs),
		},
		{
			// Unsupported sources are omitted, never exported as zero.
			name: "unsupported host",
			src: fakeSource{ok: true, errors: errs, sample: collector.Sample{
				Snapshot: collector.Snapshot{Filesystems: []collector.Filesystem{}, Network: []collector.Interface{}},
			}},
			want: agentMetrics("1.2.3", errs),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := New(tt.src, "1.2.3")
			if err := testutil.CollectAndCompare(e, strings.NewReader(tt.want), allMetrics...); err != nil {
				t.Error(err)
			}
		})
	}
}

func TestExporterLint(t *testing.T) {
	e := New(fakeSource{sample: pi5Sample, ok: true, errors: map[string]uint64{"cpu": 1}}, "dev")
	problems, err := testutil.CollectAndLint(e)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range problems {
		t.Errorf("%s: %s", p.Metric, p.Text)
	}
}

func TestExporterRegisters(t *testing.T) {
	reg := prometheus.NewRegistry()
	src := fakeSource{sample: pi5Sample, ok: true, errors: map[string]uint64{}}
	if err := reg.Register(New(src, "dev")); err != nil {
		t.Fatal(err)
	}
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	if len(mfs) != 16 { // every pi_ family except the empty collect-errors one
		t.Errorf("gathered %d families, want 16", len(mfs))
	}
}

// TestExporterInvalidLabel checks that a label value Prometheus rejects
// fails the scrape instead of panicking inside the registry's goroutine.
func TestExporterInvalidLabel(t *testing.T) {
	sample := pi5Sample
	sample.Snapshot.Network = []collector.Interface{{Interface: "eth\xff"}}
	reg := prometheus.NewRegistry()
	reg.MustRegister(New(fakeSource{sample: sample, ok: true}, "dev"))
	if _, err := reg.Gather(); err == nil || !strings.Contains(err.Error(), "UTF-8") {
		t.Errorf("Gather error = %v, want an invalid UTF-8 label error", err)
	}
}
