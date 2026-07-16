@echo off
rem Double-click this to start ATLAS: launches it in its own window (with a
rem crash watchdog that restarts it automatically if it ever dies) and opens
rem the dashboard. Leave the bot window running.
cd /d "%~dp0"
start "ATLAS" cmd /c run-bot.cmd
rem Give the server a few seconds to come up, then open the dashboard.
timeout /t 5 /nobreak >nul
start "" http://localhost:3400
