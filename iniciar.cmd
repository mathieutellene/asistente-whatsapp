@echo off
cd /d "%~dp0"
title Asistente WhatsApp (no cierres esta ventana)
:bucle
node --env-file=.env src\index.js
if %errorlevel%==3 (
  timeout /t 5 >nul
  exit /b 0
)
echo.
echo El asistente se ha detenido. Reinicio en 15 segundos (cierra la ventana para pararlo)...
timeout /t 15 >nul
goto bucle
