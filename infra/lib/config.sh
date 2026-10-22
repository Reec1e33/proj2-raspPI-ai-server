#!/usr/bin/env bash
# Configuration schema for infra/config.env (documented in config.env.example):
# defaults, validation and loading. Sourced by lib/common.sh.

config_defaults() {
  : "${ADMIN_USER:=}"
  : "${SSH_AUTHORIZED_KEY:=}"
  : "${SSH_PORT:=22}"
  : "${PI_HOSTNAME:=picloud}"
  : "${TIMEZONE:=Etc/UTC}"
  : "${LAN_CIDR:=}"
  : "${LAN_ALLOW_PORTS:=}"
  : "${AUTO_REBOOT:=true}"
  : "${AUTO_REBOOT_TIME:=04:00}"
  : "${UPGRADE_MAIL:=}"
  : "${UPGRADE_DOCKER:=true}"
  : "${NET_IFACE:=eth0}"
  : "${STATIC_IP_CIDR:=}"
  : "${STATIC_GATEWAY:=}"
  : "${STATIC_DNS:=1.1.1.1 9.9.9.9}"
  : "${DDNS_PROVIDER:=}"
  : "${DDNS_HOSTNAME:=}"
  : "${DDNS_LOGIN:=}"
  : "${DDNS_PASSWORD:=}"
  : "${DDNS_ZONE:=}"
  : "${LOG2RAM_ENABLE:=false}"
  : "${LOG2RAM_SIZE:=256M}"
  : "${PICLOUD_DIR:=/opt/picloud}"
}

# Check every value before any module runs, so a typo fails fast.
validate_config() {
  local spec specs dns dns_list
  [[ -n $ADMIN_USER ]] || die "config: ADMIN_USER is required"
  valid_username "$ADMIN_USER" || die "config: ADMIN_USER '$ADMIN_USER' is not a valid user name"
  [[ $ADMIN_USER != root ]] || die "config: ADMIN_USER must not be root"
  # One line: a pasted private key (or several keys) must not reach authorized_keys.
  [[ $SSH_AUTHORIZED_KEY != *$'\n'* ]] ||
    die "config: SSH_AUTHORIZED_KEY must be one public key on one line (the content of a .pub file)"
  valid_port "$SSH_PORT" || die "config: SSH_PORT '$SSH_PORT' is not a port number"
  valid_hostname "$PI_HOSTNAME" || die "config: PI_HOSTNAME '$PI_HOSTNAME' is not a valid host name"
  valid_time_hhmm "$AUTO_REBOOT_TIME" || die "config: AUTO_REBOOT_TIME must be HH:MM"
  # Rendered into an apt.conf string.
  [[ -z $UPGRADE_MAIL || $UPGRADE_MAIL =~ ^[A-Za-z0-9._%+@-]+$ ]] ||
    die "config: UPGRADE_MAIL '$UPGRADE_MAIL' is not a mail address"
  # Rendered into picloud.service, where spaces and '%' have a meaning.
  [[ $PICLOUD_DIR =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    die "config: PICLOUD_DIR must be an absolute path of letters, digits and ._/-"
  [[ $LOG2RAM_SIZE =~ ^[0-9]+[KMG]$ ]] || die "config: LOG2RAM_SIZE must look like 256M"

  read -ra specs <<<"$LAN_ALLOW_PORTS"
  if ((${#specs[@]})); then
    valid_ipv4_cidr "$LAN_CIDR" || die "config: LAN_ALLOW_PORTS needs a valid LAN_CIDR (got '$LAN_CIDR')"
  fi
  for spec in "${specs[@]}"; do
    valid_port_spec "$spec" || die "config: LAN_ALLOW_PORTS entry '$spec' must look like 9100/tcp"
  done

  if [[ -n $STATIC_IP_CIDR ]]; then
    valid_ipv4_cidr "$STATIC_IP_CIDR" || die "config: STATIC_IP_CIDR must look like 192.168.1.50/24"
    valid_ipv4 "$STATIC_GATEWAY" || die "config: STATIC_GATEWAY must be an IPv4 address"
    read -ra dns_list <<<"$STATIC_DNS"
    ((${#dns_list[@]})) || die "config: STATIC_DNS needs at least one DNS server"
    for dns in "${dns_list[@]}"; do
      valid_ipv4 "$dns" || die "config: STATIC_DNS entry '$dns' is not an IPv4 address"
    done
  fi

  case $DDNS_PROVIDER in
    '') ;;
    noip | cloudflare)
      [[ -n $DDNS_HOSTNAME && -n $DDNS_PASSWORD ]] ||
        die "config: DDNS_PROVIDER=$DDNS_PROVIDER needs DDNS_HOSTNAME and DDNS_PASSWORD"
      # These values become lines of ddclient.conf; a stray newline or quote
      # could add options such as "use=cmd, cmd=...", which runs a program.
      [[ $DDNS_PASSWORD != *[\'\\$'\n']* ]] ||
        die "config: DDNS_PASSWORD must not contain quotes, backslashes or newlines"
      [[ $DDNS_HOSTNAME =~ ^[A-Za-z0-9.,_-]+$ ]] ||
        die "config: DDNS_HOSTNAME '$DDNS_HOSTNAME' must be host names (comma-separated)"
      [[ -z $DDNS_ZONE || $DDNS_ZONE =~ ^[A-Za-z0-9._-]+$ ]] ||
        die "config: DDNS_ZONE '$DDNS_ZONE' is not a domain"
      [[ $DDNS_LOGIN != *[[:space:]\'\"\\=,]* ]] ||
        die "config: DDNS_LOGIN must not contain spaces, quotes, backslashes, '=' or ','"
      if [[ $DDNS_PROVIDER == noip && -z $DDNS_LOGIN ]]; then die "config: No-IP needs DDNS_LOGIN"; fi
      if [[ $DDNS_PROVIDER == cloudflare && -z $DDNS_ZONE ]]; then die "config: Cloudflare needs DDNS_ZONE"; fi
      ;;
    *) die "config: DDNS_PROVIDER must be empty, 'noip' or 'cloudflare'" ;;
  esac
}

# Source config.env (it is Bash) after a permission check, then apply defaults.
load_config() {
  local file=$1 mode
  [[ -f $file ]] || die "config file $file not found: cp config.env.example config.env, then edit it"
  mode=$(file_mode "$file")
  if ((8#$mode & 8#022)); then
    die "$file is writable by group or others and runs as root: chmod 600 $file"
  fi
  # The owner of a file can always change it, so a non-root owner could
  # make this script run any command as root.
  if ((EUID == 0)) && [[ $(file_owner "$file") != root:* ]]; then
    die "$file runs as root but belongs to $(file_owner "$file"): chown root:root $file"
  fi
  if ((8#$mode & 8#004)); then warn "$file is world-readable and can hold secrets: chmod 600 $file"; fi
  # shellcheck source=/dev/null
  source "$file"
  config_defaults
  validate_config
}
