# Operations runbook

This runbook is for a Pi that you set up with [setup.md](setup.md). Run the
`docker compose` commands in `/opt/picloud/deploy` as the admin user, unless a
step says otherwise.

## Routine checks

| When | Check | Command or place |
| --- | --- | --- |
| Each week | Active alerts | Grafana, `PiCloud overview`, **Firing alerts** table |
| Each week | Container health | `docker compose ps` |
| Each week | Security events | Grafana, **Logs** row, **Security events** panel |
| Each month | Host controls | `sudo /opt/picloud/infra/verify.sh` |
| Each month | Backup restore test | [Restore a backup](#restore-a-backup) on a spare volume |

## Update the stack

The host installs Debian, Raspberry Pi and Docker Engine updates every day
(`unattended-upgrades`). The PiCloud images change only when you update them.

1. Get the new code:

   ```sh
   cd /opt/picloud
   git pull
   ```

2. Look for new settings in the template:

   ```sh
   git diff ORIG_HEAD -- deploy/.env.example infra/config.env.example
   ```

   Add new settings to `deploy/.env` or `infra/config.env` if you need them.

3. If `infra/` changed, preview and apply the host changes:

   ```sh
   cd /opt/picloud/infra
   sudo ./bootstrap.sh --dry-run
   sudo ./bootstrap.sh
   ```

4. Get the new images and restart the changed services. If you built the
   images on the Pi, use `docker compose build` in place of
   `docker compose pull`:

   ```sh
   cd /opt/picloud/deploy
   docker compose pull
   docker compose up -d --wait
   ```

5. Run the smoke test:

   ```sh
   SMOKE_USER=admin SMOKE_PASSWORD='<gateway password>' ./scripts/smoke-test.sh https://localhost
   ```

To keep one release, set `PICLOUD_VERSION=2.0.0` in `.env`. The Images workflow
tags the images for each `v*` Git tag. To go back to an earlier release, set its
version and run `docker compose up -d --wait`.

The third-party images (for example Grafana) have fixed tags in
`docker-compose.yml`. A new release of the repository changes these tags. The
stack does not use `latest` for them.

## Rotate secrets and certificates

| Secret | Procedure |
| --- | --- |
| Gateway password | Run `sudo ./scripts/create-htpasswd.sh admin`. nginx reads the file for each request, so no reload is necessary. |
| Grafana admin password | Run `docker compose exec -T grafana grafana cli admin reset-admin-password --password-from-stdin`. Type the password, then push Ctrl-D. Also write the new password in `.env`, so that a new Grafana volume gets it. |
| Chat key (`PICLOUD_API_KEY`) | Change the value in `.env`. Run `docker compose up -d --wait`. Enter the new key in the dashboard settings dialog. |
| Provider keys | Make a new key in the provider console. Change it in `.env`. Run `docker compose up -d --wait`. Then revoke the old key. |
| Self-signed certificate | Run `sudo ./scripts/gen-self-signed-cert.sh -f picloud.local IP:<pi-address>`, then `docker compose exec gateway nginx -s reload`. The certificate is valid for 825 days. |
| Let's Encrypt certificate | The certbot timer renews it. The deploy hook from [setup.md](setup.md#step-12-get-a-lets-encrypt-certificate) copies it. Test with `sudo certbot renew --dry-run`. |
| SSH key | Add the new key to `~/.ssh/authorized_keys`. Test a new session with the new key. Then remove the old key. |
| DDNS password | Change it in `infra/config.env`. Run `sudo ./bootstrap.sh --only ddns`. |

## Back up

`backup.sh` writes one archive (mode 0600) with these items:

- `deploy/.env`, the certificates and `htpasswd`.
- The Grafana volume.
- With `--with-data`, also the Prometheus and Loki volumes.

The script stops each service while it copies the volume, then starts it
again. It does not copy the Ollama models: `pull-model.sh` downloads them again.

```sh
sudo ./scripts/backup.sh                                  # to /var/backups/picloud, keep 7
sudo ./scripts/backup.sh -d /mnt/usb -k 14 --with-data    # to a USB drive, keep 14
```

The archive does not include `infra/config.env`. Keep a copy of that file in a
safe place, because it can hold the DDNS password.

Keep backups on a second device, for example a USB drive. A backup on the same
SD card is lost with the card.

The project does not schedule backups. To make a daily backup at 03:00, before
the update reboot at 04:00, add this line with `sudo crontab -e`:

```text
0 3 * * * /opt/picloud/deploy/scripts/backup.sh -d /mnt/usb -k 14
```

### Restore a backup

The [restore procedure](../deploy/README.md#backup) in `deploy/README.md` gives
each command. In short:

1. Stop the stack with `docker compose down`.
2. Extract the archive, and copy `.env`, `htpasswd` and the certificates back.
3. Replace each volume with an empty one, and extract the volume archive into
   it.
4. Start the stack with `docker compose up -d --wait`.

## Read the logs

### In Grafana

Open `https://<SERVER_NAME>/grafana/`. The home dashboard is `PiCloud overview`.
The **Logs** row has these panels:

- **Log volume by service** and **Container logs**, with a `service` filter and
  a search box.
- **Errors**: container lines at level error or higher, and journal lines at
  priority `err` or higher.
- **Security events** and **Security log**: failed SSH logins, fail2ban bans and
  UFW blocks.

For other queries, open **Explore** and select the Loki data source. These
queries are useful:

| Purpose | LogQL |
| --- | --- |
| API errors | `{job="docker", service="api"} \| json \| level="error"` |
| Failed provider attempts | `{job="docker", service="api"} \|= "provider attempt failed"` |
| Gateway responses with status 500 or more | `{job="docker", service="gateway"} \| json \| status >= 500` |
| All lines of one request | `{compose_project="picloud"} \|= "<request-id>"` |
| SSH login failures | `{job="systemd-journal", syslog_identifier=~"sshd\|sshd-session"} \|~ "Failed\|Invalid user"` |
| fail2ban bans | `{job="fail2ban"} \|= "] Ban "` |
| UFW blocks | `{job="systemd-journal", syslog_identifier="kernel"} \|= "[UFW BLOCK]"` |

The response header `X-Request-ID` and the chat `meta` event give the request
ID.

### On the host

| Purpose | Command |
| --- | --- |
| Logs of one service | `docker compose logs -f --tail 100 api` |
| Start of the stack at boot | `journalctl -u picloud -b` |
| SSH logins | `journalctl -u ssh --since today` |
| fail2ban state | `sudo fail2ban-client status sshd` |
| Firewall rules | `sudo ufw status verbose` |
| Disk use of the journal | `journalctl --disk-usage` |

## Alerts

Prometheus evaluates the rules in
[`picloud-alerts.yml`](../deploy/prometheus/rules/picloud-alerts.yml). The stack
has no Alertmanager, so an alert sends no message. You see the active alerts in
these places:

- Grafana: the **Firing alerts** table at the top of `PiCloud overview`.
- Prometheus: open an SSH tunnel with `ssh -L 9090:127.0.0.1:9090 <user>@<pi-address>`,
  then open `http://localhost:9090/alerts`.

| Alert | Condition | Description | First response |
| --- | --- | --- | --- |
| `PiHighTemperature` | Above 75 °C for 5 min | The fan and the heatsink cannot remove the heat of the load. | Check the fan and the case airflow. Find the load with `docker stats --no-stream`. |
| `PiCriticalTemperature` | Above 80 °C for 1 min | The firmware throttles the CPU from 80 °C. | Decrease the load now, for example `docker compose stop ollama`. Then check the fan and the heatsink. |
| `PiThrottledNow` | Throttle flag set for 2 min | The CPU runs below its rated speed. | Look at the temperature and the under-voltage flag on the dashboard. See [throttling](#throttling-and-under-voltage). |
| `PiUnderVoltageNow` | Under-voltage flag set for 1 min | The supply voltage is too low. This can damage the SD card. | Use the official power supply and cable. Disconnect USB devices that take power. |
| `PiDiskAlmostFull` | More than 85 % used for 15 min | A filesystem is almost full. | Run `df -h` and `docker system df`. Remove old images with `docker image prune`. Decrease the retention in `.env`. |
| `PiMemoryPressure` | Less than 10 % available for 10 min | The Pi is close to an out-of-memory kill. | Run `docker stats --no-stream`. Use a smaller model, lower the memory limits, or use the 4 GB settings. |
| `AgentDown` | Prometheus cannot scrape the agent for 2 min | No host data. The dashboard shows "Offline". | Run `docker compose ps agent` and `docker compose logs agent`. See [the agent does not start](#the-agent-container-does-not-start). |
| `ApiDown` | Prometheus cannot scrape the API for 2 min | No dashboard data and no chat. | Run `docker compose logs api`. A bad value in `.env` stops the API at start. Correct it, then run `docker compose up -d --wait`. |
| `ChatErrorRateHigh` | More than 25 % of chat requests fail over 10 min (5 requests or more) | Providers fail. | Run `curl -sk -u admin https://localhost/api/providers`. Look for failed provider attempts in Loki. Check the keys, the quotas and the Ollama model. |
| `ProviderCircuitOpen` | The circuit of a provider is not closed for 5 min | The API skips this provider. | Fix the provider (for example `./scripts/pull-model.sh` for Ollama). The circuit closes only after a successful request, so send one chat with this provider to clear the alert. |
| `ObservabilityTargetDown` | Prometheus cannot scrape Prometheus, Loki, Alloy or Grafana for 5 min | Metrics, logs or dashboards are not available. The chat and the dashboard continue to work. | Run `docker compose ps` and `docker compose logs <service>`. Loki has no Docker healthcheck, so this alert is its health signal. |

## Troubleshooting

### Throttling and under-voltage

The Pi firmware lowers the CPU clock when the SoC is too hot or when the supply
voltage is too low. The dashboard shows each flag "now" and "since boot".

1. Look at the **Power and throttling** panel on the dashboard. A flag that is
   set "since boot" but not "now" tells you about an earlier event.
2. If the under-voltage flag is set, replace the power supply or the cable. A
   Pi 5 needs 5 V/5 A, and a Pi 4 needs 5 V/3 A.
3. If the temperature is high, add a fan or a heatsink, or use the official
   case fan. Keep the Pi out of closed spaces.
4. Long chat answers from the local model keep all CPU cores busy. On a hot Pi,
   decrease the answer length (`PICLOUD_MAX_TOKENS`) or use a cloud provider.

### The throttle panel is empty

The agent reads the throttle state through the firmware mailbox device. If it
cannot open the device, it reports `throttling.supported: false`, and the
`PiThrottledNow` and `PiUnderVoltageNow` alerts cannot fire.

1. Run `ls -l /dev/vcio*` on the host.
2. If `/dev/vcio_gencmd` exists, set `PI_AGENT_MAILBOX_DEVICE=/dev/vcio_gencmd`
   in `.env`. Else use `/dev/vcio`.
3. The device must belong to group `video` (GID 44), with read access for the
   group.
4. Run `docker compose up -d --wait`, then `docker compose logs agent`.

### The agent container does not start

Docker does not start a container whose device does not exist. If
`docker compose up` reports `error gathering device information`, the device in
`PI_AGENT_MAILBOX_DEVICE` does not exist. Set the correct device (see above). On
a host that is not a Pi, set `PI_AGENT_MAILBOX_DEVICE=/dev/null`.

### SD card wear

An SD card has a limited number of writes. These settings decrease the writes:

| Data | Limit | Configuration |
| --- | --- | --- |
| systemd journal | 200 MB, 2 weeks | `infra/files/journald/90-picloud.conf` |
| Container logs | 3 files of 10 MB per container | `daemon.json` and `docker-compose.yml` |
| Prometheus | 15 days or 2 GB | `PROMETHEUS_RETENTION_TIME`, `PROMETHEUS_RETENTION_SIZE` |
| Loki | 7 days | `LOKI_RETENTION_PERIOD` |
| `/var/log` | in RAM, synced at intervals | `LOG2RAM_ENABLE="true"` (off by default) |

For a server that runs all the time, boot from an SSD. A Pi 5 can use an NVMe
SSD, and a Pi 4 can boot from a USB SSD. Then log2ram is not necessary.

Signs of a card that starts to fail:

- The root filesystem changes to read-only. Run `findmnt -no OPTIONS /` and look
  for `ro`.
- The kernel log shows I/O errors. Run `journalctl -k | grep -i 'i/o error'`.

If you see these signs, make a backup at once and replace the card.

### Ollama runs out of memory

The default memory limit of Ollama is 4 GB. That fits an 8 GB Pi with the rest
of the stack. It does not fit a 4 GB Pi.

1. Find out if the kernel stopped Ollama for lack of memory:

   ```sh
   docker inspect --format '{{.State.OOMKilled}}' picloud-ollama-1
   ```

2. On a 4 GB Pi, run without Ollama. Follow the
   [4 GB settings](../deploy/README.md#memory-budget), and set a cloud provider
   key.
3. On an 8 GB Pi, use the default model `llama3.2:1b` (about 1.3 GB). A larger
   model needs more memory for the model and its context.

While Ollama is down, the chat uses the next provider in
`PICLOUD_PROVIDER_ORDER`, if a key is set.

### The dashboard shows "Offline" or "Stale"

| Badge | Cause | Action |
| --- | --- | --- |
| Offline | The browser cannot reach the API, or the API cannot reach the agent. | Run `docker compose ps`. Look at the reason line below the badge. |
| Stale | Events arrive, but the agent sample does not change. The agent sampler can hang on a dead mount. | Run `docker compose logs agent` and `docker compose restart agent`. |

### The browser asks for the password again

The gateway sent a `401`. This occurs when the gateway password changes. Reload
the page and log in again. A wrong chat key gives a `403`, not a `401`, so it
does not log you out.

### The chat returns 503

No provider could start an answer. Each circuit is open, or no provider is
enabled.

1. Run `curl -sk -u admin https://localhost/api/providers` on the Pi.
2. Each provider shows `enabled` and `circuit`. A provider without a key or URL
   shows `enabled: false`.
3. For Ollama, run `./scripts/pull-model.sh` and `docker compose logs ollama`.
