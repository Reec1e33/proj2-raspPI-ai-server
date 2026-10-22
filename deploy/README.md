# deploy

The Docker Compose stack for the Pi: nginx in front (TLS, basic auth, the
dashboard), the FastAPI api, the `pi-agent` telemetry agent, an optional Ollama,
and Prometheus, Grafana, Loki and Alloy. `docker-compose.yml` is the Pi stack,
`docker-compose.dev.yml` is a laptop override, and `.env.example` documents
every setting.

So far the stack has only run on a laptop and in CI, with the agent in demo
mode. It hasn't run on real Pi hardware yet.

## On the Pi

Run [`infra/bootstrap.sh`](../infra/) first. It installs Docker, adds the admin
user to the `docker` group, and installs `picloud.service`, which starts the
stack from `/opt/picloud/deploy` at boot.

In `.env`, set at least `SERVER_NAME`, a real `GRAFANA_ADMIN_PASSWORD`
(`openssl rand -base64 24`) and your provider keys. Grafana reads the password
only on its first start, so set it before the first `up`. Also check which
mailbox device the Pi has; see [Throttle state](#throttle-state).

```sh
cd /opt/picloud/deploy
cp .env.example .env && chmod 600 .env    # then edit it
sudo ./scripts/gen-self-signed-cert.sh picloud.local IP:192.168.1.50
sudo ./scripts/create-htpasswd.sh admin
docker compose pull            # images from GHCR; `docker compose build` works too, slowly
docker compose up -d --wait
./scripts/pull-model.sh        # llama3.2:1b unless PICLOUD_OLLAMA_MODEL says otherwise
SMOKE_USER=admin SMOKE_PASSWORD='...' ./scripts/smoke-test.sh
```

The dashboard is at `https://<SERVER_NAME>/` and Grafana at `/grafana/`. For
a public DNS name, use a [Let's Encrypt](#lets-encrypt) cert instead.

Run the cert and htpasswd scripts with `sudo`: as root they set mode 0640 and
group 101 (the gateway's GID). Without root the files end up world-readable.

### Throttle state

Raspberry Pi kernels 6.12+ no longer expose `get_throttled` in sysfs, so the
agent asks the firmware through the mailbox device, like `vcgencmd` does.
Compose passes in one device, `PI_AGENT_MAILBOX_DEVICE`, plus the `video` group
(GID 44). `/dev/vcio` exists on every Pi kernel and is the default. Kernels from
May 2026 also create `/dev/vcio_gencmd`, which only accepts `vcgencmd`
commands, and updated Pi OS 13 images make `/dev/vcio` root-only. Check
`ls -l /dev/vcio*`:

| You see | Set `PI_AGENT_MAILBOX_DEVICE` to |
| --- | --- |
| `/dev/vcio_gencmd` | `/dev/vcio_gencmd` |
| only `/dev/vcio` | `/dev/vcio` (default) |
| nothing (not a Pi) | `/dev/null`, which turns throttle reporting off |

Docker won't start a container whose device is missing; `infra/verify.sh`
checks it. If the agent can't read the device, it keeps running and reports
`throttling.supported: false`, so `PiThrottledNow` and `PiUnderVoltageNow`
can't fire.

## On a laptop

The dev override builds the images locally, runs the agent in demo mode
(synthetic Pi data, no host mounts or mailbox device), and leaves Ollama off.
The gateway is on `https://localhost:8443` (8080 redirects), and the api is
also on `127.0.0.1:8000` for `pnpm dev` in `web/`. Alloy collects container
logs only. It needs Docker Compose 2.24.4+ for the `!reset`/`!override` tags.

From the repo root:

```sh
make dev-init     # .env, a cert for localhost, and an htpasswd user
make dev-up       # builds and starts the stack with the dev override
SMOKE_USER=admin SMOKE_PASSWORD='...' make smoke
make dev-down
```

`create-htpasswd.sh` needs `openssl passwd -6` (OpenSSL 1.1.1+). The macOS
`openssl` is LibreSSL, so the script refuses there. Run `brew install openssl@3`
and put `$(brew --prefix openssl@3)/bin` first on your `PATH`.

For the chat you need a model. Either set `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` in `.env`, or use Ollama:

- Native Ollama on the laptop: set
  `PICLOUD_DEV_OLLAMA_URL=http://host.docker.internal:11434`.
- Ollama in Docker: set `COMPOSE_PROFILES=dev-ollama` and
  `PICLOUD_DEV_OLLAMA_URL=http://ollama:11434`, start the stack, then run
  `deploy/scripts/pull-model.sh`. Docker on macOS has no GPU, so it runs on the CPU.

## Configuration

The settings you're most likely to touch. `.env.example` has the rest
(api tuning, agent interval and mounts, log levels).

| Variable | Default | Notes |
| --- | --- | --- |
| `SERVER_NAME` | `picloud.local` | Used by Grafana links, the cert script and the smoke test. |
| `PICLOUD_VERSION` | `latest` | Image tag for gateway, api and agent. Pin a release such as `2.0.0`. |
| `COMPOSE_PROFILES` | `ollama` | Remove `ollama` on a 4 GB Pi. |
| `PICLOUD_PROVIDER_ORDER` | `ollama,anthropic,openai` | Providers without a key or URL are skipped. |
| `PICLOUD_OLLAMA_URL`, `PICLOUD_OLLAMA_MODEL` | `http://ollama:11434`, `llama3.2:1b` | An empty URL disables Ollama. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | unset | Unset disables that provider. |
| `PICLOUD_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible API, e.g. Groq. |
| `PICLOUD_API_KEY` | unset | If set, `POST /api/chat` needs `X-API-Key`. |
| `PI_AGENT_MAILBOX_DEVICE` | `/dev/vcio` | See [Throttle state](#throttle-state). |
| `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD` | `admin`, none | Compose refuses to start without the password. |
| `PROMETHEUS_RETENTION_TIME`, `PROMETHEUS_RETENTION_SIZE` | `15d`, `2GB` | Whichever is hit first. |
| `LOKI_RETENTION_PERIOD` | `168h` | Log retention. |
| `MEM_LIMIT_OLLAMA`, `MEM_LIMIT_PROMETHEUS`, `MEM_LIMIT_LOKI`, `MEM_LIMIT_GRAFANA` | `4g`, `512m`, `384m`, `512m` | See [Memory budget](#memory-budget). |

## Ports

Only the gateway publishes on all interfaces. Everything else is on the
internal `picloud` network.

| Host | Container | What |
| --- | --- | --- |
| 80 | gateway:8080 | Redirect to HTTPS, plus ACME HTTP-01 challenges |
| 443 | gateway:8443 | Dashboard, `/api/`, `/grafana/` |
| 127.0.0.1:9090 | prometheus:9090 | Reach it with `ssh -L 9090:127.0.0.1:9090 pi@<SERVER_NAME>` |
| none | api:8000, agent:9110, ollama:11434, grafana:3000, loki:3100, alloy:12345 | Internal only |

Docker publishes ports with its own iptables rules, which run before UFW's. A
published port is open to the network even if UFW says otherwise. That's why
nothing but 80/443 is published on `0.0.0.0` and Prometheus binds to
localhost. If you add a debug port, bind it to `127.0.0.1` and tunnel to it.
`infra/verify.sh` warns about anything else that's exposed.

## Memory budget

Limits are caps, not reservations. `.env` sets the four large ones (the
`MEM_LIMIT_*` variables); the rest are fixed in `docker-compose.yml`. Defaults
suit an 8 GB Pi, and the 4 GB values are in brackets in `.env.example`.

| Service | 8 GB limit | 4 GB limit | Idle (Mac VM) |
| --- | ---: | ---: | ---: |
| gateway | 128 MiB | 128 MiB | ~10 MiB |
| api | 256 MiB | 256 MiB | ~85 MiB |
| agent | 64 MiB | 64 MiB | ~10 MiB |
| ollama | 4 GiB | off | ~1.9 GiB with `llama3.2:1b` loaded |
| prometheus | 512 MiB | 256 MiB | ~70 MiB |
| grafana | 512 MiB | 512 MiB | ~200 MiB |
| loki | 384 MiB | 256 MiB | ~85 MiB |
| alloy | 256 MiB | 256 MiB | ~65 MiB |

Idle use was measured on the laptop stack in a Docker Desktop VM on a Mac, not
on a Pi. Without Ollama it's about 0.5 GiB. Keep `MEM_LIMIT_GRAFANA` at 512m or
more: compose sets `GOMEMLIMIT: 400MiB` because Go doesn't see the cgroup limit.

To run on a 4 GB Pi:

1. Remove `ollama` from `COMPOSE_PROFILES`.
2. Uncomment `PICLOUD_OLLAMA_URL=` (empty) to disable the Ollama provider.
3. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
4. Use the bracketed memory limits.

## Security notes

Every service gets `no-new-privileges`, `cap_drop: [ALL]`, a read-only root
filesystem, memory and CPU limits, and rotated `json-file` logs (3 x 10 MB).
Most run as a non-root user. Ollama and Alloy run as root inside the container,
with no capabilities. Third-party images are pinned to exact tags.

The gateway does TLS 1.2/1.3 with ECDHE suites only, HSTS, and a strict CSP on
the dashboard. Basic auth covers every HTTPS path except `/api/health`.
`/api/chat` is limited to 30 requests a minute per IP (burst 10).

The gateway has a fixed address, 172.30.0.10, and overwrites `X-Forwarded-For`.
The api trusts that header only from there (`FORWARDED_ALLOW_IPS`), so its own
rate limit sees real clients. If 172.30.0.0/24 clashes with your LAN, change
the subnet and the gateway address together in `docker-compose.yml`.

Grafana gives anonymous users the Viewer role, since basic auth already guards
`/grafana/`. The gateway strips the `Authorization` header on the way in. Use
the Grafana admin account to edit dashboards.

`htpasswd` uses SHA-512 crypt, not bcrypt. Basic auth has no session, so nginx
checks the hash on every request. A Grafana page load is over 100 requests, and
at bcrypt cost 12 each check takes about 0.45 s of the gateway's half CPU.

Loki has no Docker healthcheck: the image is distroless (no shell, `wget` or
`curl`) and Loki has no probe subcommand. Prometheus scrapes it instead, and
`ObservabilityTargetDown` fires if it stops answering.

### Alloy and the Docker socket

Alloy reads container logs from `/var/run/docker.sock`. Access to that socket
is root on the host, and `:ro` doesn't change that: it stops writes to the
socket file, not Docker API calls. Alloy is the only container with the socket.
It runs the official pinned image with no published port, no capabilities, and
a read-only root filesystem and config. For a single-user home server I accept
that. If you don't, put a socket proxy such as `tecnativa/docker-socket-proxy`
in front and allow only `GET /containers`.

## Let's Encrypt

You need a public DNS name and port 80 forwarded to the Pi. The gateway serves
`/.well-known/acme-challenge/` from `nginx/acme/`.

```sh
sudo apt install certbot
sudo certbot certonly --webroot -w /opt/picloud/deploy/nginx/acme -d pi.example.com

live=/etc/letsencrypt/live/pi.example.com
sudo install -m 0644 "$live/fullchain.pem" /opt/picloud/deploy/nginx/certs/
sudo install -m 0640 -g 101 "$live/privkey.pem" /opt/picloud/deploy/nginx/certs/
docker compose -f /opt/picloud/deploy/docker-compose.yml exec gateway nginx -s reload
```

Put the last four lines in `/etc/letsencrypt/renewal-hooks/deploy/picloud.sh`
so they run after each renewal.

## Operations

Run these from `/opt/picloud/deploy`.

| Task | Command |
| --- | --- |
| Status and logs | `docker compose ps`, `docker compose logs -f api` |
| Reload nginx after a cert change | `docker compose exec gateway nginx -s reload` |
| Reload Prometheus config or rules | `docker compose kill -s SIGHUP prometheus` |
| Update | `git pull && docker compose pull && docker compose up -d` |
| Add a model | `./scripts/pull-model.sh llama3.2:3b` |
| Change the Grafana admin password | `docker compose exec -T grafana grafana cli admin reset-admin-password --password-from-stdin`, type it, then Ctrl-D |

There's no Alertmanager. The `PiCloud overview` dashboard has a **Firing
alerts** table, a **Logs** row, and a **Security events** panel (failed SSH
logins, fail2ban bans, UFW blocks).

### Backup

`backup.sh` writes one archive with `.env`, the certs, `htpasswd` and the
Grafana volume. `--with-data` adds the Prometheus and Loki volumes. It stops
each service while copying its volume, then starts it again. Ollama models are
left out; `pull-model.sh` gets them back.

```sh
sudo ./scripts/backup.sh                          # to /var/backups/picloud, keeps 7
sudo ./scripts/backup.sh -d /mnt/usb -k 14 --with-data
```

To restore, stop the stack, unpack the archive, copy the config back, and
recreate each volume before you fill it. Shown here for `grafana-data`:

```sh
docker compose down
sudo mkdir /tmp/restore && sudo tar -xzf picloud-<time>.tar.gz -C /tmp/restore
sudo cp -Rp /tmp/restore/config/. .   # .env, nginx/htpasswd, nginx/certs/
docker volume rm picloud_grafana-data
docker compose create grafana        # recreates the volume with its compose labels
docker run --rm -v picloud_grafana-data:/data -v /tmp/restore/volumes:/backup:ro \
  alpine:3.24.2 tar -xzf /backup/grafana-data.tar.gz -C /data
docker compose up -d --wait
```

## Checks

These validate the config without a Pi. Run them from the repo root; CI and
`make check` run them too. They use the stack's own pinned images for promtool,
Alloy and Loki, so Docker is all you need.

```sh
make deploy-lint    # compose config (Pi and dev), promtool check config,
                    # alloy fmt + validate, loki -verify-config, dashboard JSON
make deploy-test    # promtool test rules on prometheus/tests/picloud-alerts.test.yml
make shell-lint     # shellcheck on deploy/scripts and infra
```
