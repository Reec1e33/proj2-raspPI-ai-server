#!/usr/bin/env bash
# Summary: static IPv4 address with NetworkManager (skipped if not configured)
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

NET_APPLY_UUID=''

mod_network() {
  local uuid want_dns addrs current_ip profile_ok=0
  if [[ -z $STATIC_IP_CIDR ]]; then
    log "STATIC_IP_CIDR is empty: the address stays on DHCP (skipped)"
    return 0
  fi
  if ! unit_active NetworkManager; then
    warn "NetworkManager is not active (older images use dhcpcd). Set the address in"
    warn "/etc/dhcpcd.conf instead. Static IP skipped."
    return 0
  fi

  uuid=$(network_connection_uuid "$NET_IFACE")
  [[ -n $uuid ]] || die "no active NetworkManager connection on $NET_IFACE (check NET_IFACE)"

  want_dns=$(network_dns_list "$STATIC_DNS")
  if [[ $(network_get "$uuid" ipv4.method) == manual &&
    $(network_get "$uuid" ipv4.addresses) == "$STATIC_IP_CIDR" &&
    $(network_get "$uuid" ipv4.gateway) == "$STATIC_GATEWAY" &&
    $(network_dns_list "$(network_get "$uuid" ipv4.dns)") == "$want_dns" ]]; then
    profile_ok=1
  fi
  addrs=$(ip -4 -o addr show dev "$NET_IFACE" 2>/dev/null || true)
  current_ip=$(awk 'NR == 1 { print $4 }' <<<"$addrs")
  if ((profile_ok)) && [[ $addrs == *" inet $STATIC_IP_CIDR "* ]]; then
    log "$NET_IFACE already uses $STATIC_IP_CIDR via $STATIC_GATEWAY"
    return 0
  fi
  # A profile that is right but not live: an earlier run stopped before its
  # post-run hook. Activate it now instead of waiting for a reboot.

  warn "Static IP for $NET_IFACE: ${current_ip:-none} -> $STATIC_IP_CIDR (gateway $STATIC_GATEWAY)."
  warn "The change applies 10 s AFTER this run ends. If the address changes, this SSH"
  warn "session drops: reconnect to ${STATIC_IP_CIDR%/*}. Pick an address outside the"
  warn "router's DHCP pool (or reserve it), or two hosts can get the same address."
  if ! confirm "Set the static IP now?"; then
    warn "static IP skipped"
    return 0
  fi

  if ((profile_ok)); then
    note_change "activate static IP $STATIC_IP_CIDR on $NET_IFACE (after the run)"
  else
    run nmcli connection modify "$uuid" ipv4.method manual ipv4.addresses "$STATIC_IP_CIDR" \
      ipv4.gateway "$STATIC_GATEWAY" ipv4.dns "$want_dns"
    note_change "static IP $STATIC_IP_CIDR on $NET_IFACE (applies after the run)"
  fi
  NET_APPLY_UUID=$uuid
  add_post_run_hook network_apply
}

# UUID of the active connection on <iface> (empty if none).
network_connection_uuid() {
  nmcli -t -f UUID,DEVICE connection show --active |
    awk -F: -v dev="$1" '$2 == dev && !found { print $1; found = 1 }'
}

network_get() { nmcli -g "$2" connection show "$1"; }

# "1.1.1.1 9.9.9.9" or "1.1.1.1, 9.9.9.9" -> "1.1.1.1,9.9.9.9"
network_dns_list() {
  local servers
  read -ra servers <<<"${1//,/ }"
  local IFS=,
  printf '%s\n' "${servers[*]}"
}

# Post-run hook: re-activate the connection from a transient systemd timer, so
# the switch happens outside this SSH session and cannot cut the run short.
# AccuracySec=1s: timers default to 1 minute of slack.
network_apply() {
  log "applying the static IP in 10 seconds (systemd-run, detached from this session)"
  run systemd-run --quiet --collect --unit="picloud-net-apply-$RUN_ID" \
    --on-active=10s --timer-property=AccuracySec=1s \
    /usr/bin/nmcli connection up "$NET_APPLY_UUID"
}
