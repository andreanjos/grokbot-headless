#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${HOME}/.local/bin"
lib_dir="${HOME}/.local/lib/grok-bot-headless"
unit_dir="${HOME}/.config/systemd/user"
config_dir="${HOME}/.config/grok-bot-headless"
environment_path="${config_dir}/environment"
app_bin="${GROK_BOT_BINARY:-/opt/Grok Bot/grok-bot}"
daemon_script="${GROK_BOT_DAEMON_SCRIPT:-/opt/Grok Bot/resources/app.asar/dist/local-exec-daemon/main.cjs}"
if [[ "$app_bin" == *$'\n'* || "$app_bin" == *$'\r'* || "$daemon_script" == *$'\n'* || "$daemon_script" == *$'\r'* ]]; then
  printf 'Error: application paths cannot contain line breaks.\n' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'Error: Node.js 20 or newer is required.\n' >&2
  exit 1
fi
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 20 )); then
  printf 'Error: Node.js 20 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 1
fi
printf 'Checking Grok Bot compatibility...\n'
if ! GROK_BOT_BINARY="$app_bin" GROK_BOT_DAEMON_SCRIPT="$daemon_script" \
  node "$repo_dir/grok-bot-headless.mjs" check --local; then
  printf 'Install Grok Bot first, or set GROK_BOT_BINARY and GROK_BOT_DAEMON_SCRIPT.\n' >&2
  exit 1
fi

mkdir -p "$bin_dir" "$lib_dir" "$unit_dir" "$config_dir"
chmod 0700 "$config_dir"
install -m 0755 "$repo_dir/grok-bot-headless.mjs" "$lib_dir/grok-bot-headless.mjs"
install -m 0755 "$repo_dir/bin/grok-bot-headless" "$bin_dir/grok-bot-headless"
install -m 0644 "$repo_dir/grok-bot-headless.service" "$unit_dir/grok-bot-headless.service"
escaped_app_bin="${app_bin//\\/\\\\}"
escaped_app_bin="${escaped_app_bin//\"/\\\"}"
escaped_daemon_script="${daemon_script//\\/\\\\}"
escaped_daemon_script="${escaped_daemon_script//\"/\\\"}"
printf 'GROK_BOT_BINARY="%s"\nGROK_BOT_DAEMON_SCRIPT="%s"\n' \
  "$escaped_app_bin" "$escaped_daemon_script" > "$environment_path"
chmod 0600 "$environment_path"
systemctl --user daemon-reload
systemctl --user enable grok-bot-headless.service

printf '\nInstalled grok-bot-headless.\n'
printf 'Next steps:\n'
printf '  1. %s/grok-bot-headless login\n' "$bin_dir"
printf '  2. %s/grok-bot-headless policy ask\n' "$bin_dir"
printf '  3. systemctl --user start grok-bot-headless\n'
printf '\nFor startup before desktop login, run once:\n'
printf '  sudo loginctl enable-linger %s\n' "$USER"
