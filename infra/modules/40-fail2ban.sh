#!/usr/bin/env bash
# Summary: fail2ban: sshd jail (systemd journal), incremental bans, recidive
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

F2B_JAIL=/etc/fail2ban/jail.local
F2B_LOG=/var/log/fail2ban.log

mod_fail2ban() {
  # python3-systemd provides the journal backend that the sshd jail uses.
  ensure_pkg fail2ban python3-systemd

  # The recidive jail reads fail2ban's own log; it must exist at start-up.
  if [[ ! -e $F2B_LOG ]]; then
    run install -m 0640 -o root -g adm /dev/null "$F2B_LOG"
    note_change "create $F2B_LOG"
  fi

  if install_template "$PICLOUD_FILES/fail2ban/jail.local" "$F2B_JAIL" 0644; then
    validate_or_restore "$F2B_JAIL" fail2ban-client --test
    run systemctl restart fail2ban
  fi
  enable_unit fail2ban --now
}
