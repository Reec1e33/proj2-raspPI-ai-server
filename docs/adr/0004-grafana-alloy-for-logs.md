# ADR-0004: Use Grafana Alloy, not Promtail, to ship logs

- Status: Accepted
- Date: 2026-10-02

## Context

Loki gets logs from three places: the stack's own containers (JSON logs from
nginx, the API, and the agent), the host's systemd journal (sshd, the kernel,
UFW, Docker), and `/var/log/fail2ban.log`, because fail2ban writes its bans to
a file and not the journal. Promtail used to be the default shipper for Loki,
but Grafana deprecated it in favour of Alloy and it's now end of life.

## Decision

Use Grafana Alloy (`grafana/alloy:v1.20.1`,
[`config.alloy`](../../deploy/alloy/config.alloy)).
`loki.source.docker` reads container logs, with a Docker API filter so only
containers from the `picloud` Compose project get through.
`loki.source.journal` reads the journal and labels it with `unit` (`.service`
units only), `syslog_identifier`, and `level`. `loki.source.file` picks up the
fail2ban log. A `stage.drop` step throws away lines older than 168 hours,
because Loki rejects them anyway.

## Consequences

- The shipper is supported, and `alloy validate` catches config mistakes.
- Alloy can collect metrics or traces later without adding another agent.
- It needs the Docker socket, which is root on the host in all but name.
  [docs/security.md](../security.md) covers the risk and what limits it.
- It runs as root in the container (with no capabilities) so it can read the
  journal and the socket.
- Memory limit is 256 MiB. It used 94 MiB idle on the laptop stack (Docker
  Desktop arm64 VM).
