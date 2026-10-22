#!/usr/bin/env bash
# Summary: persistent journald with size/age caps, optional log2ram for the SD card
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

# Docker container log rotation lives in /etc/docker/daemon.json, which the
# docker module owns (one module per file).

JOURNALD_DROPIN=/etc/systemd/journald.conf.d/90-picloud.conf
AZLUX_KEYRING=/etc/apt/keyrings/azlux.gpg
AZLUX_SOURCES=/etc/apt/sources.list.d/azlux.sources

mod_logging() {
  if install_file "$PICLOUD_FILES/journald/90-picloud.conf" "$JOURNALD_DROPIN" 0644; then
    run systemctl restart systemd-journald
    # Move logs collected in /run (volatile) to /var/log/journal.
    run journalctl --flush
  fi

  if is_true "$LOG2RAM_ENABLE"; then
    logging_log2ram
  else
    log "log2ram is off (LOG2RAM_ENABLE=false)"
  fi
}

# log2ram keeps /var/log in RAM and writes it to the SD card on a schedule and
# at shutdown. That cuts SD-card wear, but a power cut loses the logs since
# the last sync. The tmpfs must hold the journal (SystemMaxUse=200M), hence
# the 256M default for LOG2RAM_SIZE.
logging_log2ram() {
  local key repo_changed=0
  if ! missing_in_dry_run curl "download of the azlux key"; then
    key=$(work_file)
    fetch https://azlux.fr/repo.gpg "$key"
    if install_file "$key" "$AZLUX_KEYRING" 0644; then repo_changed=1; fi
  fi
  if install_template "$PICLOUD_FILES/apt/azlux.sources" "$AZLUX_SOURCES" 0644; then repo_changed=1; fi
  if ((repo_changed)); then APT_UPDATED=0; fi

  ensure_pkg log2ram
  if set_kv /etc/log2ram.conf SIZE "$LOG2RAM_SIZE" || ! unit_active log2ram; then
    warn "log2ram (SIZE=$LOG2RAM_SIZE) takes effect after the next reboot"
  fi
}
