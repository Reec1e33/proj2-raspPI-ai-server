#!/usr/bin/env bash
#
# PiCloud host bootstrap: provision and harden a Raspberry Pi (64-bit Raspberry
# Pi OS or Debian 12/13) for the PiCloud stack. Every module is idempotent, so
# the script is safe to re-run; a second run reports "0 changes".
#
#   sudo ./bootstrap.sh --dry-run     # show what would change
#   sudo ./bootstrap.sh               # apply all modules
#   sudo ./bootstrap.sh --only ssh,firewall --yes

# Bash >= 4.4 is required (empty arrays under `set -u`, ${var,,}, [[ -v ]]).
# This check uses Bash 3 syntax only, so old shells get a clear message.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ] ||
  { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
  echo "bootstrap.sh: needs bash >= 4.4 (this is ${BASH_VERSION:-not bash})" >&2
  exit 1
fi

set -Eeuo pipefail
IFS=$' \t\n'

INFRA_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$INFRA_DIR/lib/common.sh"

LOCK_FILE=/run/picloud-bootstrap.lock
MODULES=()
SELECTED=()
DONE_MODULES=()
CURRENT_MODULE=''
ONLY=()
SKIP=()
LIST_ONLY=0
CONFIG_FILE="$INFRA_DIR/config.env"
DISTRO_CODENAME=''

usage() {
  cat <<EOF
Usage: sudo $0 [options]

Provision and harden this Raspberry Pi for PiCloud. Safe to re-run.

Options:
  -n, --dry-run        Print the changes and commands; change nothing.
  -y, --yes            Do not ask for confirmation (needed without a terminal).
      --only a,b       Run only these modules.
      --skip a,b       Run all modules except these.
  -c, --config FILE    Config file (default: $INFRA_DIR/config.env).
  -l, --list           List the selected modules and exit.
  -h, --help           Show this help.

Modules, in run order:
$(module_table)

Audit the result with: $INFRA_DIR/verify.sh
EOF
}

usage_error() {
  printf 'bootstrap.sh: %s (see --help)\n' "$1" >&2
  exit 2
}

module_name() {
  local base=${1##*/}
  base=${base%.sh}
  printf '%s\n' "${base#[0-9][0-9]-}"
}

# Source every modules/NN-name.sh; each defines mod_<name>().
load_modules() {
  local file
  MODULES=()
  for file in "$INFRA_DIR"/modules/[0-9][0-9]-*.sh; do
    # shellcheck source=/dev/null
    source "$file"
    MODULES+=("$(module_name "$file")")
  done
}

module_table() {
  local file
  for file in "$INFRA_DIR"/modules/[0-9][0-9]-*.sh; do
    printf '  %-10s %s\n' "$(module_name "$file")" "$(sed -n 's/^# Summary: //p' "$file")"
  done
}

# Append the comma-separated module names in $2 to the array named $1.
# An empty list is an error: `--only ''` must not quietly select every module.
add_names() {
  local -n target=$1
  local names
  [[ -n $2 ]] || usage_error "empty module list"
  IFS=, read -ra names <<<"$2"
  target+=("${names[@]}")
}

parse_args() {
  while (($#)); do
    case $1 in
      -n | --dry-run) DRY_RUN=1 ;;
      -y | --yes) ASSUME_YES=1 ;;
      -l | --list) LIST_ONLY=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      --only | --skip | -c | --config)
        (($# >= 2)) || usage_error "$1 needs a value"
        case $1 in
          --only) add_names ONLY "$2" ;;
          --skip) add_names SKIP "$2" ;;
          *) CONFIG_FILE=$2 ;;
        esac
        shift
        ;;
      --only=*) add_names ONLY "${1#*=}" ;;
      --skip=*) add_names SKIP "${1#*=}" ;;
      --config=*) CONFIG_FILE=${1#*=} ;;
      *) usage_error "unknown option '$1'" ;;
    esac
    shift
  done
}

# Fill SELECTED with the modules to run, in run order, honouring --only/--skip.
select_modules() {
  local name
  for name in "${ONLY[@]}" "${SKIP[@]}"; do
    in_list "$name" "${MODULES[@]}" || usage_error "unknown module '$name' (known: ${MODULES[*]})"
  done
  SELECTED=()
  for name in "${MODULES[@]}"; do
    if ((${#ONLY[@]})) && ! in_list "$name" "${ONLY[@]}"; then continue; fi
    if in_list "$name" "${SKIP[@]}"; then continue; fi
    SELECTED+=("$name")
  done
  ((${#SELECTED[@]})) || usage_error "no modules selected"
}

require_root() {
  ((EUID == 0)) || die "run as root: sudo $0 $*"
}

# Debian 12/13 (Raspberry Pi OS 64-bit reports ID=debian). Sets DISTRO_CODENAME.
check_os() {
  local id version arch model=''
  id=$(get_kv /etc/os-release ID)
  version=$(get_kv /etc/os-release VERSION_ID)
  DISTRO_CODENAME=$(get_kv /etc/os-release VERSION_CODENAME)
  case "$id:$version" in
    debian:12 | debian:13) ;;
    raspbian:*) die "32-bit Raspberry Pi OS is not supported: install the 64-bit image" ;;
    *) die "unsupported OS '$id $version': use Debian 12/13 or Raspberry Pi OS 64-bit" ;;
  esac
  [[ -n $DISTRO_CODENAME ]] || die "/etc/os-release has no VERSION_CODENAME"

  arch=$(dpkg --print-architecture)
  case $arch in
    arm64) ;;
    amd64) warn "amd64 host: fine for a VM test, but PiCloud targets arm64" ;;
    *) die "unsupported architecture '$arch': PiCloud needs a 64-bit OS (arm64)" ;;
  esac
  if [[ -r /proc/device-tree/model ]]; then model=$(tr -d '\0' </proc/device-tree/model); fi
  log "host: ${model:-unknown board}, $(get_kv /etc/os-release PRETTY_NAME), $arch"
}

# Only one bootstrap at a time (apt and the config files are shared state).
take_lock() {
  exec {lock_fd}>"$LOCK_FILE" || die "cannot open $LOCK_FILE"
  flock -n "$lock_fd" || die "another bootstrap.sh is running"
}

on_exit() {
  local status=$?
  trap - ERR
  set +e
  printf '\n%sSummary%s\n' "$C_BOLD" "$C_RESET"
  printf '  done:     %s\n' "${DONE_MODULES[*]:-none}"
  if ((status != 0)); then
    printf '  %sfailed:   %s%s\n' "$C_RED" "${CURRENT_MODULE:-preflight}" "$C_RESET"
  fi
  if ((DRY_RUN)); then
    printf '  changes:  %d planned (dry-run: nothing was changed)\n' "$CHANGES"
  else
    printf '  changes:  %d\n' "$CHANGES"
  fi
  if [[ -d $BACKUP_DIR/$RUN_ID ]]; then
    printf '  backups:  %s\n' "$BACKUP_DIR/$RUN_ID"
  fi
  if [[ -f /var/run/reboot-required ]]; then
    printf '  %sreboot:   required (%s)%s\n' "$C_YELLOW" "/var/run/reboot-required" "$C_RESET"
  fi
  cleanup_runtime
  exit "$status"
}

main() {
  local name hook
  parse_args "$@"
  load_modules
  select_modules
  if ((LIST_ONLY)); then
    printf '%s\n' "${SELECTED[@]}"
    return 0
  fi

  require_root "$@"
  check_os
  load_config "$CONFIG_FILE"
  take_lock
  init_runtime
  trap on_exit EXIT
  trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR

  log "modules: ${SELECTED[*]}"
  if ((DRY_RUN)); then log "dry-run: nothing will be changed"; fi
  confirm "Apply these modules to $(hostname)?" || die "cancelled"

  for name in "${SELECTED[@]}"; do
    CURRENT_MODULE=$name
    section "$name"
    "mod_$name"
    DONE_MODULES+=("$name")
  done
  CURRENT_MODULE=''

  for hook in "${POST_RUN_HOOKS[@]}"; do
    section "post-run: $hook"
    "$hook"
  done
}

# Run main only when executed, so tests can source this file.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
