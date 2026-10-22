# pi-agent

`pi-agent` is the host telemetry agent of PiCloud. It reads CPU, memory, disk,
network, temperature, and firmware throttle data from a Raspberry Pi. It serves
this data as JSON for the PiCloud API and as Prometheus metrics. It is one
static Go binary.

The agent reads the host sources on a fixed interval and keeps the latest
sample in memory. The HTTP endpoints use only this cached sample. They do not
read the host sources.

## Endpoints

| Method and path    | Response                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `GET /healthz`     | `200 {"status":"ok"}`. `503` before the first sample, or if the latest sample is older than 3 intervals. |
| `GET /metrics`     | Prometheus text exposition.                                                               |
| `GET /v1/snapshot` | The latest sample as JSON. `503` before the first sample.                                 |

## Data sources

`<PROCFS>`, `<SYSFS>`, and `<ROOTFS>` are the configured mount paths.

| Data                     | Source                                                                       |
| ------------------------ | ---------------------------------------------------------------------------- |
| CPU usage, per-core usage | `<PROCFS>/stat`                                                             |
| Load average             | `<PROCFS>/loadavg`                                                           |
| Memory and swap          | `<PROCFS>/meminfo` (`MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree`)     |
| Uptime                   | `<PROCFS>/uptime`                                                            |
| Kernel                   | `<PROCFS>/sys/kernel/osrelease`                                              |
| Network                  | `<PROCFS>/1/net/dev`, else `<PROCFS>/net/dev`                                |
| Temperature              | `<SYSFS>/class/thermal/thermal_zone0/temp` (millidegrees Celsius)           |
| CPU frequency            | `<SYSFS>/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq` (kHz)             |
| Throttle state           | `<SYSFS>/devices/platform/soc/soc:firmware/get_throttled`, else `vcgencmd get_throttled`, else `get_throttled` through the firmware mailbox (`/dev/vcio_gencmd` or `/dev/vcio`) |
| Board model              | `<SYSFS>/firmware/devicetree/base/model`                                     |
| OS name                  | `PRETTY_NAME` in `<ROOTFS>/etc/os-release`, else `<ROOTFS>/usr/lib/os-release` |
| Hostname                 | `<ROOTFS>/etc/hostname`, else the hostname of the process                    |
| Filesystems              | `statfs` on each mountpoint in `PI_AGENT_MOUNTS`, under `<ROOTFS>`          |

Rules:

- `/proc/net` shows the network namespace of the process that reads it. In a
  container, `<PROCFS>/1/net/dev` shows the network of the host.
- The agent does not report the `lo`, `docker*`, `veth*`, and `br-*`
  interfaces.
- Some device trees give the `soc` node a unit address, for example
  `soc@107c000000`. If the `get_throttled` path above does not exist, the agent
  also tries `<SYSFS>/devices/platform/*/*:firmware/get_throttled`.
- Raspberry Pi kernels 6.12 and later do not have the `get_throttled` file. On
  these kernels, the agent runs `vcgencmd get_throttled` if `vcgencmd` is on
  `PATH`. If not, the agent sends the same command to the firmware through the
  mailbox device, as `vcgencmd` does. It tries `/dev/vcio_gencmd` first, then
  `/dev/vcio`.
- If a source does not exist, the related JSON value is `null`, or
  `throttling.supported` is `false`. The agent does not export the related
  metric. It does not export a zero in place of an unknown value.
- If a source exists but the agent cannot read or parse it, the agent
  increments `pi_agent_collect_errors_total{collector}`. It writes one `warn`
  log when a collector starts to fail, and one `info` log when it recovers.
- A configured mountpoint that does not exist is an error of the `filesystem`
  collector. It is not an unsupported source.

## Snapshot JSON

All keys are always present. Abbreviated example:

```json
{
  "hostname": "picloud",
  "collected_at": "2026-10-02T12:00:00.123Z",
  "uptime_seconds": 90922.47,
  "platform": { "model": "Raspberry Pi 5 Model B Rev 1.0", "os": "Debian GNU/Linux 12 (bookworm)", "kernel": "6.6.51+rpt-rpi-2712", "arch": "arm64" },
  "cpu": { "cores": 4, "usage_percent": 12.3, "per_core_percent": [10.1, 14.0, 9.8, 15.2],
           "load_average": { "one": 0.42, "five": 0.35, "fifteen": 0.3 },
           "temperature_celsius": 51.25, "frequency_mhz": 2400 },
  "memory": { "total_bytes": 8443211776, "available_bytes": 6000000000, "used_bytes": 2443211776,
              "usage_percent": 28.9, "swap_total_bytes": 536866816, "swap_used_bytes": 12582912 },
  "filesystems": [{ "mountpoint": "/", "total_bytes": 62101032960, "used_bytes": 19251321719,
                    "available_bytes": 39744659592, "usage_percent": 32.6 }],
  "network": [{ "interface": "eth0", "rx_bytes_total": 9876543210, "tx_bytes_total": 1234567890,
                "rx_bytes_per_second": 2048.0, "tx_bytes_per_second": 512.0 }],
  "throttling": { "supported": true, "raw": "0x50005",
                  "under_voltage_now": true, "frequency_capped_now": false, "throttled_now": true, "soft_temp_limit_now": false,
                  "under_voltage_occurred": true, "frequency_capped_occurred": false, "throttled_occurred": true, "soft_temp_limit_occurred": false }
}
```

Value rules:

- All `usage_percent` values are from 0 to 100, with one decimal place.
- CPU usage and network rates are deltas between two samples. The first sample
  after start shows the average CPU usage since boot, and network rates of 0.
- If a counter decreases (wrap or reset), the rate for that interval is 0. A
  rate is never negative.
- `memory.used_bytes` is `total_bytes - available_bytes`.
- Filesystem `usage_percent` is `used / (used + available)`, as in `df`. Blocks
  that the filesystem keeps for root are not in either value.
- `collected_at` is UTC with millisecond precision.

Throttle bits from the firmware:

| Bit | Flag (now)             | Bit | Flag (since boot)           |
| --- | ---------------------- | --- | --------------------------- |
| 0   | `under_voltage_now`    | 16  | `under_voltage_occurred`    |
| 1   | `frequency_capped_now` | 17  | `frequency_capped_occurred` |
| 2   | `throttled_now`        | 18  | `throttled_occurred`        |
| 3   | `soft_temp_limit_now`  | 19  | `soft_temp_limit_occurred`  |

## Configuration

Each flag has an environment variable. A flag on the command line overrides
the environment variable.

| Flag         | Environment variable | Default | Description                                                         |
| ------------ | -------------------- | ------- | ------------------------------------------------------------------- |
| `-listen`    | `PI_AGENT_LISTEN`    | `:9110` | HTTP listen address.                                                |
| `-procfs`    | `PI_AGENT_PROCFS`    | `/proc` | Mount path of procfs.                                               |
| `-sysfs`     | `PI_AGENT_SYSFS`     | `/sys`  | Mount path of sysfs.                                                |
| `-rootfs`    | `PI_AGENT_ROOTFS`    | `/`     | Mount path of the host root filesystem.                             |
| `-mounts`    | `PI_AGENT_MOUNTS`    | `/`     | Comma-separated list of absolute mountpoints. The agent resolves each one under the root filesystem path, and reports the host path. It removes trailing slashes and duplicate entries. |
| `-interval`  | `PI_AGENT_INTERVAL`  | `2s`    | Sample interval. The minimum is `100ms`.                            |
| `-demo`      | `PI_AGENT_DEMO`      | `false` | Serve synthetic Raspberry Pi data. See [Demo mode](#demo-mode).     |
| `-log-level` | `PI_AGENT_LOG_LEVEL` | `info`  | `debug`, `info`, `warn`, or `error`. Logs are JSON lines on stdout. |
| `-version`   |                      |         | Print the version and exit.                                         |

## Metrics

| Metric                            | Type    | Labels                  | Description                                    |
| --------------------------------- | ------- | ----------------------- | ---------------------------------------------- |
| `pi_cpu_usage_ratio`              | gauge   |                         | CPU busy time in the last interval, 0 to 1.    |
| `pi_cpu_temperature_celsius`      | gauge   |                         | SoC temperature.                               |
| `pi_cpu_frequency_hertz`          | gauge   |                         | Clock speed of CPU 0.                          |
| `pi_load_average`                 | gauge   | `window` = `1m`, `5m`, `15m` | Load average.                             |
| `pi_memory_total_bytes`           | gauge   |                         | Total usable RAM.                              |
| `pi_memory_available_bytes`       | gauge   |                         | `MemAvailable`.                                |
| `pi_swap_total_bytes`             | gauge   |                         | Total swap.                                    |
| `pi_swap_used_bytes`              | gauge   |                         | Swap in use.                                   |
| `pi_filesystem_size_bytes`        | gauge   | `mountpoint`            | Filesystem size.                               |
| `pi_filesystem_avail_bytes`       | gauge   | `mountpoint`            | Space available to users that are not root.    |
| `pi_filesystem_used_bytes`        | gauge   | `mountpoint`            | Space in use.                                  |
| `pi_network_receive_bytes_total`  | counter | `interface`             | Bytes received.                                |
| `pi_network_transmit_bytes_total` | counter | `interface`             | Bytes sent.                                    |
| `pi_throttled`                    | gauge   | `condition`, `scope`    | 1 if the flag is set, else 0. `condition` = `under_voltage`, `frequency_capped`, `throttled`, `soft_temp_limit`. `scope` = `now`, `occurred`. |
| `pi_uptime_seconds`               | gauge   |                         | Time since boot.                               |
| `pi_agent_build_info`             | gauge   | `version`, `go_version` | Always 1.                                      |
| `pi_agent_collect_errors_total`   | counter | `collector`             | Failed reads per collector.                    |

The agent also exports the standard `go_*` and `process_*` metrics.

## Run modes

### Host mode

Run the binary on the Pi. The defaults read `/proc`, `/sys`, and `/`.

```sh
make build
./bin/pi-agent -mounts /,/boot/firmware
```

If procfs is not readable, the agent stops with an error. On a host without
procfs, use demo mode.

### Container mode

The Docker Compose stack in `deploy/` uses this mode. The image is
`ghcr.io/reec1e33/picloud-agent`. To build it locally:

```sh
make docker VERSION=dev   # image picloud-agent:dev
```

Give the container read-only access to the pseudo-filesystems and the root
filesystem of the host:

```sh
docker run -d --name pi-agent \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro \
  -e PI_AGENT_PROCFS=/host/proc -e PI_AGENT_SYSFS=/host/sys -e PI_AGENT_ROOTFS=/host/root \
  picloud-agent:dev
```

The agent does not need `--pid host` (`pid: host` in Compose), and the Compose
stack does not use it. The bind mount gives the procfs of the host. This procfs
finds each PID in the PID namespace of the host. Thus `/host/proc/1` is the init
process of the host, and `/host/proc/1/net/dev` shows the network of the host.
The UID of the agent (65532) can read this file.

The image has no `vcgencmd`. On a Raspberry Pi with kernel 6.12 or later, the
agent needs a mailbox device for the throttle state. Give the container the
device and its group. Use `/dev/vcio_gencmd` if it exists, else `/dev/vcio`:

```sh
--device /dev/vcio_gencmd --group-add "$(stat -c %g /dev/vcio_gencmd)"
```

The agent runs as a non-root user, so the device must allow access for its
group. Use `ls -l /dev/vcio*` to examine the mode. Docker does not start the
container if the device does not exist. Without a device,
`throttling.supported` is `false` and the agent does not export `pi_throttled`.
The device gives the container access to firmware commands. The agent sends
only `get_throttled`.

The final image is `gcr.io/distroless/static-debian12:nonroot`. It has no shell
and runs as a non-root user. The image `HEALTHCHECK` runs `pi-agent
healthcheck`. This command sends `GET /healthz` to the address in
`PI_AGENT_LISTEN` and exits with 0 if the status is 200, else with 1.

### Demo mode

Demo mode does not read the host. It synthesizes data for a Raspberry Pi 5
with 8 GB of RAM. Use it on macOS, in CI, and for screenshots.

```sh
make run-demo          # same as: go run ./cmd/pi-agent -demo -listen 127.0.0.1:9110
curl -s localhost:9110/v1/snapshot
```

The demo data changes smoothly over time:

- CPU load follows a slow wave. Short bursts of high load occur about every 4
  minutes, as when a local LLM writes a reply.
- The temperature follows the CPU load. It stays from 45 °C to 70 °C.
- The CPU clock is 1500 MHz at low load and 2400 MHz at high load.
- `eth0` traffic has short download bursts.
- A brief under-voltage event occurs about every 30 minutes. The soft
  temperature limit flag is set at 65 °C or more. The "occurred" flags stay
  set.

The demo source emits raw counters, as the host source does. Thus the demo data
goes through the same delta calculations as real data.

## Development

You need Go 1.25 or later.

| Command      | Action                                                         |
| ------------ | -------------------------------------------------------------- |
| `make test`  | Run the tests with the race detector and show coverage.        |
| `make lint`  | Run `gofmt`, `go vet`, and `staticcheck`.                      |
| `make cross` | Compile for `linux/arm64` and `linux/arm` (ARMv7).             |
| `make build` | Build `bin/pi-agent`. Set `VERSION` to change the version string. |
| `make docker`| Build the container image for this machine.                    |

The tests use fixture trees in `internal/collector/testdata/`:

- `pi5`: a Raspberry Pi 5 with all sources.
- `minimal`: a generic Linux host with procfs only.

A test creates the `get_throttled` fixture at run time. Go module archives do
not accept `:` in file names, so the repository cannot contain the
`soc:firmware` directory.

Code layout:

```text
cmd/pi-agent/         flags, logging, HTTP server, healthcheck subcommand
internal/collector/   procfs/sysfs parsers, Host source, Sampler, snapshot types
internal/demo/        synthetic Raspberry Pi 5 source
internal/exporter/    Prometheus collector
internal/server/      HTTP routes
```
