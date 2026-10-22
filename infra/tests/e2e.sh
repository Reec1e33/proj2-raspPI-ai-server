#!/usr/bin/env bash
#
# End-to-end test: boot Debian with systemd in a privileged container, then
#   1. bootstrap.sh --dry-run    must not write anything under /etc
#   2. bootstrap.sh              real run
#   3. bootstrap.sh              second run must change nothing
#   4. verify.sh                 must report no FAIL, as root and as the admin user
#
# Usage: tests/e2e.sh [bookworm|trixie]      (needs Docker; takes a few minutes)
#
# Not covered: the sysctl module (a container shares the host kernel), the
# network module (no NetworkManager) and ddns (it would call a real provider).
# systemd-timesyncd cannot run in a container, so the NTP step re-applies on
# every run there; the idempotency check ignores that one line.

set -Eeuo pipefail

CODENAME=${1:-bookworm}
INFRA_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
NAME=picloud-infra-e2e-$CODENAME
IMAGE=$NAME:latest
SKIP=sysctl,network,ddns

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$NAME-docker" "$NAME-containerd" >/dev/null 2>&1 || true
}
in_box() { docker exec "$NAME" "$@"; }
fail() {
  printf 'e2e FAILED: %s\n' "$*" >&2
  exit 1
}
step() { printf '\n=== %s\n' "$*"; }

trap cleanup EXIT
cleanup

step "build and boot $IMAGE"
docker build -q --build-arg CODENAME="$CODENAME" -t "$IMAGE" "$INFRA_DIR/tests/e2e" >/dev/null
# Named volumes for the Docker data dirs: overlayfs cannot nest on overlayfs.
docker run -d --name "$NAME" --hostname picloud --add-host picloud:127.0.1.1 \
  --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  -v "$NAME-docker:/var/lib/docker" -v "$NAME-containerd:/var/lib/containerd" \
  -v "$INFRA_DIR:/opt/picloud/infra:ro" "$IMAGE" >/dev/null
for _ in {1..60}; do
  [[ $(in_box systemctl is-system-running 2>/dev/null) =~ running|degraded ]] && break
  sleep 1
done

step "config, SSH key and a stub compose stack"
# shellcheck disable=SC2016 # expanded by the shell inside the container
in_box bash -euc '
  ssh-keygen -q -t ed25519 -N "" -C e2e -f /root/id_e2e
  printf "%s\n" "ADMIN_USER=reece" "SSH_AUTHORIZED_KEY=\"$(cat /root/id_e2e.pub)\"" \
    "TIMEZONE=Europe/London" "LAN_CIDR=192.168.1.0/24" "LAN_ALLOW_PORTS=\"9100/tcp\"" >/root/config.env
  chmod 600 /root/config.env
  # The container is not a Pi: no mailbox device, as deploy/README.md documents.
  # Mode 600 as deploy/README.md sets it, so the audit as reece cannot read it.
  mkdir -p /opt/picloud/deploy && echo "PI_AGENT_MAILBOX_DEVICE=/dev/null" >/opt/picloud/deploy/.env
  chmod 600 /opt/picloud/deploy/.env
  printf "%s\n" "services:" "  web:" "    image: busybox:1.36" "    command: [httpd, -f, -p, \"80\"]" \
    "    ports: [\"80:80\", \"127.0.0.1:9090:80\"]" >/opt/picloud/deploy/docker-compose.yml
  touch /root/before-dry-run'

BOOTSTRAP=(/opt/picloud/infra/bootstrap.sh --yes --config /root/config.env --skip "$SKIP")

step "dry-run"
in_box "${BOOTSTRAP[@]}" --dry-run
written=$(in_box find /etc /var/backups -newer /root/before-dry-run -type f)
[[ -z $written ]] || fail "dry-run wrote files: $written"

step "first run"
in_box "${BOOTSTRAP[@]}"

step "second run (must change nothing)"
out=$(in_box "${BOOTSTRAP[@]}" 2>&1)
printf '%s\n' "$out"
changes=$(grep '^  ~ ' <<<"$out" | grep -v 'enable NTP time sync' || true)
[[ -z $changes ]] || fail "second run changed: $changes"

step "verify"
in_box systemctl start picloud.service
out=$(in_box /opt/picloud/infra/verify.sh --config /root/config.env 2>&1 || true)
printf '%s\n' "$out"
fails=$(grep '^\[FAIL\]' <<<"$out" | grep -v '^\[FAIL\] sysctl ' || true)
[[ -z $fails ]] || fail "verify reported: $fails"
grep -q '^\[SKIP\] agent throttle state: off' <<<"$out" || fail "verify did not read deploy/.env as root"

step "verify as the admin user (no root, no sudo password)"
# Root-only checks must report WARN, never a false FAIL.
out=$(docker exec -u reece "$NAME" /opt/picloud/infra/verify.sh --quick 2>&1 || true)
printf '%s\n' "$out"
grep -q '^\[WARN\] ssh: not checked (needs root' <<<"$out" || fail "verify did not run without root"
grep -q '^\[WARN\] agent mailbox device in .*: not checked (needs root' <<<"$out" ||
  fail "verify guessed the mailbox device without access to deploy/.env"
fails=$(grep '^\[FAIL\]' <<<"$out" | grep -v '^\[FAIL\] sysctl ' || true)
[[ -z $fails ]] || fail "verify as reece reported: $fails"

printf '\ne2e passed on %s\n' "$CODENAME"
