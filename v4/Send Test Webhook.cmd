@echo off
setlocal
cd /d "%~dp0"
echo V4 Standalone Webhook Sender
echo This sends a simulation-only test unless you start it from a terminal with --live.
call npm run webhook:send
echo.
pause
