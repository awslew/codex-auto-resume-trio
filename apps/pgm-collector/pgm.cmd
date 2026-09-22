@echo off
rem PGM CLI — 项目路径 = 脚本所在目录
rem 解释器解析顺序：PGM_PYTHON → py -3 → python（不写死本机路径）
setlocal
if not "%PGM_PYTHON%"=="" (
  "%PGM_PYTHON%" "%~dp0pgm.py" %*
  exit /b %ERRORLEVEL%
)
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%~dp0pgm.py" %*
  exit /b %ERRORLEVEL%
)
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python "%~dp0pgm.py" %*
  exit /b %ERRORLEVEL%
)
echo 找不到 Python。请安装 Python 3.11+，或用 PGM_PYTHON 指向解释器。
exit /b 1
