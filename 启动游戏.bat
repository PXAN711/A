@echo off
rem ============================================================
rem  HuanSanZhang Mahjong - offline portable launcher (Windows)
rem  Uses the bundled runtime\node.exe: no install / no network
rem  needed on another computer. Goto-based flow on purpose, to
rem  avoid parenthesis-parsing errors inside cmd IF blocks.
rem ============================================================
cd /d "%~dp0"
title Mahjong Server port 3000

rem 1) Prefer the Node runtime bundled inside this package.
set "NODE=runtime\node.exe"
if exist "%NODE%" goto haveNode
set "NODE=node"
:haveNode

rem 2) Verify Node is available, bundled or system-installed.
"%NODE%" -v >nul 2>&1
if not errorlevel 1 goto nodeOk
echo.
echo [ERROR] Node.js runtime was not found.
echo The runtime folder with node.exe must stay next to this file.
echo Please extract the whole zip into one folder and run again.
echo.
pause
exit /b 1
:nodeOk

rem 3) Dependencies are bundled; only install if somehow missing.
if exist "node_modules" goto depsOk
echo node_modules missing - running npm install once, needs internet...
call npm install --no-audit --no-fund
:depsOk

echo.
echo ============================================================
echo  Server starting - KEEP THIS WINDOW OPEN while playing.
echo  This PC      : http://localhost:3000
echo  Same-LAN PC  : open the http://YOUR-IP:3000 printed below.
echo  Close this window to stop the server.
echo ============================================================
echo.
"%NODE%" server.js
echo.
echo Server stopped.
pause
