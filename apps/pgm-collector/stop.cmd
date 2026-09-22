@echo off
rem 停止 PGM 看板/托盘：按端口找 PID 后精确杀掉（禁按名字杀进程）
set PORT=%1
if "%PORT%"=="" set PORT=5101
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo Killing PID %%p on port %PORT% ...
    taskkill /PID %%p /F
)
echo Done.
