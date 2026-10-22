package demo

import (
	"context"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/Reec1e33/proj2-raspPI-ai-server/agent/internal/collector"
)

// fakeClock advances by step on every call.
func fakeClock(step time.Duration) func() time.Time {
	t := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	return func() time.Time {
		t = t.Add(step)
		return t
	}
}

func newTestSource(seed uint64, mounts ...string) *Source {
	s := New(seed, mounts)
	s.now = fakeClock(2 * time.Second)
	return s
}

func TestDeterministic(t *testing.T) {
	a, b := newTestSource(42, "/"), newTestSource(42, "/")
	c := newTestSource(7, "/")
	ctx := context.Background()
	differs := false
	for i := range 200 {
		ra, rb, rc := a.Read(ctx), b.Read(ctx), c.Read(ctx)
		if !reflect.DeepEqual(ra, rb) {
			t.Fatalf("step %d: same seed diverged:\n%+v\n%+v", i, ra, rb)
		}
		if !reflect.DeepEqual(ra, rc) {
			differs = true
		}
	}
	if !differs {
		t.Error("different seeds produced identical data")
	}
}

// TestPlausibleOverSixHours runs the source through the real Sampler maths
// and checks ranges, smoothness and that throttle events show up.
func TestPlausibleOverSixHours(t *testing.T) {
	src := newTestSource(1, "/", "/mnt/ssd")
	ctx := context.Background()
	const steps = 6 * 3600 / 2

	var (
		prev        *collector.Reading
		prevTemp    float64
		sawUnder    bool
		sawSoft     bool
		sawBurst    bool
		sawDownload bool
		lastUptime  float64
		lastRx      uint64
	)
	for i := range steps {
		r := src.Read(ctx)
		s := collector.BuildSample(prev, r)
		snap := s.Snapshot
		prev = &r

		if s.Available != (collector.Availability{CPU: true, LoadAverage: true, Memory: true, Uptime: true}) {
			t.Fatalf("step %d: Available = %+v", i, s.Available)
		}
		temp := *snap.CPU.TemperatureCelsius
		if temp < minTemp || temp > maxTemp {
			t.Fatalf("step %d: temperature %v outside [%v, %v]", i, temp, minTemp, maxTemp)
		}
		if i > 0 && math.Abs(temp-prevTemp) > 1.5 {
			t.Fatalf("step %d: temperature jumped %v -> %v", i, prevTemp, temp)
		}
		prevTemp = temp

		if snap.CPU.Cores != cores || len(snap.CPU.PerCorePercent) != cores {
			t.Fatalf("step %d: cores = %d, per-core = %v", i, snap.CPU.Cores, snap.CPU.PerCorePercent)
		}
		for _, p := range append(snap.CPU.PerCorePercent, snap.CPU.UsagePercent, snap.Memory.UsagePercent) {
			if p < 0 || p > 100 {
				t.Fatalf("step %d: percent %v out of range", i, p)
			}
		}
		if snap.CPU.UsagePercent > 60 {
			sawBurst = true
		}
		if snap.Memory.UsedBytes == 0 || snap.Memory.UsedBytes >= snap.Memory.TotalBytes {
			t.Fatalf("step %d: memory %+v", i, snap.Memory)
		}
		if snap.UptimeSeconds <= lastUptime {
			t.Fatalf("step %d: uptime did not advance", i)
		}
		lastUptime = snap.UptimeSeconds

		if len(snap.Network) != 2 || snap.Network[0].Interface != "eth0" || snap.Network[1].Interface != "wlan0" {
			t.Fatalf("step %d: network %+v", i, snap.Network)
		}
		eth := snap.Network[0]
		if eth.RxBytesTotal < lastRx || eth.RxBytesPerSecond < 0 || eth.TxBytesPerSecond < 0 {
			t.Fatalf("step %d: eth0 %+v", i, eth)
		}
		lastRx = eth.RxBytesTotal
		if eth.RxBytesPerSecond > 1e6 {
			sawDownload = true
		}

		if len(snap.Filesystems) != 2 || snap.Filesystems[1].Mountpoint != "/mnt/ssd" {
			t.Fatalf("step %d: filesystems %+v", i, snap.Filesystems)
		}
		th := snap.Throttling
		if !th.Supported {
			t.Fatalf("step %d: throttling unsupported", i)
		}
		if th.UnderVoltageNow {
			sawUnder = true
			if !th.FrequencyCappedNow || *snap.CPU.FrequencyMHz != 1500 {
				t.Fatalf("step %d: under-voltage must cap the clock: %+v", i, th)
			}
		}
		if sawUnder && !th.UnderVoltageOccurred {
			t.Fatalf("step %d: under_voltage_occurred must be sticky", i)
		}
		if th.SoftTempLimitNow != (temp >= softTempLimit) {
			t.Fatalf("step %d: soft_temp_limit_now=%v at %v °C", i, th.SoftTempLimitNow, temp)
		}
		sawSoft = sawSoft || th.SoftTempLimitNow
	}
	if !sawUnder || !sawSoft || !sawBurst || !sawDownload {
		t.Errorf("events over six hours: under-voltage=%v soft-limit=%v inference=%v download=%v",
			sawUnder, sawSoft, sawBurst, sawDownload)
	}
}

func TestClockSteps(t *testing.T) {
	src := New(3, nil)
	times := []time.Time{
		time.Unix(1000, 0),
		time.Unix(1000, 0), // stalled
		time.Unix(900, 0),  // stepped back
		time.Unix(90000, 0),
	}
	i := 0
	src.now = func() time.Time { t := times[i]; i++; return t }

	ctx := context.Background()
	first := src.Read(ctx)
	for range len(times) - 1 {
		r := src.Read(ctx)
		if r.CPU.Total.User < first.CPU.Total.User || r.Network[0].RxBytes < first.Network[0].RxBytes {
			t.Fatal("counters went backwards")
		}
		if *r.Uptime-*first.Uptime > 60 {
			t.Fatalf("uptime advanced %v s; a single step must be clamped to 60 s", *r.Uptime-*first.Uptime)
		}
	}
	if len(first.Filesystems) != 0 {
		t.Errorf("no mounts configured, got %+v", first.Filesystems)
	}
}
