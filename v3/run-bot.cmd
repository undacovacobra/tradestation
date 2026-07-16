@echo off
rem The crash watchdog: runs the bot, and if it ever stops or crashes, waits 5
rem seconds and starts it again. Close this window to stop the bot for real.
cd /d "%~dp0"
title ATLAS
:loop
call npm start
echo.
echo ATLAS stopped or crashed - restarting in 5 seconds...
echo (Close this window if you want it to STAY stopped.)
timeout /t 5 /nobreak >nul
goto loop
