@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title ATLAS

if not exist "node_modules\.bin\tsx.cmd" (
  echo Installing ATLAS dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo Dependency installation failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

:loop
call npm.cmd start
set "ATLAS_EXIT=%ERRORLEVEL%"
echo.
echo ATLAS stopped with exit code %ATLAS_EXIT% - restarting in 5 seconds...
echo Close this window if you want ATLAS to stay stopped.
timeout /t 5 /nobreak >nul
goto loop

