@echo off
setlocal EnableExtensions
title Pi Node - Weekly Maintenance
if /I "%~1"=="/scheduled" goto RUN
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo ============================================================
echo  WEEKLY MAINTENANCE
echo ============================================================
echo  Will do:
echo   - Sync Windows time
echo   - Clean old temp files
echo   - Flush DNS
echo   - Prevent AC sleep
echo   - Optional unused docker image/volume prune
echo  Will NOT:
echo   - Change LAN IP
echo   - Restart the Pi container
echo   - Reboot Windows
echo  Use when: node is already healthy. Best on Sunday quiet hours.
echo ============================================================
echo.
choice /C YN /N /M "Run maintenance now? [Y/N] "
if errorlevel 2 exit /b 0
:RUN
w32tm /resync >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"foreach($root in @($env:TEMP,(Join-Path $env:SystemRoot 'Temp'))){ if(Test-Path $root){ Get-ChildItem $root -Force -EA SilentlyContinue | Where-Object {$_.LastWriteTime -lt (Get-Date).AddHours(-6)} | ForEach-Object { try{Remove-Item -LiteralPath $_.FullName -Recurse -Force -EA Stop}catch{} } } }"
ipconfig /flushdns >nul
powercfg /change monitor-timeout-ac 0 >nul 2>&1
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
where docker.exe >nul 2>&1
if not errorlevel 1 (
  docker volume prune -f
  docker image prune -f
)
echo [OK] Maintenance finished.
if /I "%~1"=="/scheduled" exit /b 0
echo.
choice /C YN /N /M "Install Sunday 03:00 weekly task? [Y/N] "
if errorlevel 2 goto END
schtasks /Create /TN "PiNode_Weekly_Maintenance" /TR "\"%~f0\" /scheduled" /SC WEEKLY /D SUN /ST 03:00 /RL HIGHEST /F
echo [OK] Task PiNode_Weekly_Maintenance = Sunday 03:00 (no Y prompt when scheduled).
:END
pause
exit /b 0
