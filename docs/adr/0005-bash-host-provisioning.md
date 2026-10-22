# ADR-0005: Use Bash, not Ansible, to provision the host

- Status: Accepted
- Date: 2026-10-02

## Context

The host needs SSH hardening, a firewall, fail2ban, automatic updates, a static
IP address, dynamic DNS, journald limits, sysctl values, Docker and a systemd
unit for the stack.

These are the constraints:

- There is one host. The operator runs the setup on the Pi, after the first SSH
  login.
- Raspberry Pi OS Lite has Bash. It does not have Ansible.
- The operator must see each change before it occurs (dry run).
- A second run must make no changes.
- A bad SSH configuration must not lock the operator out of a Pi that has no
  screen.

Ansible gives idempotent modules and a dry-run mode (`--check`). It also needs
an installation and a control node, or `ansible-pull` on the Pi.

## Decision

Use Bash 4.4 or later with a small helper library
([`common.sh`](../../infra/lib/common.sh)).

- `bootstrap.sh` runs numbered modules (`modules/NN-name.sh`). Options:
  `--dry-run`, `--only`, `--skip`, `--yes`.
- `run` prints each command in a dry run, and stops on a failure with the exact
  command.
- `install_file` writes a file only when its SHA-256 changes. It keeps a backup
  of the old file for each run.
- `validate_or_restore` tests the new file (`sshd -t`, `fail2ban-client --test`,
  `apt-config dump`, `dockerd --validate`). If the test fails, it puts back the
  old file.
- `verify.sh` audits each control without changes.
- ShellCheck (`-S style`), 37 unit tests and an end-to-end test in Debian 12 and
  13 containers with systemd check the code.

## Consequences

- The toolkit needs only Bash, coreutils, `git` and `jq` on the Pi. The `base`
  module installs `git` and `jq`.
- A reader sees each command that changes the system.
- The dry-run and idempotency logic is custom code. It needs its own tests
  (`infra/tests/run.sh`).
- The design does not scale to many hosts. For a fleet, Ansible is a better
  choice.
- Bash has known risks, for example word splitting. `set -Eeuo pipefail` and
  ShellCheck decrease these risks.
