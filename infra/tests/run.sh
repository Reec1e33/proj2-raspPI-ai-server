#!/usr/bin/env bash
# shellcheck disable=SC2034 # tests set globals that the code under test reads
#
# Unit tests for the infra toolkit: pure helpers, argument parsing, module
# selection and dry-run behaviour. No root, no network, no changes outside a
# temp directory. Output is TAP.
#
#   bash infra/tests/run.sh            # all tests
#   bash infra/tests/run.sh install    # tests whose name contains "install"
#
# Needs bash >= 4.4, jq and ssh-keygen.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ] ||
  { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
  echo "tests/run.sh: needs bash >= 4.4 (this is ${BASH_VERSION:-not bash})" >&2
  exit 1
fi

set -Eeuo pipefail
IFS=$' \t\n'

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../bootstrap.sh
source "$TESTS_DIR/../bootstrap.sh"
load_modules
# shellcheck source=../verify.sh
source "$INFRA_DIR/verify.sh"

NO_COLOR=1
C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_BOLD='' C_DIM='' C_RESET=''

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

fail() {
  printf 'assertion failed: %s\n' "$*" >&2
  return 1
}

assert_eq() { [[ $1 == "$2" ]] || fail "${3:-value}: expected [$2], got [$1]"; }
assert_contains() { [[ $1 == *"$2"* ]] || fail "expected output to contain [$2]; output: [$1]"; }
assert_not_contains() { [[ $1 != *"$2"* ]] || fail "expected output NOT to contain [$2]"; }

# rc_of <cmd...>: run a command in this shell and store its status in RC.
rc_of() {
  RC=0
  "$@" || RC=$?
}

# assert_status <status> <cmd...>: run a command in a subshell (so die/exit
# cannot end the test) and compare its exit status.
assert_status() {
  local want=$1 got=0
  shift
  ("$@") >/dev/null 2>&1 || got=$?
  [[ $got == "$want" ]] || fail "status of [$*]: expected $want, got $got"
}

# Put command stubs first on PATH. Each stub logs "name args" to $CALLS.
stub() {
  local name
  mkdir -p "$TEST_TMP/bin"
  for name in "$@"; do
    printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "%s" "$*" >>"%s"\n%s\n' \
      "$name" "$CALLS" "${STUB_BODY[$name]:-}" >"$TEST_TMP/bin/$name"
    chmod +x "$TEST_TMP/bin/$name"
  done
  PATH="$TEST_TMP/bin:$PATH"
}
# shellcheck disable=SC2016 # the stub bodies expand when the stub runs
declare -A STUB_BODY=(
  [ufw]='if [[ $1 == status ]]; then echo "Status: inactive"; fi'
  [dpkg-query]='echo installed'
  [getent]='echo "reece:x:1000:1000::$STUB_HOME:/bin/bash"'
  [id]='if [[ $1 == -gn ]]; then echo reece; else echo "reece sudo"; fi'
  [nmcli]='case "$*" in
    "-t -f UUID,DEVICE connection show --active") echo "uuid-1:eth0" ;;
    "-g ipv4.method connection show uuid-1") echo "$STUB_METHOD" ;;
    "-g ipv4.addresses connection show uuid-1") echo 192.168.1.50/24 ;;
    "-g ipv4.gateway connection show uuid-1") echo 192.168.1.1 ;;
    "-g ipv4.dns connection show uuid-1") echo 1.1.1.1,9.9.9.9 ;;
  esac'
  [ip]='echo "2: eth0    inet $STUB_IP brd 192.168.1.255 scope global eth0"'
)

# ---------------------------------------------------------------------------
# Tests: run() and dry-run
# ---------------------------------------------------------------------------

test_run_dry_run_prints_but_does_not_execute() {
  local out
  DRY_RUN=1
  out=$(run touch "$TEST_TMP/created")
  assert_contains "$out" "[dry-run] touch $TEST_TMP/created"
  [[ ! -e $TEST_TMP/created ]] || fail "dry-run executed the command"
}

test_run_executes_and_aborts_with_the_failed_command() {
  local out rc=0
  run touch "$TEST_TMP/created" >/dev/null
  [[ -e $TEST_TMP/created ]] || fail "command did not run"
  out=$(run ls "$TEST_TMP/missing file" 2>&1) || rc=$?
  assert_eq "$rc" 1 "status"
  assert_contains "$out" "command failed (exit"
  assert_contains "$out" 'ls '"$TEST_TMP"'/missing\ file'
}

test_confirm_is_automatic_with_yes_or_dry_run_and_fails_without_terminal() {
  ASSUME_YES=1
  confirm "go?"
  ASSUME_YES=0 DRY_RUN=1
  confirm "go?"
  DRY_RUN=0
  assert_status 1 confirm "go?" </dev/null
}

# ---------------------------------------------------------------------------
# Tests: install_file, backups, restore
# ---------------------------------------------------------------------------

test_install_file_writes_once_then_reports_no_change() {
  local src=$TEST_TMP/src dest=$TEST_TMP/etc/app.conf
  printf 'a=1\n' >"$src"
  rc_of install_file "$src" "$dest" 0640
  assert_eq "$RC" 0 "first install"
  assert_eq "$(<"$dest")" "a=1" "content"
  assert_eq "$(file_mode "$dest")" 640 "mode"
  rc_of install_file "$src" "$dest" 0640
  assert_eq "$RC" 1 "second install"
  assert_eq "$CHANGES" 1 "change count"
}

test_install_file_backs_up_the_pre_run_state_and_restore_rolls_back() {
  local src=$TEST_TMP/src dest=$TEST_TMP/app.conf
  printf 'old\n' >"$dest"
  printf 'new\n' >"$src"
  install_file "$src" "$dest" 0644 || fail "first update"
  assert_eq "$(<"$BACKUP_DIR/$RUN_ID$dest")" old "backup"
  printf 'newer\n' >"$src"
  install_file "$src" "$dest" 0644 || fail "second update"
  assert_eq "$(<"$BACKUP_DIR/$RUN_ID$dest")" old "backup keeps the pre-run state"
  restore_file "$dest" 2>/dev/null
  assert_eq "$(<"$dest")" old "restored content"
}

test_restore_file_removes_a_file_that_is_new_in_this_run() {
  local src=$TEST_TMP/src dest=$TEST_TMP/new.conf
  printf 'x\n' >"$src"
  install_file "$src" "$dest" 0644 || fail "install"
  restore_file "$dest" 2>/dev/null
  [[ ! -e $dest ]] || fail "new file was not removed"
}

test_install_file_fixes_the_mode_without_rewriting() {
  local src=$TEST_TMP/src dest=$TEST_TMP/app.conf
  printf 'same\n' >"$src"
  printf 'same\n' >"$dest"
  chmod 0644 "$dest"
  rc_of install_file "$src" "$dest" 0600
  assert_eq "$RC" 0 "mode change counts as a change"
  assert_eq "$(file_mode "$dest")" 600 "mode"
  [[ ! -e $BACKUP_DIR/$RUN_ID$dest ]] || fail "a mode fix should not need a backup"
}

test_install_file_dry_run_writes_nothing_and_hides_secret_content() {
  local src=$TEST_TMP/src dest=$TEST_TMP/secret.conf out
  DRY_RUN=1
  printf 'password=hunter2\n' >"$src"
  out=$(install_file "$src" "$dest" 0600) || fail "dry-run should report a change"
  [[ ! -e $dest ]] || fail "dry-run wrote the file"
  assert_not_contains "$out" hunter2
  assert_contains "$out" "would: write $dest"

  printf 'x=1\n' >"$TEST_TMP/public.conf"
  printf 'x=2\n' >"$src"
  out=$(install_file "$src" "$TEST_TMP/public.conf" 0644) || fail "dry-run should report a change"
  assert_contains "$out" "+x=2"
  assert_eq "$(<"$TEST_TMP/public.conf")" "x=1" "dry-run left the file alone"
}

# ---------------------------------------------------------------------------
# Tests: line and key/value editing
# ---------------------------------------------------------------------------

test_ensure_line_is_idempotent_and_handles_a_missing_final_newline() {
  local file=$TEST_TMP/list
  printf 'first' >"$file"
  rc_of ensure_line "$file" second
  assert_eq "$RC" 0 "first call"
  rc_of ensure_line "$file" second
  assert_eq "$RC" 1 "second call"
  assert_eq "$(<"$file")" $'first\nsecond' "content"
}

test_set_kv_replaces_appends_and_is_idempotent() {
  local file=$TEST_TMP/defaults
  printf '# comment\nIPV6=no\nOTHER=1\n' >"$file"
  rc_of set_kv "$file" IPV6 yes
  assert_eq "$RC" 0 "replace"
  assert_eq "$(<"$file")" $'# comment\nIPV6=yes\nOTHER=1' "content"
  rc_of set_kv "$file" IPV6 yes
  assert_eq "$RC" 1 "no-op"
  set_kv "$file" NEW 2 || fail "append"
  assert_eq "$(tail -n 1 "$file")" "NEW=2" "appended line"
}

test_get_kv_strips_quotes_and_tolerates_missing_files() {
  local file=$TEST_TMP/os-release
  printf 'ID=debian\nVERSION_ID="12"\nNAME='\''Debian GNU'\''\n' >"$file"
  assert_eq "$(get_kv "$file" ID)" debian
  assert_eq "$(get_kv "$file" VERSION_ID)" 12
  assert_eq "$(get_kv "$file" NAME)" "Debian GNU"
  assert_eq "$(get_kv "$file" MISSING)" ""
  assert_eq "$(get_kv "$TEST_TMP/nope" ID)" ""
}

test_set_hosts_entry_replaces_the_127_0_1_1_line() {
  local file=$TEST_TMP/hosts
  printf '127.0.0.1\tlocalhost\n127.0.1.1\traspberrypi\n' >"$file"
  set_hosts_entry "$file" 127.0.1.1 picloud || fail "replace"
  assert_eq "$(<"$file")" $'127.0.0.1\tlocalhost\n127.0.1.1\tpicloud' "content"
  rc_of set_hosts_entry "$file" 127.0.1.1 picloud
  assert_eq "$RC" 1 "no-op"
  printf '127.0.0.1\tlocalhost\n' >"$file"
  set_hosts_entry "$file" 127.0.1.1 picloud || fail "append"
  assert_eq "$(tail -n 1 "$file")" $'127.0.1.1\tpicloud' "appended line"
}

# ---------------------------------------------------------------------------
# Tests: templates
# ---------------------------------------------------------------------------

# shellcheck disable=SC2016 # ${distro_codename} must stay literal
test_render_template_substitutes_values_literally() {
  local tpl=$TEST_TMP/tpl out
  printf 'User {{NAME}}\nList {{LIST}}\nKeep ${distro_codename}\n{{BLOCK}}\n' >"$tpl"
  NAME=reece LIST='a{{NAME}}b' BLOCK=$'line1\nline2'
  out=$(render_template "$tpl")
  assert_eq "$out" $'User reece\nList a{{NAME}}b\nKeep ${distro_codename}\nline1\nline2'
}

test_render_template_rejects_unset_and_malformed_placeholders() {
  local tpl=$TEST_TMP/tpl
  printf 'x {{PICLOUD_TEST_UNSET}}\n' >"$tpl"
  assert_status 1 render_template "$tpl"
  printf 'x {{lower}}\n' >"$tpl"
  assert_status 1 render_template "$tpl"
  printf 'x {{OPEN\n' >"$tpl"
  assert_status 1 render_template "$tpl"
}

test_every_shipped_template_renders_with_default_config() {
  local tpl
  ADMIN_USER=reece
  config_defaults
  DISTRO_CODENAME=bookworm DEB_ARCH=arm64
  SSH_KEX_ALGORITHMS=k SSH_CIPHERS=c SSH_MACS=m SSH_HOSTKEY_ALGORITHMS=h
  updates_render_vars
  DDNS_PROVIDER=noip DDNS_LOGIN=me DDNS_PASSWORD=pw DDNS_HOSTNAME=home.ddns.net
  DDNS_PROVIDER_CONFIG=$(ddns_provider_config)
  for tpl in "$PICLOUD_FILES"/*/*; do
    render_template "$tpl" >/dev/null || fail "cannot render $tpl"
  done
  assert_contains "$(render_template "$PICLOUD_FILES/ssh/10-picloud-hardening.conf")" "AllowUsers reece"
  assert_contains "$(render_template "$PICLOUD_FILES/systemd/picloud.service")" \
    "WorkingDirectory=/opt/picloud/deploy"
}

test_updates_docker_origin_follows_the_config_flag() {
  local out
  ADMIN_USER=reece
  config_defaults
  updates_render_vars
  out=$(render_template "$PICLOUD_FILES/apt/52picloud-unattended-upgrades")
  # Docker's Release file has no Codename: the pattern must match the Suite.
  # shellcheck disable=SC2016 # a literal unattended-upgrades variable
  assert_contains "$out" '"origin=Docker,label=Docker CE,archive=${distro_codename}";'
  UPGRADE_DOCKER=false
  updates_render_vars
  out=$(render_template "$PICLOUD_FILES/apt/52picloud-unattended-upgrades")
  assert_not_contains "$out" 'origin=Docker'
  assert_contains "$out" 'UPGRADE_DOCKER=false'
}

# ---------------------------------------------------------------------------
# Tests: validators and config
# ---------------------------------------------------------------------------

test_is_true_accepts_common_spellings() {
  local value
  for value in true TRUE yes 1 on; do is_true "$value" || fail "$value should be true"; done
  for value in false no 0 off ''; do
    if is_true "$value"; then fail "'$value' should be false"; fi
  done
}

test_validators_accept_good_and_reject_bad_values() {
  valid_ipv4 192.168.1.50 || fail "ipv4"
  assert_status 1 valid_ipv4 192.168.1.256
  assert_status 1 valid_ipv4 192.168.1
  valid_ipv4_cidr 192.168.1.50/24 || fail "cidr"
  assert_status 1 valid_ipv4_cidr 192.168.1.50/33
  assert_status 1 valid_ipv4_cidr 192.168.1.50
  valid_port_spec 9100/tcp || fail "port spec"
  assert_status 1 valid_port_spec 9100
  assert_status 1 valid_port_spec 70000/udp
  valid_time_hhmm 04:00 || fail "time"
  assert_status 1 valid_time_hhmm 24:00
  valid_hostname picloud || fail "hostname"
  assert_status 1 valid_hostname -bad
}

# with_config KEY=value... -- set config values, then run validate_config.
with_config() {
  local assignment
  for assignment in "$@"; do printf -v "${assignment%%=*}" '%s' "${assignment#*=}"; done
  validate_config
}

test_validate_config_rejects_bad_values() {
  ADMIN_USER=reece
  config_defaults
  assert_status 0 with_config
  assert_status 1 with_config ADMIN_USER=
  assert_status 1 with_config ADMIN_USER=root
  assert_status 1 with_config SSH_PORT=70000
  assert_status 1 with_config LAN_ALLOW_PORTS=9100/tcp LAN_CIDR=
  assert_status 0 with_config LAN_ALLOW_PORTS="9100/tcp 53/udp" LAN_CIDR=192.168.1.0/24
  assert_status 1 with_config STATIC_IP_CIDR=192.168.1.50/24 STATIC_GATEWAY=
  assert_status 1 with_config DDNS_PROVIDER=noip DDNS_HOSTNAME=h DDNS_PASSWORD=p DDNS_LOGIN=
  assert_status 1 with_config DDNS_PROVIDER=cloudflare DDNS_HOSTNAME=h DDNS_PASSWORD="it's" DDNS_ZONE=z
  assert_status 1 with_config DDNS_PROVIDER=dyndns
  # Values that end up in ddclient.conf, apt.conf, picloud.service or authorized_keys.
  assert_status 0 with_config DDNS_PROVIDER=noip DDNS_HOSTNAME=home.ddns.net DDNS_PASSWORD=p DDNS_LOGIN=me@example.com
  assert_status 1 with_config DDNS_PROVIDER=noip DDNS_HOSTNAME=h DDNS_PASSWORD=p DDNS_LOGIN="me, use=cmd"
  assert_status 1 with_config DDNS_PROVIDER=noip DDNS_HOSTNAME=$'h\nuse=cmd' DDNS_PASSWORD=p DDNS_LOGIN=me
  assert_status 1 with_config SSH_AUTHORIZED_KEY=$'-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE='
  assert_status 0 with_config UPGRADE_MAIL=admin@example.com
  assert_status 1 with_config UPGRADE_MAIL='a"; Foo "b'
  assert_status 1 with_config PICLOUD_DIR="/opt/pi cloud"
}

test_load_config_rejects_group_writable_files() {
  local cfg=$TEST_TMP/config.env
  printf 'ADMIN_USER=reece\n' >"$cfg"
  chmod 0664 "$cfg"
  assert_status 1 load_config "$cfg"
  chmod 0600 "$cfg"
  load_config "$cfg"
  assert_eq "$ADMIN_USER" reece
  assert_eq "$SSH_PORT" 22 "default applied"
}

# ---------------------------------------------------------------------------
# Tests: bootstrap argument parsing and module selection
# ---------------------------------------------------------------------------

test_modules_are_discovered_in_run_order() {
  assert_eq "${MODULES[*]}" \
    "base ssh firewall fail2ban updates network ddns logging sysctl docker picloud"
  local name
  for name in "${MODULES[@]}"; do
    declare -F "mod_$name" >/dev/null || fail "modules/*-$name.sh does not define mod_$name"
  done
}

test_parse_args_reads_flags_and_comma_lists() {
  parse_args --dry-run --yes --only ssh,firewall --skip=firewall -c /tmp/x.env
  assert_eq "$DRY_RUN$ASSUME_YES" 11 "flags"
  assert_eq "${ONLY[*]}" "ssh firewall" "ONLY"
  assert_eq "${SKIP[*]}" "firewall" "SKIP"
  assert_eq "$CONFIG_FILE" /tmp/x.env "config"
  assert_status 2 parse_args --only
  assert_status 2 parse_args --only ''
  assert_status 2 parse_args --skip=
  assert_status 2 parse_args --bogus
}

test_select_modules_honours_only_and_skip_and_keeps_run_order() {
  ONLY=(docker ssh firewall) SKIP=(firewall)
  select_modules
  assert_eq "${SELECTED[*]}" "ssh docker"
  ONLY=() SKIP=(network ddns)
  select_modules
  assert_eq "${SELECTED[*]}" "base ssh firewall fail2ban updates logging sysctl docker picloud"
  ONLY=(nope) SKIP=()
  assert_status 2 select_modules
  ONLY=(ssh) SKIP=(ssh)
  assert_status 2 select_modules
}

test_bootstrap_cli_help_list_and_usage_errors() {
  local out
  out=$("$BASH" "$INFRA_DIR/bootstrap.sh" --help)
  assert_contains "$out" "--dry-run"
  assert_contains "$out" "picloud    picloud.service"
  out=$("$BASH" "$INFRA_DIR/bootstrap.sh" --list --skip ddns,network)
  assert_eq "$(head -n 1 <<<"$out") $(tail -n 1 <<<"$out")" "base picloud" "first and last module"
  assert_not_contains "$out" ddns
  assert_status 2 "$BASH" "$INFRA_DIR/bootstrap.sh" --only nope
  assert_status 2 "$BASH" "$INFRA_DIR/bootstrap.sh" --nope
}

test_bootstrap_explains_an_old_bash() {
  local out rc=0
  if ! [[ -x /bin/bash ]] || /bin/bash -c '((BASH_VERSINFO[0] >= 5 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4)))'; then
    echo "# skip: /bin/bash is new enough"
    return 0
  fi
  out=$(/bin/bash "$INFRA_DIR/bootstrap.sh" --help 2>&1) || rc=$?
  assert_eq "$rc" 1 "status"
  assert_contains "$out" "needs bash >= 4.4"
}

# ---------------------------------------------------------------------------
# Tests: module helpers
# ---------------------------------------------------------------------------

test_filter_algorithms_keeps_supported_names_in_wanted_order() {
  local supported=$'curve25519-sha256@libssh.org\nsntrup761x25519-sha512@openssh.com\ndiffie-hellman-group14-sha1'
  assert_eq "$(filter_algorithms "$supported" mlkem768x25519-sha256 sntrup761x25519-sha512@openssh.com \
    curve25519-sha256@libssh.org)" "sntrup761x25519-sha512@openssh.com,curve25519-sha256@libssh.org"
  assert_eq "$(filter_algorithms "$supported" curve25519-sha256)" "" "no partial-name match"
}

test_has_authorized_key_requires_a_parseable_key() {
  local keys=$TEST_TMP/authorized_keys
  ssh-keygen -q -t ed25519 -N '' -C test -f "$TEST_TMP/id"
  : >"$keys"
  assert_status 1 has_authorized_key "$keys"
  printf '# no keys yet\n\n' >"$keys"
  assert_status 1 has_authorized_key "$keys"
  printf 'from="192.168.1.0/24",no-pty %s\n' "$(<"$TEST_TMP/id.pub")" >>"$keys"
  has_authorized_key "$keys" || fail "key with options should count"
}

test_ddns_provider_config_renders_each_provider() {
  DDNS_LOGIN=me DDNS_PASSWORD=s3cret DDNS_HOSTNAME=home.ddns.net DDNS_ZONE=example.com
  DDNS_PROVIDER=noip
  assert_eq "$(ddns_provider_config)" $'protocol=noip\nlogin=me\npassword=\'s3cret\'\nhome.ddns.net'
  DDNS_PROVIDER=cloudflare
  assert_eq "$(ddns_provider_config)" \
    $'protocol=cloudflare\nzone=example.com\nlogin=token\npassword=\'s3cret\'\nhome.ddns.net'
}

test_network_dns_list_normalises_separators() {
  assert_eq "$(network_dns_list "1.1.1.1 9.9.9.9")" "1.1.1.1,9.9.9.9"
  assert_eq "$(network_dns_list "1.1.1.1, 9.9.9.9")" "1.1.1.1,9.9.9.9"
}

test_docker_daemon_json_merge_keeps_other_keys_and_is_stable() {
  local current=$TEST_TMP/daemon.json merged
  printf '{"data-root":"/mnt/docker","log-opts":{"max-size":"50m","labels":"app"}}\n' >"$current"
  merged=$(docker_merge_daemon_json "$current" "$PICLOUD_FILES/docker/daemon.json")
  assert_eq "$(jq -c . <<<"$merged")" \
    '{"data-root":"/mnt/docker","live-restore":true,"log-driver":"json-file","log-opts":{"labels":"app","max-file":"3","max-size":"10m"},"no-new-privileges":true}'
  printf '%s\n' "$merged" >"$current"
  assert_eq "$(docker_merge_daemon_json "$current" "$PICLOUD_FILES/docker/daemon.json")" "$merged" "re-merge"
  printf '{broken' >"$current"
  assert_status 1 docker_merge_daemon_json "$current" "$PICLOUD_FILES/docker/daemon.json"
}

# ---------------------------------------------------------------------------
# Tests: verify.sh parsers
# ---------------------------------------------------------------------------

test_public_bindings_reports_only_ports_on_all_interfaces() {
  local ps out
  ps=$'gateway\t0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp\n'
  ps+=$'prometheus\t127.0.0.1:9090->9090/tcp\n'
  ps+=$'agent\t9110/tcp\n'
  ps+=$'debug\t0.0.0.0:8080->80/tcp, :::8080->80/tcp\n'
  ps+=$'dns\t0.0.0.0:53->53/udp'
  out=$(public_bindings <<<"$ps")
  assert_eq "$out" $'gateway 80/tcp\ngateway 443/tcp\ndebug 8080/tcp\ndns 53/udp'
}

test_check_sysctl_fails_wrong_values_and_warns_about_unreadable_keys() {
  local out
  if ((EUID == 0)); then
    echo "# skip: root can read a mode 000 file"
    return 0
  fi
  PROC_SYS=$TEST_TMP/proc/sys PICLOUD_FILES=$TEST_TMP/files ROOT_MODE=none
  mkdir -p "$PROC_SYS/kernel" "$PROC_SYS/net/core" "$PICLOUD_FILES/sysctl"
  printf '%s\n' '# comment' 'kernel.ok = 1' 'kernel.wrong = 2' 'kernel.gone = 1' \
    '-net.core.optional = 1' 'net.core.rootonly = 2' >"$PICLOUD_FILES/sysctl/90-picloud-hardening.conf"
  echo 1 >"$PROC_SYS/kernel/ok"
  echo 0 >"$PROC_SYS/kernel/wrong"
  echo 2 >"$PROC_SYS/net/core/rootonly"
  chmod 000 "$PROC_SYS/net/core/rootonly" # like net.core.bpf_jit_harden (0600)
  check_sysctl >"$TEST_TMP/out"
  out=$(<"$TEST_TMP/out")
  assert_contains "$out" "[FAIL] sysctl kernel.wrong = 0 (want 2)"
  assert_contains "$out" "[FAIL] sysctl kernel.gone = missing (want 1)"
  assert_contains "$out" "[SKIP] sysctl net.core.optional: not supported"
  assert_contains "$out" "[WARN] sysctl net.core.rootonly: not checked (needs root"
  assert_not_contains "$out" "kernel.ok"
  assert_eq "$FAIL_COUNT/$WARN_COUNT" 2/1 "FAIL/WARN counts"
}

test_check_mailbox_device_reads_deploy_env_and_checks_the_device() {
  local out
  PICLOUD_DIR=$TEST_TMP/picloud ROOT_MODE=none
  mkdir -p "$PICLOUD_DIR/deploy"
  printf '%s\n' '# PI_AGENT_MAILBOX_DEVICE=/dev/vcio' 'PI_AGENT_MAILBOX_DEVICE="/dev/null"' >"$PICLOUD_DIR/deploy/.env"
  out=$(check_mailbox_device)
  assert_contains "$out" "[SKIP] agent throttle state: off"
  # /dev/zero exists but belongs to root, not to group video.
  printf '%s\n' 'PI_AGENT_MAILBOX_DEVICE=/dev/zero' >"$PICLOUD_DIR/deploy/.env"
  out=$(check_mailbox_device)
  assert_contains "$out" "[WARN] agent mailbox device /dev/zero (PI_AGENT_MAILBOX_DEVICE): group video (GID 44) cannot read it"
  printf '%s\n' 'PI_AGENT_MAILBOX_DEVICE=/dev/no-such-mailbox' >"$PICLOUD_DIR/deploy/.env"
  out=$(check_mailbox_device)
  assert_contains "$out" "[FAIL] agent mailbox device /dev/no-such-mailbox (PI_AGENT_MAILBOX_DEVICE) does not exist"
  # A .env without the key: the compose default. Only the label is portable
  # (on a Pi /dev/vcio exists, elsewhere it does not).
  printf '%s\n' 'SERVER_NAME=pi.example' >"$PICLOUD_DIR/deploy/.env"
  out=$(check_mailbox_device)
  assert_contains "$out" "agent mailbox device /dev/vcio (PI_AGENT_MAILBOX_DEVICE)"
}

test_check_mailbox_device_skips_when_deploy_env_is_missing() {
  PICLOUD_DIR=$TEST_TMP/picloud ROOT_MODE=none
  mkdir -p "$PICLOUD_DIR/deploy"
  # The stack is not configured yet: no device to check, so no FAIL.
  check_mailbox_device >"$TEST_TMP/out"
  assert_eq "$(<"$TEST_TMP/out")" \
    "[SKIP] agent mailbox device: not checked ($PICLOUD_DIR/deploy/.env does not exist: the stack is not configured yet)"
  assert_eq "$PASS_COUNT/$WARN_COUNT/$FAIL_COUNT" 0/0/0 "PASS/WARN/FAIL counts"
}

test_check_mailbox_device_warns_when_deploy_env_needs_root() {
  local out
  if ((EUID == 0)); then
    echo "# skip: root can read a mode 000 file"
    return 0
  fi
  PICLOUD_DIR=$TEST_TMP/picloud ROOT_MODE=none
  mkdir -p "$PICLOUD_DIR/deploy"
  # The admin user cannot read a mode 600 .env: do not guess the device.
  printf '%s\n' 'PI_AGENT_MAILBOX_DEVICE=/dev/null' >"$PICLOUD_DIR/deploy/.env"
  chmod 000 "$PICLOUD_DIR/deploy/.env"
  check_mailbox_device >"$TEST_TMP/out"
  out=$(<"$TEST_TMP/out")
  assert_contains "$out" "[WARN] agent mailbox device in $PICLOUD_DIR/deploy/.env: not checked (needs root"
  assert_not_contains "$out" "[FAIL]"
  assert_eq "$WARN_COUNT/$FAIL_COUNT" 1/0 "WARN/FAIL counts"
}

test_network_applies_a_set_profile_that_is_not_live_and_is_idempotent() {
  local out
  stub systemctl nmcli ip
  export STUB_METHOD=auto STUB_IP=192.168.1.23/24
  ADMIN_USER=reece STATIC_IP_CIDR=192.168.1.50/24 STATIC_GATEWAY=192.168.1.1
  config_defaults
  ASSUME_YES=1

  mod_network >/dev/null 2>&1
  grep -q '^nmcli connection modify uuid-1 ipv4.method manual ipv4.addresses 192.168.1.50/24' "$CALLS" ||
    fail "a DHCP profile was not changed"
  assert_eq "${POST_RUN_HOOKS[*]}" network_apply "hook after a profile change"

  # The profile is right but the run stopped before the hook: apply it now.
  POST_RUN_HOOKS=() STUB_METHOD=manual
  : >"$CALLS"
  mod_network >/dev/null 2>&1
  if grep -q '^nmcli connection modify' "$CALLS"; then fail "a correct profile was changed"; fi
  assert_eq "${POST_RUN_HOOKS[*]}" network_apply "hook for a profile that is not live"

  POST_RUN_HOOKS=() STUB_IP=192.168.1.50/24
  out=$(mod_network 2>&1)
  assert_contains "$out" "already uses 192.168.1.50/24"
  mod_network >/dev/null 2>&1
  assert_eq "${#POST_RUN_HOOKS[@]}" 0 "no hook when the address is live"
}

test_sshd_value_reads_one_keyword() {
  local cfg=$'port 22\npermitrootlogin no\nallowusers reece\nciphers a,b'
  assert_eq "$(sshd_value "$cfg" permitrootlogin)" no
  assert_eq "$(sshd_value "$cfg" ciphers)" a,b
  assert_eq "$(sshd_value "$cfg" missing)" ""
}

# ---------------------------------------------------------------------------
# Tests: whole modules against command stubs
# ---------------------------------------------------------------------------

test_firewall_dry_run_runs_only_read_only_commands() {
  local out calls
  stub ufw dpkg-query apt-get systemctl
  ADMIN_USER=reece SSH_PORT=2222 LAN_CIDR=192.168.1.0/24 LAN_ALLOW_PORTS="9100/tcp"
  config_defaults
  DRY_RUN=1
  out=$(mod_firewall 2>&1)
  assert_contains "$out" "[dry-run] ufw limit 2222/tcp"
  assert_contains "$out" "[dry-run] ufw allow from 192.168.1.0/24 to any port 9100 proto tcp"
  assert_contains "$out" "[dry-run] ufw --force enable"
  calls=$(<"$CALLS")
  if grep -Ev '^(ufw status|ufw show added|dpkg-query -W .*)$' <<<"$calls"; then
    fail "dry-run called a state-changing command (see above)"
  fi
}

test_ssh_lockout_guard_stops_before_any_change() {
  local out rc=0
  stub dpkg-query getent id sshd systemctl
  STUB_HOME=$TEST_TMP/home
  export STUB_HOME
  mkdir -p "$STUB_HOME/.ssh"
  ADMIN_USER=reece SSH_AUTHORIZED_KEY=''
  config_defaults
  out=$(mod_ssh 2>&1) || rc=$?
  assert_eq "$rc" 1 "status"
  assert_contains "$out" "lockout guard"
  if grep -Eq '^(sshd|systemctl) ' "$CALLS"; then fail "sshd/systemctl ran before the guard stopped"; fi
}

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

setup() {
  TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/picloud-test.XXXXXX")
  trap 'rm -rf "$TEST_TMP"' EXIT
  WORK_DIR=$TEST_TMP/work
  mkdir -p "$WORK_DIR"
  BACKUP_DIR=$TEST_TMP/backups
  CALLS=$TEST_TMP/calls
  : >"$CALLS"
  RUN_ID=testrun DRY_RUN=0 ASSUME_YES=0 CHANGES=0
}

run_tests() {
  local filter=${1:-} name log status count=0 failed=0
  local -a tests
  mapfile -t tests < <(declare -F | awk '$3 ~ /^test_/ { print $3 }')
  log=$(mktemp "${TMPDIR:-/tmp}/picloud-test-log.XXXXXX")
  for name in "${tests[@]}"; do
    [[ $name == *"$filter"* ]] || continue
    count=$((count + 1))
    set +e
    (
      set -e
      setup
      "$name"
    ) >"$log" 2>&1
    status=$?
    set -e
    if ((status == 0)); then
      printf 'ok %d - %s\n' "$count" "$name"
    else
      failed=$((failed + 1))
      printf 'not ok %d - %s\n' "$count" "$name"
      sed 's/^/#   /' "$log"
    fi
  done
  rm -f "$log"
  printf '1..%d\n' "$count"
  if ((failed > 0)); then
    printf '# %d of %d tests failed\n' "$failed" "$count"
    return 1
  fi
  printf '# all %d tests passed\n' "$count"
}

run_tests "${1:-}"
