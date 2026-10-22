# Changelog

Notable changes to PiCloud. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-21

A full rebuild. None of the v1 code is left.

### Added

- `infra/`: Bash scripts that set up and harden the Pi. 11 re-runnable modules
  (base, ssh, firewall, fail2ban, updates, network, ddns, logging, sysctl,
  docker, picloud), with `--dry-run`, per-run backups, validate-and-rollback,
  and an SSH lockout guard.
- `infra/verify.sh`: a read-only audit that prints PASS, WARN, FAIL, or SKIP
  for each control.
- `agent/`: `pi-agent`, a Go service for CPU, memory, disk, network,
  temperature, and firmware throttle data, served as JSON and Prometheus
  metrics. Demo mode fakes Pi data on machines without procfs.
- `api/`: FastAPI with a system API and an SSE telemetry stream.
- `api/`: an AI gateway that falls back from Ollama to Anthropic to any
  OpenAI-compatible API, with retries, circuit breakers, a rate limit, and an
  optional API key.
- `web/`: a React 19 dashboard with live charts, throttle flags, a providers
  panel, and an "Ask your Pi" chat.
- `deploy/`: a Docker Compose stack with an nginx gateway (TLS, HTTP/2, basic
  auth, security headers), Prometheus with 11 tested alert rules, a provisioned
  Grafana dashboard, Loki, and Grafana Alloy.
- `deploy/scripts/`: certificates, htpasswd, model pulls, backups, and a smoke
  test.
- Docs in `docs/`: architecture, setup, security, operations, and ADRs.
- CI on GitHub Actions (`.github/workflows/ci.yml`).
- MIT license.

### Changed

- Remote access is HTTPS on 443 through the gateway, not plain HTTP on 5000
  and 3000.
- Dynamic DNS is `ddclient` (No-IP or Cloudflare) set up by the `ddns` module,
  not a hand-configured `noip2`.
- Telemetry is sampled in the background every 2 s, so requests no longer wait
  about 2 seconds on psutil.
- The agent targets Go 1.27.

### Removed

- The Flask backend (`backend/`, `monitor/`), which ran the debug server on
  `0.0.0.0:5000` with CORS open to everyone.
- The Create React App frontend (`frontend/`), which called a hardcoded No-IP
  hostname over plain HTTP.
- The unused Kubernetes manifests (`k8s/`), which pointed at a placeholder
  image.
- Fake values: v1 returned a random CPU temperature when `vcgencmd` was
  missing, plus a simulated sensor reading.
- The old `docker/` Dockerfiles, the empty CI workflow, the empty `CI`,
  `Example`, and `file` files, and committed `__pycache__`.

### Security

- The agent container no longer runs with `pid: host`. The read-only `/proc`
  mount already gives it the host's view.
- Every container drops all capabilities and runs with `no-new-privileges`.

## [1.0.0] - 2025-02-24

The first prototype, built in January and February 2025.

### Added

- A Flask API with `GET /metrics`: CPU temperature from `vcgencmd`, CPU, RAM,
  disk, and network use from psutil, and uptime.
- A React dashboard (Create React App, Chart.js, Axios) that polled the API
  every 5 seconds.
- Dockerfiles for the backend and frontend.
- Kubernetes manifests (a Deployment and a Service) for the backend.
- Remote access through No-IP dynamic DNS.
