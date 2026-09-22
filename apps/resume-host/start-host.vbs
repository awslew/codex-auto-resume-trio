' Codex 自动续跑宿主 — 开机自启入口（Windows 计划任务调用）
'
' 和旧的 taskboard 启动器同一模式：wscript 隐藏窗口拉起 node，用户看不到黑框。
' 真实发送开关在这里显式开启：AUTO_RESUME_V2_EXECUTE=1（宿主默认恒 observe）。
'
' 计划任务注册方式见 apps/resume-host/install-autostart.ps1。
Option Explicit

Dim shell, fso, here, hostScript, command, env
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
hostScript = fso.BuildPath(here, "bin\resume-host.mjs")

' 0 = 隐藏窗口；True = 等待进程结束（任务计划据此判断运行状态）
shell.CurrentDirectory = here
Set env = shell.Environment("PROCESS")
env("AUTO_RESUME_V2_EXECUTE") = "1"

command = "node """ & hostScript & """ run --tray"
WScript.Quit shell.Run(command, 0, True)
