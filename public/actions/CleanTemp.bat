@echo off
setlocal EnableExtensions
title Pi Node - CleanTemp
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
echo  CLEAN TEMP
echo ============================================================
echo  Will do: delete user/system temp older than 6 hours, Recycle Bin.
echo  Will NOT: change IP, stop Docker, prune images/containers.
echo ============================================================
echo.
choice /C YN /N /M "Run this script? [Y/N] "
if errorlevel 2 exit /b 0

:RUN
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"foreach($root in @($env:TEMP,(Join-Path $env:SystemRoot 'Temp'))){ if(Test-Path $root){ Get-ChildItem $root -Force -EA SilentlyContinue | Where-Object {$_.LastWriteTime -lt (Get-Date).AddHours(-6)} | ForEach-Object { try{Remove-Item -LiteralPath $_.FullName -Recurse -Force -EA Stop}catch{} } } }; try{Clear-RecycleBin -Force -EA SilentlyContinue}catch{}"
echo [OK] Temp cleaned.
if /I not "%~1"=="/scheduled" if /I not "%~1"=="/quiet" pause
exit /b 0
