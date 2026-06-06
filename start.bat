@echo off
chcp 65001>nul
setlocal enabledelayedexpansion
:: 改成你的项目路径
set "DIR=G:\game\suroi"
set PORT=5173
set WAIT=2
set MAX=35

cd /d "%DIR%" || exit

:: 如需安装依赖取消注释
:: pnpm install

:: 最小化后台启动dev，不阻塞脚本
start "" /min cmd /c "pnpm dev --port %PORT%"

set n=0
:loop
timeout /t %WAIT% /nobreak>nul
set /a n+=1
:: curl加1秒超时，不会卡死
curl --connect-timeout 1 -s http://127.0.0.1:%PORT% >nul 2>&1
if !errorlevel! equ 0 (
    start "" http://127.0.0.1:%PORT%
    exit
)
if !n! lss %MAX% goto loop
exit