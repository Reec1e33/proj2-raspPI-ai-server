// Package collector reads host telemetry from procfs, sysfs and the root
// filesystem, and turns consecutive readings into Snapshots.
//
// The package has three layers:
//   - pure parsers for the kernel's text formats (parse.go),
//   - a Host source that reads those files under configurable roots (host.go),
//   - a Sampler that polls a Source and computes rates between readings
//     (sampler.go, sample.go).
package collector

import (
	"encoding/json"
	"math"
	"time"
)

// Snapshot is the JSON document served at /v1/snapshot. Every key is always
// present; pointer fields encode as null when their source is unsupported.
type Snapshot struct {
	Hostname      string       `json:"hostname"`
	CollectedAt   time.Time    `json:"collected_at"`
	UptimeSeconds float64      `json:"uptime_seconds"`
	Platform      Platform     `json:"platform"`
	CPU           CPU          `json:"cpu"`
	Memory        Memory       `json:"memory"`
	Filesystems   []Filesystem `json:"filesystems"`
	Network       []Interface  `json:"network"`
	Throttling    Throttling   `json:"throttling"`
}

// Platform describes the board and operating system.
type Platform struct {
	Model  *string `json:"model"`
	OS     *string `json:"os"`
	Kernel *string `json:"kernel"`
	Arch   string  `json:"arch"`
}

// CPU holds utilisation, load, temperature and clock speed.
type CPU struct {
	Cores              int         `json:"cores"`
	UsagePercent       Percent     `json:"usage_percent"`
	PerCorePercent     []Percent   `json:"per_core_percent"`
	LoadAverage        LoadAverage `json:"load_average"`
	TemperatureCelsius *float64    `json:"temperature_celsius"`
	FrequencyMHz       *float64    `json:"frequency_mhz"`
}

// LoadAverage is the run-queue length averaged over 1, 5 and 15 minutes.
type LoadAverage struct {
	One     float64 `json:"one"`
	Five    float64 `json:"five"`
	Fifteen float64 `json:"fifteen"`
}

// Memory holds RAM and swap usage. UsedBytes is TotalBytes - AvailableBytes.
type Memory struct {
	TotalBytes     uint64  `json:"total_bytes"`
	AvailableBytes uint64  `json:"available_bytes"`
	UsedBytes      uint64  `json:"used_bytes"`
	UsagePercent   Percent `json:"usage_percent"`
	SwapTotalBytes uint64  `json:"swap_total_bytes"`
	SwapUsedBytes  uint64  `json:"swap_used_bytes"`
}

// Filesystem holds capacity for one configured mountpoint. UsagePercent
// follows df(1): used / (used + available), so blocks reserved for root
// count as neither.
type Filesystem struct {
	Mountpoint     string  `json:"mountpoint"`
	TotalBytes     uint64  `json:"total_bytes"`
	UsedBytes      uint64  `json:"used_bytes"`
	AvailableBytes uint64  `json:"available_bytes"`
	UsagePercent   Percent `json:"usage_percent"`
}

// Interface holds traffic counters and rates for one network interface.
type Interface struct {
	Interface        string  `json:"interface"`
	RxBytesTotal     uint64  `json:"rx_bytes_total"`
	TxBytesTotal     uint64  `json:"tx_bytes_total"`
	RxBytesPerSecond float64 `json:"rx_bytes_per_second"`
	TxBytesPerSecond float64 `json:"tx_bytes_per_second"`
}

// Throttling is the decoded Raspberry Pi firmware throttle state. "Now"
// flags describe the current state; "Occurred" flags are sticky since boot.
type Throttling struct {
	Supported               bool    `json:"supported"`
	Raw                     *string `json:"raw"`
	UnderVoltageNow         bool    `json:"under_voltage_now"`
	FrequencyCappedNow      bool    `json:"frequency_capped_now"`
	ThrottledNow            bool    `json:"throttled_now"`
	SoftTempLimitNow        bool    `json:"soft_temp_limit_now"`
	UnderVoltageOccurred    bool    `json:"under_voltage_occurred"`
	FrequencyCappedOccurred bool    `json:"frequency_capped_occurred"`
	ThrottledOccurred       bool    `json:"throttled_occurred"`
	SoftTempLimitOccurred   bool    `json:"soft_temp_limit_occurred"`
}

// Percent is a value from 0 to 100. It keeps full precision in Go and is
// rounded to one decimal place when encoded as JSON.
type Percent float64

// MarshalJSON implements json.Marshaler.
func (p Percent) MarshalJSON() ([]byte, error) {
	return json.Marshal(math.Round(float64(p)*10) / 10)
}
