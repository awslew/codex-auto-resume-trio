@echo off
rem 停止 Codex 自动续跑宿主：按 PID 文件精确杀进程树（禁按镜像名批量清杀）
setlocal enabledelayedexpansion
set "PIDFILE=%~dp0runtime\host.pid"
if not exist "%PIDFILE%" (
  echo [stop] 未找到 %PIDFILE% —— 宿主可能没在跑。
  exit /b 0
)
set "PID="
for /f "usebackq tokens=*" %%i in (`node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pid)}catch(e){console.log('')}" "%PIDFILE%"`) do set "PID=%%i"
if "%PID%"=="" (
  echo [stop] PID 文件无法解析，未执行任何杀进程操作。
  exit /b 1
)
echo [stop] taskkill /PID %PID% /T /F
taskkill /PID %PID% /T /F
endlocal
