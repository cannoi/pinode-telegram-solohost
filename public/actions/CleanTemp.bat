@echo off
setlocal EnableExtensions
title Pi Node - Clean Temp
if /I "%~1"=="/scheduled" goto RUN
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo ============================================================
echo  CLEAN TEMP
echo ============================================================
echo  Will do: delete user/system temp older than 6 hours, recycle bin.
echo  Will NOT: change IP, stop Docker, prune running containers.
echo ============================================================
echo.
choice /C YN /N /M "Run this script? [Y/N] "
if errorlevel 2 exit /b 0
:RUN
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"foreach($root in @($env:TEMP,(Join-Path $env:SystemRoot 'Temp'))){ if(Test-Path $root){ Get-ChildItem $root -Force -EA SilentlyContinue | Where-Object {$_.LastWriteTime -lt (Get-Date).AddHours(-6)} | ForEach-Object { try{Remove-Item -LiteralPath $_.FullName -Recurse -Force -EA Stop}catch{} } } }; try{Clear-RecycleBin -Force -EA SilentlyContinue}catch{}"
echo [OK] Temp cleaned.
if /I not "%~1"=="/scheduled" pause
exit /b 0
