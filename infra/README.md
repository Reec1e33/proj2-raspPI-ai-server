# PiCloud host toolkit (`infra/`)

The scripts in this directory prepare a Raspberry Pi for the PiCloud stack.
They make the host more secure and keep it up to date.
You can run them again at any time. A second run on a correct host makes no changes.

Each step is a module. A module changes the system only when the current state is not correct.
The `--dry-run` option shows each change before you apply it.

## Requirements

- A Raspberry Pi 4 or 5 with the 64-bit Raspberry Pi OS (Debian 12 "bookworm" or Debian 13 "trixie").
  Debian 12 or 13 for arm64 also works.
- Bash 4.4 or later. The supported OS releases have Bash 5.
- A user account that is not root. This user must be able to use `sudo`.
- An SSH key pair on your computer.

## Procedure

1. Clone the repository to `/opt/picloud`:

   ```sh
   sudo git clone https://github.com/Reec1e33/proj2-raspPI-ai-server.git /opt/picloud
   ```

2. Make the configuration file. Set `ADMIN_USER` and the other values:

   ```sh
   cd /opt/picloud/infra
   sudo cp config.env.example config.env
   sudo chmod 600 config.env
   sudo nano config.env
   ```

3. Copy your public key to the Pi. Do this step on your computer:

   ```sh
   ssh-copy-id <user>@<pi-address>
   ```

   You can also put the key in `SSH_AUTHORIZED_KEY` in `config.env`.

4. Show the planned changes. This step changes nothing:

   ```sh
   sudo ./bootstrap.sh --dry-run
   ```

5. CAUTION: Keep your current SSH session open until a new session works.
   If the new session fails, use the open session to correct the configuration.

   Apply all modules:

   ```sh
   sudo ./bootstrap.sh
   ```

6. Open a new SSH session from your computer. Make sure that it works.
   If the login fails with `Too many authentication failures`, your SSH agent offers too many keys (the limit is 3).
   Use `ssh -o IdentitiesOnly=yes -i <private-key-file> <user>@<pi-address>`.
7. Audit the host:

   ```sh
   sudo ./verify.sh
   ```

8. If the summary shows `reboot: required`, reboot the Pi with `sudo reboot`.

## Options

| Option | Result |
| --- | --- |
| `-n`, `--dry-run` | Show the changes and the commands. Change nothing. |
| `-y`, `--yes` | Do not ask for confirmation. Use this option when there is no terminal. |
| `--only a,b` | Run only the modules `a` and `b`. |
| `--skip a,b` | Run all modules except `a` and `b`. |
| `-c`, `--config FILE` | Use a different configuration file. |
| `-l`, `--list` | Show the selected modules, then stop. |

Example: `sudo ./bootstrap.sh --only ssh,firewall --dry-run`

## Modules

The modules run in this order.

| Module | Function |
| --- | --- |
| `base` | Upgrades all packages (`apt-get full-upgrade`). Installs `curl`, `git` and `jq`. Sets the time zone, the host name and NTP time sync. |
| `ssh` | Allows key login for `ADMIN_USER` only. Blocks root login. Allows modern algorithms only. |
| `firewall` | Blocks all inbound traffic except SSH (with a rate limit), HTTP and HTTPS. Opens extra ports to the LAN only. |
| `fail2ban` | Bans an address after 5 failed SSH logins in 10 minutes. Each new ban of the same address is longer. |
| `updates` | Installs Debian, Raspberry Pi and Docker Engine updates every day. Reboots at a set time if an update needs a reboot. |
| `network` | Sets a static IPv4 address with NetworkManager. Does nothing if `STATIC_IP_CIDR` is empty. |
| `ddns` | Keeps a No-IP or Cloudflare host name on the public IP address. Does nothing if `DDNS_PROVIDER` is empty. |
| `logging` | Keeps the journal on disk with a size limit and an age limit. Installs log2ram if you set `LOG2RAM_ENABLE=true`. |
| `sysctl` | Applies kernel and network security values. IP forwarding stays on, because Docker needs it. |
| `docker` | Installs Docker Engine and the compose plugin from the Docker repository. Sets log rotation, live restore and `no-new-privileges`. If the kernel uses AppArmor, installs the AppArmor tools, so that Docker can confine the containers. |
| `picloud` | Installs `picloud.service`. This unit starts the stack in `/opt/picloud/deploy` at boot. |

## Controls and verification

`verify.sh` does a read-only audit of each control. It prints PASS, WARN, FAIL or SKIP for each check.
SKIP shows a control that is off or not configured. A SKIP is not an error.
Its exit code is 1 if a check fails. The `--quick` option skips `unattended-upgrade --dry-run`, because it is slow.
`verify.sh` needs root for some checks. Without root, it uses `sudo -n` or reports WARN for those checks.

| Control | File or object | Manual check |
| --- | --- | --- |
| SSH: key login only, no root, one user | `/etc/ssh/sshd_config.d/10-picloud-hardening.conf` | `sudo sshd -T \| grep -E '^(passwordauthentication\|permitrootlogin\|allowusers) '` |
| SSH: modern algorithms only | same file | `sudo sshd -T \| grep -E '^(kexalgorithms\|ciphers\|macs) '` |
| Firewall: deny inbound, SSH rate limit, 80/443 | UFW rules | `sudo ufw status verbose` |
| Bans after failed logins | `/etc/fail2ban/jail.local` | `sudo fail2ban-client status sshd` |
| Automatic updates (Debian, Raspberry Pi, Docker) | `/etc/apt/apt.conf.d/20auto-upgrades`, `52picloud-unattended-upgrades` | `systemctl list-timers 'apt-daily*'` and `sudo unattended-upgrade --dry-run --debug \| grep '^Allowed origins'` |
| Static IP address | NetworkManager connection of `NET_IFACE` | `ip -4 addr show eth0` |
| Dynamic DNS | `/etc/ddclient.conf` (mode 0600) | `systemctl status ddclient` |
| Persistent journal with limits | `/etc/systemd/journald.conf.d/90-picloud.conf` | `journalctl --disk-usage` |
| log2ram (optional) | `/etc/log2ram.conf` | `systemctl status log2ram` |
| Kernel and network values | `/etc/sysctl.d/90-picloud-hardening.conf` | `sysctl kernel.kptr_restrict net.ipv4.conf.all.rp_filter` |
| Docker log rotation, live restore, no-new-privileges | `/etc/docker/daemon.json` | `docker info --format '{{.LoggingDriver}} {{.LiveRestoreEnabled}}'` |
| Only 80/443 published on all interfaces | Docker | `docker ps --format '{{.Names}} {{.Ports}}'` |
| Stack starts at boot | `/etc/systemd/system/picloud.service` | `systemctl status picloud` |
| Agent can read the throttle state | the device in `deploy/.env` (`PI_AGENT_MAILBOX_DEVICE`, default `/dev/vcio`) | `ls -l /dev/vcio*` |
| No reboot is necessary | `/var/run/reboot-required` | `cat /var/run/reboot-required.pkgs` |

The agent check reads `PI_AGENT_MAILBOX_DEVICE` from `deploy/.env`. The result depends on the state of the host:

| State | Result |
| --- | --- |
| `deploy/.env` does not exist. The stack is not configured yet. | SKIP |
| `deploy/.env` sets `/dev/null`. The agent does not read the throttle state. | SKIP |
| The device does not exist. Docker cannot start the agent container. | FAIL |
| The `video` group (GID 44) cannot read the device. | WARN |
| `/dev/vcio_gencmd` exists, and `deploy/.env` sets a different device. | WARN |
| Only root can read `deploy/.env`, and `verify.sh` has no root access. | WARN |
| The `video` group can read the device. | PASS |

## Safety features

- **Dry run.** `--dry-run` prints each command and each file change. For a file that is not world-readable, it prints only the file name, because the file can hold secrets.
- **Backups.** Before a module changes a file, it copies the old file to `/var/backups/picloud/<run-id>/<path>`.
- **Validation and rollback.** After a change, the module tests the new configuration with `sshd -t`, `fail2ban-client --test`, `apt-config dump` or `dockerd --validate`. If the test fails, the module puts back the old file and stops.
- **SSH lockout guard.** The `ssh` module stops before it disables password login if `ADMIN_USER` has no valid public key.
- **SSH port change.** When you change `SSH_PORT` and UFW is active, the `ssh` module opens the new port in UFW before sshd reloads. If UFW is not active, the `firewall` module opens the port before it enables UFW. The rule for port 22 stays. Delete it after a new session on the new port works.
- **Static IP address.** A transient systemd timer applies the new address 10 seconds after the run ends. Thus the run is complete before the address changes.
  If a run stops before the timer starts, the next run applies the address.
- **One run at a time.** The lock file `/run/picloud-bootstrap.lock` stops a second run.
- **Configuration file.** `bootstrap.sh` reads `config.env` as Bash code, with root access. Thus it stops if root does not own the file, or if other users can write to it.

## Docker updates

Docker Engine comes from `download.docker.com`, not from the Debian archive.
Thus the Debian security updates do not include it.
The `updates` module adds the Docker origin to unattended-upgrades when `UPGRADE_DOCKER="true"` (the default).

- An update of `docker-ce` or `containerd.io` restarts the daemon.
  The `docker` module sets `live-restore`, so the containers continue to run during the restart.
- The Docker repository has no `Codename` field in its `Release` file.
  Thus the origin pattern uses the suite: `origin=Docker,label=Docker CE,archive=${distro_codename}`.
- To update Docker by hand only, set `UPGRADE_DOCKER="false"` and run `sudo ./bootstrap.sh --only updates`.

`verify.sh` shows a WARN if the flag is on and the Docker origin is not in the APT configuration.

## Docker and UFW

Docker writes its own iptables rules for published container ports.
Traffic to these ports does not go through the UFW rules.
Thus UFW cannot block a port that a container publishes on all interfaces (`0.0.0.0`).

The PiCloud stack publishes only the gateway, on ports 80 and 443.
Prometheus binds to `127.0.0.1:9090`. You reach it through an SSH tunnel:

```sh
ssh -L 9090:127.0.0.1:9090 <user>@<pi-address>
```

`verify.sh` shows a WARN for each other container port on all interfaces.

The `docker` module keeps the Docker userland proxy (the default).
If you disable the proxy, Docker sets `route_localnet` on its bridges.
On older Docker releases, LAN hosts could then reach ports on `127.0.0.1`.

## The docker group

The `docker` module adds `ADMIN_USER` to the `docker` group.
A member of this group can get root access, for example with a container that mounts `/`.
Give this group to administrators only.

## SD card and log2ram

The journal stays on disk (`Storage=persistent`), so the logs stay after a reboot.
The limits are 200 MB and 2 weeks. These limits decrease the writes to the SD card.

log2ram decreases the writes more. It keeps `/var/log` in RAM and copies it to the card at intervals and at shutdown.
If the power fails, you lose the logs since the last copy. Thus `LOG2RAM_ENABLE` is `false` by default.
Set it to `true` only if the Pi boots from an SD card and you accept this risk.
If the Pi boots from an SSD, you do not need log2ram.

## Tests

- Unit tests: `bash tests/run.sh`. They need Bash 4.4 or later, `jq` and `ssh-keygen`.
  They need no root access and no network. On macOS, install a newer Bash first (`brew install bash`).
- Lint: `shellcheck -x -S style bootstrap.sh verify.sh lib/*.sh modules/*.sh tests/*.sh`.
- End-to-end test: `tests/e2e.sh bookworm` or `tests/e2e.sh trixie`. It needs Docker.
  It starts Debian with systemd in a privileged container. Then it does a dry run, a real run, a second run and an audit.
  The test fails if the dry run writes a file, if the second run makes a change, or if `verify.sh` reports a FAIL that is not for `sysctl`.
- The audit runs two times: as root, and as the admin user without root.
  Without root, a check that needs root must show WARN, not FAIL.
- The test ignores each `[FAIL] sysctl` line. These FAIL lines are expected in a container:
  the test skips the `sysctl` module, so the kernel values are not set.
- The stub `deploy/.env` sets `PI_AGENT_MAILBOX_DEVICE=/dev/null`, because the container is not a Raspberry Pi.
  Thus the agent check shows SKIP as root. The file has mode 600, so the check shows WARN as the admin user.
- The end-to-end test skips three modules:
  - `sysctl`, because a container shares the kernel of the host.
  - `network`, because the container has no NetworkManager.
  - `ddns`, because the test must not send data to a DDNS provider.

## Layout

```text
bootstrap.sh         entry point: options, checks, module runner, summary
verify.sh            read-only audit
config.env.example   documented configuration (copy it to config.env)
lib/common.sh        output, run(), file helpers, packages, services
lib/config.sh        configuration defaults and validation
modules/NN-name.sh   one module per file; each defines mod_<name>()
files/               configuration files and templates ({{NAME}} placeholders)
tests/run.sh         unit tests
tests/e2e.sh         end-to-end test in a systemd container
```

## Add a module

1. Make the file `modules/NN-name.sh`. The number sets the run order.
2. Add a `# Summary:` line. `--help` shows this line.
3. Define the function `mod_<name>`.
4. Use `run` for each command that changes the system.
5. Use `install_file` or `install_template` for each file.
6. Add a check to `verify.sh`.
