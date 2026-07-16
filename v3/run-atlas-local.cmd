@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title ATLAS

set "ATLAS_INSTALL_REQUIRED="
if not exist "node_modules\.bin\tsx.cmd" set "ATLAS_INSTALL_REQUIRED=1"
node.exe -e "import('@ngrok/ngrok')" >nul 2>nul
if errorlevel 1 set "ATLAS_INSTALL_REQUIRED=1"

if defined ATLAS_INSTALL_REQUIRED (
  echo Installing ATLAS dependencies...
  call npm.cmd install --include=optional
  if errorlevel 1 (
    echo Dependency installation failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

node.exe -e "import('@ngrok/ngrok')" >nul 2>nul
if errorlevel 1 (
  echo The remote-access module still cannot load. Close this window and run Start-ATLAS.cmd again.
  pause
  exit /b 1
)

:loop
call npm.cmd start
set "ATLAS_EXIT=%ERRORLEVEL%"
echo.
echo ATLAS stopped with exit code %ATLAS_EXIT% - restarting in 5 seconds...
echo Close this window if you want ATLAS to stay stopped.
timeout /t 5 /nobreak >nul
goto loop
