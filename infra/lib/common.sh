#!/usr/bin/env bash
# Shared helpers for the PiCloud host toolkit (bootstrap.sh, verify.sh, tests).
#
# Conventions
#   * "Ensure" helpers (install_file, install_template, ensure_line, set_kv)
#     return 0 when they changed something and 1 when the target was already
#     correct. Call them in a condition, e.g.
#         if install_file src dest 0644; then systemctl reload foo; fi
#     or append `|| true`. Real errors always go through die().
#   * run() is the only way to execute a state-changing command, so --dry-run
#     prints those commands instead of running them. Read-only probes
#     (systemctl is-active, dpkg-query, ...) are called directly.

[[ -n "${PICLOUD_COMMON_LOADED:-}" ]] && return 0
PICLOUD_COMMON_LOADED=1

INFRA_DIR=${INFRA_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
# shellcheck disable=SC2034 # used by the modules
PICLOUD_FILES="$INFRA_DIR/files"

DRY_RUN=${DRY_RUN:-0}
ASSUME_YES=${ASSUME_YES:-0}
CHANGES=0
APT_UPDATED=0
BACKUP_DIR=${PICLOUD_BACKUP_DIR:-/var/backups/picloud}
RUN_ID=${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
WORK_DIR=${WORK_DIR:-}
POST_RUN_HOOKS=()

APT_GET=(env DEBIAN_FRONTEND=noninteractive apt-get -y
  -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [[ -t 1 && -t 2 && -z "${NO_COLOR:-}" ]]; then
  C_RED=$'\e[31m' C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m' C_BLUE=$'\e[34m'
  C_BOLD=$'\e[1m' C_DIM=$'\e[2m' C_RESET=$'\e[0m'
else
  C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_BOLD='' C_DIM='' C_RESET=''
fi

log() { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
warn() { printf '%sWARN:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() {
  printf '%sERROR:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
  exit 1
}
section() { printf '\n%s## %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

# Record (and print) one change to the system. In dry-run it is a planned change.
note_change() {
  CHANGES=$((CHANGES + 1))
  local prefix=''
  if ((DRY_RUN)); then prefix='would: '; fi
  printf '%s  ~ %s%s%s\n' "$C_GREEN" "$prefix" "$*" "$C_RESET"
}

# Print an ERR-trap report: on_error <status> <line> <command>.
on_error() {
  printf '%sERROR:%s "%s" exited with status %s at %s:%s\n' \
    "$C_RED" "$C_RESET" "$3" "$1" "${BASH_SOURCE[1]:-?}" "$2" >&2
}

# Shell-quote a command for display, so it can be copied and pasted.
quote_cmd() {
  local out
  printf -v out '%q ' "$@"
  printf '%s' "${out% }"
}

# Run a state-changing command, or only print it in dry-run mode.
# A failing command aborts the run with the exact command line.
run() {
  local status=0
  if ((DRY_RUN)); then
    printf '%s  [dry-run] %s%s\n' "$C_DIM" "$(quote_cmd "$@")" "$C_RESET"
    return 0
  fi
  printf '%s  + %s%s\n' "$C_DIM" "$(quote_cmd "$@")" "$C_RESET"
  "$@" || status=$?
  ((status == 0)) || die "command failed (exit $status): $(quote_cmd "$@")"
}

# Ask a yes/no question. --yes and --dry-run answer "yes" without a prompt.
confirm() {
  if ((ASSUME_YES || DRY_RUN)); then return 0; fi
  [[ -t 0 ]] || die "$1 (no terminal to ask: re-run with --yes to confirm)"
  local reply
  read -r -p "$1 [y/N] " reply
  [[ $reply == [yY] || $reply == [yY][eE][sS] ]]
}

# ---------------------------------------------------------------------------
# Small predicates and validators (pure, unit-tested)
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# missing_in_dry_run <command> <step>: a dry-run on a fresh system lacks tools
# that a real run installs first. Then warn and return 0, so the caller skips
# <step>. A real run without <command> is an error. Returns 1 if it exists.
missing_in_dry_run() {
  if have "$1"; then return 1; fi
  ((DRY_RUN)) || die "$1 is required but not installed"
  warn "$1 is not installed yet (a real run installs it first); skipped: $2"
}

# The running kernel has AppArmor turned on (Debian's default; not every Pi kernel).
apparmor_enabled() { [[ $(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true) == Y ]]; }

is_true() {
  case "${1,,}" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

in_list() {
  local needle=$1 item
  shift
  for item in "$@"; do
    if [[ $item == "$needle" ]]; then return 0; fi
  done
  return 1
}

valid_port() { [[ $1 =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }

valid_ipv4() {
  local octet
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for octet in "${BASH_REMATCH[@]:1}"; do
    ((10#$octet <= 255)) || return 1
  done
}

valid_ipv4_cidr() {
  [[ $1 == */* ]] || return 1
  local prefix=${1#*/}
  valid_ipv4 "${1%/*}" && [[ $prefix =~ ^[0-9]{1,2}$ ]] && ((10#$prefix <= 32))
}

# "9100/tcp" or "53/udp"
valid_port_spec() { [[ $1 =~ ^([0-9]{1,5})/(tcp|udp)$ ]] && valid_port "${BASH_REMATCH[1]}"; }

valid_time_hhmm() { [[ $1 =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; }

valid_hostname() { [[ $1 =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; }

valid_username() { [[ $1 =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; }

# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------

# Create the per-run scratch directory. Call once from the main shell.
init_runtime() {
  if [[ -z $WORK_DIR ]]; then
    WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/picloud.XXXXXX") || die "cannot create a temp directory"
  fi
  mkdir -p -- "$WORK_DIR"
}

cleanup_runtime() {
  if [[ -n $WORK_DIR && -d $WORK_DIR ]]; then rm -rf -- "$WORK_DIR"; fi
}

work_file() {
  [[ -n $WORK_DIR ]] || die "internal: init_runtime was not called"
  mktemp "$WORK_DIR/tmp.XXXXXX"
}

sha256_of() {
  local sum
  if have sha256sum; then
    sum=$(sha256sum -- "$1") || die "cannot hash $1"
  else
    sum=$(shasum -a 256 -- "$1") || die "cannot hash $1"
  fi
  printf '%s\n' "${sum%% *}"
}

# Octal mode and owner:group of a file (GNU stat first, BSD stat for macOS tests).
file_mode() { stat -c '%a' -- "$1" 2>/dev/null || stat -f '%Lp' -- "$1"; }
file_owner() { stat -c '%U:%G' -- "$1" 2>/dev/null || stat -f '%Su:%Sg' -- "$1"; }
file_group_id() { stat -c '%g' -- "$1" 2>/dev/null || stat -f '%g' -- "$1"; }

# Copy <path> to $BACKUP_DIR/$RUN_ID/<path> once per run (first copy = pre-run state).
backup_file() {
  local path=$1 dest
  [[ $path == /* ]] || die "backup_file: path must be absolute: $path"
  dest="$BACKUP_DIR/$RUN_ID$path"
  if [[ ! -e $path || -e $dest ]]; then return 0; fi
  if [[ ! -d $BACKUP_DIR ]]; then install -d -m 0700 -- "$BACKUP_DIR" || die "cannot create $BACKUP_DIR"; fi
  mkdir -p -- "$(dirname -- "$dest")" || die "cannot create backup dir for $path"
  cp -p -- "$path" "$dest" || die "cannot back up $path"
}

# Put <path> back to its state before this run (or delete it if it is new).
restore_file() {
  local path=$1 backup="$BACKUP_DIR/$RUN_ID$1"
  if [[ -e $backup ]]; then
    cp -p -- "$backup" "$path" || die "cannot restore $path from $backup"
    warn "restored $path from $backup"
  else
    rm -f -- "$path"
    warn "removed $path (it did not exist before this run)"
  fi
}

# install_file <src> <dest> <mode> [owner:group]
# Write <dest> atomically when its sha256 differs from <src> (keeping a backup),
# or fix its mode/owner. Returns 0 if something changed (or would change in
# dry-run), 1 if <dest> was already correct.
install_file() {
  local src=$1 dest=$2 mode=$3 owner=${4:-}
  local content_changed=1 meta_changed=0 tmp dir
  [[ -f $src ]] || die "install_file: source $src not found"
  [[ $mode =~ ^[0-7]{3,4}$ ]] || die "install_file: bad mode '$mode'"

  if [[ -f $dest && "$(sha256_of "$src")" == "$(sha256_of "$dest")" ]]; then
    content_changed=0
    if ((8#$(file_mode "$dest") != 8#$mode)); then meta_changed=1; fi
    if [[ -n $owner && "$(file_owner "$dest")" != "$owner" ]]; then meta_changed=1; fi
  fi
  if ((!content_changed && !meta_changed)); then return 1; fi

  if ((!content_changed)); then
    if ((!DRY_RUN)); then
      chmod "$mode" "$dest" || die "cannot chmod $dest"
      if [[ -n $owner ]]; then chown "$owner" "$dest" || die "cannot chown $dest"; fi
    fi
    note_change "set mode ${mode}${owner:+ and owner $owner} on $dest"
    return 0
  fi

  if ((DRY_RUN)); then
    show_diff "$dest" "$src" "$mode"
    note_change "write $dest"
    return 0
  fi

  dir=$(dirname -- "$dest")
  if [[ ! -d $dir ]]; then mkdir -p -- "$dir" || die "cannot create $dir"; fi
  backup_file "$dest"
  tmp=$(mktemp "$dir/.picloud.XXXXXX") || die "cannot create a temp file in $dir"
  cp -- "$src" "$tmp" || die "cannot copy $src"
  chmod "$mode" "$tmp" || die "cannot chmod $tmp"
  if [[ -n $owner ]]; then chown "$owner" "$tmp" || die "cannot chown $tmp"; fi
  mv -f -- "$tmp" "$dest" || die "cannot move $tmp to $dest"
  note_change "wrote $dest"
  return 0
}

# Show what a dry-run would change. Files that are not world-readable can hold
# secrets, so only their name is printed.
show_diff() {
  local dest=$1 src=$2 mode=$3
  if ((!(8#$mode & 8#004))); then
    printf '    (content hidden: %s is not world-readable)\n' "$dest"
  elif [[ -f $dest ]]; then
    diff -u --label "$dest" --label "$dest (new)" -- "$dest" "$src" | sed 's/^/    /' || true
  else
    printf '    (new file)\n'
  fi
}

# Replace every {{NAME}} in <src> with the value of shell variable NAME and
# print the result. Unset variables and malformed placeholders are errors.
# Values are inserted literally (a value that contains "{{X}}" is not expanded).
render_template() {
  local src=$1 rest out='' name
  [[ -f $src ]] || die "template $src not found"
  rest=$(<"$src")
  while [[ $rest == *'{{'* ]]; do
    out+=${rest%%'{{'*}
    rest=${rest#*'{{'}
    name=${rest%%'}}'*}
    [[ $rest == *'}}'* && $name =~ ^[A-Z][A-Z0-9_]*$ ]] ||
      die "template $src: malformed placeholder near '{{${name:0:20}'"
    [[ -v $name ]] || die "template $src: variable $name is not set"
    out+=${!name}
    rest=${rest#*'}}'}
  done
  printf '%s\n' "$out$rest"
}

# install_template <src> <dest> <mode> [owner:group] -- render, then install_file.
install_template() {
  local tmp
  tmp=$(work_file) || die "cannot create a temp file"
  render_template "$1" >"$tmp"
  install_file "$tmp" "$2" "$3" "${4:-}"
}

# Append <line> to <file> unless the exact line is already there.
ensure_line() {
  local file=$1 line=$2
  if [[ -f $file ]] && grep -Fxq -- "$line" "$file"; then return 1; fi
  if ((DRY_RUN)); then
    note_change "add a line to $file"
    return 0
  fi
  backup_file "$file"
  if [[ -s $file && -n "$(tail -c 1 -- "$file")" ]]; then
    printf '\n' >>"$file" || die "cannot write $file"
  fi
  printf '%s\n' "$line" >>"$file" || die "cannot write $file"
  note_change "added a line to $file"
}

# Print the value of KEY=value in a shell-style file (quotes removed).
get_kv() {
  local file=$1 key=$2 line value
  [[ -r $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == "$key="* ]] || continue
    value=${line#*=}
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
    printf '%s\n' "$value"
    return 0
  done <"$file"
}

# Set KEY=value in a shell-style file: replace existing KEY= lines or append.
set_kv() {
  local file=$1 key=$2 value=$3 tmp line found=0 mode=0644
  tmp=$(work_file) || die "cannot create a temp file"
  if [[ -f $file ]]; then
    mode=$(file_mode "$file")
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line == "$key="* ]]; then
        line="$key=$value"
        found=1
      fi
      printf '%s\n' "$line"
    done <"$file" >"$tmp"
  fi
  if ((!found)); then printf '%s=%s\n' "$key" "$value" >>"$tmp"; fi
  install_file "$tmp" "$file" "$mode"
}

# Map <ip> to <name> in a hosts file: replace the line for <ip> or append one.
set_hosts_entry() {
  local file=$1 ip=$2 name=$3 tmp line found=0 mode=0644
  tmp=$(work_file) || die "cannot create a temp file"
  if [[ -f $file ]]; then
    mode=$(file_mode "$file")
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line =~ ^${ip//./\\.}[[:space:]] ]]; then
        if ((found)); then continue; fi
        printf -v line '%s\t%s' "$ip" "$name"
        found=1
      fi
      printf '%s\n' "$line"
    done <"$file" >"$tmp"
  fi
  if ((!found)); then printf '%s\t%s\n' "$ip" "$name" >>"$tmp"; fi
  install_file "$tmp" "$file" "$mode"
}

# Download <url> to <file> over HTTPS only.
fetch() {
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" -- "$1" || die "download failed: $1"
}

user_home() {
  local entry
  entry=$(getent passwd "$1") || die "user '$1' does not exist"
  cut -d: -f6 <<<"$entry"
}

# ---------------------------------------------------------------------------
# Packages and services
# ---------------------------------------------------------------------------

pkg_installed() {
  local status
  # shellcheck disable=SC2016 # ${...} is a dpkg-query format, not shell.
  status=$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null) || return 1
  [[ $status == installed ]]
}

apt_update_once() {
  if ((APT_UPDATED)); then return 0; fi
  run "${APT_GET[@]}" update
  APT_UPDATED=1
}

# Install any of the given packages that are missing.
ensure_pkg() {
  local pkg missing=()
  for pkg in "$@"; do
    pkg_installed "$pkg" || missing+=("$pkg")
  done
  if ((${#missing[@]} == 0)); then return 0; fi
  apt_update_once
  run "${APT_GET[@]}" install --no-install-recommends "${missing[@]}"
  note_change "install ${missing[*]}"
}

unit_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
unit_enabled() { systemctl is-enabled --quiet "$1" 2>/dev/null; }
# Active, or on its way there (a slow oneshot such as picloud.service).
unit_started() { [[ $(systemctl is-active "$1" 2>/dev/null) =~ ^(active|activating|reloading)$ ]]; }

# enable_unit <unit> [--now]: enable at boot and, with --now, start it too.
enable_unit() {
  local unit=$1 now=${2:-}
  if ! unit_enabled "$unit"; then
    run systemctl enable "$unit"
    note_change "enable $unit"
  fi
  if [[ $now == --now ]] && ! unit_started "$unit"; then
    run systemctl start "$unit"
    note_change "start $unit"
  fi
}

# Run a validation command after a config change. On failure, roll the file
# back to its pre-run state and abort, so a bad config never stays in place.
validate_or_restore() {
  local file=$1
  shift
  if ((DRY_RUN)); then
    run "$@"
    return 0
  fi
  printf '%s  + %s%s\n' "$C_DIM" "$(quote_cmd "$@")" "$C_RESET"
  if "$@"; then return 0; fi
  restore_file "$file"
  die "$(quote_cmd "$@") failed; $file is back to its previous state"
}

# Add (or keep) a UFW rule, e.g. `ufw_rule limit 22/tcp`. UFW skips rules that
# already exist; its output tells us whether anything changed.
ufw_rule() {
  local out
  if ((DRY_RUN)); then
    run ufw "$@"
    return 0
  fi
  out=$(ufw "$@" 2>&1) || die "ufw $* failed: $out"
  if [[ $out == *Rule* ]]; then note_change "ufw $*"; fi
}

ufw_active() {
  local out
  out=$(ufw status 2>/dev/null) || return 1
  [[ $out == *"Status: active"* ]]
}

# Register a function that bootstrap.sh calls after all modules succeed.
add_post_run_hook() { POST_RUN_HOOKS+=("$1"); }

# Configuration schema: defaults, validation and loading of config.env.
# shellcheck source=config.sh
source "$INFRA_DIR/lib/config.sh"
