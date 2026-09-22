# Codex 自动续跑宿主 · 卸载开机自启（Windows 计划任务）
#
# 用法（管理员 PowerShell）：
#     powershell -ExecutionPolicy Bypass -File apps\resume-host\uninstall-autostart.ps1
#
# 只注销计划任务，不删除任何状态数据（watch / lease / jobs 都在状态目录里保留）。
param(
    [string]$TaskName = "codex-resume-host"
)

$ErrorActionPreference = "Stop"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "[skip] 计划任务 $TaskName 不存在。"
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "[ok] 已注销计划任务：$TaskName"
Write-Host "     状态数据未删除；宿主进程若仍在运行，用 apps\resume-host\stop.cmd 停止。"
