#!/usr/bin/env bash
# Summary: UFW: deny inbound, rate-limit SSH, allow 80/443, LAN-only extras
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

# Docker and UFW: Docker programs its own iptables chains, and traffic to a
# published container port never reaches UFW's INPUT rules. UFW therefore
# cannot block a port that a container publishes on 0.0.0.0. The PiCloud
# compose stack publishes only the gateway (80/443) and binds Prometheus to
# 127.0.0.1, so nothing else is exposed. verify.sh warns about any other
# container port published on all interfaces.

UFW_DEFAULTS=/etc/default/ufw
UFW_CONF=/etc/ufw/ufw.conf

mod_firewall() {
  local reload=0 spec specs
  ensure_pkg ufw

  # Must be set before rules are added, or the rules get no IPv6 copy.
  if set_kv "$UFW_DEFAULTS" IPV6 yes; then reload=1; fi

  if [[ $(get_kv "$UFW_DEFAULTS" DEFAULT_INPUT_POLICY) != DROP ]]; then
    run ufw default deny incoming
    note_change "ufw default deny incoming"
  fi
  if [[ $(get_kv "$UFW_DEFAULTS" DEFAULT_OUTPUT_POLICY) != ACCEPT ]]; then
    run ufw default allow outgoing
    note_change "ufw default allow outgoing"
  fi

  # The SSH rule exists before UFW is enabled, so this session survives.
  # "limit" denies an address after 6 connections in 30 seconds.
  ufw_rule limit "$SSH_PORT/tcp"
  ufw_rule allow 80/tcp
  ufw_rule allow 443/tcp
  read -ra specs <<<"$LAN_ALLOW_PORTS"
  for spec in "${specs[@]}"; do
    ufw_rule allow from "$LAN_CIDR" to any port "${spec%/*}" proto "${spec#*/}"
  done

  if [[ $(get_kv "$UFW_CONF" LOGLEVEL) != low ]]; then
    run ufw logging low
    note_change "ufw logging low"
  fi

  if ! ufw_active; then
    run ufw --force enable
    note_change "enable ufw"
  elif ((reload)); then
    run ufw reload
  fi

  firewall_warn_old_ssh_rule
}

# After a port change the old port 22 rule stays until you remove it by hand,
# so a failed move cannot lock you out.
firewall_warn_old_ssh_rule() {
  local added
  if [[ $SSH_PORT == 22 ]]; then return 0; fi
  added=$(ufw show added 2>/dev/null || true)
  if grep -Eq '^ufw (allow|limit) 22(/tcp)?$' <<<"$added"; then
    warn "UFW still allows port 22. When port $SSH_PORT works, run: ufw delete limit 22/tcp"
  fi
}
