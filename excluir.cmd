@echo off
title Numeros excluidos
set "D=%LOCALAPPDATA%\asistente-whatsapp"
set "F=%D%\excluidos.txt"
if not exist "%D%" mkdir "%D%"
if not exist "%F%" (
  echo # Numeros que el asistente NO debe guardar ni usar nunca.
  echo # Uno por linea, con prefijo de pais. Ejemplos validos:
  echo #   34600111222
  echo #   +34 600 111 222
  echo # Los espacios, guiones y el + se ignoran. Las lineas que empiezan por # tambien.
) > "%F%"
echo Se abre el Bloc de notas con la lista. Escribe los numeros, guarda y cierra el Bloc de notas.
start "" notepad "%F%"
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\aplicar-excluidos.ps1"
pause
