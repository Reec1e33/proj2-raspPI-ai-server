# ADR-0005: Use Bash, not Ansible, to provision the host

- Status: Accepted
- Date: 2026-10-02

## Context

The host needs SSH hardening, a firewall, fail2ban, automatic updates, a static
IP, dynamic DNS, journald limits, sysctl settings, Docker, and a systemd unit
for the stack. There's one host, and the setup runs on the Pi itself after the
first SSH login. Raspberry Pi OS Lite ships Bash, not Ansible. I wanted a dry
run, a second run that changes nothing, and no way for a bad SSH config to lock
me out of a Pi with no screen. Ansible covers the first two with `--check` and
its modules, but it needs installing plus a control node (or `ansible-pull` on
the Pi).

## Decision

Use Bash 4.4+ with a small helper library
([`common.sh`](../../infra/lib/common.sh)). `bootstrap.sh` runs numbered modules
(`modules/NN-name.sh`) and takes `--dry-run`, `--only`, `--skip`, and `--yes`.
`run` prints commands in a dry run and stops on failure with the exact command.
`install_file` only writes a file when its SHA-256 changes and keeps a backup
per run. `validate_or_restore` checks the new file (`sshd -t`,
`fail2ban-client --test`, `apt-config dump`, `dockerd --validate`) and puts the
old one back if the check fails. `verify.sh` audits everything without changing
anything.

## Consequences

- The Pi only needs Bash, coreutils, `git`, and `jq`, and the `base` module
  installs the last two.
- Every command that changes the system is right there to read.
- The dry-run and idempotency logic is my own code, so it needs its own tests:
  39 unit tests, an end-to-end run in Debian 12 and 13 containers with systemd,
  and ShellCheck at `-S style`.
- It doesn't scale past one host. For a fleet, use Ansible.
- Bash has its usual traps, like word splitting. `set -Eeuo pipefail` and
  ShellCheck catch most of them.
