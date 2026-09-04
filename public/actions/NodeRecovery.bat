@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [INFO] Requesting Administrator permission...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title Pi Node - Node Recovery
echo.
echo ============================================================
echo   PI NODE - CONTAINER RECOVERY
echo   Docker restart only / NO WSL shutdown
echo ============================================================
echo  Will restart the Pi container (testnet2/mainnet).
echo  Will NOT change LAN IP, WSL, or modem.
echo  Use only if the container is stopped for a long time.
echo ============================================================
echo.
choice /C YN /N /M "Restart the Pi container now? [Y/N] "
if errorlevel 2 exit /b 0
echo.
where docker.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker CLI not found.
    pause
    exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker Engine is not healthy. Fix Docker first.
    pause
    exit /b 2
)

set "TARGET="
for /f "delims=" %%C in ('docker ps --format "{{.Names}}"') do (
    echo %%C | findstr /I /R "^testnet2$ ^mainnet$ ^testnet$" >nul && if not defined TARGET set "TARGET=%%C"
)
if not defined TARGET set "TARGET=testnet2"

echo [ACTION] Restarting container: %TARGET%
docker restart --time 60 %TARGET%
if errorlevel 1 (
    echo [WARN] Restart failed. Trying start...
    docker start %TARGET%
)
timeout /t 12 /nobreak >nul
docker ps --filter "name=%TARGET%" --filter "status=running" --format "{{.Names}}" | findstr /I /X "%TARGET%" >nul
if errorlevel 1 (
    echo [FAIL] Container is still not running.
    echo [NEXT] Do not blindly reset WSL. Escalate to Docker recovery.
) else (
    echo [OK] Container %TARGET% is running.
)
pause
