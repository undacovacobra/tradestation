@echo off
rem Double-click this file to start everything: it launches the bot (which also
rem turns on remote access automatically if you've set it up) and opens the
rem dashboard in your browser. Leave the bot window that opens running.
cd /d "%~dp0"
start "Trading Bot" cmd /k npm start
rem Give the server a few seconds to come up, then open the dashboard.
timeout /t 5 /nobreak >nul
start "" http://localhost:3300
