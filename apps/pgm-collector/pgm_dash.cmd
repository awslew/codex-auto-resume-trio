@echo off
rem PGM Dashboard — 项目路径 = 脚本所在目录（默认端口 5100，可加参数指定）
setlocal
if not "%PGM_PYTHON%"=="" (
  "%PGM_PYTHON%" "%~dp0pgm_dash.py" %*
  exit /b %ERRORLEVEL%
)
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%~dp0pgm_dash.py" %*
  exit /b %ERRORLEVEL%
)
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python "%~dp0pgm_dash.py" %*
  exit /b %ERRORLEVEL%
)
echo 找不到 Python。请安装 Python 3.11+，或用 PGM_PYTHON 指向解释器。
exit /b 1
