#!/usr/bin/env bash
# Summary: packages (apt full-upgrade, essentials), timezone, hostname, NTP
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

BASE_PACKAGES=(ca-certificates curl git jq)

mod_base() {
  apt_update_once
  base_upgrade
  ensure_pkg "${BASE_PACKAGES[@]}"
  base_timezone
  base_hostname
  base_ntp
}

base_upgrade() {
  local plan count
  if ! plan=$(apt-get -s full-upgrade 2>/dev/null); then
    warn "cannot simulate apt-get full-upgrade; skipping the upgrade check"
    return 0
  fi
  count=$(grep -c '^Inst ' <<<"$plan" || true)
  if ((count == 0)); then
    log "no package upgrades pending"
    return 0
  fi
  # full-upgrade (not upgrade) is what Raspberry Pi OS recommends: it also
  # takes new dependencies of the kernel and firmware packages.
  run "${APT_GET[@]}" full-upgrade
  note_change "upgrade $count packages"
}

base_timezone() {
  local current
  [[ -f /usr/share/zoneinfo/$TIMEZONE ]] || die "unknown TIMEZONE '$TIMEZONE'"
  current=$(timedatectl show -p Timezone --value 2>/dev/null || true)
  if [[ $current == "$TIMEZONE" ]]; then return 0; fi
  run timedatectl set-timezone "$TIMEZONE"
  note_change "timezone ${current:-unknown} -> $TIMEZONE"
}

base_hostname() {
  local current=''
  if [[ -r /etc/hostname ]]; then current=$(</etc/hostname); fi
  if [[ $current != "$PI_HOSTNAME" ]]; then
    run hostnamectl set-hostname "$PI_HOSTNAME"
    note_change "hostname ${current:-unset} -> $PI_HOSTNAME"
  fi
  # Debian resolves its own name through the 127.0.1.1 line in /etc/hosts.
  set_hosts_entry /etc/hosts 127.0.1.1 "$PI_HOSTNAME" || true
}

base_ntp() {
  # Correct time matters for TLS, logs and apt signatures.
  if [[ $(timedatectl show -p NTP --value 2>/dev/null || true) == yes ]]; then return 0; fi
  if [[ $(timedatectl show -p CanNTP --value 2>/dev/null || true) != yes ]]; then
    warn "no NTP service found: install systemd-timesyncd (or chrony) for time sync"
    return 0
  fi
  run timedatectl set-ntp true
  note_change "enable NTP time sync"
}
