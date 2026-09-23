@echo off
cd /d "%~dp0"
title Asistente WhatsApp (no cierres esta ventana)
:bucle
call npm.cmd start
echo.
echo El asistente se ha detenido. Reinicio en 15 segundos (cierra la ventana para pararlo)...
timeout /t 15 >nul
goto bucle
