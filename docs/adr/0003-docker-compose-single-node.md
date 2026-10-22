# ADR-0003: Use Docker Compose on a single node, not k3s

- Status: Accepted
- Date: 2026-10-02

## Context

PiCloud runs on one Raspberry Pi with 4 or 8 GB of RAM, and the stack is eight
services. v1 had Kubernetes manifests (`k8s/`) for a Deployment and a
LoadBalancer Service, but they pointed at a placeholder image and nothing used
them. k3s is the small option, but on one node it still brings a control plane,
a CNI plugin, and an ingress controller. That's memory the local LLM wants, for
a scheduler that only has one node to pick from.

## Decision

Use Docker Compose: one file for the Pi
([`docker-compose.yml`](../../deploy/docker-compose.yml)) and an override for a
laptop ([`docker-compose.dev.yml`](../../deploy/docker-compose.dev.yml)). Every
service gets `restart: unless-stopped`, memory and CPU limits, `cap_drop: [ALL]`,
`no-new-privileges`, and log rotation. All but Loki have a healthcheck (its
distroless image has nothing to run one with). A systemd unit
([`picloud.service`](../../infra/files/systemd/picloud.service)) starts the
stack at boot. Ollama is behind a Compose profile so a 4 GB Pi can leave it out.

## Consequences

- The whole stack is one file you can read in a few minutes, and the same file
  runs on a laptop with the agent in demo mode.
- No rolling updates. An update restarts whatever changed.
- If the Pi goes down, everything goes down.
- Docker's iptables rules for published ports come before UFW's. So only the
  gateway publishes public ports (80/443), Prometheus binds to
  `127.0.0.1:9090`, and `infra/verify.sh` warns about anything else exposed.
- If this ever needs a second node, the services map onto Kubernetes
  Deployments without much rework.
