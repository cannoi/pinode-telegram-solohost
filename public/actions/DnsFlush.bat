@echo off
setlocal EnableExtensions
title Pi Node - DnsFlush
cd /d "%~dp0"

REM ============================================================
REM SELF-ELEVATION
REM ============================================================
if /I "%~1"=="/scheduled" goto GOTADMIN
if /I "%~1"=="/quiet" goto GOTADMIN
if /I "%~1"=="/elevated" goto GOTADMIN

fltmc >nul 2>&1
if not errorlevel 1 goto GOTADMIN

echo.
echo Requesting Administrator permission...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
 "$p='%~f0'; $w='%~dp0'; Start-Process -FilePath $p -WorkingDirectory $w -Verb RunAs -ArgumentList '/elevated'"

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to request Administrator permission.
    echo Please right-click this file and select:
    echo RUN AS ADMINISTRATOR
    pause
)

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
