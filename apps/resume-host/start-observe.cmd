@echo off
rem Codex 自动续跑宿主 — 只观测模式（零发送）
rem 用来确认门禁/额度识别是否正常，不会有任何真实续跑动作。
setlocal
set "HERE=%~dp0"
set "AUTO_RESUME_V2_SHADOW="
set "AUTO_RESUME_V2_EXECUTE="
if "%RESUME_HOST_PORT%"=="" set "RESUME_HOST_PORT=5173"
echo [observe] 观测模式启动（不会发送任何消息）。
node "%HERE%bin\resume-host.mjs" run --observe --port %RESUME_HOST_PORT% --tray
endlocal
