# Operations

For a Pi set up with [setup.md](setup.md). Run `docker compose` commands as
the admin user in `/opt/picloud/deploy` unless noted.

Weekly, look at **Firing alerts** and **Security events** on the
`PiCloud overview` dashboard and run `docker compose ps`. Monthly, run
`sudo /opt/picloud/infra/verify.sh` and test a [restore](#restoring-a-backup).

## Updating

OS and Docker Engine packages update daily through `unattended-upgrades`. The
PiCloud images only change when you update them:

```sh
cd /opt/picloud
git pull
git diff ORIG_HEAD -- deploy/.env.example infra/config.env.example
```

The diff shows new settings to copy into `deploy/.env` or `infra/config.env`.
If `infra/` changed, run `sudo ./bootstrap.sh --dry-run` and then
`sudo ./bootstrap.sh` from `/opt/picloud/infra`. Then update the stack:

```sh
cd /opt/picloud/deploy
docker compose pull          # or: docker compose build, if you build on the Pi
docker compose up -d --wait
SMOKE_USER=admin SMOKE_PASSWORD='<gateway password>' ./scripts/smoke-test.sh https://localhost
```

To pin or roll back a release, set `PICLOUD_VERSION` (for example `2.0.0`) in
`.env` and run `docker compose up -d --wait`. Third-party images are pinned in
`docker-compose.yml` and only move when the repo does.

## Rotating secrets

- Gateway password: `sudo ./scripts/create-htpasswd.sh admin`. No reload
  needed.
- Grafana admin password: run
  `docker compose exec -T grafana grafana cli admin reset-admin-password --password-from-stdin`,
  type the password, and press Ctrl-D. Update `.env` too, so a fresh
  Grafana volume gets it.
- `PICLOUD_API_KEY` or a provider key: change it in `.env` and run
  `docker compose up -d --wait`. Enter a new chat key in the dashboard
  settings, and revoke an old provider key afterwards.
- Self-signed certificate (825 days):
  `sudo ./scripts/gen-self-signed-cert.sh -f picloud.local IP:<pi-address>`,
  then `docker compose exec gateway nginx -s reload`.
- Let's Encrypt: certbot's timer renews it and the
  [deploy hook](setup.md#7-get-a-lets-encrypt-certificate) copies it in. Test
  with `sudo certbot renew --dry-run`.
- SSH key: add the new one to `~/.ssh/authorized_keys`, log in with it, and
  only then remove the old one.
- DDNS password: change it in `infra/config.env` and run
  `sudo ./bootstrap.sh --only ddns`.

## Backups

`backup.sh` writes one archive with `deploy/.env`, the certificates,
`htpasswd`, and the Grafana volume, plus Prometheus and Loki with `--with-data`.
It briefly stops each service while it copies the volume. Ollama models are
left out, since `pull-model.sh` fetches them again.

```sh
sudo ./scripts/backup.sh                                  # to /var/backups/picloud, keep 7
sudo ./scripts/backup.sh -d /mnt/usb -k 14 --with-data    # to a USB drive, keep 14
```

Keep backups off the SD card, or they die with it. `infra/config.env` isn't in
the archive, so keep a safe copy of it yourself.

Nothing schedules backups. This line in `sudo crontab -e` runs one at 03:00,
before the 04:00 update reboot:

```text
0 3 * * * /opt/picloud/deploy/scripts/backup.sh -d /mnt/usb -k 14
```

### Restoring a backup

The [deploy README](../deploy/README.md#backup) has the commands. In short:
`docker compose down`, extract the archive, copy `.env`, `htpasswd`, and the
certs back, recreate each volume empty and untar its archive into it, then
`docker compose up -d --wait`.

## Logs

The **Logs** row on `PiCloud overview` has container logs per service,
**Errors**, and **Security events** (failed SSH logins, fail2ban bans, UFW
blocks). For anything else, use **Explore** with the Loki data source:

```text
{job="docker", service="api"} | json | level="error"
{job="docker", service="api"} |= "provider attempt failed"
{job="docker", service="gateway"} | json | status >= 500
{compose_project="picloud"} |= "<request-id>"
{job="systemd-journal", syslog_identifier=~"sshd|sshd-session"} |~ "Failed|Invalid user"
{job="fail2ban"} |= "] Ban "
{job="systemd-journal", syslog_identifier="kernel"} |= "[UFW BLOCK]"
```

Request IDs are in the `X-Request-ID` response header and the chat `meta`
event. On the host:

```sh
docker compose logs -f --tail 100 api     # one service
journalctl -u picloud -b                  # stack start at boot
journalctl -u ssh --since today           # SSH logins
sudo fail2ban-client status sshd
sudo ufw status verbose
journalctl --disk-usage
```

## Alerts

The rules are in
[`picloud-alerts.yml`](../deploy/prometheus/rules/picloud-alerts.yml). There's
no Alertmanager, so nothing pings you. Check **Firing alerts** in Grafana, or
tunnel to Prometheus with `ssh -L 9090:127.0.0.1:9090 <user>@<pi-address>` and
open `http://localhost:9090/alerts`.

- `PiHighTemperature` (over 75 °C) and `PiCriticalTemperature` (over
  80 °C, where the firmware throttles): find the load with
  `docker stats --no-stream` and check the fan. If critical, cut the load first,
  for example `docker compose stop ollama`.
- `PiThrottledNow` and `PiUnderVoltageNow`: see
  [throttling](#throttling-and-under-voltage). Under-voltage can corrupt the SD
  card, so don't sit on it.
- `PiDiskAlmostFull` (over 85%): check `df -h` and `docker system df`, run
  `docker image prune`, or lower the retention in `.env`.
- `PiMemoryPressure` (under 10% free): check `docker stats --no-stream`.
  Use a smaller model, lower the memory limits, or switch to the 4 GB settings.
- `AgentDown`: check `docker compose logs agent`, and see
  [the agent won't start](#the-agent-container-wont-start).
- `ApiDown`: usually a bad value in `.env`. Check `docker compose logs api`,
  fix it, and run `docker compose up -d --wait`.
- `ChatErrorRateHigh` (over 25% of chats failing): run
  `curl -sk -u admin https://localhost/api/providers`, look for failed provider
  attempts in Loki, and check keys, quotas, and the Ollama model.
- `ProviderCircuitOpen`: the API is skipping that provider. Fix it (for
  Ollama, often `./scripts/pull-model.sh`), then send one chat through it,
  because the circuit only closes after a successful request.
- `ObservabilityTargetDown`: Prometheus, Loki, Alloy, or Grafana is down, but
  the dashboard and chat still work. Check `docker compose ps` and the logs.
  Loki has no Docker healthcheck, so this alert is its only health signal.

## Troubleshooting

### Throttling and under-voltage

The firmware drops the CPU clock when the SoC runs hot or the voltage sags.
The **Power and throttling** panel on the dashboard shows each flag "now" and
"since boot". Under-voltage almost always means the supply or cable, so use the
official one. For heat, add a fan or heatsink. Long local-model answers load
every core, so on a hot Pi lower `PICLOUD_MAX_TOKENS` or use a cloud provider.

### The throttle panel is empty

The agent can't open the firmware mailbox device, so it reports
`throttling.supported: false` and the two throttle alerts can't fire. Run
`ls -l /dev/vcio*`. Set `PI_AGENT_MAILBOX_DEVICE=/dev/vcio_gencmd` in `.env` if
that exists, otherwise `/dev/vcio`. The device needs group `video` (GID 44) with
group read. Then `docker compose up -d --wait` and check the agent logs.

### The agent container won't start

If `docker compose up` says `error gathering device information`, the device in
`PI_AGENT_MAILBOX_DEVICE` doesn't exist. Fix it as above, or use `/dev/null` on
a machine that isn't a Pi.

### SD card wear

The journal, container logs, Prometheus, and Loki all have size or age caps
(the last two set in `.env`). `LOG2RAM_ENABLE` in `infra/config.env` helps
more, but booting from an SSD is the real fix.

A dying card tends to remount root read-only (look for `ro` in
`findmnt -no OPTIONS /`) or log I/O errors (`journalctl -k | grep -i 'i/o error'`).
If you see either, back up right away and replace the card.

### Ollama runs out of memory

Ollama's limit is 4 GB, which fits an 8 GB Pi but not a 4 GB one. To check
whether the kernel killed it:

```sh
docker inspect --format '{{.State.OOMKilled}}' picloud-ollama-1
```

On a 4 GB Pi, drop Ollama with the
[4 GB settings](../deploy/README.md#memory-budget) and set a cloud key. On
8 GB, stick with `llama3.2:1b`. Meanwhile the chat falls through to the next
provider in `PICLOUD_PROVIDER_ORDER` that has a key.

### The dashboard says "Offline" or "Stale"

"Offline" means the browser can't reach the API, or the API can't reach the
agent. Check `docker compose ps` and the reason under the badge. "Stale" means
the agent's sample stopped changing, often a sampler stuck on a dead mount.
Run `docker compose restart agent`.

### The browser keeps asking for the password

The gateway sent a 401, usually because the password changed. Log in again. A
wrong chat key returns 403, so it won't log you out.

### The chat returns 503

No provider could start an answer: every circuit is open, or none is enabled.
Run `curl -sk -u admin https://localhost/api/providers` on the Pi to see each
provider's `enabled` and `circuit`. A provider with no key or URL shows
`enabled: false`. For Ollama, try `./scripts/pull-model.sh` and check
`docker compose logs ollama`.
