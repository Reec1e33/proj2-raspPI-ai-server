#!/usr/bin/env bash
# Summary: SSH: keys only, no root, modern algorithms, sshd -t, lockout guard
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

SSH_DROPIN=/etc/ssh/sshd_config.d/10-picloud-hardening.conf

# Wanted algorithms in preference order. Names the local OpenSSH does not
# support (e.g. ML-KEM before OpenSSH 9.9) are dropped at install time.
SSH_WANTED_KEX=(mlkem768x25519-sha256 sntrup761x25519-sha512 sntrup761x25519-sha512@openssh.com
  curve25519-sha256 curve25519-sha256@libssh.org)
SSH_WANTED_CIPHERS=(chacha20-poly1305@openssh.com aes256-gcm@openssh.com aes128-gcm@openssh.com)
SSH_WANTED_MACS=(hmac-sha2-512-etm@openssh.com hmac-sha2-256-etm@openssh.com umac-128-etm@openssh.com)
SSH_WANTED_HOSTKEYS=(ssh-ed25519 ssh-ed25519-cert-v01@openssh.com
  rsa-sha2-512 rsa-sha2-512-cert-v01@openssh.com rsa-sha2-256 rsa-sha2-256-cert-v01@openssh.com)

mod_ssh() {
  local keys
  keys="$(user_home "$ADMIN_USER")/.ssh/authorized_keys"

  ensure_pkg openssh-server
  if [[ -n $SSH_AUTHORIZED_KEY ]]; then ssh_install_key "$keys"; fi
  ssh_lockout_guard "$keys"
  ssh_require_include
  ssh_select_algorithms
  # sshd -t and sshd -T need the privilege separation dir, which exists only
  # while ssh.service runs (SSH is off by default on Raspberry Pi OS).
  if [[ ! -d /run/sshd ]]; then run install -d -m 0755 /run/sshd; fi
  ssh_port_guard

  if install_template "$PICLOUD_FILES/ssh/10-picloud-hardening.conf" "$SSH_DROPIN" 0644; then
    validate_or_restore "$SSH_DROPIN" sshd -t
    # Reload keeps open sessions, including the one running this script.
    if unit_active ssh; then run systemctl reload ssh; fi
  fi
  enable_unit ssh --now
}

# filter_algorithms <supported, one per line> <wanted...>
# Print the wanted names that are supported, comma-separated, in wanted order.
filter_algorithms() {
  local supported=$'\n'"$1"$'\n' alg out=()
  shift
  for alg in "$@"; do
    if [[ $supported == *$'\n'"$alg"$'\n'* ]]; then out+=("$alg"); fi
  done
  local IFS=,
  printf '%s\n' "${out[*]}"
}

# Set the algorithm lists that the drop-in template uses.
# shellcheck disable=SC2034 # read by render_template through {{NAME}}
ssh_select_algorithms() {
  SSH_KEX_ALGORITHMS=$(ssh_supported kex "${SSH_WANTED_KEX[@]}")
  SSH_CIPHERS=$(ssh_supported cipher "${SSH_WANTED_CIPHERS[@]}")
  SSH_MACS=$(ssh_supported mac "${SSH_WANTED_MACS[@]}")
  SSH_HOSTKEY_ALGORITHMS=$(ssh_supported key-sig "${SSH_WANTED_HOSTKEYS[@]}")
}

# ssh_supported <ssh -Q query> <wanted...>: the supported subset, comma-separated.
ssh_supported() {
  local query=$1 list
  shift
  if missing_in_dry_run ssh "filter of the $query list"; then
    list=$(IFS=,; printf '%s' "$*")
  else
    list=$(filter_algorithms "$(ssh -Q "$query")" "$@")
  fi
  [[ -n $list ]] || die "none of the wanted $query algorithms is supported by this OpenSSH"
  printf '%s\n' "$list"
}

# True if <file> holds at least one public key that ssh-keygen can parse.
has_authorized_key() {
  if [[ -s $1 ]] && ssh-keygen -l -f "$1" >/dev/null 2>&1; then return 0; fi
  return 1
}

# Add SSH_AUTHORIZED_KEY to the admin user's authorized_keys.
ssh_install_key() {
  local file=$1 dir tmp group
  dir=$(dirname -- "$file")
  tmp=$(work_file)
  printf '%s\n' "$SSH_AUTHORIZED_KEY" >"$tmp"
  if ! missing_in_dry_run ssh-keygen "check of SSH_AUTHORIZED_KEY"; then
    has_authorized_key "$tmp" || die "config: SSH_AUTHORIZED_KEY is not a valid public key"
  fi
  group=$(id -gn "$ADMIN_USER")
  if [[ ! -d $dir ]]; then run install -d -m 0700 -o "$ADMIN_USER" -g "$group" "$dir"; fi
  if [[ ! -f $file ]]; then run install -m 0600 -o "$ADMIN_USER" -g "$group" /dev/null "$file"; fi
  ensure_line "$file" "$SSH_AUTHORIZED_KEY" || true
}

# Refuse to turn off password login while the admin user has no key: that
# would lock everyone out of a headless Pi.
ssh_lockout_guard() {
  local file=$1
  if has_authorized_key "$file"; then return 0; fi
  if ((DRY_RUN)) && [[ -n $SSH_AUTHORIZED_KEY ]]; then return 0; fi
  die "lockout guard: $file has no valid public key, and this module turns off password login.
       From your computer run: ssh-copy-id $ADMIN_USER@<pi-address>
       or set SSH_AUTHORIZED_KEY in config.env, then run the module again."
}

ssh_require_include() {
  local main=/etc/ssh/sshd_config
  if grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$main" 2>/dev/null; then
    return 0
  fi
  if ((DRY_RUN)) && [[ ! -f $main ]]; then return 0; fi
  die "$main does not include /etc/ssh/sshd_config.d/*.conf, so the drop-in would be ignored"
}

# A port change must not lock us out: confirm it, and open the new port in UFW
# (when UFW is already active) before sshd reloads.
ssh_port_guard() {
  local current=''
  if have sshd; then current=$(sshd -T 2>/dev/null | awk '$1 == "port" && !n++ { print $2 }' || true); fi
  if [[ -z $current || $current == "$SSH_PORT" ]]; then return 0; fi

  warn "SSH moves from port $current to port $SSH_PORT. This session stays open."
  warn "Test a NEW session (ssh -p $SSH_PORT $ADMIN_USER@<pi>) before you close this one."
  confirm "Change the SSH port to $SSH_PORT?" || die "SSH port change cancelled"
  if ufw_active; then ufw_rule limit "$SSH_PORT/tcp"; fi
  if unit_active ssh.socket; then
    warn "ssh.socket is active: socket activation sets the listen port, not sshd_config"
  fi
}
