#!/usr/bin/env sh
set -eu

target="$HOME/Library/LaunchAgents/dev.codex-auto-resume.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$(dirname "$0")/codex-auto-resume.plist" "$target"
launchctl unload "$target" 2>/dev/null || true
launchctl load "$target"
echo "installed $target"
