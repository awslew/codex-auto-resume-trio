#!/usr/bin/env sh
set -eu

target="$HOME/.config/systemd/user/codex-auto-resume.service"
mkdir -p "$(dirname "$target")"
cp "$(dirname "$0")/codex-auto-resume.service" "$target"
systemctl --user daemon-reload
systemctl --user enable --now codex-auto-resume.service
echo "installed $target"
