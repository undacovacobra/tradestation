@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem If ATLAS is already healthy, do not create a second server/watchdog.
curl.exe -fsS http://localhost:3400/health >nul 2>nul
if not errorlevel 1 goto open_dashboard

rem Start the current ATLAS v3 build in its own watchdog window. This uses
rem cmd.exe and npm.cmd, so Windows PowerShell execution policy is irrelevant.
start "ATLAS" cmd.exe /c ""%~dp0run-atlas.cmd""

rem Wait for health instead of guessing how long dependency installation takes.
for /L %%N in (1,1,60) do (
  curl.exe -fsS http://localhost:3400/health >nul 2>nul
  if not errorlevel 1 goto open_dashboard
  timeout /t 1 /nobreak >nul
)

:open_dashboard
start "" "http://localhost:3400/"
