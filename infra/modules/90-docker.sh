#!/usr/bin/env bash
# Summary: Docker Engine + compose plugin from download.docker.com, daemon.json defaults
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"

DOCKER_KEY_URL=https://download.docker.com/linux/debian/gpg
DOCKER_KEYRING=/etc/apt/keyrings/docker.asc
DOCKER_SOURCES=/etc/apt/sources.list.d/docker.sources
DOCKER_DAEMON_JSON=/etc/docker/daemon.json
# Fingerprint of Docker's release signing key, as published in the Docker docs.
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)
# Distro packages that conflict with Docker CE (see the Docker install guide).
DOCKER_CONFLICTS=(docker.io docker-doc docker-compose podman-docker containerd runc)

# files/docker/daemon.json:
#   log-driver, log-opts  rotate container logs (3 x 10 MB) so they cannot fill the disk
#   live-restore          containers keep running while dockerd restarts or upgrades
#   no-new-privileges     processes in containers cannot gain privileges (setuid)
# userland-proxy stays at its default (on). With it off, Docker routes published
# ports through iptables NAT and sets route_localnet on its bridges, which on
# older releases let LAN hosts reach ports bound to 127.0.0.1 (Prometheus).
# The proxy costs one small process per published port.

mod_docker() {
  local was_active=0 daemon_changed=0 repo_changed=0
  docker_check_conflicts
  ensure_pkg ca-certificates curl gpg jq
  # dockerd applies its docker-default AppArmor profile only if apparmor_parser
  # is installed (a Recommends that --no-install-recommends skips). Without
  # it, containers run unconfined even though the kernel supports AppArmor.
  if apparmor_enabled; then ensure_pkg apparmor; fi

  if docker_install_key; then repo_changed=1; fi
  # shellcheck disable=SC2034 # read by render_template through {{NAME}}
  DEB_ARCH=$(dpkg --print-architecture)
  if install_template "$PICLOUD_FILES/apt/docker.sources" "$DOCKER_SOURCES" 0644; then repo_changed=1; fi
  if ((repo_changed)); then APT_UPDATED=0; fi

  # daemon.json goes in place before the first install, so dockerd starts with it.
  if unit_active docker; then was_active=1; fi
  if docker_write_daemon_json; then daemon_changed=1; fi
  ensure_pkg "${DOCKER_PACKAGES[@]}"
  if ((daemon_changed)); then
    validate_or_restore "$DOCKER_DAEMON_JSON" dockerd --validate --config-file "$DOCKER_DAEMON_JSON"
    if ((was_active)); then run systemctl restart docker; fi
  fi
  enable_unit docker --now
  docker_admin_group
}

docker_check_conflicts() {
  local pkg found=()
  for pkg in "${DOCKER_CONFLICTS[@]}"; do
    if pkg_installed "$pkg"; then found+=("$pkg"); fi
  done
  ((${#found[@]} == 0)) || die "remove the distro Docker packages first: apt-get purge ${found[*]}"
}

# Download the repository key, check its fingerprint, install it if new.
docker_install_key() {
  local key fpr
  if missing_in_dry_run curl "download of the Docker key"; then return 0; fi
  key=$(work_file)
  fetch "$DOCKER_KEY_URL" "$key"
  if ! missing_in_dry_run gpg "fingerprint check of the Docker key"; then
    fpr=$(gpg_primary_fingerprint "$key")
    [[ $fpr == "$DOCKER_KEY_FINGERPRINT" ]] ||
      die "Docker key fingerprint mismatch: got '$fpr', want $DOCKER_KEY_FINGERPRINT"
  fi
  install_file "$key" "$DOCKER_KEYRING" 0644
}

gpg_primary_fingerprint() {
  local home
  home=$(mktemp -d "$WORK_DIR/gnupg.XXXXXX")
  GNUPGHOME=$home gpg --batch --quiet --with-colons --show-keys "$1" |
    awk -F: '$1 == "fpr" && !n++ { print $10 }'
}

docker_write_daemon_json() {
  local merged
  if missing_in_dry_run jq "preview of the daemon.json merge"; then return 0; fi
  merged=$(work_file)
  docker_merge_daemon_json "$DOCKER_DAEMON_JSON" "$PICLOUD_FILES/docker/daemon.json" >"$merged"
  install_file "$merged" "$DOCKER_DAEMON_JSON" 0644
}

# Deep-merge our settings over an existing daemon.json and keep its other
# keys. Sorted keys give stable output, so a re-run does not rewrite the file.
docker_merge_daemon_json() {
  local current=$1 ours=$2
  if [[ -s $current ]]; then
    jq -S -s '.[0] * .[1]' "$current" "$ours" || die "$current is not valid JSON; fix or remove it"
  else
    jq -S . "$ours"
  fi
}

docker_admin_group() {
  if [[ " $(id -nG "$ADMIN_USER") " == *" docker "* ]]; then return 0; fi
  run usermod -aG docker "$ADMIN_USER"
  note_change "add $ADMIN_USER to the docker group"
  warn "The docker group is root-equivalent: its members can mount / into a container."
  warn "$ADMIN_USER must log out and in again to use docker without sudo."
}
