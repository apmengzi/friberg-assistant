@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 -m http.server 4173 --bind 127.0.0.1
) else (
  python -m http.server 4173 --bind 127.0.0.1
)
