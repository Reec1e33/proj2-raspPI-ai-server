#!/usr/bin/env bash
# Summary: picloud.service: docker compose up -d in PICLOUD_DIR/deploy at boot
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

PICLOUD_UNIT=/etc/systemd/system/picloud.service

mod_picloud() {
  local deploy="$PICLOUD_DIR/deploy"
  if install_template "$PICLOUD_FILES/systemd/picloud.service" "$PICLOUD_UNIT" 0644; then
    run systemctl daemon-reload
  fi
  enable_unit picloud.service

  if [[ ! -f $deploy/docker-compose.yml ]]; then
    warn "$deploy/docker-compose.yml not found: clone the repository to $PICLOUD_DIR."
    warn "picloud.service is enabled but not started."
    return 0
  fi
  if [[ ! -f $deploy/.env ]]; then
    warn "$deploy/.env is missing, so the stack is not started. Create it, then start it:"
    warn "  cp $deploy/.env.example $deploy/.env; edit it; systemctl start picloud"
    return 0
  fi
  if ! unit_started picloud.service; then
    # --no-block: the first start can build or pull images for many minutes.
    run systemctl start --no-block picloud.service
    note_change "start picloud.service (follow it with: journalctl -u picloud -f)"
  fi
}
