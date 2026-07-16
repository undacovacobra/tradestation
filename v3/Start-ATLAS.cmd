@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Safe to run from PowerShell as .\Start-ATLAS.cmd: the filename has no spaces.
curl.exe -fsS http://localhost:3400/health >nul 2>nul
if not errorlevel 1 goto open_dashboard

start "ATLAS" cmd.exe /c ""%~dp0run-atlas-local.cmd""

for /L %%N in (1,1,60) do (
  curl.exe -fsS http://localhost:3400/health >nul 2>nul
  if not errorlevel 1 goto open_dashboard
  timeout /t 1 /nobreak >nul
)

:open_dashboard
start "" "http://localhost:3400/"

