@echo off
title Trading Bot Launcher
cd /d "%~dp0"

echo ============================================================
echo   Starting your trading bot + Cloudflare tunnel...
echo ============================================================
echo.
echo Two windows will open:
echo   1) BOT     - the trading bot. Leave it running.
echo   2) TUNNEL  - shows your web address for TradingView.
echo.
echo (Whatever EXECUTOR is set to in your .env decides practice vs live.)
echo.

rem Start the webhook server (npm uses the .env settings).
start "Tradovate Bot" cmd /k npm start

rem Give the bot a few seconds to come up, then open the tunnel to it.
timeout /t 4 >nul
start "Cloudflare Tunnel" cmd /k cloudflared tunnel --url http://localhost:3000

echo.
echo Done. You can close THIS window.
echo In the TUNNEL window, look for your https://...trycloudflare.com
echo address and paste it (with /webhook on the end) into TradingView.
echo.
timeout /t 10 >nul
