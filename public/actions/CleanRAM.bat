@echo off
setlocal EnableExtensions
title Pi Node - Clean RAM
if /I "%~1"=="/scheduled" goto RUN
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo ============================================================
echo  CLEAN RAM
echo ============================================================
echo  Will do:
echo   - Close heavy user apps (Chrome, Edge, OneDrive, Copilot...)
echo   - Clear user TEMP
echo   - Flush DNS
echo  Will NOT:
echo   - Stop Pi Network / Docker / PiCheck
echo   - Change LAN IP
echo   - Restart Explorer when run from a schedule
echo  Use when: RAM is high for a long time and the node is still synced.
echo ============================================================
echo.
choice /C YN /N /M "Run this script? [Y/N] "
if errorlevel 2 exit /b 0
:RUN
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$protect=@('docker','com.docker','Pi Network','PiNode','PiCheck','stellar'); foreach($n in @('chrome','msedge','SearchApp','SearchIndexer','TabTip','TextInputHost','OneDrive','Copilot')){ Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $nm=$_.ProcessName; -not ($protect | Where-Object { $nm -match $_ }) } | Stop-Process -Force -ErrorAction SilentlyContinue }; Get-ChildItem $env:TEMP -Force -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }"
ipconfig /flushdns >nul
echo [OK] CleanRAM finished. Pi Node / Docker were not stopped.
if /I not "%~1"=="/scheduled" pause
exit /b 0
