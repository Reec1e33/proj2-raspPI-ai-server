// Package demo synthesises smoothly varying Raspberry Pi 5 telemetry. It
// lets the agent run on hosts without procfs (macOS, CI) and produce stable
// screenshots.
//
// The source emits raw cumulative counters, exactly like the host source,
// so CPU usage and network rates go through the same delta maths in the
// collector.Sampler.
package demo

import (
	"context"
	"math"
	"math/rand/v2"
	"time"

	"github.com/Reec1e33/proj2-raspPI-ai-server/agent/internal/collector"
)

const (
	cores  = 4
	userHZ = 100 // /proc/stat ticks per second

	memTotal  = 8443211776 // Pi 5 8 GB as reported by MemTotal
	swapTotal = 536866816  // Raspberry Pi OS default 512 MB swap file

	bootUptime = 3*86400 + 4*3600 + 17*60 // seconds already up at start

	minTemp, maxTemp = 45.0, 70.0
	softTempLimit    = 65.0 // demo threshold for the soft_temp_limit flag

	bitUnderVoltage    = 1 << 0
	bitFrequencyCapped = 1 << 1
	bitSoftTempLimit   = 1 << 3

	// Mean time between events, in seconds.
	inferenceEvery    = 240.0  // a burst of CPU load, like a local LLM reply
	downloadEvery     = 300.0  // a burst of inbound traffic on eth0
	underVoltageEvery = 1800.0 // a brief supply dip
)

var (
	model  = "Raspberry Pi 5 Model B Rev 1.0"
	osName = "Debian GNU/Linux 12 (bookworm)"
	kernel = "6.6.51+rpt-rpi-2712"
)

// Source is a collector.Source with synthetic data. It is deterministic for
// a given seed and sequence of clock readings. It is not safe for
// concurrent use; the Sampler calls it from one goroutine.
type Source struct {
	rng    *rand.Rand
	now    func() time.Time
	mounts []string

	started bool
	last    time.Time
	uptime  float64

	util      float64 // mean CPU utilisation, 0..1
	coreNoise [cores]float64
	busy      [cores]float64 // cumulative ticks
	idle      [cores]float64
	temp      float64
	load      [3]float64
	memAvail  float64
	swapUsed  float64

	inference    float64 // seconds of burst left
	download     float64
	downloadRate float64
	underVoltage float64
	occurred     uint32 // sticky "since boot" throttle bits
	throttled    uint32 // get_throttled value

	ifaces []iface
	fsUsed []float64
}

type iface struct {
	name           string
	rxBase, txBase float64 // typical bytes per second
	rxRate, txRate float64
	rx, tx         float64 // cumulative bytes
}

// New returns a demo source seeded with seed that reports the given
// mountpoints.
func New(seed uint64, mounts []string) *Source {
	return &Source{
		rng:    rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15)),
		now:    time.Now,
		mounts: mounts,
	}
}

// Read implements collector.Source.
func (s *Source) Read(context.Context) collector.Reading {
	now := s.now()
	if !s.started {
		s.init()
		s.started = true
	} else {
		// Clamp so a stalled or stepped clock cannot cause a jump.
		s.step(min(max(now.Sub(s.last).Seconds(), 0), 60))
	}
	s.last = now
	return s.reading(now)
}

func (s *Source) init() {
	s.uptime = bootUptime
	s.util = 0.12
	s.temp = 49
	s.load = [3]float64{0.5, 0.45, 0.4}
	s.memAvail = 5.9e9
	s.swapUsed = 12 << 20
	for i := range cores {
		s.busy[i] = bootUptime * userHZ * 0.08
		s.idle[i] = bootUptime * userHZ * 0.92
	}
	s.ifaces = []iface{
		{name: "eth0", rxBase: 120e3, txBase: 35e3, rx: 18.7e9, tx: 3.2e9},
		{name: "wlan0", rxBase: 300, txBase: 120, rx: 41e6, tx: 9e6},
	}
	for i := range s.ifaces {
		s.ifaces[i].rxRate, s.ifaces[i].txRate = s.ifaces[i].rxBase, s.ifaces[i].txBase
	}
	s.fsUsed = make([]float64, len(s.mounts))
	for i := range s.mounts {
		size, used := fsSize(i)
		s.fsUsed[i] = size * used
	}
}

func (s *Source) step(dt float64) {
	s.uptime += dt

	s.inference = s.countdown(s.inference, dt, inferenceEvery, 20, 90)
	downloading := s.download > 0
	s.download = s.countdown(s.download, dt, downloadEvery, 5, 25)
	if !downloading && s.download > 0 {
		s.downloadRate = 2e6 + 7e6*s.rng.Float64()
	}
	s.underVoltage = s.countdown(s.underVoltage, dt, underVoltageEvery, 2, 8)

	// CPU: a slow 10-minute wave at idle, near-saturation during inference.
	target := 0.12 + 0.05*math.Sin(2*math.Pi*s.uptime/600)
	if s.inference > 0 {
		target = 0.9
	}
	s.util = clamp(s.relax(s.util, target, 6, 0.01, dt), 0.02, 0.98)
	var sum float64
	for i := range cores {
		s.coreNoise[i] = s.relax(s.coreNoise[i], 0, 10, 0.01, dt)
		u := clamp(s.util+s.coreNoise[i], 0.01, 1)
		s.busy[i] += u * dt * userHZ
		s.idle[i] += (1 - u) * dt * userHZ
		sum += u
	}
	avg := sum / cores

	// Temperature follows load with a thermal time constant of ~30 s.
	s.temp = clamp(s.relax(s.temp, minTemp+25*avg, 30, 0.05, dt), minTemp, maxTemp)

	for i, tau := range [3]float64{60, 300, 900} {
		s.load[i] = s.relax(s.load[i], cores*avg, tau, 0, dt)
	}

	memTarget := 5.9e9
	if s.inference > 0 {
		memTarget = 4.6e9 // model weights resident
	}
	s.memAvail = clamp(s.relax(s.memAvail, memTarget, 15, 2e6, dt), 0, memTotal)
	s.swapUsed = clamp(s.swapUsed+s.rng.NormFloat64()*4096*math.Sqrt(dt), 0, swapTotal)

	for i := range s.ifaces {
		n := &s.ifaces[i]
		n.rxRate = max(s.relax(n.rxRate, n.rxBase, 20, n.rxBase*0.1, dt), 0)
		n.txRate = max(s.relax(n.txRate, n.txBase, 20, n.txBase*0.1, dt), 0)
		rx := n.rxRate
		if i == 0 && s.download > 0 {
			rx += s.downloadRate
		}
		n.rx += rx * dt
		n.tx += n.txRate * dt
	}

	for i := range s.fsUsed {
		s.fsUsed[i] += 1500 * dt // logs and metrics accumulating
	}

	var now uint32
	if s.underVoltage > 0 {
		now |= bitUnderVoltage | bitFrequencyCapped // a supply dip caps the ARM clock
	}
	if s.reportedTemp() >= softTempLimit {
		now |= bitSoftTempLimit
	}
	s.occurred |= now << 16
	s.throttled = now | s.occurred
}

func (s *Source) reading(now time.Time) collector.Reading {
	r := collector.Reading{
		Time:     now,
		Hostname: "picloud",
		Platform: collector.Platform{Model: &model, OS: &osName, Kernel: &kernel, Arch: "arm64"},
		Load: &collector.LoadAverage{
			One: round(s.load[0], 100), Five: round(s.load[1], 100), Fifteen: round(s.load[2], 100),
		},
		Memory: &collector.MemInfo{
			TotalBytes:     memTotal,
			AvailableBytes: uint64(s.memAvail),
			SwapTotalBytes: swapTotal,
			SwapFreeBytes:  swapTotal - uint64(s.swapUsed),
		},
		Uptime:      ptr(round(s.uptime, 100)),
		Temperature: ptr(s.reportedTemp()),
		Errors:      map[string]error{},
	}

	cpu := &collector.CPUStat{PerCore: make([]collector.CPUTimes, cores)}
	for i := range cores {
		busy := uint64(s.busy[i])
		t := collector.CPUTimes{User: busy * 3 / 4, System: busy - busy*3/4, Idle: uint64(s.idle[i])}
		cpu.PerCore[i] = t
		cpu.Total.User += t.User
		cpu.Total.System += t.System
		cpu.Total.Idle += t.Idle
	}
	r.CPU = cpu

	r.Throttled = ptr(s.throttled)

	// The ondemand governor idles at 1.5 GHz and boosts to 2.4 GHz.
	freq := 1500.0
	if s.util > 0.25 && s.throttled&bitFrequencyCapped == 0 {
		freq = 2400
	}
	r.FrequencyMHz = &freq

	for _, n := range s.ifaces {
		r.Network = append(r.Network, collector.NetCounters{Interface: n.name, RxBytes: uint64(n.rx), TxBytes: uint64(n.tx)})
	}
	for i, m := range s.mounts {
		total, _ := fsSize(i)
		used := min(s.fsUsed[i], total*0.95)
		avail := total*0.95 - used // ext4 reserves 5% for root
		r.Filesystems = append(r.Filesystems, collector.Filesystem{
			Mountpoint:     m,
			TotalBytes:     uint64(total),
			UsedBytes:      uint64(used),
			AvailableBytes: uint64(avail),
			UsagePercent:   collector.Percent(100 * used / (used + avail)),
		})
	}
	return r
}

// reportedTemp is the temperature in 0.05 °C steps.
func (s *Source) reportedTemp() float64 { return round(s.temp, 20) }

// fsSize returns the size in bytes and initial used fraction of the i-th
// mount: a 64 GB SD card for the first, a 500 GB SSD for any others.
func fsSize(i int) (size, used float64) {
	if i == 0 {
		return 62_101_032_960, 0.31
	}
	return 500_107_862_016, 0.42
}

// relax moves x toward target with time constant tau and adds Gaussian
// noise scaled by sqrt(dt): a discretised Ornstein-Uhlenbeck process.
func (s *Source) relax(x, target, tau, sigma, dt float64) float64 {
	return x + (target-x)*(1-math.Exp(-dt/tau)) + sigma*math.Sqrt(dt)*s.rng.NormFloat64()
}

// countdown decrements an active event, or starts a new one lasting between
// lo and hi seconds with the given mean interval.
func (s *Source) countdown(left, dt, every, lo, hi float64) float64 {
	if left > 0 {
		return left - dt
	}
	if s.chance(dt, every) {
		return lo + (hi-lo)*s.rng.Float64()
	}
	return 0
}

// chance reports whether a Poisson event with the given mean interval
// happens within dt seconds.
func (s *Source) chance(dt, every float64) bool {
	return s.rng.Float64() < 1-math.Exp(-dt/every)
}

func clamp(v, lo, hi float64) float64 { return min(max(v, lo), hi) }

// round rounds v to the nearest 1/perUnit. Dividing by an integer (rather
// than multiplying by a fractional step) keeps values like 52.35 exact in JSON.
func round(v, perUnit float64) float64 { return math.Round(v*perUnit) / perUnit }

func ptr[T any](v T) *T { return &v }
