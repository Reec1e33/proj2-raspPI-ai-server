# ADR-0003: Use Docker Compose on a single node, not k3s

- Status: Accepted
- Date: 2026-10-02

## Context

PiCloud runs on one Raspberry Pi with 4 GB or 8 GB of RAM. The stack has eight
services.

Version 1 had Kubernetes manifests (`k8s/`) for a Deployment and a
`LoadBalancer` Service. They named a placeholder image, and the project did not
use them.

k3s is a small Kubernetes distribution. On one node, it adds a control plane, a
container network plugin and an ingress controller. These parts use memory that
the local LLM needs. A single node also gets no benefit from the scheduler.

## Decision

Use Docker Compose with one file for the Pi
([`docker-compose.yml`](../../deploy/docker-compose.yml)) and one override for a
laptop ([`docker-compose.dev.yml`](../../deploy/docker-compose.dev.yml)).

- Each service has a healthcheck (Loki excepted), `restart: unless-stopped`,
  a memory limit and a CPU limit.
- Each service has `cap_drop: [ALL]`, `no-new-privileges` and log rotation.
- The systemd unit `picloud.service` starts the stack at boot
  ([`picloud.service`](../../infra/files/systemd/picloud.service)).
- Ollama is in a Compose profile, so a 4 GB Pi can run without it.

## Consequences

- One file describes the full stack. A reader can review it in a few minutes.
- The same file runs on a laptop, with the agent in demo mode.
- There are no rolling updates. An update restarts the changed containers.
- No scheduler moves services to another node. If the Pi stops, the stack stops.
- Docker writes its own iptables rules for published ports. These rules come
  before the UFW rules. Thus the stack publishes only ports 80 and 443, and
  `infra/verify.sh` warns about any other published port.
- If the project needs more than one node later, the Compose services map
  directly to Kubernetes Deployments.
