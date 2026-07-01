@echo off
rem Double-click this file to start the bot and open the dashboard.
cd /d "%~dp0"
start "" http://localhost:3300
npm start
pause
