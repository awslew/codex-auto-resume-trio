$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName "codex-auto-resume" -Confirm:$false
Write-Host "removed codex-auto-resume scheduled task"
