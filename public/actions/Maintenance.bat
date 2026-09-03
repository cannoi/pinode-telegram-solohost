@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [INFO] Requesting Administrator permission...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title Pi Node - Weekly Maintenance
echo.
echo ============================================================
echo   PI NODE - MAINTENANCE
echo   Safe weekly maintenance / no reboot
echo ============================================================
echo.
echo [1/6] Time synchronization...
w32tm /resync >nul 2>&1
echo [2/6] Cleaning temporary files older than 6 hours...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"foreach($root in @($env:TEMP,(Join-Path $env:SystemRoot 'Temp'))){if(Test-Path $root){Get-ChildItem $root -Force -ErrorAction SilentlyContinue ^| Where-Object {$_.LastWriteTime -lt (Get-Date).AddHours(-6)} ^| ForEach-Object {try{Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop}catch{}}}}"
echo [3/6] Refreshing DNS...
ipconfig /flushdns >nul
echo [4/6] Applying AC anti-sleep...
powercfg /change monitor-timeout-ac 0 >nul 2>&1
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
echo [5/6] Raising Docker Desktop priority when available...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue ^| ForEach-Object {try{$_.PriorityClass='AboveNormal'}catch{}}"
echo [6/6] Safe Docker cleanup (unused image/volume only)...
where docker.exe >nul 2>&1
if not errorlevel 1 (
    docker volume prune -f
    docker image prune -f
) else (
    echo [INFO] Docker CLI not found - skipped.
)
echo.
echo ============================================================
echo   MAINTENANCE COMPLETE
echo ============================================================
echo.

choice /C YN /N /M "Install weekly scheduled maintenance (Sunday 03:00)? [Y/N] "
if errorlevel 2 goto END
echo.
echo [SCHEDULE] Creating weekly task...
schtasks /Create /TN "PiNode Weekly Maintenance" /TR "\"%~f0\" /scheduled" /SC WEEKLY /D SUN /ST 03:00 /RL HIGHEST /F
if errorlevel 1 (
    echo [WARN] Could not create the task automatically.
    echo        Open Task Scheduler and create: PiNode Weekly Maintenance
) else (
    echo [OK] Weekly maintenance scheduled for Sunday at 03:00.
)
:END
echo.
if /I "%~1"=="/scheduled" exit /b 0
pause
