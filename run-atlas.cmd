@echo off
setlocal EnableExtensions
for %%I in ("%~dp0.") do set "REPO_ROOT=%%~fI"
set "ATLAS_DIR=%REPO_ROOT%\v3"
title ATLAS

if not exist "%ATLAS_DIR%\package.json" (
  echo ATLAS v3 was not found at "%ATLAS_DIR%".
  echo Download the complete repository ZIP and extract it before starting ATLAS.
  pause
  exit /b 1
)

rem Preserve a configured installation that had v3 runtime files at ZIP root.
rem Existing v3 files always win; migration happens only when the target is absent.
if not exist "%ATLAS_DIR%\.env" if exist "%REPO_ROOT%\.env" (
  copy /y "%REPO_ROOT%\.env" "%ATLAS_DIR%\.env" >nul
)
if not exist "%ATLAS_DIR%\data\settings.json" if exist "%REPO_ROOT%\data\settings.json" (
  robocopy "%REPO_ROOT%\data" "%ATLAS_DIR%\data" /E /R:1 /W:1 >nul
)
if not exist "%ATLAS_DIR%\.tradovate-session" if exist "%REPO_ROOT%\.tradovate-session\Default" (
  mklink /J "%ATLAS_DIR%\.tradovate-session" "%REPO_ROOT%\.tradovate-session" >nul
)
if not exist "%ATLAS_DIR%\.tradovate-sessions" if exist "%REPO_ROOT%\.tradovate-sessions" (
  mklink /J "%ATLAS_DIR%\.tradovate-sessions" "%REPO_ROOT%\.tradovate-sessions" >nul
)

if not exist "%ATLAS_DIR%\.env" (
  copy /y "%ATLAS_DIR%\.env.example" "%ATLAS_DIR%\.env" >nul
  echo Created v3\.env from the safe template. Review its secrets before LIVE mode.
)

set "ATLAS_INSTALL_REQUIRED="
if not exist "%ATLAS_DIR%\node_modules\.bin\tsx.cmd" set "ATLAS_INSTALL_REQUIRED=1"
pushd "%ATLAS_DIR%"
node.exe -e "import('@ngrok/ngrok')" >nul 2>nul
if errorlevel 1 set "ATLAS_INSTALL_REQUIRED=1"
popd

if defined ATLAS_INSTALL_REQUIRED (
  echo Installing ATLAS v3 dependencies...
  call npm.cmd --prefix "%ATLAS_DIR%" install --include=optional
  if errorlevel 1 (
    echo Dependency installation failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

pushd "%ATLAS_DIR%"
node.exe -e "import('@ngrok/ngrok')" >nul 2>nul
if errorlevel 1 (
  popd
  echo The remote-access module still cannot load. Close this window and run Start ATLAS.cmd again.
  pause
  exit /b 1
)
popd

:loop
call npm.cmd --prefix "%ATLAS_DIR%" start
set "ATLAS_EXIT=%ERRORLEVEL%"
echo.
echo ATLAS stopped with exit code %ATLAS_EXIT% - restarting in 5 seconds...
echo Close this window if you want ATLAS to stay stopped.
timeout /t 5 /nobreak >nul
goto loop
