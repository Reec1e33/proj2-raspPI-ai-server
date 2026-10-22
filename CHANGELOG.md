# Changelog

This file records the notable changes to PiCloud.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The version numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-21

Version 2 is a full rebuild of the project. No code from version 1 remains.

### Added

- `infra/`: a Bash toolkit that prepares and hardens the Raspberry Pi host.
  - 11 modules that you can run again safely: base, ssh, firewall, fail2ban,
    updates, network, ddns, logging, sysctl, docker and picloud.
  - `--dry-run`, a backup of each changed file, validation with rollback, and an
    SSH lockout guard.
  - `verify.sh`, a read-only audit that prints PASS, WARN, FAIL or SKIP for each control.
- `agent/`: `pi-agent`, a Go service that reads CPU, memory, disk, network,
  temperature and firmware throttle data. It serves the data as JSON and as
  Prometheus metrics. A demo mode gives synthetic Pi data on hosts without
  procfs.
- `api/`: a FastAPI service with these parts:
  - A system API and a Server-Sent Events (SSE) stream of the host telemetry.
  - An AI gateway with an ordered fallback chain (Ollama, Anthropic,
    OpenAI-compatible), retries, circuit breakers, a rate limit and an optional
    API key.
- `web/`: a React 19 dashboard with live charts, the throttle flags, a
  providers panel and an "Ask your Pi" chat.
- `deploy/`: a Docker Compose stack with these parts:
  - An nginx gateway with TLS, HTTP/2, basic auth and security headers.
  - Prometheus with 11 alert rules and unit tests for the rules.
  - A provisioned Grafana dashboard, Loki and Grafana Alloy.
  - Scripts for certificates, htpasswd, models, backups and a smoke test.
- Documentation: architecture, setup, security, operations and architecture
  decision records (`docs/`).
- A GitHub Actions workflow (`.github/workflows/ci.yml`).
- The MIT license.

### Changed

- Remote access: HTTPS on port 443 through the gateway. Version 1 used plain
  HTTP on ports 5000 and 3000.
- Dynamic DNS: the `ddns` module configures `ddclient` for No-IP or Cloudflare.
  Version 1 used a manual `noip2` setup.
- Telemetry: a Go agent reads `/proc` and `/sys` on a fixed interval. Version 1
  read psutil values in the request path, and each request waited for about
  2 seconds.

### Removed

- The Flask backend (`backend/`, `monitor/`). It ran the Flask debug server on
  `0.0.0.0:5000`, with CORS open to all origins.
- The Create React App frontend (`frontend/`). It called a hardcoded No-IP
  hostname over plain HTTP on port 5000.
- The unused Kubernetes manifests (`k8s/`). They named a placeholder image.
- Random placeholder values. Version 1 returned a random CPU temperature when
  `vcgencmd` was not available, and a simulated sensor value.
- The old Dockerfiles (`docker/`), the empty CI workflow, the empty files `CI`,
  `Example` and `file`, and committed `__pycache__` files.

## [1.0.0] - 2025-02-24

The first prototype, from January and February 2025.

### Added

- A Flask API with `GET /metrics`: CPU temperature from `vcgencmd`, CPU, RAM,
  disk and network use from psutil, and the uptime.
- A React dashboard (Create React App, Chart.js and Axios) that read the API
  every 5 seconds.
- Dockerfiles for the backend and the frontend.
- Kubernetes manifests (a Deployment and a Service) for the backend.
- Remote access through No-IP dynamic DNS.
