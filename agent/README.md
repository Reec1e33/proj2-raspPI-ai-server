# pi-agent

A small Go service that reads CPU, memory, disk, network, temperature and
firmware throttle state from a Raspberry Pi, and serves it as JSON (for the API)
and as Prometheus metrics. It's a single static binary.

A background loop samples the host every interval and keeps the latest result
in memory. The HTTP handlers only ever read that cached sample, so a scrape
never touches `/proc` or `/sys`.

## Running it

You need Go 1.27 or later.

On a Pi, just build and run it. The defaults read `/proc`, `/sys` and `/`:

```sh
make build
./bin/pi-agent -mounts /,/boot/firmware
```

Anywhere else (macOS, CI), use demo mode. It makes up plausible Pi 5 data with
load bursts, a temperature that follows the load, and the occasional
under-voltage event:

```sh
make run-demo     # go run ./cmd/pi-agent -demo -listen 127.0.0.1:9110
curl -s localhost:9110/v1/snapshot
```

The demo source emits raw counters like the real one, so it goes through the
same rate calculations.

### In a container

This is how the Compose stack in [`deploy/`](../deploy/) runs it. The image is
`ghcr.io/reec1e33/picloud-agent`; `make docker VERSION=dev` builds
`picloud-agent:dev` locally. Mount the host's pseudo-filesystems read-only and
point the agent at them:

```sh
docker run -d --name pi-agent \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro \
  -e PI_AGENT_PROCFS=/host/proc -e PI_AGENT_SYSFS=/host/sys -e PI_AGENT_ROOTFS=/host/root \
  --device /dev/vcio --group-add "$(stat -c %g /dev/vcio)" \
  picloud-agent:dev
```

The `--device` part is for throttle state on newer kernels (see below). Use
`/dev/vcio_gencmd` instead if your Pi has it. Docker refuses to start if the
device doesn't exist, so leave the flag off on a non-Pi host.

The image is `distroless/static-debian12:nonroot`: no shell, non-root user. Its
`HEALTHCHECK` runs `pi-agent healthcheck`, which hits `/healthz` on
`PI_AGENT_LISTEN` and exits 0 or 1.

## Configuration

Each flag except `-version` has an environment variable. The flag wins if both
are set.

| Flag         | Variable             | Default | Notes                                              |
| ------------ | -------------------- | ------- | -------------------------------------------------- |
| `-listen`    | `PI_AGENT_LISTEN`    | `:9110` | HTTP listen address                                |
| `-procfs`    | `PI_AGENT_PROCFS`    | `/proc` | Where procfs is mounted                            |
| `-sysfs`     | `PI_AGENT_SYSFS`     | `/sys`  | Where sysfs is mounted                             |
| `-rootfs`    | `PI_AGENT_ROOTFS`    | `/`     | Where the host root filesystem is mounted          |
| `-mounts`    | `PI_AGENT_MOUNTS`    | `/`     | Comma-separated mountpoints to report, as host paths |
| `-interval`  | `PI_AGENT_INTERVAL`  | `2s`    | Sample interval, minimum `100ms`                   |
| `-demo`      | `PI_AGENT_DEMO`      | `false` | Serve synthetic data                               |
| `-log-level` | `PI_AGENT_LOG_LEVEL` | `info`  | `debug`, `info`, `warn` or `error`; JSON to stdout |
| `-version`   |                      |         | Print the version and exit                         |

## Endpoints

| Path               | Returns                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `GET /healthz`     | `200 {"status":"ok"}`, or `503` before the first sample or once the latest is older than 3 intervals |
| `GET /metrics`     | Prometheus metrics                                                      |
| `GET /v1/snapshot` | The latest sample as JSON, or `503` before the first one                |

The snapshot always has every key. A value the host can't provide (no thermal
zone, say) is `null`, and throttling has `"supported": false`. The struct
definitions are in
[`snapshot.go`](internal/collector/snapshot.go). Abbreviated:

```json
{
  "hostname": "picloud",
  "collected_at": "2026-10-02T12:00:00.123Z",
  "uptime_seconds": 90922.47,
  "platform": { "model": "Raspberry Pi 5 Model B Rev 1.0", "os": "Debian GNU/Linux 12 (bookworm)", "kernel": "6.6.51+rpt-rpi-2712", "arch": "arm64" },
  "cpu": { "cores": 4, "usage_percent": 12.3, "temperature_celsius": 51.25, "frequency_mhz": 2400, "...": "..." },
  "memory": { "total_bytes": 8443211776, "available_bytes": 6000000000, "...": "..." },
  "filesystems": [{ "mountpoint": "/", "usage_percent": 32.6, "...": "..." }],
  "network": [{ "interface": "eth0", "rx_bytes_per_second": 2048.0, "...": "..." }],
  "throttling": { "supported": true, "raw": "0x50005", "under_voltage_now": true, "throttled_occurred": true, "...": "..." }
}
```

## Metrics

| Metric                            | Labels                    |
| --------------------------------- | ------------------------- |
| `pi_cpu_usage_ratio`              |                           |
| `pi_cpu_temperature_celsius`      |                           |
| `pi_cpu_frequency_hertz`          |                           |
| `pi_load_average`                 | `window` (`1m`, `5m`, `15m`) |
| `pi_memory_total_bytes`           |                           |
| `pi_memory_available_bytes`       |                           |
| `pi_swap_total_bytes`             |                           |
| `pi_swap_used_bytes`              |                           |
| `pi_filesystem_size_bytes`        | `mountpoint`              |
| `pi_filesystem_avail_bytes`       | `mountpoint`              |
| `pi_filesystem_used_bytes`        | `mountpoint`              |
| `pi_network_receive_bytes_total`  | `interface`               |
| `pi_network_transmit_bytes_total` | `interface`               |
| `pi_throttled`                    | `condition`, `scope` (`now`, `occurred`) |
| `pi_uptime_seconds`               |                           |
| `pi_agent_build_info`             | `version`, `go_version`   |
| `pi_agent_collect_errors_total`   | `collector`               |

Plus the standard `go_*` and `process_*` metrics. `pi_throttled` conditions are
`under_voltage`, `frequency_capped`, `throttled` and `soft_temp_limit`.

## Development

```sh
make test     # race detector + coverage
make lint     # gofmt, go vet, staticcheck
make cross    # check linux/arm64 and linux/arm (ARMv7) compile
```

Collector tests run against fixture trees in `internal/collector/testdata/`:
`pi5` (everything present) and `minimal` (a plain Linux box with only procfs).
The `get_throttled` fixture is created at test time, because Go module zips
can't contain a `:` in a path and the real directory is `soc:firmware`.

## Design notes

- **Unknown is not zero.** If a source doesn't exist, the metric is left out
  instead of exported as 0. A source that exists but fails to parse bumps
  `pi_agent_collect_errors_total` and logs once when it starts failing and once
  when it recovers.
- **Throttle state has three fallbacks.** Raspberry Pi kernels 6.12+ dropped
  the sysfs `get_throttled` file, and the image has no `vcgencmd`. So the agent
  tries sysfs first, then `vcgencmd` if it's on `PATH`, then sends
  `get_throttled` straight to the firmware mailbox (`/dev/vcio_gencmd`, then
  `/dev/vcio`) with the same ioctl `vcgencmd` uses. That's the only firmware
  command it sends. See [`mailbox_linux.go`](internal/collector/mailbox_linux.go).
- **No `pid: host`.** `/proc/net` shows the network of whoever reads it, which
  in a container is the container. But a bind-mounted host `/proc` resolves
  PIDs in the host's namespace, so `<procfs>/1/net/dev` is the host's network,
  and the non-root agent can read it. The agent skips `lo`, `docker*`, `veth*`
  and `br-*`.
- **Rates come from deltas.** CPU usage and network rates compare two samples.
  The first sample after start shows CPU averaged since boot and zero network
  rates. A counter that goes backwards gives a rate of 0, never a negative one.
