#!/usr/bin/env bash
# Summary: unattended-upgrades: Debian, Raspberry Pi and Docker archives, reboot window
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

UU_PERIODIC=/etc/apt/apt.conf.d/20auto-upgrades
UU_CONFIG=/etc/apt/apt.conf.d/52picloud-unattended-upgrades

mod_updates() {
  ensure_pkg unattended-upgrades
  updates_render_vars

  if install_file "$PICLOUD_FILES/apt/20auto-upgrades" "$UU_PERIODIC" 0644; then
    validate_or_restore "$UU_PERIODIC" apt-config dump --no-empty APT::Periodic
  fi
  if install_template "$PICLOUD_FILES/apt/52picloud-unattended-upgrades" "$UU_CONFIG" 0644; then
    validate_or_restore "$UU_CONFIG" apt-config dump --no-empty Unattended-Upgrade
  fi
  if [[ -n $UPGRADE_MAIL ]] && ! have sendmail; then
    warn "UPGRADE_MAIL is set but no mail transport is installed (e.g. msmtp-mta); mails will not go out"
  fi

  # apt-daily(-upgrade).timer run the periodic jobs; the service makes
  # unattended-upgrades finish safely on shutdown.
  enable_unit apt-daily.timer --now
  enable_unit apt-daily-upgrade.timer --now
  enable_unit unattended-upgrades.service --now
}

# Values for the 52picloud-unattended-upgrades template.
# shellcheck disable=SC2034 # read by render_template through {{NAME}}
updates_render_vars() {
  UU_AUTO_REBOOT=false
  if is_true "$AUTO_REBOOT"; then UU_AUTO_REBOOT=true; fi
  if is_true "$UPGRADE_DOCKER"; then
    # download.docker.com has no Codename in its Release file, so match the
    # Suite (archive=). dockerd restarts on upgrade; live-restore (daemon.json,
    # docker module) keeps the containers running meanwhile.
    # shellcheck disable=SC2016 # ${distro_codename} is for unattended-upgrades, not the shell
    UU_DOCKER_ORIGIN='        // Docker Engine (download.docker.com, see the docker module).
        "origin=Docker,label=Docker CE,archive=${distro_codename}";'
  else
    UU_DOCKER_ORIGIN='        // Docker Engine updates are off: UPGRADE_DOCKER=false in config.env.'
  fi
  if [[ -n $UPGRADE_MAIL ]]; then
    UU_MAIL_CONFIG="Unattended-Upgrade::Mail \"$UPGRADE_MAIL\";
Unattended-Upgrade::MailReport \"only-on-error\";"
  else
    UU_MAIL_CONFIG='// Mail reports are off: set UPGRADE_MAIL in config.env to turn them on.'
  fi
}
