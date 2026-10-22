#!/usr/bin/env bash
# Generate a self-signed TLS certificate for the PiCloud gateway.
#
# Usage: gen-self-signed-cert.sh [-f] [NAME] [SAN...]
#   NAME  DNS name for the certificate. Default: SERVER_NAME from
#         deploy/.env, else "localhost".
#   SAN   extra subjectAltName entries, e.g. DNS:pi.lan IP:192.168.1.50
#   -f    replace an existing certificate
#
# "localhost" and 127.0.0.1 are always included.
# Output: deploy/nginx/certs/{fullchain,privkey}.pem (ECDSA P-256, 825 days).
# For a public DNS name, prefer a Let's Encrypt certificate (deploy/README.md).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEPLOY_DIR
readonly CERT_DIR="$DEPLOY_DIR/nginx/certs"
readonly GATEWAY_GID=101 # the nginx group inside the gateway image

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  # Print the header comment: line 2 up to the first line that is not a comment.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
  exit "${1:-0}"
}

# Print the value of KEY from deploy/.env (empty when absent).
env_value() {
  [[ -f "$DEPLOY_DIR/.env" ]] || return 0
  sed -n "s/^$1=//p" "$DEPLOY_DIR/.env" | tail -n 1 | tr -d "\"'"
}

# Turn a host name or IPv4 address into a subjectAltName entry.
san_entry() {
  if [[ "$1" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    echo "IP:$1"
  else
    echo "DNS:$1"
  fi
}

sans=()
# Append a SAN entry unless it is already present (bash 3.2 safe: no assoc arrays).
add_san() {
  case " ${sans[*]-} " in
    *" $1 "*) ;;
    *) sans+=("$1") ;;
  esac
}

force=0
case "${1:-}" in
  -h | --help) usage ;;
  -f)
    force=1
    shift
    ;;
esac

name="${1:-$(env_value SERVER_NAME)}"
name="${name:-localhost}"
if (($# > 0)); then shift; fi

command -v openssl >/dev/null || die "openssl is not installed"
if [[ -e "$CERT_DIR/privkey.pem" && $force -eq 0 ]]; then
  die "$CERT_DIR/privkey.pem exists; use -f to replace it"
fi

for host in "$name" localhost 127.0.0.1; do
  add_san "$(san_entry "$host")"
done
for extra in "$@"; do
  add_san "$extra"
done
san_list="$(IFS=,; echo "${sans[*]}")"

mkdir -p "$CERT_DIR"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# named_curve: LibreSSL (macOS) otherwise writes explicit curve parameters,
# which TLS 1.3 clients and browsers reject.
if ! (
  umask 077
  openssl req -x509 -nodes -sha256 -days 825 \
    -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -pkeyopt ec_param_enc:named_curve \
    -subj "/CN=$name" \
    -addext "subjectAltName=$san_list" \
    -addext "extendedKeyUsage=serverAuth" \
    -keyout "$tmp_dir/privkey.pem" -out "$tmp_dir/fullchain.pem" 2>"$tmp_dir/openssl.log"
); then
  cat "$tmp_dir/openssl.log" >&2
  die "openssl could not create the certificate"
fi

# The gateway runs as UID/GID 101 and must be able to read the key.
if [[ $EUID -eq 0 ]]; then
  chown "root:$GATEWAY_GID" "$tmp_dir/privkey.pem"
  chmod 0640 "$tmp_dir/privkey.pem"
else
  chmod 0644 "$tmp_dir/privkey.pem"
  echo "note: privkey.pem is world-readable so the gateway (UID 101) can read it." >&2
  echo "      Run this script as root to restrict it to root:$GATEWAY_GID (0640)." >&2
fi
chmod 0644 "$tmp_dir/fullchain.pem"
mv -f "$tmp_dir/privkey.pem" "$tmp_dir/fullchain.pem" "$CERT_DIR/"

echo "Wrote $CERT_DIR/fullchain.pem and privkey.pem"
echo "subjectAltName: $san_list"
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate -fingerprint -sha256
