#!/usr/bin/env bash
set -euo pipefail

purge=false
if [[ "${1:-}" == "--purge" ]]; then
  purge=true
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--purge]\n' "$0" >&2
  exit 2
fi

systemctl --user disable --now grok-bot-headless.service 2>/dev/null || true
rm -f "${HOME}/.config/systemd/user/grok-bot-headless.service"
rm -f "${HOME}/.local/bin/grok-bot-headless"
rm -rf "${HOME}/.local/lib/grok-bot-headless"
rm -f "${HOME}/.config/grok-bot-headless/environment"
systemctl --user daemon-reload 2>/dev/null || true

if [[ "$purge" == true ]]; then
  rm -rf "${HOME}/.config/grok-bot-headless" "${HOME}/.local/share/grok-bot-headless"
  printf 'Removed the service, controller, credentials, and runtime data.\n'
else
  printf 'Removed the service and controller. Credentials and runtime data remain.\n'
  printf 'Run %s --purge to remove them.\n' "$0"
fi
