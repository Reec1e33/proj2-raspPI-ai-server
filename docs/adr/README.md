# Architecture decision records

Each record gives one design decision, the context of the decision, and its
consequences. Do not change an accepted record. If the decision changes, write
a new record that replaces it.

| ADR | Decision | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-go-host-agent.md) | Use Go for the host telemetry agent | Accepted | 2026-10-02 |
| [0002](0002-local-first-llm-fallback.md) | Use a local-first LLM fallback chain with circuit breakers | Accepted | 2026-10-02 |
| [0003](0003-docker-compose-single-node.md) | Use Docker Compose on a single node, not k3s | Accepted | 2026-10-02 |
| [0004](0004-grafana-alloy-for-logs.md) | Use Grafana Alloy, not Promtail, to ship logs | Accepted | 2026-10-02 |
| [0005](0005-bash-host-provisioning.md) | Use Bash, not Ansible, to provision the host | Accepted | 2026-10-02 |
| [0006](0006-basic-auth-and-api-key.md) | Use nginx basic auth at the gateway and an optional X-API-Key at the API | Accepted | 2026-10-02 |
| [0007](0007-server-sent-events.md) | Use Server-Sent Events for live telemetry and chat | Accepted | 2026-10-02 |

## Add a record

1. Copy the newest record to `NNNN-short-title.md` with the next number.
2. Write these sections: Context, Decision, Consequences.
3. Set the status to `Proposed`. Change it to `Accepted` when the code agrees.
4. Add a row to the table above.
