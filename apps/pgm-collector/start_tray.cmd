@echo off
rem 启动 PGM 托盘常驻（无控制台窗口）
rem 解释器解析顺序：PGM_PYTHONW → PGM_PYTHON → py -3（pythonw）→ pythonw（不写死本机路径）
setlocal
if not "%PGM_PYTHONW%"=="" (
  start "" "%PGM_PYTHONW%" "%~dp0pgm_tray.py"
  exit /b 0
)
if not "%PGM_PYTHON%"=="" (
  start "" "%PGM_PYTHON%" "%~dp0pgm_tray.py"
  exit /b 0
)
where pythonw >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" pythonw "%~dp0pgm_tray.py"
  exit /b 0
)
echo 找不到 pythonw。请安装 Python 3.11+，或用 PGM_PYTHONW 指向 pythonw.exe。
exit /b 1
