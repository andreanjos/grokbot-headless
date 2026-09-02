#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
home_dir="$test_root/home"
fake_dir="$test_root/fake"
shim_dir="$test_root/bin"
mkdir -p "$home_dir" "$fake_dir" "$shim_dir"
printf '#!/usr/bin/env sh\ncase "${2:-}" in\n  *process.stdout.write*) printf "0.30.0" ;;\n  *require.resolve*) test "${FAIL_DAEMON_PROBE:-0}" != 1 ;;\nesac\n' > "$fake_dir/grok-bot"
printf 'archive fixture\n' > "$fake_dir/app.asar"
printf '#!/usr/bin/env sh\nexit 0\n' > "$shim_dir/systemctl"
chmod 0755 "$fake_dir/grok-bot" "$shim_dir/systemctl"

HOME="$home_dir" \
USER=testuser \
PATH="$shim_dir:$PATH" \
GROK_BOT_BINARY="$fake_dir/grok-bot" \
GROK_BOT_DAEMON_SCRIPT="$fake_dir/app.asar/dist/local-exec-daemon/main.cjs" \
  "$repo_dir/install.sh"

test -x "$home_dir/.local/bin/grok-bot-headless"
test -x "$home_dir/.local/lib/grok-bot-headless/grok-bot-headless.mjs"
test -f "$home_dir/.config/systemd/user/grok-bot-headless.service"
test "$(stat -c '%a' "$home_dir/.config/grok-bot-headless/environment")" = 600
test "$(stat -c '%a' "$home_dir/.config/grok-bot-headless")" = 700
HOME="$home_dir" "$home_dir/.local/bin/grok-bot-headless" help >/dev/null
check_output="$(
  HOME="$home_dir" \
  GROK_BOT_BINARY="$fake_dir/grok-bot" \
  GROK_BOT_DAEMON_SCRIPT="$fake_dir/app.asar/dist/local-exec-daemon/main.cjs" \
  SAND_CLIENT_APP_VERSION="99.0.0" \
    "$home_dir/.local/bin/grok-bot-headless" check --local
)"
[[ "$check_output" == *'"compatible": true'* ]]
[[ "$check_output" == *'"installedVersion": "0.30.0"'* ]]
if HOME="$home_dir" \
  GROK_BOT_BINARY="$fake_dir/grok-bot" \
  GROK_BOT_DAEMON_SCRIPT="$fake_dir/app.asar/dist/local-exec-daemon/main.cjs" \
  FAIL_DAEMON_PROBE=1 \
    "$home_dir/.local/bin/grok-bot-headless" check --local >/dev/null 2>&1; then
  printf 'compatibility check accepted a missing daemon entry point\n' >&2
  exit 1
fi
mkdir -p "$home_dir/.local/share/grok-bot-headless"
printf '{}\n' > "$home_dir/.config/grok-bot-headless/credentials.json"
printf '{"pid":%s}\n' "$$" > "$home_dir/.local/share/grok-bot-headless/local-exec-daemon.json"
if HOME="$home_dir" PATH="$shim_dir:$PATH" "$home_dir/.local/bin/grok-bot-headless" logout >/dev/null 2>&1; then
  printf 'logout accepted an active daemon\n' >&2
  exit 1
fi
test -f "$home_dir/.config/grok-bot-headless/credentials.json"
rm -f "$home_dir/.local/share/grok-bot-headless/local-exec-daemon.json"
HOME="$home_dir" PATH="$shim_dir:$PATH" "$home_dir/.local/bin/grok-bot-headless" logout >/dev/null
test ! -e "$home_dir/.config/grok-bot-headless/credentials.json"

HOME="$home_dir" PATH="$shim_dir:$PATH" "$repo_dir/uninstall.sh" --purge
test ! -e "$home_dir/.local/bin/grok-bot-headless"
test ! -e "$home_dir/.local/lib/grok-bot-headless"
test ! -e "$home_dir/.config/grok-bot-headless"
