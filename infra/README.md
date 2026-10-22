# infra

Bash scripts that take a fresh 64-bit Raspberry Pi OS install and get it ready
for the PiCloud stack: hardened SSH, a firewall, automatic updates, Docker, and
a systemd unit that starts the stack at boot. `bootstrap.sh` applies the
changes and `verify.sh` audits them afterwards.

Each step is a module that only changes something when the current state is
wrong, so a second run on a good host makes no changes. These scripts have only
run in Debian 12 and 13 containers so far, not on a real Pi.

## Usage

You need a Pi 4 or 5 on 64-bit Raspberry Pi OS or plain Debian 12/13 (arm64),
Bash 4.4+, a non-root user with `sudo`, and an SSH key on your own machine.

```sh
sudo git clone https://github.com/Reec1e33/proj2-raspPI-ai-server.git /opt/picloud
cd /opt/picloud/infra
sudo cp config.env.example config.env && sudo chmod 600 config.env
sudo nano config.env                    # set ADMIN_USER at least
```

Get your key onto the Pi with `ssh-copy-id <user>@<pi-address>` or put it in
`SSH_AUTHORIZED_KEY`, then:

```sh
sudo ./bootstrap.sh --dry-run    # show every command and file change
sudo ./bootstrap.sh
sudo ./verify.sh
```

Keep your current SSH session open until a new one works. If the new login
fails with `Too many authentication failures`, your agent is offering more keys
than `MaxAuthTries 3` allows; use `ssh -o IdentitiesOnly=yes -i <key> ...`. If
the summary says `reboot: required`, reboot.

| Option | Effect |
| --- | --- |
| `-n`, `--dry-run` | Print the changes and commands, change nothing |
| `-y`, `--yes` | Don't ask for confirmation (needed without a terminal) |
| `--only a,b` / `--skip a,b` | Run only these modules, or all except these |
| `-c`, `--config FILE` | Use another config file |
| `-l`, `--list` | List the selected modules and exit |

For example: `sudo ./bootstrap.sh --only ssh,firewall --dry-run`.

## Modules

They run in this order.

| Module | What it does |
| --- | --- |
| `base` | `apt-get full-upgrade`, installs `ca-certificates`, `curl`, `git`, `jq`, sets time zone, host name and NTP |
| `ssh` | Key-only login for `ADMIN_USER`, no root, modern algorithms only (filtered against `ssh -Q`) |
| `firewall` | UFW: deny inbound, rate-limit SSH, allow 80/443, open `LAN_ALLOW_PORTS` to `LAN_CIDR` only |
| `fail2ban` | sshd jail on the journal: 5 failures in 10 minutes bans for 1h, doubling up to 4 weeks, plus a recidive jail |
| `updates` | Daily unattended-upgrades for the Debian, Raspberry Pi and Docker archives. Reboots at `AUTO_REBOOT_TIME` when an update needs it |
| `network` | Static IPv4 through NetworkManager. Skipped if `STATIC_IP_CIDR` is empty |
| `ddns` | ddclient for No-IP or Cloudflare. Skipped if `DDNS_PROVIDER` is empty |
| `logging` | Persistent journal capped at 200 MB and 2 weeks, optional log2ram |
| `sysctl` | Kernel and network hardening. IP forwarding stays on for Docker |
| `docker` | Docker Engine and the compose plugin from `download.docker.com`, `daemon.json` with log rotation, `live-restore` and `no-new-privileges`, AppArmor tools if the kernel has AppArmor |
| `picloud` | `picloud.service`, which runs `docker compose up -d` in `PICLOUD_DIR/deploy` at boot |

## Configuration

`config.env`, copied from `config.env.example`. Values shown are the ones in the
example file.

| Key | Value | Notes |
| --- | --- | --- |
| `ADMIN_USER` | required | The only user allowed in over SSH. Also joins the `docker` group |
| `SSH_AUTHORIZED_KEY` | empty | One public key, added before password login is turned off |
| `PI_HOSTNAME`, `TIMEZONE` | `picloud`, `Etc/UTC` | |
| `SSH_PORT` | `22` | |
| `LAN_CIDR`, `LAN_ALLOW_PORTS` | `192.168.1.0/24`, empty | e.g. `LAN_ALLOW_PORTS="9100/tcp 5353/udp"`. Rules are only added, never removed |
| `AUTO_REBOOT`, `AUTO_REBOOT_TIME` | `true`, `04:00` | |
| `UPGRADE_MAIL` | empty | Mails errors; needs an MTA such as `msmtp-mta` |
| `UPGRADE_DOCKER` | `true` | Include Docker Engine in unattended upgrades |
| `NET_IFACE` | `eth0` | |
| `STATIC_IP_CIDR`, `STATIC_GATEWAY`, `STATIC_DNS` | empty, empty, `1.1.1.1 9.9.9.9` | Empty `STATIC_IP_CIDR` keeps DHCP |
| `DDNS_PROVIDER` | empty | `noip` or `cloudflare` |
| `DDNS_HOSTNAME`, `DDNS_LOGIN`, `DDNS_PASSWORD`, `DDNS_ZONE` | empty | No-IP needs a login. Cloudflare needs a zone and an API token as the password |
| `LOG2RAM_ENABLE`, `LOG2RAM_SIZE` | `false`, `256M` | |
| `PICLOUD_DIR` | `/opt/picloud` | |

`bootstrap.sh` sources this file as root, so it refuses to run if root doesn't
own it or anyone else can write to it.

## verify.sh

A read-only audit of everything above. Each check prints PASS, WARN, FAIL or
SKIP; SKIP means the control is off or not configured. It exits 1 if anything
fails. `--quick` skips the slow `unattended-upgrade --dry-run`. As a normal
user it uses `sudo -n` where it needs root, and reports WARN if it can't.

It also checks the stack side: that only 80/443 are published on all
interfaces, and that the agent's mailbox device from `deploy/.env`
(`PI_AGENT_MAILBOX_DEVICE`, default `/dev/vcio`) exists and is readable by the
`video` group. A missing device is a FAIL, because Docker won't start the agent
without it. See [deploy/README.md](../deploy/README.md#throttle-state).

## Notes

The `ssh` module won't turn off password login until `ADMIN_USER` has a key
that `ssh-keygen` can parse. Changed sshd, fail2ban, APT and Docker configs are
validated (`sshd -t`, `fail2ban-client --test`, `apt-config dump`,
`dockerd --validate`) and rolled back if that fails. Replaced files are backed
up to `/var/backups/picloud/<run-id>/`. `--dry-run` hides the contents of files
that aren't world-readable, since they can hold secrets.

Changing `SSH_PORT` opens the new port in UFW before sshd reloads. The port 22
rule stays until you delete it, once a session on the new port works.

The static IP is applied by a transient systemd timer 10 seconds after the run
ends, so the change can't cut off the SSH session running the script. If a run
dies before that, the next run applies it.

Docker Engine comes from `download.docker.com`, which Debian security updates
don't cover, so `UPGRADE_DOCKER="true"` adds Docker's origin to
unattended-upgrades. That repo has no `Codename` in its `Release` file, so the
pattern matches on `archive=${distro_codename}`. `live-restore` keeps the
containers running while an upgrade restarts dockerd.

Published Docker ports bypass UFW, so the stack publishes only 80/443 and
`verify.sh` warns about anything else (more in
[deploy/README.md](../deploy/README.md#ports)). The userland proxy stays on:
without it Docker sets `route_localnet`, which on older releases let LAN hosts
reach ports bound to `127.0.0.1`. The `docker` group is root-equivalent, so
keep it to admins.

log2ram is off by default. It saves SD card writes by keeping `/var/log` in
RAM, but a power cut loses everything since the last sync. Skip it if the Pi
boots from an SSD.

## Tests

```sh
bash tests/run.sh         # unit tests: Bash 4.4+ (brew install bash on macOS), jq, ssh-keygen
tests/e2e.sh bookworm     # or trixie; needs Docker
make shell-lint           # from the repo root
```

The end-to-end test boots Debian with systemd in a privileged container and
does a dry run, a real run, a second run, and audits as root and as the admin
user. It fails if the dry run writes anything, the second run changes anything,
or `verify.sh` reports a FAIL. It skips `sysctl` (shared host kernel, so its
`[FAIL] sysctl` lines are ignored), `network` and `ddns`.

## Adding a module

Create `modules/NN-name.sh` (the number sets the order) with a `# Summary:`
line for `--help` and a `mod_<name>` function. Use `run` for every command that
changes the system and `install_file` or `install_template` for every file.
Add a matching check to `verify.sh`.
