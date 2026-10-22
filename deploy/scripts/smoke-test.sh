#!/usr/bin/env bash
# End-to-end checks through the PiCloud gateway.
#
# Usage: SMOKE_USER=admin SMOKE_PASSWORD=... smoke-test.sh [BASE_URL]
#   BASE_URL  gateway HTTPS URL. Default: https://<SERVER_NAME from deploy/.env>,
#             else https://localhost. Laptop stack: https://localhost:8443
#
# Environment:
#   SMOKE_USER, SMOKE_PASSWORD  basic-auth credentials (required)
#   SMOKE_HTTP_URL    plain-HTTP URL for the redirect check. Default: http://<host>
#                     when BASE_URL has no port, else the check is skipped.
#   SMOKE_VERIFY_TLS  set to 1 to verify the certificate (default: accept self-signed)
#
# Exit status: 0 when every check passes, 1 otherwise. Needs curl and jq.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEPLOY_DIR

die() {
  echo "error: $*" >&2
  exit 2
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

case "${1:-}" in
  -h | --help) usage ;;
esac

command -v curl >/dev/null || die "curl is not installed"
command -v jq >/dev/null || die "jq is not installed"
[[ -n "${SMOKE_USER:-}" && -n "${SMOKE_PASSWORD:-}" ]] || die "set SMOKE_USER and SMOKE_PASSWORD"

default_host="$(env_value SERVER_NAME)"
base_url="${1:-https://${default_host:-localhost}}"
base_url="${base_url%/}"
host_port="${base_url#*://}"
host_port="${host_port%%/*}"
if [[ -n "${SMOKE_HTTP_URL:-}" ]]; then
  http_url="${SMOKE_HTTP_URL%/}"
elif [[ "$host_port" != *:* ]]; then
  http_url="http://$host_port"
else
  http_url=""
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A curl config file keeps the password off the command line (and out of `ps`).
curl_quote() {
  local value="${1//\\/\\\\}"
  printf '%s' "${value//\"/\\\"}"
}
(
  umask 077
  printf 'user = "%s:%s"\n' "$(curl_quote "$SMOKE_USER")" "$(curl_quote "$SMOKE_PASSWORD")" >"$tmp/auth.cfg"
)

curl_opts=(--silent --show-error --max-time 10)
[[ "${SMOKE_VERIFY_TLS:-0}" == 1 ]] || curl_opts+=(--insecure)

passed=0
failed=0
code=""

# fetch public|auth PATH: response body -> $tmp/body, headers -> $tmp/headers, status -> $code.
fetch() {
  local args=("${curl_opts[@]}" --output "$tmp/body" --dump-header "$tmp/headers" --write-out '%{http_code}')
  [[ "$1" == auth ]] && args+=(--config "$tmp/auth.cfg")
  : >"$tmp/body"
  : >"$tmp/headers"
  code="$(curl "${args[@]}" "$base_url$2" || true)"
}

# expect DESCRIPTION COMMAND...: the check passes when COMMAND succeeds.
expect() {
  local description="$1"
  shift
  if "$@"; then
    printf '  PASS  %s\n' "$description"
    passed=$((passed + 1))
  else
    printf '  FAIL  %s (HTTP %s)\n' "$description" "${code:-n/a}"
    failed=$((failed + 1))
  fi
}

status_is() { [[ "$code" == "$1" ]]; }
json() { jq -e "$1" "$tmp/body" >/dev/null 2>&1; }
has_header() { grep -qi "^$1:" "$tmp/headers"; }
# The SPA fallback answers unknown paths, so a hidden route returns index.html.
metrics_hidden() { [[ "$code" == 200 ]] && ! grep -q '^picloud_' "$tmp/body"; }

sse_snapshot() {
  # The stream never ends, so curl always stops on --max-time; ignore that error.
  { curl "${curl_opts[@]}" --config "$tmp/auth.cfg" --no-buffer --max-time 6 \
    "$base_url/api/system/stream" 2>/dev/null || true; } | grep -q '^event: snapshot'
}

http_redirects_to_https() {
  local result
  result="$(curl "${curl_opts[@]}" --output /dev/null --write-out '%{http_code} %{redirect_url}' \
    "$http_url/smoke-test" || true)"
  code="${result%% *}"
  [[ "$code" == 301 && "${result#* }" == https://* ]]
}

# shellcheck disable=SC2016 # $ks, $o and $k are jq variables
readonly SNAPSHOT_SHAPE='
  def keys_ok($ks): . as $o | $ks | all(. as $k | $o | has($k));
  keys_ok(["hostname", "collected_at", "uptime_seconds", "platform", "cpu", "memory",
           "filesystems", "network", "throttling"])
  and (.cpu | keys_ok(["cores", "usage_percent", "per_core_percent", "load_average",
                       "temperature_celsius", "frequency_mhz"]))
  and (.memory | keys_ok(["total_bytes", "available_bytes", "used_bytes", "usage_percent"]))
  and (.filesystems | type == "array")
  and (.network | type == "array")
  and (.throttling | keys_ok(["supported", "under_voltage_now", "throttled_now"]))'

echo "PiCloud smoke test: $base_url"

fetch public /api/health
expect "GET /api/health is public (200)" status_is 200
expect "/api/health reports status ok" json '.status == "ok"'

fetch public /
expect "GET / without credentials is rejected (401)" status_is 401

fetch auth /
expect "GET / with credentials serves the SPA (200)" status_is 200
expect "Strict-Transport-Security header is set" has_header Strict-Transport-Security
expect "Content-Security-Policy header is set" has_header Content-Security-Policy
expect "X-Content-Type-Options header is set" has_header X-Content-Type-Options

fetch auth /api/system
expect "GET /api/system returns a snapshot (200)" status_is 200
expect "/api/system matches the snapshot contract" json "$SNAPSHOT_SHAPE"

expect "GET /api/system/stream emits an SSE snapshot event" sse_snapshot

fetch auth /api/providers
expect "GET /api/providers returns the provider list" json \
  'type == "array" and all(.[]; has("name") and has("enabled") and has("circuit"))'

fetch auth /grafana/api/health
expect "GET /grafana/api/health is reachable (200)" status_is 200
expect "Grafana reports database ok" json '.database == "ok"'

fetch auth /metrics
expect "api /metrics is not exposed through the gateway" metrics_hidden

if [[ -n "$http_url" ]]; then
  expect "$http_url redirects to HTTPS (301)" http_redirects_to_https
else
  printf '  SKIP  HTTP redirect check (BASE_URL has a port; set SMOKE_HTTP_URL)\n'
fi

echo "Result: $passed passed, $failed failed"
((failed == 0))
