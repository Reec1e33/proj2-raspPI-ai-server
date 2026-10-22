#!/usr/bin/env bash
# Add or replace a basic-auth user for the PiCloud gateway.
#
# Usage: create-htpasswd.sh USER
#   The password is read from the terminal (asked twice), or from the first
#   line of stdin when stdin is not a terminal:
#     printf '%s\n' "$PASSWORD" | create-htpasswd.sh admin
#
# Writes deploy/nginx/htpasswd, hashed with SHA-512 crypt (openssl passwd -6).
# Not bcrypt: basic auth has no session, so nginx checks the hash on every
# request, and bcrypt cost 12 takes ~0.45 s of the gateway's 0.5 CPU per
# request (Grafana loads ~130 files per page). Existing users keep their hash.
# The password never appears on a command line.
#
# Needs OpenSSL 1.1.1 or later (OpenSSL 3). The openssl of macOS is LibreSSL,
# which has no 'passwd -6'. On macOS, use Homebrew's openssl@3:
#   PATH="$(brew --prefix openssl@3)/bin:$PATH" create-htpasswd.sh USER
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEPLOY_DIR
readonly HTPASSWD_FILE="$DEPLOY_DIR/nginx/htpasswd"
readonly GATEWAY_GID=101 # the nginx group inside the gateway image
readonly MIN_LENGTH=12

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  # Print the header comment: line 2 up to the first line that is not a comment.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
  exit "${1:-0}"
}

# Explain why the openssl in PATH cannot hash the password, then exit.
no_sha512_crypt() {
  local openssl version
  openssl="$(command -v openssl)"
  version="$(openssl version 2>/dev/null)" || version="unknown version"
  cat >&2 <<EOF
error: $openssl ($version) cannot make a SHA-512 crypt hash ('openssl passwd -6').
Nothing was saved. Use OpenSSL 1.1.1 or later (OpenSSL 3). On macOS, use Homebrew's:
  brew install openssl@3
  PATH="\$(brew --prefix openssl@3)/bin:\$PATH" $0 $1
Or run this script on the Pi.
EOF
  exit 1
}

case "${1:-}" in
  "") usage 1 ;;
  -h | --help) usage ;;
esac
user="$1"
[[ "$user" =~ ^[A-Za-z0-9._-]+$ ]] || die "user name may contain only letters, digits, '.', '_' and '-'"

if [[ -t 0 ]]; then
  read -rsp "Password for $user: " password && echo >&2
  read -rsp "Repeat password: " repeat && echo >&2
  [[ "$password" == "$repeat" ]] || die "passwords do not match"
else
  IFS= read -r password || [[ -n "$password" ]] || die "no password on stdin"
fi
((${#password} >= MIN_LENGTH)) || die "use at least $MIN_LENGTH characters"

command -v openssl >/dev/null || die "openssl is not installed. Install OpenSSL 3, or run this script on the Pi."
# Hash into a variable and check it before anything is written. LibreSSL (the macOS
# /usr/bin/openssl) has no -6: it prints its usage and fails, and that must not end up
# as "USER:" with an empty hash.
if ! pw_hash="$(printf '%s\n' "$password" | openssl passwd -6 -stdin 2>/dev/null)" ||
  [[ "$pw_hash" != "\$6\$"* ]]; then
  no_sha512_crypt "$user"
fi
entry="$user:$pw_hash"

tmp="$(mktemp "$HTPASSWD_FILE.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
if [[ -f "$HTPASSWD_FILE" ]]; then
  awk -F: -v user="$user" '$1 != user' "$HTPASSWD_FILE" >"$tmp"
fi
printf '%s\n' "$entry" >>"$tmp"

if [[ -f "$HTPASSWD_FILE" ]]; then
  # Rewrite in place: the compose file bind-mounts this single file, and such a
  # mount follows the inode, so replacing the file would hide the change.
  cat "$tmp" >"$HTPASSWD_FILE"
else
  mv "$tmp" "$HTPASSWD_FILE"
fi

# The gateway runs as UID/GID 101 and must be able to read the file.
if [[ $EUID -eq 0 ]]; then
  chown "root:$GATEWAY_GID" "$HTPASSWD_FILE"
  chmod 0640 "$HTPASSWD_FILE"
else
  chmod 0644 "$HTPASSWD_FILE"
fi

echo "Saved user '$user' in $HTPASSWD_FILE"
echo "nginx reads this file on every request: a running gateway needs no reload."
