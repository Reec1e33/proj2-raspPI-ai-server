# ADR-0001: Use Go for the host telemetry agent

- Status: Accepted
- Date: 2026-10-02

## Context

The dashboard, the chat prompt, and the alerts all need host data: CPU, memory,
disk, network, temperature, and the firmware throttle flags. Whatever collects
it shares the Pi with Ollama, Prometheus, and Grafana, so it has to be cheap. It
runs in a container and reads the host's `/proc` and `/sys` through read-only
mounts. It has to build for arm64, amd64, and arm/v7, and it has to run on a
laptop with no `/proc` for dev, CI, and screenshots.

v1 called psutil inside the Flask request handler and slept to measure CPU and
network rates, so every request took about 2 seconds. `node_exporter` was the
other obvious option, but it doesn't read the throttle state and has no JSON
snapshot for the API.

## Decision

Write a small agent, `pi-agent`, in Go (currently 1.27). The only direct
dependency is `prometheus/client_golang`. A background sampler reads everything
every 2 s and the HTTP handlers only serve the cached sample. Rates are deltas
between samples on the monotonic clock, clamped at zero
([`sample.go`](../../agent/internal/collector/sample.go)). The binary is static
and ships in `distroless/static-debian12:nonroot`, cross-compiled on
`$BUILDPLATFORM` so multi-arch builds don't need emulation. Demo mode emits raw
counters, so fake data goes through the same delta code as real data
([`demo.go`](../../agent/internal/demo/demo.go)).

## Consequences

- The image is about 4.2 MB. The agent used 8 MiB idle on the laptop stack
  (a Docker Desktop arm64 VM, not a Pi).
- The Pi-specific code is in one place, including the throttle fallback from
  sysfs to `vcgencmd` to the firmware mailbox
  ([`host.go`](../../agent/internal/collector/host.go)).
- It exports far fewer metrics than `node_exporter`, only what the dashboard
  and alerts use.
- One more language in the repo.
- The sysfs paths and the mailbox call are only tested against fixtures. None
  of it has run on real Pi hardware yet.
