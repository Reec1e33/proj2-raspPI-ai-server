package collector

import (
	"context"
	"encoding/json"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestBusyFraction(t *testing.T) {
	tests := []struct {
		name      string
		prev, cur CPUTimes
		want      float64
	}{
		{name: "idle", prev: CPUTimes{Idle: 100}, cur: CPUTimes{Idle: 200}, want: 0},
		{name: "fully busy", prev: CPUTimes{User: 100}, cur: CPUTimes{User: 150, System: 50}, want: 1},
		{
			name: "quarter busy, iowait counts as idle",
			prev: CPUTimes{User: 10, Idle: 10, IOWait: 10},
			cur:  CPUTimes{User: 20, Nice: 5, System: 5, IRQ: 3, SoftIRQ: 1, Steal: 1, Idle: 65, IOWait: 30},
			want: 0.25,
		},
		{name: "since boot from zero", cur: CPUTimes{User: 30, Idle: 70}, want: 0.3},
		{name: "no time passed", prev: CPUTimes{User: 5, Idle: 5}, cur: CPUTimes{User: 5, Idle: 5}, want: 0},
		{
			name: "iowait going backwards is clamped",
			prev: CPUTimes{User: 100, Idle: 100, IOWait: 50},
			cur:  CPUTimes{User: 150, Idle: 150, IOWait: 40},
			want: 0.5,
		},
		{name: "counter reset", prev: CPUTimes{User: 1000, Idle: 1000}, cur: CPUTimes{User: 10, Idle: 10}, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := busyFraction(tt.prev, tt.cur); math.Abs(got-tt.want) > 1e-9 {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestRate(t *testing.T) {
	tests := []struct {
		name      string
		prev, cur uint64
		seconds   float64
		want      float64
	}{
		{name: "steady", prev: 1000, cur: 3000, seconds: 2, want: 1000},
		{name: "rounded to 0.1", prev: 0, cur: 10, seconds: 3, want: 3.3},
		{name: "idle", prev: 5, cur: 5, seconds: 2, want: 0},
		{name: "32-bit wrap", prev: math.MaxUint32 - 10, cur: 20, seconds: 2, want: 0},
		{name: "reset", prev: 1 << 40, cur: 0, seconds: 2, want: 0},
		{name: "zero interval", prev: 0, cur: 100, seconds: 0, want: 0},
		{name: "negative interval", prev: 0, cur: 100, seconds: -1, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := rate(tt.prev, tt.cur, tt.seconds); got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDecodeThrottled(t *testing.T) {
	tests := []struct {
		in   uint32
		want Throttling
	}{
		{in: 0, want: Throttling{Supported: true, Raw: ptr("0x0")}},
		{in: 0x50005, want: Throttling{
			Supported: true, Raw: ptr("0x50005"),
			UnderVoltageNow: true, ThrottledNow: true,
			UnderVoltageOccurred: true, ThrottledOccurred: true,
		}},
		{in: 0x80008, want: Throttling{
			Supported: true, Raw: ptr("0x80008"),
			SoftTempLimitNow: true, SoftTempLimitOccurred: true,
		}},
		{in: 0x20000, want: Throttling{
			Supported: true, Raw: ptr("0x20000"),
			FrequencyCappedOccurred: true,
		}},
		{in: 0xf000f, want: Throttling{
			Supported: true, Raw: ptr("0xf000f"),
			UnderVoltageNow: true, FrequencyCappedNow: true, ThrottledNow: true, SoftTempLimitNow: true,
			UnderVoltageOccurred: true, FrequencyCappedOccurred: true, ThrottledOccurred: true, SoftTempLimitOccurred: true,
		}},
		// Unknown bits are ignored by the flags but kept in Raw.
		{in: 0xfff0fff0, want: Throttling{Supported: true, Raw: ptr("0xfff0fff0")}},
	}
	for _, tt := range tests {
		if got := DecodeThrottled(tt.in); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("DecodeThrottled(%#x) = %+v, want %+v", tt.in, got, tt.want)
		}
	}
}

func TestBuildSampleDeltas(t *testing.T) {
	t0 := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	prev := Reading{
		Time: t0,
		CPU: &CPUStat{
			Total:   CPUTimes{User: 100, Idle: 300},
			PerCore: []CPUTimes{{User: 50, Idle: 150}, {User: 50, Idle: 150}},
		},
		Network: []NetCounters{
			{Interface: "eth0", RxBytes: 1000, TxBytes: 500},
			{Interface: "wlan0", RxBytes: 1 << 32, TxBytes: 100},
		},
	}
	cur := Reading{
		Time: t0.Add(2 * time.Second),
		CPU: &CPUStat{
			Total: CPUTimes{User: 200, Idle: 400}, // 50% busy
			PerCore: []CPUTimes{
				{User: 125, Idle: 175}, // 75%
				{User: 75, Idle: 225},  // 25%
				{User: 10, Idle: 30},   // new core: since boot, 25%
			},
		},
		Network: []NetCounters{
			{Interface: "eth0", RxBytes: 5000, TxBytes: 1500},
			{Interface: "wlan0", RxBytes: 10, TxBytes: 10}, // reset
			{Interface: "usb0", RxBytes: 99, TxBytes: 99},  // new
		},
	}
	s := BuildSample(&prev, cur)
	snap := s.Snapshot

	if snap.CPU.UsagePercent != 50 {
		t.Errorf("UsagePercent = %v, want 50", snap.CPU.UsagePercent)
	}
	if want := []Percent{75, 25, 25}; !slices.Equal(snap.CPU.PerCorePercent, want) {
		t.Errorf("PerCorePercent = %v, want %v", snap.CPU.PerCorePercent, want)
	}
	if snap.CPU.Cores != 3 {
		t.Errorf("Cores = %d", snap.CPU.Cores)
	}
	want := []Interface{
		{Interface: "eth0", RxBytesTotal: 5000, TxBytesTotal: 1500, RxBytesPerSecond: 2000, TxBytesPerSecond: 500},
		{Interface: "wlan0", RxBytesTotal: 10, TxBytesTotal: 10},
		{Interface: "usb0", RxBytesTotal: 99, TxBytesTotal: 99},
	}
	if !reflect.DeepEqual(snap.Network, want) {
		t.Errorf("Network = %+v\nwant %+v", snap.Network, want)
	}
	if !s.Time.Equal(cur.Time) || !snap.CollectedAt.Equal(cur.Time) {
		t.Errorf("times: sample %v, collected_at %v", s.Time, snap.CollectedAt)
	}
}

func TestBuildSampleFromPi5Fixture(t *testing.T) {
	h := newTestHost(t, pi5Root(t, "50005\n"), "/")
	s := BuildSample(nil, h.Read(context.Background()))
	snap := s.Snapshot

	if s.Available != (Availability{CPU: true, LoadAverage: true, Memory: true, Uptime: true}) {
		t.Errorf("Available = %+v", s.Available)
	}
	// First sample: CPU usage averaged since boot.
	if got := float64(snap.CPU.UsagePercent); math.Abs(got-5.366) > 0.001 {
		t.Errorf("UsagePercent = %v, want ~5.366", got)
	}
	wantMem := Memory{
		TotalBytes: 8443211776, AvailableBytes: 6000000000, UsedBytes: 2443211776,
		SwapTotalBytes: 536866816, SwapUsedBytes: 12582912,
		UsagePercent: Percent(100 * 2443211776.0 / 8443211776.0),
	}
	if snap.Memory != wantMem {
		t.Errorf("Memory = %+v\nwant %+v", snap.Memory, wantMem)
	}
	if !snap.Throttling.UnderVoltageNow || !snap.Throttling.ThrottledOccurred || *snap.Throttling.Raw != "0x50005" {
		t.Errorf("Throttling = %+v", snap.Throttling)
	}
	for _, n := range snap.Network {
		if n.RxBytesPerSecond != 0 || n.TxBytesPerSecond != 0 {
			t.Errorf("first sample must have zero rates: %+v", n)
		}
	}
}

func TestBuildSampleMemoryGuards(t *testing.T) {
	// MemAvailable can briefly exceed MemTotal on some kernels.
	s := BuildSample(nil, Reading{Memory: &MemInfo{TotalBytes: 100, AvailableBytes: 120, SwapTotalBytes: 10, SwapFreeBytes: 20}})
	if s.Snapshot.Memory.UsedBytes != 0 || s.Snapshot.Memory.SwapUsedBytes != 0 || s.Snapshot.Memory.UsagePercent != 0 {
		t.Errorf("Memory = %+v", s.Snapshot.Memory)
	}
	s = BuildSample(nil, Reading{Memory: &MemInfo{}})
	if s.Snapshot.Memory.UsagePercent != 0 {
		t.Errorf("UsagePercent with zero total = %v", s.Snapshot.Memory.UsagePercent)
	}
}

// TestSnapshotJSONShape checks the wire contract: snake_case keys that are
// always present, nulls for unsupported sources, and 1-decimal percentages.
func TestSnapshotJSONShape(t *testing.T) {
	tests := []struct {
		name  string
		read  Reading
		nulls []string
	}{
		{
			name: "unsupported host",
			read: Reading{Time: time.Unix(0, 0), Platform: Platform{Arch: "arm64"}},
			nulls: []string{
				"platform.model", "platform.os", "platform.kernel",
				"cpu.temperature_celsius", "cpu.frequency_mhz", "throttling.raw",
			},
		},
		{
			name: "pi5",
			read: func() Reading {
				h := newTestHost(t, pi5Root(t, "0\n"), "/")
				return h.Read(context.Background())
			}(),
		},
	}
	wantKeys := map[string][]string{
		"":            {"hostname", "collected_at", "uptime_seconds", "platform", "cpu", "memory", "filesystems", "network", "throttling"},
		"platform":    {"model", "os", "kernel", "arch"},
		"cpu":         {"cores", "usage_percent", "per_core_percent", "load_average", "temperature_celsius", "frequency_mhz"},
		"memory":      {"total_bytes", "available_bytes", "used_bytes", "usage_percent", "swap_total_bytes", "swap_used_bytes"},
		"throttling":  {"supported", "raw", "under_voltage_now", "frequency_capped_now", "throttled_now", "soft_temp_limit_now", "under_voltage_occurred", "frequency_capped_occurred", "throttled_occurred", "soft_temp_limit_occurred"},
		"filesystems": {"mountpoint", "total_bytes", "used_bytes", "available_bytes", "usage_percent"},
		"network":     {"interface", "rx_bytes_total", "tx_bytes_total", "rx_bytes_per_second", "tx_bytes_per_second"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(BuildSample(nil, tt.read).Snapshot)
			if err != nil {
				t.Fatal(err)
			}
			var doc map[string]any
			if err := json.Unmarshal(data, &doc); err != nil {
				t.Fatal(err)
			}
			for section, keys := range wantKeys {
				obj := doc
				if section != "" {
					switch v := doc[section].(type) {
					case map[string]any:
						obj = v
					case []any:
						if len(v) == 0 {
							continue
						}
						obj = v[0].(map[string]any)
					default:
						t.Fatalf("%s: unexpected %T", section, v)
					}
				}
				if len(obj) != len(keys) {
					t.Errorf("%s: got %d keys, want %d: %v", section, len(obj), len(keys), obj)
				}
				for _, k := range keys {
					if _, ok := obj[k]; !ok {
						t.Errorf("%s: missing key %q", section, k)
					}
				}
			}
			for _, path := range tt.nulls {
				section, key, _ := strings.Cut(path, ".")
				if v := doc[section].(map[string]any)[key]; v != nil {
					t.Errorf("%s = %v, want null", path, v)
				}
			}
			for _, k := range []string{"filesystems", "network"} {
				if _, ok := doc[k].([]any); !ok {
					t.Errorf("%s must be an array, got %T", k, doc[k])
				}
			}
			if _, ok := doc["cpu"].(map[string]any)["per_core_percent"].([]any); !ok {
				t.Error("per_core_percent must be an array")
			}
		})
	}
}

func TestPercentJSON(t *testing.T) {
	tests := []struct {
		in   Percent
		want string
	}{
		{0, "0"}, {12.34, "12.3"}, {12.35, "12.4"}, {28.937, "28.9"}, {99.96, "100"}, {100, "100"},
	}
	for _, tt := range tests {
		got, err := json.Marshal(tt.in)
		if err != nil || string(got) != tt.want {
			t.Errorf("Marshal(%v) = %s, %v; want %s", float64(tt.in), got, err, tt.want)
		}
	}
	if _, err := json.Marshal(Percent(math.NaN())); err == nil {
		t.Error("NaN must not encode")
	}
}

func TestCollectedAtFormat(t *testing.T) {
	ts := time.Date(2026, 10, 2, 14, 0, 0, 123456789, time.FixedZone("CEST", 2*3600))
	data, _ := json.Marshal(BuildSample(nil, Reading{Time: ts}).Snapshot.CollectedAt)
	if want := `"2026-10-02T12:00:00.123Z"`; string(data) != want {
		t.Errorf("collected_at = %s, want %s", data, want)
	}
}
