# Setting up PiCloud on a Raspberry Pi

From a blank SD card to a stack you can reach from the internet. The host
scripts have only run in Debian containers so far, not on a real Pi, so expect
rough edges. To try it without a Pi, use the
[laptop demo](../README.md#try-it-on-a-laptop).

## What you need

- A Pi 5 or Pi 4 with 4 or 8 GB of RAM (the local LLM wants 8).
- A 32 GB+ microSD card, or better, an SSD.
- The official power supply. Cheap ones cause under-voltage.
- Ethernet, admin access to your router, and
  [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
- Optional: a No-IP or Cloudflare account for dynamic DNS, and an Anthropic or
  OpenAI-compatible API key.

Below, `<user>` is the admin user you create in Imager, `<pi-address>` is the
Pi's LAN address (say `192.168.1.50`), and `pi.example.com` is its public name.

## 1. Flash the card

If you don't have an Ed25519 key yet, make one:

```sh
ssh-keygen -t ed25519 -C "picloud"
```

In Imager, pick **Raspberry Pi OS Lite (64-bit)** (under "Raspberry Pi OS
(other)"). In the customization settings, set the hostname to `picloud`, create
your admin user with a strong password (`sudo` asks for it), set your time zone,
and turn on SSH with public-key auth only, pasting in `~/.ssh/id_ed25519.pub`.
Write the card, boot the Pi on Ethernet, and log in:

```sh
ssh <user>@picloud.local
```

If `picloud.local` doesn't resolve, find the Pi in your router's DHCP client
list and use its address.

## 2. Clone the repo

The stack expects to live in `/opt/picloud`:

```sh
sudo apt-get update && sudo apt-get install -y git
sudo install -d -o "$USER" -g "$(id -gn)" /opt/picloud
git clone https://github.com/Reec1e33/proj2-raspPI-ai-server.git /opt/picloud
```

## 3. Configure the host

`bootstrap.sh` sources `config.env` as root, so it refuses to run unless root
owns the file and nobody else can write to it.

```sh
cd /opt/picloud/infra
sudo cp config.env.example config.env
sudo chmod 600 config.env
sudo nano config.env
```

Only `ADMIN_USER` is required. Also check `TIMEZONE` and `LAN_CIDR`. To get a
static address, set `STATIC_IP_CIDR` and `STATIC_GATEWAY` (empty keeps DHCP),
and pick an address outside the router's DHCP pool so nothing else gets it.
`LOG2RAM_ENABLE="true"` keeps `/var/log` in RAM to save SD card writes, at the
cost of recent logs on a power cut. Leave the `DDNS_*` values for later.

## 4. Run the bootstrap

Do a dry run first. It changes nothing. Check that the SSH module finds your
key.

```sh
sudo ./bootstrap.sh --dry-run
```

Keep this SSH session open until a new one works, so you can fix things if
you get locked out. If you set a static IP, it takes effect about 10 seconds
after the run and drops your session, so reconnect to the new address.

```sh
sudo ./bootstrap.sh
```

If the `ssh` module stops with `lockout guard`, your user has no valid key.
Run `ssh-copy-id <user>@<pi-address>` from your computer (or set
`SSH_AUTHORIZED_KEY` in `config.env`), then rerun the bootstrap.

Log in from a new terminal. If you get `Too many authentication failures`, add
`-o IdentitiesOnly=yes -i ~/.ssh/id_ed25519`. Once it works, close the old
session; the new one also has your user in the `docker` group. Then audit the
host:

```sh
cd /opt/picloud/infra
sudo ./verify.sh
```

You want `0 FAIL`. A WARN for `picloud.service` is fine, since the stack isn't
running yet. If it asks for a reboot, `sudo reboot` and log back in.

## 5. Configure and start the stack

```sh
cd /opt/picloud/deploy
cp .env.example .env && chmod 600 .env
ls -l /dev/vcio*
```

Change the example Grafana password before the first start. Grafana reads it
only once, and otherwise anyone with the gateway login gets Grafana admin. Then
edit `.env`:

- `GRAFANA_ADMIN_PASSWORD`: the output of `openssl rand -base64 24`.
- `PI_AGENT_MAILBOX_DEVICE`: `/dev/vcio_gencmd` if the `ls` showed it,
  otherwise leave the default `/dev/vcio`.
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for a cloud fallback, and
  `PICLOUD_API_KEY` for a second secret on the chat. Both optional.
- `COMPOSE_PROFILES`: keep `ollama` on an 8 GB Pi. On 4 GB, use the
  [4 GB settings](../deploy/README.md#memory-budget).

Leave `SERVER_NAME` as `picloud.local` for now.

Run the next two scripts with `sudo`, or the private key and password file end
up world-readable. They make a self-signed certificate (use your LAN address)
and a gateway login (12+ character password):

```sh
sudo ./scripts/gen-self-signed-cert.sh picloud.local IP:192.168.1.50
sudo ./scripts/create-htpasswd.sh admin
```

The [Images workflow](../.github/workflows/images.yml) publishes arm64 and amd64
images to GHCR, and `PICLOUD_VERSION` in `.env` picks the tag (`latest` or a
release like `2.0.0`). Grafana's first start can take a few minutes on an SD
card.

```sh
docker compose pull
docker compose up -d --wait
sudo systemctl start picloud
```

If the pull fails, build on the Pi with `docker compose build` (slow). The
`systemctl start` is a no-op now, but that unit is what brings the stack up
after each boot.

Pull the default model (`llama3.2:1b`, about 1.3 GB) and run the smoke test:

```sh
./scripts/pull-model.sh
SMOKE_USER=admin SMOKE_PASSWORD='<gateway password>' ./scripts/smoke-test.sh https://localhost
```

It should end with `0 failed`. Then open `https://picloud.local/`, click
through the certificate warning, and log in. Grafana is at `/grafana/`.

## 6. Open it to the internet

Forward only ports 80 and 443, never Prometheus, Grafana, or the API.

Reserve the Pi's address on the router (or use your static IP) and forward TCP
80 and 443 to it. For SSH from outside, use a VPN into your home network. If you
forward SSH anyway, key-only login, the UFW rate limit, and fail2ban protect it.

If your public IP changes, set up dynamic DNS in
`/opt/picloud/infra/config.env` (`sudo nano`):

- No-IP: `DDNS_PROVIDER="noip"`, plus `DDNS_HOSTNAME`, `DDNS_LOGIN`, and
  `DDNS_PASSWORD`.
- Cloudflare: `DDNS_PROVIDER="cloudflare"`, plus `DDNS_HOSTNAME`, `DDNS_ZONE`,
  and `DDNS_PASSWORD` (an API token with Zone.DNS edit permission).

Apply just that module and check ddclient:

```sh
cd /opt/picloud/infra
sudo ./bootstrap.sh --only ddns
systemctl status ddclient
```

Set `SERVER_NAME` in `/opt/picloud/deploy/.env` to your public name and apply
it:

```sh
cd /opt/picloud/deploy
docker compose up -d --wait
```

## 7. Get a Let's Encrypt certificate

Optional, but it gets rid of the browser warning. Port 80 has to reach the Pi,
because the gateway serves the ACME challenge from `deploy/nginx/acme/`.

```sh
sudo apt-get install -y certbot
sudo certbot certonly --webroot -w /opt/picloud/deploy/nginx/acme -d pi.example.com
```

Copy the cert into the gateway and reload nginx:

```sh
live=/etc/letsencrypt/live/pi.example.com
sudo install -m 0644 "$live/fullchain.pem" /opt/picloud/deploy/nginx/certs/
sudo install -m 0640 -g 101 "$live/privkey.pem" /opt/picloud/deploy/nginx/certs/
docker compose -f /opt/picloud/deploy/docker-compose.yml exec gateway nginx -s reload
```

So renewals get copied too, save this as
`/etc/letsencrypt/renewal-hooks/deploy/picloud.sh` and `sudo chmod 755` it:

```sh
#!/bin/sh
set -e
live=/etc/letsencrypt/live/pi.example.com
install -m 0644 "$live/fullchain.pem" /opt/picloud/deploy/nginx/certs/
install -m 0640 -g 101 "$live/privkey.pem" /opt/picloud/deploy/nginx/certs/
docker compose -f /opt/picloud/deploy/docker-compose.yml exec -T gateway nginx -s reload
```

## 8. Test from outside

Many routers won't loop LAN traffic back to their own public address, so test
from another network, like a phone hotspot. From a clone of the repo (needs
`curl` and `jq`):

```sh
SMOKE_USER=admin SMOKE_PASSWORD='<gateway password>' SMOKE_VERIFY_TLS=1 \
  ./deploy/scripts/smoke-test.sh https://pi.example.com
```

Drop `SMOKE_VERIFY_TLS=1` if you're still on the self-signed certificate.

Next: [operations.md](operations.md) for updates, backups, and alerts, and
[security.md](security.md) for the threat model. Every option is in
[infra/README.md](../infra/README.md) and [deploy/README.md](../deploy/README.md).
