#!/usr/bin/env bash
# Summary: kernel and network sysctl hardening (IP forwarding stays on for Docker)
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

SYSCTL_DROPIN=/etc/sysctl.d/90-picloud-hardening.conf

mod_sysctl() {
  if install_file "$PICLOUD_FILES/sysctl/90-picloud-hardening.conf" "$SYSCTL_DROPIN" 0644; then
    # Apply all sysctl.d files exactly as at boot.
    run systemctl restart systemd-sysctl.service
  fi
}
