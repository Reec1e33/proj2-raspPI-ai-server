# ADR-0004: Use Grafana Alloy, not Promtail, to ship logs

- Status: Accepted
- Date: 2026-10-02

## Context

The stack sends logs to Loki from three sources:

- The Docker containers of the stack (JSON logs from nginx, the API and the
  agent).
- The systemd journal of the host (sshd, the kernel and UFW, Docker).
- `/var/log/fail2ban.log`. fail2ban writes its bans to this file, not to the
  journal.

Promtail was the usual log agent for Loki. Grafana Labs deprecated Promtail and
names Grafana Alloy as its replacement. Promtail is at end of life.

## Decision

Use Grafana Alloy (`grafana/alloy:v1.20.1`)
([`config.alloy`](../../deploy/alloy/config.alloy)).

- `discovery.docker` and `loki.source.docker` read the container logs. A filter
  in the Docker API keeps only the containers of the `picloud` Compose project.
- `loki.source.journal` reads the host journal. Labels: `unit` (only
  `.service` units), `syslog_identifier` and `level`.
- `loki.source.file` reads the fail2ban log.
- A `stage.drop` step drops lines older than 168 hours. Loki rejects such
  lines.

## Consequences

- The log agent has vendor support, and `alloy validate` checks the
  configuration.
- Alloy can also collect metrics or traces later, with no new agent.
- Alloy needs the Docker socket. Access to the socket is equal to root access on
  the host. [docs/security.md](../security.md) gives the risk and the
  mitigations.
- Alloy runs as root in the container, with no capabilities, so that it can
  read the journal and the socket.
- Alloy has a memory limit of 256 MiB. On the laptop stack it used 94 MiB at
  idle (measured on a Docker Desktop arm64 VM).
