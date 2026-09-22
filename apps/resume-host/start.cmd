@echo off
rem Codex 自动续跑宿主 — 手动启动（会弹控制台窗口，便于看日志）
rem 真实发送在这里显式开启：AUTO_RESUME_V2_EXECUTE=1
rem 只观测（不发送、不改动任何东西）请用：start-observe.cmd
setlocal
set "HERE=%~dp0"
set "REPO=%HERE%..\.."
set "AUTO_RESUME_V2_EXECUTE=1"
if "%RESUME_HOST_PORT%"=="" set "RESUME_HOST_PORT=5173"
echo [start] 启动 Codex 自动续跑宿主（execute 已开启），关闭本窗口即停止。
node "%HERE%bin\resume-host.mjs" run --port %RESUME_HOST_PORT% --tray
endlocal
