$ErrorActionPreference = "Stop"
$Action = New-ScheduledTaskAction -Execute "car" -Argument "daemon foreground"
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "codex-auto-resume" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Codex Auto Resume daemon" -Force | Out-Null
Write-Host "installed codex-auto-resume scheduled task"
