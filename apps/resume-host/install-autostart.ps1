# Codex 自动续跑宿主 · 注册开机自启（Windows 计划任务）
#
# 用法（管理员 PowerShell）：
#     powershell -ExecutionPolicy Bypass -File apps\resume-host\install-autostart.ps1
# 卸载：
#     powershell -ExecutionPolicy Bypass -File apps\resume-host\uninstall-autostart.ps1
#
# 脚本不硬编码本机路径：计划任务的动作指向本仓库里实际存在的 start-host.vbs。
param(
    [string]$TaskName = "resume-host"
)

$ErrorActionPreference = "Stop"

$hostDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $hostDir "start-host.vbs"

if (-not (Test-Path $vbs)) {
    throw "找不到 $vbs —— 请在仓库内运行本脚本。"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "PATH 上找不到 node。宿主需要 Node.js >= 22.5。"
}

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`"" -WorkingDirectory $hostDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 3 `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Codex 自动续跑宿主（无人值守续跑 + 只读状态页 + 系统托盘）" -Force | Out-Null

Write-Host "[ok] 已注册计划任务：$TaskName"
Write-Host "     动作：wscript.exe `"$vbs`""
Write-Host "     状态页：http://127.0.0.1:$($env:RESUME_HOST_PORT ?? '5173')/"
Write-Host "     首次验证：Start-ScheduledTask -TaskName $TaskName"
Write-Host "     查看结果：Get-ScheduledTaskInfo -TaskName $TaskName"
