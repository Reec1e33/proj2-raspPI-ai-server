#!/usr/bin/env bash
#
# PiCloud host audit: read-only checks of every control that bootstrap.sh
# applies. Prints PASS / WARN / FAIL per control (SKIP for controls that are
# not configured), then a summary. Exits 1 if any check FAILs.
#
#   ./verify.sh           # as the admin user; uses `sudo -n` where root is needed
#   sudo ./verify.sh      # full audit
#   ./verify.sh --quick   # skip the slow `unattended-upgrade --dry-run`

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ] ||
  { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
  echo "verify.sh: needs bash >= 4.4 (this is ${BASH_VERSION:-not bash})" >&2
  exit 1
fi

set -Eeuo pipefail
IFS=$' \t\n'

INFRA_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$INFRA_DIR/lib/common.sh"
# The wanted SSH algorithm lists live in the ssh module (one source of truth).
# shellcheck source=modules/20-ssh.sh
source "$INFRA_DIR/modules/20-ssh.sh"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
QUICK=0
ROOT_MODE=none
DOCKER_CMD=()
CONFIG_FILE="$INFRA_DIR/config.env"
PROC_SYS=/proc/sys

verify_usage() {
  cat <<EOF
Usage: $0 [--quick] [--config FILE]

Read-only audit of the controls that bootstrap.sh applies.
Prints PASS/WARN/FAIL per control; exits 1 if any check fails.

  -q, --quick        Skip the slow 'unattended-upgrade --dry-run' check.
  -c, --config FILE  Config file (default: $INFRA_DIR/config.env).
  -h, --help         Show this help.
EOF
}

# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

report() {
  local level=$1 color=''
  shift
  case $level in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) color=$C_GREEN ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)) color=$C_YELLOW ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) color=$C_RED ;;
    SKIP) color=$C_DIM ;;
    *) die "internal: bad report level $level" ;;
  esac
  printf '%s[%s]%s %s\n' "$color" "$level" "$C_RESET" "$*"
}

# expect_eq <level-if-wrong> <label> <actual> <wanted>
expect_eq() {
  if [[ $3 == "$4" ]]; then
    report PASS "$2: $3"
  else
    report "$1" "$2: ${3:-<none>} (want $4)"
  fi
}

# expect_match <level-if-wrong> <label> <text> <extended regex>
expect_match() {
  if grep -Eq -- "$4" <<<"$3"; then report PASS "$2"; else report "$1" "$2"; fi
}

expect_active() {
  if unit_active "$2"; then report PASS "$2 is active"; else report "$1" "$2 is not active"; fi
}

expect_enabled() {
  if unit_enabled "$2"; then report PASS "$2 is enabled"; else report "$1" "$2 is not enabled"; fi
}

# expect_same_file <level> <repo file> <installed file>: detect drift.
expect_same_file() {
  if [[ -r $3 && "$(sha256_of "$2")" == "$(sha256_of "$3")" ]]; then
    report PASS "$3 matches the repository"
  else
    report "$1" "$3 is missing or differs from infra/${2#"$INFRA_DIR"/}"
  fi
}

# ---------------------------------------------------------------------------
# Privilege and parsing helpers
# ---------------------------------------------------------------------------

detect_root() {
  if ((EUID == 0)); then
    ROOT_MODE=root
  elif have sudo && sudo -n true 2>/dev/null; then
    ROOT_MODE=sudo
  fi
}

as_root() {
  case $ROOT_MODE in
    root) "$@" ;;
    sudo) sudo -n -- "$@" ;;
    *) return 126 ;;
  esac
}

# need_root <area>: true if root checks can run, else report why not.
need_root() {
  if [[ $ROOT_MODE != none ]]; then return 0; fi
  report WARN "$1: not checked (needs root: run 'sudo $0')"
  return 1
}

# sshd_value <sshd -T output> <keyword>: the value(s) of one keyword.
sshd_value() {
  awk -v k="$2" '$1 == k { $1 = ""; sub(/^ /, ""); print }' <<<"$1"
}

# public_bindings: read `docker ps --format '{{.Names}}\t{{.Ports}}'` lines and
# print "name port/proto" for each port published on all interfaces
# (0.0.0.0 or [::]), once per port.
public_bindings() {
  local name ports item host addr items key
  local -A seen=()
  while IFS=$'\t' read -r name ports; do
    IFS=, read -ra items <<<"$ports"
    for item in "${items[@]}"; do
      item=${item# }
      [[ $item == *'->'* ]] || continue
      host=${item%%->*}
      addr=${host%:*}
      case $addr in
        0.0.0.0 | '[::]' | '::') ;;
        *) continue ;;
      esac
      key="$name ${host##*:}/${item##*/}"
      [[ -z ${seen[$key]:-} ]] || continue
      seen[$key]=1
      printf '%s\n' "$key"
    done
  done
}

# Fill DOCKER_CMD with a way to reach the Docker daemon (or return 1).
docker_access() {
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
  elif [[ $ROOT_MODE != none ]] && as_root docker info >/dev/null 2>&1; then
    DOCKER_CMD=(as_root docker)
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Checks, one function per bootstrap module
# ---------------------------------------------------------------------------

check_base() {
  section base
  expect_eq WARN "hostname" "$(hostname)" "$PI_HOSTNAME"
  expect_eq WARN "timezone" "$(timedatectl show -p Timezone --value 2>/dev/null || true)" "$TIMEZONE"
  expect_eq WARN "clock synchronised (NTP)" \
    "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" yes
}

check_ssh() {
  section ssh
  need_root ssh || return 0
  local cfg key want home ctx=()
  if [[ -n $ADMIN_USER ]]; then ctx=(-C "user=$ADMIN_USER,host=localhost,addr=127.0.0.1"); fi
  if ! cfg=$(as_root sshd -T "${ctx[@]}" 2>&1); then
    report FAIL "sshd -T failed: ${cfg##*$'\n'}"
    return 0
  fi

  while read -r key want; do
    expect_eq FAIL "sshd $key" "$(sshd_value "$cfg" "$key")" "$want"
  done <<EOF
port $SSH_PORT
permitrootlogin no
passwordauthentication no
kbdinteractiveauthentication no
pubkeyauthentication yes
authenticationmethods publickey
maxauthtries 3
logingracetime 30
clientaliveinterval 300
clientalivecountmax 2
allowtcpforwarding local
allowagentforwarding no
x11forwarding no
EOF
  if [[ -n $ADMIN_USER ]]; then
    expect_eq FAIL "sshd allowusers" "$(sshd_value "$cfg" allowusers)" "$ADMIN_USER"
  fi

  ssh_expect_subset kexalgorithms "$(sshd_value "$cfg" kexalgorithms)" "${SSH_WANTED_KEX[@]}"
  ssh_expect_subset ciphers "$(sshd_value "$cfg" ciphers)" "${SSH_WANTED_CIPHERS[@]}"
  ssh_expect_subset macs "$(sshd_value "$cfg" macs)" "${SSH_WANTED_MACS[@]}"
  ssh_expect_subset hostkeyalgorithms "$(sshd_value "$cfg" hostkeyalgorithms)" "${SSH_WANTED_HOSTKEYS[@]}"

  if [[ -n $ADMIN_USER ]]; then
    home=$(getent passwd "$ADMIN_USER" | cut -d: -f6 || true)
    if [[ -n $home ]] && as_root ssh-keygen -l -f "$home/.ssh/authorized_keys" >/dev/null 2>&1; then
      report PASS "$ADMIN_USER has a valid authorized key"
    else
      report FAIL "$ADMIN_USER has no valid key in ~/.ssh/authorized_keys"
    fi
  fi
}

# ssh_expect_subset <keyword> <comma list from sshd -T> <allowed...>
ssh_expect_subset() {
  local key=$1 actual=$2 alg algs extra=()
  shift 2
  IFS=, read -ra algs <<<"$actual"
  for alg in "${algs[@]}"; do
    in_list "$alg" "$@" || extra+=("$alg")
  done
  if [[ -n $actual && ${#extra[@]} -eq 0 ]]; then
    report PASS "sshd $key: hardened list only"
  else
    report FAIL "sshd $key: unexpected entries: ${extra[*]:-<none set>}"
  fi
}

check_firewall() {
  section firewall
  need_root firewall || return 0
  local status
  if ! status=$(as_root ufw status verbose 2>&1); then
    report FAIL "ufw is not installed or not working"
    return 0
  fi
  expect_match FAIL "ufw is active" "$status" '^Status: active'
  expect_match FAIL "ufw denies incoming by default" "$status" '^Default: deny \(incoming\)'
  expect_match FAIL "ufw rate-limits SSH on $SSH_PORT/tcp" "$status" "^$SSH_PORT/tcp +LIMIT IN +Anywhere"
  expect_match WARN "ufw allows 80/tcp" "$status" '^80/tcp +ALLOW IN +Anywhere'
  expect_match WARN "ufw allows 443/tcp" "$status" '^443/tcp +ALLOW IN +Anywhere'
  expect_match WARN "ufw logging is low" "$status" '^Logging: on \(low\)'
  expect_eq WARN "ufw IPv6" "$(get_kv /etc/default/ufw IPV6)" yes
}

check_fail2ban() {
  section fail2ban
  expect_active FAIL fail2ban.service
  need_root fail2ban || return 0
  local jail level out
  for jail in sshd recidive; do
    level=FAIL
    if [[ $jail == recidive ]]; then level=WARN; fi
    if out=$(as_root fail2ban-client status "$jail" 2>&1); then
      report PASS "fail2ban jail $jail is running ($(grep -Eo 'Currently banned:[[:space:]]*[0-9]+' <<<"$out" | tr -s '\t ' ' ' || true))"
    else
      report "$level" "fail2ban jail $jail is not running"
    fi
  done
}

check_updates() {
  section updates
  local dump out reboot=false
  expect_enabled FAIL unattended-upgrades.service
  expect_active FAIL apt-daily.timer
  expect_active FAIL apt-daily-upgrade.timer

  dump=$(apt-config dump 2>/dev/null || true)
  expect_match FAIL "APT runs unattended-upgrade daily" "$dump" '^APT::Periodic::Unattended-Upgrade "1";'
  expect_match FAIL "Debian security origin is enabled" "$dump" 'Origins-Pattern:: ".*label=Debian-Security'
  if [[ -f /etc/apt/sources.list.d/raspi.list || -f /etc/apt/sources.list.d/raspi.sources ]]; then
    expect_match WARN "Raspberry Pi archive origin is enabled" "$dump" 'Origins-Pattern:: ".*label=Raspberry Pi Foundation'
  fi
  if is_true "$UPGRADE_DOCKER" && [[ -f /etc/apt/sources.list.d/docker.sources ]]; then
    expect_match WARN "Docker CE origin is enabled" "$dump" 'Origins-Pattern:: "origin=Docker,label=Docker CE,'
  fi
  if is_true "$AUTO_REBOOT"; then reboot=true; fi
  expect_match WARN "automatic reboot: $reboot" "$dump" "^Unattended-Upgrade::Automatic-Reboot \"$reboot\";"
  if [[ $reboot == true ]]; then
    expect_match WARN "automatic reboot time: $AUTO_REBOOT_TIME" "$dump" \
      "^Unattended-Upgrade::Automatic-Reboot-Time \"$AUTO_REBOOT_TIME\";"
  fi

  if ((QUICK)); then
    report SKIP "unattended-upgrade --dry-run (--quick)"
  elif need_root "unattended-upgrade --dry-run"; then
    if out=$(as_root unattended-upgrade --dry-run 2>&1); then
      report PASS "unattended-upgrade --dry-run succeeds"
    else
      report WARN "unattended-upgrade --dry-run failed: ${out##*$'\n'}"
    fi
  fi
}

check_logging() {
  section logging
  local machine_id=''
  if [[ -r /etc/machine-id ]]; then machine_id=$(</etc/machine-id); fi
  if [[ -n $machine_id && -d /var/log/journal/$machine_id ]]; then
    report PASS "journald stores logs on disk (/var/log/journal)"
  else
    report FAIL "journald is not persistent (/var/log/journal/<machine-id> is missing)"
  fi
  expect_same_file WARN "$PICLOUD_FILES/journald/90-picloud.conf" /etc/systemd/journald.conf.d/90-picloud.conf
  if is_true "$LOG2RAM_ENABLE"; then
    expect_active WARN log2ram.service
  else
    report SKIP "log2ram: off (LOG2RAM_ENABLE=false)"
  fi
}

# sysctl_read <path>: print a live sysctl value. Some keys are root-only
# (net.core.bpf_jit_harden is mode 0600), so read those through as_root.
# Returns 1 if the value cannot be read.
sysctl_read() {
  if [[ -r $1 ]]; then
    printf '%s\n' "$(<"$1")"
  elif [[ $ROOT_MODE != none ]]; then
    as_root cat -- "$1"
  else
    return 1
  fi
}

check_sysctl() {
  section sysctl
  local key want actual path optional total=0 bad=0 unread=()
  while IFS='=' read -r key want; do
    key=${key//[[:space:]]/}
    want=${want//[[:space:]]/}
    [[ -n $key && $key != \#* ]] || continue
    optional=0
    if [[ $key == -* ]]; then optional=1 key=${key#-}; fi
    path=$PROC_SYS/${key//./\/}
    if [[ ! -e $path ]]; then
      if ((optional)); then
        report SKIP "sysctl $key: not supported by this kernel (optional)"
        continue
      fi
      actual=missing
    elif ! actual=$(sysctl_read "$path"); then
      unread+=("$key")
      continue
    fi
    total=$((total + 1))
    if [[ $actual != "$want" ]]; then
      report FAIL "sysctl $key = $actual (want $want)"
      bad=$((bad + 1))
    fi
  done <"$PICLOUD_FILES/sysctl/90-picloud-hardening.conf"
  if ((${#unread[@]})); then
    report WARN "sysctl ${unread[*]}: not checked (needs root: run 'sudo $0')"
  fi
  if ((bad == 0)); then report PASS "sysctl: all $total checked hardening values are live"; fi
  if have docker && [[ -r $PROC_SYS/net/ipv4/ip_forward ]]; then
    expect_eq WARN "net.ipv4.ip_forward (Docker needs 1)" "$(<"$PROC_SYS/net/ipv4/ip_forward")" 1
  fi
}

check_network() {
  section network
  local addrs route
  if [[ -z $STATIC_IP_CIDR ]]; then
    report SKIP "static IP: not configured (DHCP)"
  else
    addrs=$(ip -4 -o addr show dev "$NET_IFACE" 2>/dev/null || true)
    expect_match FAIL "$NET_IFACE has $STATIC_IP_CIDR" "$addrs" " inet ${STATIC_IP_CIDR//./\\.} "
    route=$(ip -4 route show default 2>/dev/null || true)
    expect_match WARN "default route via $STATIC_GATEWAY" "$route" "via ${STATIC_GATEWAY//./\\.} "
  fi
  if [[ -z $DDNS_PROVIDER ]]; then
    report SKIP "DDNS: not configured"
  else
    expect_active FAIL ddclient.service
    expect_eq FAIL "/etc/ddclient.conf mode" "$(file_mode /etc/ddclient.conf 2>/dev/null || true)" 600
  fi
}

check_docker() {
  section docker
  local info driver live json=''
  if ! have docker; then
    report FAIL "docker is not installed"
    return 0
  fi
  expect_active FAIL docker.service
  if docker_access; then
    info=$("${DOCKER_CMD[@]}" info --format '{{.LoggingDriver}} {{.LiveRestoreEnabled}}' 2>/dev/null || true)
    read -r driver live <<<"$info"
    expect_eq FAIL "docker default log driver" "${driver:-}" json-file
    expect_eq FAIL "docker live-restore" "${live:-}" true
    if "${DOCKER_CMD[@]}" compose version >/dev/null 2>&1; then
      report PASS "docker compose plugin is installed"
    else
      report FAIL "docker compose plugin is missing"
    fi
    if apparmor_enabled; then
      expect_match WARN "docker confines containers with AppArmor" \
        "$("${DOCKER_CMD[@]}" info --format '{{.SecurityOptions}}' 2>/dev/null || true)" 'name=apparmor'
    fi
  else
    report WARN "docker daemon: not checked (needs root or the docker group)"
  fi
  if [[ -r /etc/docker/daemon.json ]]; then json=$(</etc/docker/daemon.json); fi
  expect_match FAIL "daemon.json sets no-new-privileges" "$json" '"no-new-privileges": *true'
  expect_match FAIL "daemon.json rotates container logs" "$json" '"max-size": *"[0-9]+[kmg]"'
}

# Docker publishes ports through its own iptables chains, so UFW does not
# filter them. Only the gateway (80/443) may listen on all interfaces.
check_published_ports() {
  section "published ports"
  local name binding bad=0
  if ! have docker || ! docker_access; then
    report WARN "published ports: not checked (no access to the Docker daemon)"
    return 0
  fi
  while read -r name binding; do
    [[ -n $name ]] || continue
    case $binding in
      80/tcp | 443/tcp) ;;
      *)
        report WARN "container $name publishes $binding on all interfaces; UFW does not filter it"
        bad=1
        ;;
    esac
  done < <("${DOCKER_CMD[@]}" ps --format '{{.Names}}\t{{.Ports}}' | public_bindings)
  if ((bad == 0)); then report PASS "only 80/tcp and 443/tcp are published on all interfaces"; fi
}

check_picloud() {
  section picloud
  expect_enabled FAIL picloud.service
  expect_active WARN picloud.service
  check_mailbox_device
}

# The agent reads the firmware throttle state through the mailbox device that
# deploy/.env names (PI_AGENT_MAILBOX_DEVICE, default /dev/vcio). Docker does
# not start a container whose device is missing, and the agent opens it as
# group video (GID 44, compose group_add).
# Without deploy/.env the stack is not configured (compose needs it), so there
# is no configured device to check yet: SKIP, not FAIL. A .env that only root
# can read (deploy/README.md sets mode 600) needs root: WARN, never a guess.
check_mailbox_device() {
  local env_file=$PICLOUD_DIR/deploy/.env device='' gid mode label
  if [[ ! -f $env_file ]]; then
    report SKIP "agent mailbox device: not checked ($env_file does not exist: the stack is not configured yet)"
    return 0
  fi
  if [[ -r $env_file ]]; then
    device=$(get_kv "$env_file" PI_AGENT_MAILBOX_DEVICE)
  elif need_root "agent mailbox device in $env_file"; then
    device=$(get_kv <(as_root cat -- "$env_file") PI_AGENT_MAILBOX_DEVICE)
  else
    return 0
  fi
  device=${device:-/dev/vcio}
  label="agent mailbox device $device (PI_AGENT_MAILBOX_DEVICE)"
  if [[ $device == /dev/null ]]; then
    report SKIP "agent throttle state: off (PI_AGENT_MAILBOX_DEVICE=/dev/null)"
    return 0
  fi
  if [[ ! -c $device ]]; then
    report FAIL "$label does not exist: the agent container cannot start (see deploy/README.md)"
    return 0
  fi
  gid=$(file_group_id "$device")
  mode=$(file_mode "$device")
  if [[ $gid == 44 && ${mode: -2:1} == [4567] ]]; then
    report PASS "$label: group video can read it"
  else
    report WARN "$label: group video (GID 44) cannot read it (gid $gid, mode $mode); no throttle state"
  fi
  if [[ $device != /dev/vcio_gencmd && -c /dev/vcio_gencmd ]]; then
    report WARN "/dev/vcio_gencmd exists: set PI_AGENT_MAILBOX_DEVICE=/dev/vcio_gencmd in deploy/.env (it accepts only vcgencmd commands)"
  fi
}

check_reboot() {
  section reboot
  if [[ -f /var/run/reboot-required ]]; then
    report WARN "reboot required by: $(tr '\n' ' ' </var/run/reboot-required.pkgs 2>/dev/null || true)"
  else
    report PASS "no reboot pending"
  fi
}

# ---------------------------------------------------------------------------

verify_parse_args() {
  while (($#)); do
    case $1 in
      -q | --quick) QUICK=1 ;;
      -c | --config)
        (($# >= 2)) || die "$1 needs a value"
        CONFIG_FILE=$2
        shift
        ;;
      -h | --help)
        verify_usage
        exit 0
        ;;
      *)
        verify_usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

# Like load_config, but never fatal: the audit also runs with defaults.
load_audit_config() {
  if [[ -r $CONFIG_FILE ]]; then
    # shellcheck source=/dev/null
    source "$CONFIG_FILE"
  elif [[ -f $CONFIG_FILE && $ROOT_MODE != none ]]; then
    # shellcheck source=/dev/null
    source <(as_root cat -- "$CONFIG_FILE")
  else
    warn "cannot read $CONFIG_FILE; checking against the defaults"
  fi
  config_defaults
}

verify_main() {
  verify_parse_args "$@"
  PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"
  trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR
  detect_root
  load_audit_config
  log "PiCloud audit of $(hostname) (root access: $ROOT_MODE)"

  check_base
  check_ssh
  check_firewall
  check_fail2ban
  check_updates
  check_network
  check_logging
  check_sysctl
  check_docker
  check_published_ports
  check_picloud
  check_reboot

  printf '\n%sSummary:%s %d PASS, %d WARN, %d FAIL\n' "$C_BOLD" "$C_RESET" \
    "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
  if ((FAIL_COUNT > 0)); then exit 1; fi
}

# Run only when executed, so tests can source this file.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  verify_main "$@"
fi
