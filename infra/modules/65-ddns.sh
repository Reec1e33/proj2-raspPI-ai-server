#!/usr/bin/env bash
# Summary: dynamic DNS with ddclient for No-IP or Cloudflare (skipped if not configured)
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

DDNS_CONF=/etc/ddclient.conf

mod_ddns() {
  if [[ -z $DDNS_PROVIDER ]]; then
    log "DDNS_PROVIDER is empty: no dynamic DNS (skipped)"
    return 0
  fi
  # ddclient needs IO::Socket::SSL for ssl=yes; it is only a Recommends.
  ensure_pkg ddclient libio-socket-ssl-perl

  # shellcheck disable=SC2034 # read by render_template through {{NAME}}
  DDNS_PROVIDER_CONFIG=$(ddns_provider_config)
  if install_template "$PICLOUD_FILES/ddclient/ddclient.conf.template" "$DDNS_CONF" 0600 root:root; then
    run systemctl restart ddclient
  fi
  enable_unit ddclient --now
}

# The provider-specific part of ddclient.conf.
ddns_provider_config() {
  case $DDNS_PROVIDER in
    noip)
      printf '%s\n' 'protocol=noip' "login=$DDNS_LOGIN" "password='$DDNS_PASSWORD'" "$DDNS_HOSTNAME"
      ;;
    cloudflare)
      # With an API token (Zone.DNS edit), ddclient expects login=token.
      printf '%s\n' 'protocol=cloudflare' "zone=$DDNS_ZONE" 'login=token' \
        "password='$DDNS_PASSWORD'" "$DDNS_HOSTNAME"
      ;;
    *) die "unknown DDNS_PROVIDER '$DDNS_PROVIDER'" ;;
  esac
}
