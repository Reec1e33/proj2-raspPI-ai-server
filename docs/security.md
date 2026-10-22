# Security

PiCloud is a home server with ports 80 and 443 open to the internet, so it gets
scanned all day. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Threat model

What's worth protecting: root on the Pi (and through it, the home network), the
cloud API keys in `deploy/.env`, which cost money if stolen, the gateway and
Grafana passwords, and the chat history and telemetry.

Who I expect, and what stops them:

- Bots guessing SSH passwords and scanning for known exploits. Key-only SSH,
  UFW, fail2ban, automatic updates, and basic auth on every HTTPS path.
- Someone who knows the URL and wants to guess the password or burn API credit
  through the chat. A long random password, two rate limits on the chat, and an
  optional chat key.
- A compromised device on the LAN. UFW denies inbound by default, only the
  gateway publishes ports, and Prometheus is on localhost.
- Family with the site password. They get Grafana's Viewer role, and the chat
  key can stay separate.
- The supply chain. Pinned image tags, a fingerprint check on the Docker
  repository key, and committed lock files.
- The model. It has no tools, and its output is rendered as a Markdown subset
  with no HTML, links or images.

Physical access is out of scope. Whoever has the SD card has everything.

## Host

SSH ([`10-picloud-hardening.conf`](../infra/files/ssh/10-picloud-hardening.conf))
takes public keys only, for one user, with no root login and only local port
forwarding (for the Prometheus tunnel). [`20-ssh.sh`](../infra/modules/20-ssh.sh)
filters the algorithm lists against what the local OpenSSH supports. It won't
turn off password login until the admin user has a valid key, and it tests the
new config with `sshd -t` and restores the old one if that fails.

UFW ([`30-firewall.sh`](../infra/modules/30-firewall.sh)) denies inbound except
SSH, 80, 443 and any LAN-only ports in `LAN_ALLOW_PORTS`, and rate-limits SSH.
fail2ban ([`jail.local`](../infra/files/fail2ban/jail.local)) bans for an hour
after 5 failed logins in 10 minutes. Repeat bans grow up to 4 weeks, and the
`recidive` jail blocks persistent offenders on all ports for a week.

unattended-upgrades installs security and OS updates daily (Docker CE too,
unless you turn that off) and reboots at `AUTO_REBOOT_TIME` when needed. The
[sysctl file](../infra/files/sysctl/90-picloud-hardening.conf) has the usual
network and kernel hardening, with IP forwarding left on for Docker. Docker runs
every container with `no-new-privileges`
([`daemon.json`](../infra/files/docker/daemon.json)). Alloy ships the SSH, UFW
and fail2ban events to Loki, where the Grafana dashboard has a security log
panel.

`infra/verify.sh` checks most of this against the running system, for example
by comparing `sshd -T` and `/proc/sys` with the expected values.

## Gateway

TLS 1.2 and 1.3 only, with ECDHE suites. Port 80 only redirects to HTTPS and
serves ACME challenges. Responses get HSTS, `nosniff`, `Referrer-Policy` and
`Permissions-Policy`, and the SPA gets a strict same-origin
Content-Security-Policy. Grafana sends its own CSP.

Basic auth covers every HTTPS path except `/api/health`.
[`create-htpasswd.sh`](../deploy/scripts/create-htpasswd.sh) wants at least 12
characters and hashes with SHA-512 crypt. nginx strips the basic-auth header
before proxying to Grafana, which treats everyone as an anonymous Viewer until
they log in as admin.

Request bodies are capped at 1 MB (2 MB for chat), and the API's `/metrics`
isn't routed. [`smoke-test.sh`](../deploy/scripts/smoke-test.sh) checks the
redirect, the 401 without credentials, the headers, and that `/metrics` stays
hidden.

## API and dashboard

The chat key (`PICLOUD_API_KEY`) is compared in constant time. A wrong key gets
a 403, not a 401, because a 401 makes the browser drop the saved basic-auth
login. Uvicorn only reads `X-Forwarded-For` from the gateway
(`FORWARDED_ALLOW_IPS`), so a fake header can't dodge the rate limit.

Validation errors don't echo the input, and metrics are labelled by route
template so a scanner can't create unlimited series. The API never logs
prompts, answers or keys, and it holds the HTTP client and SDK loggers at
`WARNING` because their debug output includes request bodies.

The chat UI renders model output with
[`markdown.ts`](../web/src/lib/markdown.ts), which builds React text nodes. No
`dangerouslySetInnerHTML`.

## Containers

Every service drops all capabilities, runs with `no-new-privileges` and a
read-only root filesystem, and has memory and CPU limits. Most run as non-root.
Ollama and Alloy run as root in the container, with no capabilities.

The agent gets read-only mounts of the host's `/proc`, `/sys` and `/`, plus the
firmware mailbox device, but not the host PID namespace. The mailbox accepts any
firmware command. The agent only sends `get_throttled`.

## Secrets

`deploy/.env` holds the provider keys, the chat key and the Grafana admin
password. It's git-ignored and should be `chmod 600`. `infra/config.env` holds
the host settings and the DDNS password, and since `bootstrap.sh` sources it as
root, it refuses to run if root doesn't own it or others can write to it. The
dry run shows diffs only for world-readable files.

The TLS key and `htpasswd` are git-ignored too. When the scripts run with
`sudo`, they make both mode 0640 with group 101, so only the gateway can read
them. A chat key saved in the browser lives in `localStorage`.

## Alloy and the Docker socket

Alloy reads container logs through `/var/run/docker.sock`, and that socket is
root on the host. The `:ro` mount only stops writes to the socket file, not
Docker API calls. Alloy is the only container with it, uses a pinned official
image, and publishes no ports. To go further, put a socket proxy such as
`tecnativa/docker-socket-proxy` in front and allow only the container read
calls. That isn't included.

## Docker ports and UFW

Docker's iptables rules for published ports run before UFW's, so a published
port is open even if UFW denies it. That's why only the gateway publishes ports
on all interfaces, Prometheus binds to `127.0.0.1`, and `verify.sh` warns about
anything else on `0.0.0.0` or `[::]`. Bind debug ports to `127.0.0.1` and use an
SSH tunnel.

The userland proxy stays on. With it off, Docker sets `route_localnet` on its
bridges, and on older releases that let LAN hosts reach ports on `127.0.0.1`.

## Privacy

With Ollama, chats stay on the Pi. A cloud provider gets the messages and, if
"Include live system context" is on, a telemetry summary: hostname, Pi model,
OS, kernel, temperature, CPU, memory, disk and throttle flags. Turn that off to
send no telemetry, or remove the cloud keys to keep everything local.

## Known limitations

- Nothing has run on real Pi hardware yet. The host modules ran in Debian 12
  and 13 arm64 containers, and the stack ran on a laptop with the agent in demo
  mode. The sysfs paths, the mailbox device, sysctl, the static IP change and
  live DDNS updates are untested on a Pi.
- Basic auth is one factor, with no lockout and no logout, and fail2ban doesn't
  watch the gateway log.
- SHA-512 crypt is much faster to brute-force than bcrypt if someone gets the
  `htpasswd` file. bcrypt was too slow, because nginx checks the hash on every
  request.
- Alerts don't notify anyone. There's no Alertmanager.
- The admin user is in the `docker` group, which is effectively root.
- Everyone with the site password can read every Grafana dashboard and log,
  including the security log.
- Rate limits are in memory, so a restart resets them.
- The SPA's CSP still allows inline styles. The build works without them, so
  that can be removed later.
- HSTS has no `includeSubDomains` or preload, and the self-signed certificate
  triggers a browser warning. Use Let's Encrypt for a public name.
- The log2ram repository key isn't fingerprint-checked like the Docker key.
  log2ram is off by default.
- Model answers can be wrong. In testing, `llama3.2:1b` blamed a cause the
  telemetry didn't show.
