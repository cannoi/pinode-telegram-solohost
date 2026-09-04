@echo off
setlocal EnableExtensions
title Pi Node - DNS Refresh
if /I "%~1"=="/scheduled" goto RUN
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo ============================================================
echo  DNS REFRESH
echo ============================================================
echo  Will do:
echo   - Flush Windows DNS cache only
echo  Will NOT:
echo   - Change LAN IP
echo   - Reset Winsock / TCP-IP
echo   - Touch the modem
echo  Use when: peers drop but ports stay open and ledger still moves.
echo ============================================================
echo.
choice /C YN /N /M "Run this script? [Y/N] "
if errorlevel 2 exit /b 0
:RUN
ipconfig /flushdns
echo [OK] DNS cache flushed. LAN IP unchanged.
if /I not "%~1"=="/scheduled" pause
exit /b 0
