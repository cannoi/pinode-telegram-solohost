@echo off
setlocal EnableExtensions
title Pi Node - DnsFlush
cd /d "%~dp0"

if /I "%~1"=="/scheduled" goto GOTADMIN
if /I "%~1"=="/quiet" goto GOTADMIN
net session >nul 2>&1
if %errorLevel%==0 goto GOTADMIN
echo Requesting Administrator...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -LiteralPath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs"
exit /b
:GOTADMIN
if /I "%~1"=="/scheduled" goto RUN
if /I "%~1"=="/quiet" goto RUN
echo.
echo ============================================================
echo  DNS FLUSH
echo ============================================================
echo  Will do:
echo   - Flush Windows DNS cache
echo   - Register DNS
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
ipconfig /registerdns >nul 2>&1
echo [OK] DNS cache flushed. LAN IP unchanged.
if /I not "%~1"=="/scheduled" if /I not "%~1"=="/quiet" pause
exit /b 0
