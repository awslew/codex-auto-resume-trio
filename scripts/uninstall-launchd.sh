#!/usr/bin/env sh
set -eu

target="$HOME/Library/LaunchAgents/dev.codex-auto-resume.plist"
launchctl unload "$target" 2>/dev/null || true
rm -f "$target"
echo "removed $target"
