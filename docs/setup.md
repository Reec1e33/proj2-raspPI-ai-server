# Set up PiCloud on a Raspberry Pi

This guide goes from a blank SD card to a stack that runs and that you can reach
from the internet. Do the steps in order.

For a test on a laptop without a Pi, see the
[quick start](../README.md#quick-start-laptop-demo) in the main README.

## What you need

- A Raspberry Pi 5 or Pi 4 with 4 GB or 8 GB of RAM. The local LLM needs 8 GB.
- A microSD card of 32 GB or more, or a USB or NVMe SSD.
- The official power supply: 5 V/5 A for a Pi 5, 5 V/3 A for a Pi 4. A weak
  supply causes under-voltage.
- An Ethernet cable from the Pi to the router.
- A computer with an SSH client and [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
- Administrator access to the router, for port forwards and DHCP reservations.
- Optional: a No-IP or Cloudflare account for dynamic DNS, and an Anthropic or
  OpenAI-compatible API key.

In the commands below, replace these values with your values:

| Value | Example |
| --- | --- |
| `<user>` | The admin user that you set in Imager, for example `reece`. |
| `<pi-address>` | The LAN address of the Pi, for example `192.168.1.50`. |
| `pi.example.com` | The public DNS name of the Pi. |

## Step 1: Make an SSH key

Do this step on your computer. If you already have an Ed25519 key, go to step 2.

```sh
ssh-keygen -t ed25519 -C "picloud"
```

The public key is in `~/.ssh/id_ed25519.pub`.

## Step 2: Write the SD card

1. Start Raspberry Pi Imager.
2. Select your Pi model.
3. Select **Raspberry Pi OS (other)**, then **Raspberry Pi OS Lite (64-bit)**.
4. Select the SD card or the SSD.
5. Open the customization settings and set these values. The names of the
   settings can be different in your Imager version.

   | Imager option | Value |
   | --- | --- |
   | Hostname | `picloud` |
   | User name and password | Your admin user and a strong password. `sudo` asks for this password. |
   | Time zone | Your time zone. |
   | Wireless LAN | Empty, if you use Ethernet. |
   | SSH | On, with public-key authentication only. Paste the content of `~/.ssh/id_ed25519.pub`. |

6. Write the card.
7. Put the card in the Pi. Connect the Ethernet cable, then the power supply.

## Step 3: Log in for the first time

Do this step on your computer:

```sh
ssh <user>@picloud.local
```

If `picloud.local` does not resolve, find the address of the Pi in the DHCP
client list of the router. Then use `ssh <user>@<pi-address>`.

On the Pi, install Git:

```sh
sudo apt-get update
sudo apt-get install -y git
```

## Step 4: Clone the repository

The stack expects the repository in `/opt/picloud`. Make the directory, give it
to your user, and clone into it:

```sh
sudo install -d -o "$USER" -g "$(id -gn)" /opt/picloud
git clone https://github.com/Reec1e33/proj2-raspPI-ai-server.git /opt/picloud
```

## Step 5: Configure the host toolkit

1. Make the configuration file. `bootstrap.sh` runs this file as root, so root
   must own it:

   ```sh
   cd /opt/picloud/infra
   sudo cp config.env.example config.env
   sudo chmod 600 config.env
   ```

2. Open the file:

   ```sh
   sudo nano config.env
   ```

3. Set the values. `ADMIN_USER` is the only required value.

   | Variable | Value |
   | --- | --- |
   | `ADMIN_USER` | Your admin user. Only this user can log in with SSH. |
   | `PI_HOSTNAME` | `picloud` |
   | `TIMEZONE` | For example `America/Detroit`. |
   | `LAN_CIDR` | Your LAN, for example `192.168.1.0/24`. |
   | `STATIC_IP_CIDR`, `STATIC_GATEWAY` | For example `192.168.1.50/24` and `192.168.1.1`. Empty keeps DHCP. |
   | `AUTO_REBOOT_TIME` | The time for a reboot after an update that needs it. Default `04:00`. |
   | `UPGRADE_DOCKER` | `true` installs Docker Engine updates automatically. |
   | `LOG2RAM_ENABLE` | `true` keeps `/var/log` in RAM to decrease SD card writes. Logs since the last sync are lost if the power fails. |

   > **Caution:** Use a static address outside the DHCP pool of the router, or
   > reserve the address on the router. If you do not, two hosts can get the
   > same address.

Leave the `DDNS_*` values empty for now. Step 11 sets them.

## Step 6: Preview the changes

Run the dry run. It shows each command and each file change, and it changes
nothing.

```sh
sudo ./bootstrap.sh --dry-run
```

Read the output. Make sure that the SSH module finds your key.

## Step 7: Apply the host configuration

> **Caution:** Keep your current SSH session open until a new session works.
> If the new session fails, use the open session to correct the configuration.

> **Caution:** If you set `STATIC_IP_CIDR`, the address changes 10 seconds after
> the run. Your SSH session then stops. Connect again to the new address.

```sh
sudo ./bootstrap.sh
```

The run asks for a confirmation before a change of the SSH port or the address.
If the `ssh` module stops with `lockout guard`, your user has no valid key. Run
`ssh-copy-id <user>@<pi-address>` on your computer, then run `bootstrap.sh`
again.

## Step 8: Test a new SSH session

Open a new terminal on your computer, and log in:

```sh
ssh <user>@picloud.local
```

If the login fails with `Too many authentication failures`, your SSH agent
offers too many keys. Use this command:

```sh
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 <user>@picloud.local
```

Close the old session when the new session works. The new session also gives
your user the `docker` group.

## Step 9: Audit the host

```sh
cd /opt/picloud/infra
sudo ./verify.sh
```

The summary must show `0 FAIL`. At this point, a WARN for `picloud.service` is
normal, because the stack does not run yet. If the summary shows that a reboot
is necessary, run `sudo reboot` and log in again.

## Step 10: Configure and start the stack

1. Copy the settings template. The file holds API keys, so only its owner can
   read it:

   ```sh
   cd /opt/picloud/deploy
   cp .env.example .env && chmod 600 .env
   ```

2. Find the firmware mailbox device for the throttle state:

   ```sh
   ls -l /dev/vcio*
   ```

   > **Warning:** Do not keep the example Grafana password. Any person with the
   > gateway password can then log in to Grafana as the administrator. Grafana
   > reads the password only at its first start.

3. Edit `.env` (`nano .env`) and set these values:

   | Variable | Value |
   | --- | --- |
   | `SERVER_NAME` | `picloud.local` for now. Step 11 changes it to the public name. |
   | `GRAFANA_ADMIN_PASSWORD` | The output of `openssl rand -base64 24`. |
   | `PI_AGENT_MAILBOX_DEVICE` | `/dev/vcio_gencmd` if the `ls` command shows it. Else keep the default `/dev/vcio`. |
   | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Optional cloud fallback. |
   | `PICLOUD_API_KEY` | Optional second secret for the chat. |
   | `COMPOSE_PROFILES` | Keep `ollama` on an 8 GB Pi. On a 4 GB Pi, follow the [4 GB settings](../deploy/README.md#memory-budget). |

   > **Caution:** Run the certificate and htpasswd scripts with `sudo`. Without
   > root, the scripts make the private key and the password file readable by
   > all users.

4. Make a self-signed TLS certificate. Use your names and your LAN address:

   ```sh
   sudo ./scripts/gen-self-signed-cert.sh picloud.local IP:192.168.1.50
   ```

5. Make a user for the gateway. The script asks for the password two times. Use
   12 characters or more:

   ```sh
   sudo ./scripts/create-htpasswd.sh admin
   ```

6. Download the PiCloud images. The
   [Images workflow](../.github/workflows/images.yml) publishes them to GHCR for
   `linux/arm64` and `linux/amd64`. `PICLOUD_VERSION` in `.env` selects the tag:
   `latest`, or a release such as `2.0.0`.

   ```sh
   docker compose pull
   ```

   If the pull fails, for example because the images are not public, build them
   on the Pi. This takes some time:

   ```sh
   docker compose build
   ```

7. Start the stack. The first start of Grafana can take some minutes on an SD
   card:

   ```sh
   docker compose up -d --wait
   ```

8. Start `picloud.service`. The stack already runs, so this command changes
   nothing now. After each boot, the unit starts the stack:

   ```sh
   sudo systemctl start picloud
   ```

9. Download the default model (`llama3.2:1b`, about 1.3 GB):

   ```sh
   ./scripts/pull-model.sh
   ```

10. Test the stack on the Pi:

    ```sh
    SMOKE_USER=admin SMOKE_PASSWORD='<gateway password>' ./scripts/smoke-test.sh https://localhost
    ```

    The result must be `0 failed`.

11. On your computer, open `https://picloud.local/`. Accept the warning for the
    self-signed certificate, and log in with the gateway user. Grafana is at
    `https://picloud.local/grafana/`.

## Step 11: Forward ports and set up dynamic DNS

> **Warning:** Forward only ports 80 and 443 to the Pi. Do not forward
> Prometheus, Grafana or the API ports.

1. Reserve the address of the Pi on the router, or use the static address from
   step 5.
2. On the router, forward TCP port 80 and TCP port 443 to the address of the Pi.
3. For SSH from outside your home, use a VPN to your home network. If you
   forward the SSH port instead, the key-only login, the UFW rate limit and
   fail2ban protect it.
4. If your public IP address changes, set up dynamic DNS. Open
   `/opt/picloud/infra/config.env` with `sudo nano` and set the `DDNS_*` values:

   | Provider | Values |
   | --- | --- |
   | No-IP | `DDNS_PROVIDER="noip"`, `DDNS_HOSTNAME`, `DDNS_LOGIN`, `DDNS_PASSWORD` |
   | Cloudflare | `DDNS_PROVIDER="cloudflare"`, `DDNS_HOSTNAME`, `DDNS_ZONE`, `DDNS_PASSWORD` (an API token with Zone.DNS edit permission) |

5. Apply the DDNS module and check the service:

   ```sh
   cd /opt/picloud/infra
   sudo ./bootstrap.sh --only ddns
   systemctl status ddclient
   ```

6. Set `SERVER_NAME` in `/opt/picloud/deploy/.env` to the public name, for
   example `pi.example.com`. Then apply the change:

   ```sh
   cd /opt/picloud/deploy
   docker compose up -d --wait
   ```

## Step 12: Get a Let's Encrypt certificate

This step is optional, but a browser trusts the certificate with no warning.
Port 80 must reach the Pi (step 11). The gateway serves the ACME challenge path
from `deploy/nginx/acme/`.

1. Install certbot:

   ```sh
   sudo apt-get install -y certbot
   ```

2. Get the certificate:

   ```sh
   sudo certbot certonly --webroot -w /opt/picloud/deploy/nginx/acme -d pi.example.com
   ```

3. Copy the files to the gateway and reload nginx:

   ```sh
   live=/etc/letsencrypt/live/pi.example.com
   sudo install -m 0644 "$live/fullchain.pem" /opt/picloud/deploy/nginx/certs/
   sudo install -m 0640 -g 101 "$live/privkey.pem" /opt/picloud/deploy/nginx/certs/
   docker compose -f /opt/picloud/deploy/docker-compose.yml exec gateway nginx -s reload
   ```

4. Make a deploy hook, so that certbot copies the files after each renewal.
   Write this content to `/etc/letsencrypt/renewal-hooks/deploy/picloud.sh`
   (`sudo nano`):

   ```sh
   #!/bin/sh
   set -e
   live=/etc/letsencrypt/live/pi.example.com
   install -m 0644 "$live/fullchain.pem" /opt/picloud/deploy/nginx/certs/
   install -m 0640 -g 101 "$live/privkey.pem" /opt/picloud/deploy/nginx/certs/
   docker compose -f /opt/picloud/deploy/docker-compose.yml exec -T gateway nginx -s reload
   ```

5. Make the hook executable:

   ```sh
   sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/picloud.sh
   ```

## Step 13: Test from the internet

Many routers do not send a LAN client to their own public address. Thus do this
test from another network, for example a phone hotspot.

On your computer, in a clone of this repository (the script needs `curl` and
`jq`):

```sh
SMOKE_USER=admin SMOKE_PASSWORD='<gateway password>' SMOKE_VERIFY_TLS=1 \
  ./deploy/scripts/smoke-test.sh https://pi.example.com
```

`SMOKE_VERIFY_TLS=1` makes the script check the certificate. Use it with a Let's
Encrypt certificate only.

## Next steps

- [operations.md](operations.md): updates, secrets, backups, logs, alerts and
  troubleshooting.
- [security.md](security.md): the threat model and the known limits.
- [infra/README.md](../infra/README.md) and [deploy/README.md](../deploy/README.md):
  all options of the host toolkit and the stack.
