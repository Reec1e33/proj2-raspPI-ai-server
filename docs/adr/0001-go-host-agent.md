# ADR-0001: Use Go for the host telemetry agent

- Status: Accepted
- Date: 2026-10-02

## Context

The dashboard, the chat prompt and the alerts need host data from the Pi: CPU,
memory, disk, network, temperature and the firmware throttle flags.

These are the constraints:

- The agent runs on the Pi next to Ollama, Prometheus and Grafana. It must use
  little memory and CPU.
- It runs in a container and reads the host `/proc` and `/sys` through
  read-only mounts.
- It must build for `linux/arm64`, and also for `linux/amd64` and
  `linux/arm/v7`.
- It must export Prometheus metrics and a JSON snapshot for the API.
- It must run on a laptop without `/proc`, for development, CI and screenshots.

Version 1 read psutil values in the Flask request path. Each request waited for
about 2 seconds, because the code slept to measure CPU and network rates.

These are the options:

1. Python and psutil inside the API.
2. Prometheus `node_exporter`, plus a textfile collector for the Pi data.
3. A small agent in Go.

`node_exporter` does not read the firmware throttle state, and it gives no JSON
snapshot for the API.

## Decision

Write `pi-agent` in Go (1.27 at present). The only direct dependency is
`prometheus/client_golang`.

- A background sampler reads the sources at a fixed interval (2 s). The HTTP
  endpoints serve only the cached sample.
- CPU usage and network rates are deltas between two samples. The code clamps
  each delta at zero and uses the monotonic clock
  ([`sample.go`](../../agent/internal/collector/sample.go)).
- The binary is static (`CGO_ENABLED=0`). The image is
  `gcr.io/distroless/static-debian12:nonroot`.
- The build stage runs on `$BUILDPLATFORM` and cross-compiles, so a multi-arch
  build needs no emulation.
- A demo source emits raw counters, so demo data goes through the same delta
  calculations as real data ([`demo.go`](../../agent/internal/demo/demo.go)).

## Consequences

- The agent image is about 4.2 MB. On the laptop stack, the agent used 8 MiB of
  memory at idle (measured on a Docker Desktop arm64 VM, not on a Pi).
- The Pi-specific logic is in one place. An example is the throttle fallback
  from sysfs to `vcgencmd` to the firmware mailbox
  ([`host.go`](../../agent/internal/collector/host.go)).
- The repository has one more language.
- The agent exports fewer host metrics than `node_exporter`. It exports only
  the metrics that the dashboard and the alerts use.
- Only fixture trees and unit tests check the sysfs paths and the mailbox call.
  No test ran on Pi hardware yet.
