# Security

PiCloud is a home server with ports open to the internet. This page gives the
threat model, each control and its file, and the known limits of the design. To
report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Threat model

### Assets

- Root access to the Pi, and through it, the home network.
- The cloud API keys in `deploy/.env`. A stolen key can spend money.
- The gateway password, the Grafana admin password and the optional chat key.
- The chat messages and the host telemetry.
- The availability of the server.

### Attackers

| Attacker | Example | Main controls |
| --- | --- | --- |
| Internet scanners and bots | SSH password guesses, scans of web paths, known exploits | Key-only SSH, UFW, fail2ban, automatic updates, basic auth on all HTTPS paths |
| An internet user who knows the URL | Guesses of the gateway password, abuse of the chat to spend API credit | A long random password, rate limits on the chat, optional `X-API-Key` |
| A device on the LAN | A compromised IoT device | UFW default deny, services not published on the LAN, Prometheus on `127.0.0.1` only |
| A gateway user with the site password | A family member who reads the dashboard | Separate chat key, Grafana Viewer role only, admin login to edit |
| Supply chain | A changed image or package | Pinned image tags, a pinned Docker repository key, lock files (`uv.lock`, `pnpm-lock.yaml`, `go.sum`), a pinned pnpm hash |
| Model output | A model answer with HTML or links | A Markdown subset with no HTML, links or images. The model has no tools. |

Physical access to the Pi is out of scope. A person with the SD card has all
data.

### Attack surface

- Ports 80 and 443 on the internet (the gateway).
- Port 22 (SSH) on the LAN, and on the internet only if you forward it.
- Outbound HTTPS to the LLM providers, the Debian, Raspberry Pi and Docker
  package archives, the container registries and the DDNS provider.

## Controls

### Host

| Control | Configuration | File | Check |
| --- | --- | --- | --- |
| SSH login | Public key only, no root login, `AllowUsers <admin>`, `MaxAuthTries 3`, `LoginGraceTime 30`. Local port forwards only (for the Prometheus tunnel). `LogLevel VERBOSE` logs the key fingerprint of each login. | [`10-picloud-hardening.conf`](../infra/files/ssh/10-picloud-hardening.conf) | `verify.sh` compares `sshd -T` with each value. |
| SSH algorithms | Modern key exchange (ML-KEM and sntrup761 hybrids where OpenSSH supports them, curve25519), AEAD ciphers and ETM MACs only. The module filters the lists against `ssh -Q`. | [`20-ssh.sh`](../infra/modules/20-ssh.sh) | `verify.sh` fails on an algorithm outside the list. |
| SSH lockout guard | The module stops before it turns off password login if the admin user has no valid public key. `sshd -t` tests the new file, and a failure puts back the old file. | [`20-ssh.sh`](../infra/modules/20-ssh.sh), [`common.sh`](../infra/lib/common.sh) | Unit test `test_ssh_lockout_guard_stops_before_any_change`. |
| Firewall | UFW: deny all inbound, allow outbound, `limit` on SSH (UFW denies an address after 6 connections in 30 s), allow 80 and 443, optional ports for the LAN only. IPv6 rules too. | [`30-firewall.sh`](../infra/modules/30-firewall.sh) | `verify.sh` reads `ufw status verbose`. |
| Brute-force bans | fail2ban `sshd` jail on the systemd journal: 5 failures in 10 min give a 1 h ban. Bans of the same address get longer, up to 4 weeks. The `recidive` jail bans repeat offenders on all ports for 1 week. | [`jail.local`](../infra/files/fail2ban/jail.local) | `verify.sh`. A brute-force test from a second container got a ban on Debian 12 and 13. |
| Security updates | unattended-upgrades every day for Debian, Debian security, the Raspberry Pi archive and Docker CE. Reboot at `AUTO_REBOOT_TIME` if an update needs it. | [`52picloud-unattended-upgrades`](../infra/files/apt/52picloud-unattended-upgrades), [`50-updates.sh`](../infra/modules/50-updates.sh) | `verify.sh` runs `unattended-upgrade --dry-run`. |
| Kernel values | Reverse-path filter, no ICMP redirects, no source routes, SYN cookies, `kptr_restrict=2`, `dmesg_restrict=1`, no unprivileged eBPF, protected links, no core dumps of setuid programs. IP forwarding stays on for Docker. | [`90-picloud-hardening.conf`](../infra/files/sysctl/90-picloud-hardening.conf) | `verify.sh` compares each key with `/proc/sys`. |
| Docker Engine | `no-new-privileges` for all containers, log rotation, `live-restore`. The module installs the AppArmor parser when the kernel uses AppArmor. The Docker repository key must have the expected fingerprint. | [`daemon.json`](../infra/files/docker/daemon.json), [`90-docker.sh`](../infra/modules/90-docker.sh) | `verify.sh` |
| Published ports | Only the gateway publishes ports on all interfaces (80 and 443). Prometheus binds to `127.0.0.1`. | [`docker-compose.yml`](../deploy/docker-compose.yml) | `verify.sh` warns about each other published port. |
| Logs | Persistent journal (200 MB, 2 weeks). UFW logs blocked packets at level `low`. Alloy sends SSH, UFW and fail2ban events to Loki. | [`90-picloud.conf`](../infra/files/journald/90-picloud.conf), [`config.alloy`](../deploy/alloy/config.alloy) | The **Security events** panel in Grafana. |

### Gateway

| Control | Configuration | File | Check |
| --- | --- | --- | --- |
| TLS | TLS 1.2 and 1.3 only, ECDHE cipher suites only, no session tickets. Port 80 serves only the redirect and the ACME challenge path. | [`tls.conf`](../deploy/nginx/snippets/tls.conf), [`picloud.conf.template`](../deploy/nginx/templates/picloud.conf.template) | `smoke-test.sh` checks the redirect. |
| Headers | HSTS (1 year), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`. A Content-Security-Policy on the SPA: scripts and connections from the same origin only, `frame-ancestors 'none'`. | [`security-headers.conf`](../deploy/nginx/snippets/security-headers.conf), [`picloud.conf.template`](../deploy/nginx/templates/picloud.conf.template) | `smoke-test.sh` checks HSTS, CSP and `nosniff`. |
| Authentication | Basic auth on all HTTPS paths except `/api/health`. Passwords of 12 characters or more, hashed with SHA-512 crypt. | [`create-htpasswd.sh`](../deploy/scripts/create-htpasswd.sh) | `smoke-test.sh` expects 401 without credentials. |
| Chat rate limit | 30 requests per minute per IP, burst 10. The answer is a JSON 429 with `Retry-After`. | [`nginx.conf`](../deploy/nginx/nginx.conf) | Gateway probe during the deploy review. |
| Request size | 1 MB body limit, 2 MB on `/api/chat`. | [`nginx.conf`](../deploy/nginx/nginx.conf) | Gateway probe during the deploy review. |
| Hidden routes | The gateway does not route the API `/metrics`. `/api/health` always goes upstream as the normalized path. | [`picloud.conf.template`](../deploy/nginx/templates/picloud.conf.template) | `smoke-test.sh` checks that `/metrics` is not exposed. |

### Application

| Control | Configuration | File | Check |
| --- | --- | --- | --- |
| Chat key | Optional `PICLOUD_API_KEY`. `POST /api/chat` then needs `X-API-Key`. Constant-time compare. A bad key gets 403. | [`security.py`](../api/src/picloud_api/security.py), [`chat.py`](../api/src/picloud_api/routes/chat.py) | API tests |
| API rate limit | Token bucket of 20 requests per minute per client address. Uvicorn uses `X-Forwarded-For` only from `FORWARDED_ALLOW_IPS` (the gateway, `172.30.0.10`). | [`security.py`](../api/src/picloud_api/security.py), [`docker-compose.yml`](../deploy/docker-compose.yml) | A test proves that a direct client cannot change its key with that header. |
| Input validation | 1 to 50 messages, 1 to 8000 characters each, `max_tokens` capped. A 422 response does not repeat the input. | [`chat.py`](../api/src/picloud_api/routes/chat.py), [`main.py`](../api/src/picloud_api/main.py) | API tests |
| Metric labels | Route templates, not raw paths. Unknown HTTP methods share the label `OTHER`. | [`middleware.py`](../api/src/picloud_api/middleware.py) | API tests |
| Safe output | The chat renders a Markdown subset as React text nodes. No HTML, links or images. No `dangerouslySetInnerHTML`. The parser runs in linear time. | [`markdown.ts`](../web/src/lib/markdown.ts) | Web tests |
| Secrets in logs | The API never logs prompts, answers or keys. SDK and HTTP client loggers stay at `WARNING` or higher, because their debug output has request bodies. | [`logging.py`](../api/src/picloud_api/logging.py) | API tests |

### Containers

| Service | User | Read-only root | Notes |
| --- | --- | --- | --- |
| gateway | nginx (101) | Yes | `/tmp` and `/etc/nginx/conf.d` on tmpfs. |
| api | picloud (10001) | Yes | `/tmp` on tmpfs. |
| agent | nonroot (65532), group video (44) | Yes | Distroless static image. Read-only host mounts and the mailbox device. |
| ollama | root, no capabilities | Yes | Models in a volume. |
| prometheus | nobody (65534) | Yes | |
| grafana | grafana (472) | Yes | No plugin downloads at start. |
| loki | 10001 | Yes | |
| alloy | root, no capabilities | Yes | Docker socket, see below. |

All services have `cap_drop: [ALL]` with no capability added back,
`no-new-privileges`, memory and CPU limits, and log rotation. Third-party images
have fixed version tags.

### Secrets

| Secret | Location | Protection |
| --- | --- | --- |
| Provider keys, chat key, Grafana admin password | `deploy/.env` | Git ignores it. Mode 0600. The API holds keys as `SecretStr`. |
| Host configuration, DDNS password | `infra/config.env` | Git ignores it. `bootstrap.sh` runs it as root, so it stops if root does not own the file or if other users can write to it. |
| TLS private key, htpasswd | `deploy/nginx/certs/privkey.pem`, `deploy/nginx/htpasswd` | Git ignores them. With `sudo`, the scripts make them mode 0640, group 101 (the gateway). |
| DDNS credentials | `/etc/ddclient.conf` | Mode 0600, owner root. |
| Chat key in the browser | `localStorage` | Sent only with chat requests. The CSP limits scripts to the same origin. |

The dry run of `bootstrap.sh` prints only the name of a file that other users
cannot read. It does not print the content, because the file can hold secrets.

## Alloy and the Docker socket

Alloy reads container logs through `/var/run/docker.sock`. Access to this socket
is equal to root access on the host. The `:ro` mount option stops writes to the
socket file only. It does not stop Docker API calls.

These controls decrease the risk:

- Alloy is the only container with the socket.
- The image is the official `grafana/alloy` image with a fixed tag.
- Alloy has no published port, no capabilities and a read-only root filesystem.
- The Alloy configuration is a read-only mount.

To decrease the risk more, put a socket proxy in front of the socket, for
example `tecnativa/docker-socket-proxy`. Allow only the read calls for
containers. The project does not include this proxy.

## Docker-published ports and UFW

Docker writes its own iptables rules for published container ports. These rules
come before the UFW rules. Thus a published port is open to the network, also
when UFW denies that port.

- The stack publishes only ports 80 and 443 on all interfaces. These ports are
  public by design.
- Prometheus binds to `127.0.0.1:9090`. Use an SSH tunnel to open it.
- `infra/verify.sh` warns about each other container port on `0.0.0.0` or
  `[::]`.
- The `docker` module keeps the Docker userland proxy on. If the proxy is off,
  Docker sets `route_localnet` on its bridges. On older Docker releases, LAN
  hosts could then reach ports on `127.0.0.1`.

Do not publish other ports on all interfaces. Bind a debug port to `127.0.0.1`
and use an SSH tunnel.

## Privacy

- Ollama runs on the Pi. With the local model, the chat stays on the Pi.
- A cloud provider receives the chat messages. When the context option is on,
  it also receives the telemetry summary: hostname, Pi model, OS, kernel,
  temperature, CPU, memory and disk use, and throttle flags.
- Turn off **Include live system context** in the chat to send no telemetry.
  Remove the cloud keys to keep all chats on the Pi.

## Known limitations

- **Not tested on Pi hardware.** The host modules ran in Debian 12 and 13 arm64
  containers with systemd. The full stack ran on a laptop with the agent in demo
  mode. The sysfs paths, the mailbox device, the `sysctl` module, the static IP
  activation and the live DDNS update did not run on a real Pi.
- **Basic auth is one factor.** It has no second factor, no lockout and no
  logout. fail2ban does not watch the gateway log. Use a long random password.
- **The password hash is fast.** SHA-512 crypt is faster to guess than bcrypt
  if a person gets the `htpasswd` file. nginx checks the hash on each request,
  and bcrypt was too slow for the gateway CPU limit.
- **No alert notifications.** The stack has no Alertmanager. Active alerts show
  in Grafana and in Prometheus only.
- **The docker group is equal to root.** The `docker` module adds the admin user
  to this group. Its members can mount `/` into a container.
- **Host access of the agent.** The agent service has read-only mounts of
  `/proc`, `/sys` and `/`, and the firmware mailbox device. The device accepts
  firmware commands. The agent sends only `get_throttled`. The agent does not
  share the PID namespace of the host (no `pid: host`).
- **Grafana Viewer for all gateway users.** Each person with the site password
  can read all dashboards and logs. This includes the security log.
- **Rate limits are in memory.** A restart of the API or the gateway resets
  them.
- **The SPA CSP allows inline styles** (`style-src 'unsafe-inline'`). The web
  build works without it, so a later release can remove it.
- **HSTS has no `includeSubDomains` and no preload.**
- **Self-signed certificates** cause a browser warning. Use Let's Encrypt for a
  public name.
- **The log2ram repository key is not pinned.** The Docker key has a fingerprint
  check. The azlux key for log2ram does not. log2ram is off by default.
- **Model answers can be wrong.** The first real `llama3.2:1b` answer in the
  integration test named a cause that the telemetry did not show. Do not act on
  an answer without a check.
