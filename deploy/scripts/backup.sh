#!/usr/bin/env bash
# Back up PiCloud configuration and state into one archive.
#
# Usage: backup.sh [-d DIR] [-k KEEP] [--with-data]
#   -d DIR       destination directory (default: /var/backups/picloud)
#   -k KEEP      number of archives to keep (default: 7)
#   --with-data  also copy the Prometheus and Loki volumes (large)
#
# Archive DIR/picloud-<UTC timestamp>.tar.gz (mode 0600) contains:
#   config/   deploy/.env, nginx/htpasswd, nginx/certs/
#   volumes/  grafana-data.tar.gz (+ prometheus-data, loki-data with --with-data)
# Ollama models are left out: pull-model.sh downloads them again.
# A running service is stopped while its volume is copied, so the copy is
# consistent, and is started again afterwards. Run as root (the private key and
# htpasswd are readable only by root and the gateway).
set -euo pipefail
umask 077

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEPLOY_DIR
readonly PROJECT="picloud" # compose project name (`name:` in docker-compose.yml)
readonly HELPER_IMAGE="alpine:3.24.2"

dest="/var/backups/picloud"
keep=7
with_data=0
stopped_service=""
work=""

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  # Print the header comment: line 2 up to the first line that is not a comment.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
  exit "${1:-0}"
}

compose() {
  docker compose --progress quiet --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.yml" "$@"
}

cleanup() {
  if [[ -n "$stopped_service" ]]; then
    echo "Restarting $stopped_service after an error" >&2
    compose start "$stopped_service" >/dev/null || true
  fi
  if [[ -n "$work" ]]; then rm -rf "$work"; fi
}
trap cleanup EXIT

# Copy named volume VOLUME of SERVICE to $work/volumes/VOLUME.tar.gz.
backup_volume() {
  local service="$1" volume="$2"
  local full_name="${PROJECT}_${volume}"
  if ! docker volume inspect "$full_name" >/dev/null 2>&1; then
    echo "Skipping $full_name: volume does not exist"
    return 0
  fi
  if compose ps --status running --services | grep -qx "$service"; then
    echo "Stopping $service to copy $full_name"
    stopped_service="$service"
    compose stop "$service" >/dev/null
  fi
  docker run --rm --network none -v "$full_name:/data:ro" "$HELPER_IMAGE" \
    tar -C /data -czf - . >"$work/volumes/$volume.tar.gz"
  if [[ -n "$stopped_service" ]]; then
    compose start "$service" >/dev/null
    stopped_service=""
  fi
}

while (($# > 0)); do
  case "$1" in
    -d) dest="${2:?-d needs a directory}" && shift 2 ;;
    -k) keep="${2:?-k needs a number}" && shift 2 ;;
    --with-data) with_data=1 && shift ;;
    -h | --help) usage ;;
    *) usage 1 ;;
  esac
done
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || die "KEEP must be a positive integer"
command -v docker >/dev/null || die "docker is not installed"

mkdir -p "$dest"
work="$(mktemp -d)"
mkdir -p "$work/config/nginx" "$work/volumes"

for path in .env nginx/htpasswd nginx/certs; do
  if [[ -e "$DEPLOY_DIR/$path" ]]; then
    cp -Rp "$DEPLOY_DIR/$path" "$work/config/$path"
  fi
done

backup_volume grafana grafana-data
if ((with_data)); then
  backup_volume prometheus prometheus-data
  backup_volume loki loki-data
fi

archive="$dest/picloud-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -C "$work" -czf "$archive" config volumes
echo "Wrote $archive ($(du -h "$archive" | awk '{print $1}'))"

# Timestamped names sort chronologically, so the glob lists the oldest first.
archives=("$dest"/picloud-*.tar.gz)
excess=$((${#archives[@]} - keep))
for ((i = 0; i < excess; i++)); do
  rm -f -- "${archives[i]}"
  echo "Removed old backup ${archives[i]}"
done
