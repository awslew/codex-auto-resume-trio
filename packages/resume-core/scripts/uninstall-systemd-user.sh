#!/usr/bin/env sh
set -eu

systemctl --user disable --now codex-auto-resume.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/codex-auto-resume.service"
systemctl --user daemon-reload
echo "removed codex-auto-resume.service"
