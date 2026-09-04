@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [INFO] Requesting Administrator permission...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title Pi Node - Docker Recovery
echo.
echo ============================================================
echo   PI NODE - DOCKER RECOVERY
echo   Ladder: SOFT -> ORDERED WSL
echo   Never runs WSL shutdown while Docker Desktop is alive
echo   Does NOT change LAN IP or modem forwards.
echo ============================================================
echo.
choice /C SYN /N /M "Recovery mode: [S]oft Docker  [Y] Ordered WSL  [N] Cancel: "
if errorlevel 3 exit /b 0
if errorlevel 2 goto ORDERED
goto SOFT

:SOFT
echo.
echo [1/2] Closing Docker Desktop gracefully...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$p=Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue; if($p){$p ^| %% {try{$_.CloseMainWindow() ^| Out-Null}catch{}}; Start-Sleep 5}; ^
Get-Process -Name 'Docker Desktop','com.docker.backend','com.docker.build','com.docker.proxy','vpnkit' -ErrorAction SilentlyContinue ^| Stop-Process -Force -ErrorAction SilentlyContinue"
goto START_DOCKER

:ORDERED
echo.
echo [1/3] Stopping Docker Desktop before touching WSL...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue ^| %% {try{$_.CloseMainWindow() ^| Out-Null}catch{}}; Start-Sleep 5; ^
Get-Process -Name 'Docker Desktop','com.docker.backend','com.docker.build','com.docker.proxy','vpnkit' -ErrorAction SilentlyContinue ^| Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 3"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if(Get-Process -Name 'Docker Desktop','com.docker.backend' -ErrorAction SilentlyContinue){exit 5}else{exit 0}"
if errorlevel 1 (
    echo [SAFETY] Docker Desktop is still running. WSL shutdown REFUSED.
    pause
    exit /b 5
)
echo [2/3] WSL shutdown (Docker is confirmed stopped)...
wsl.exe --shutdown
if errorlevel 1 echo [WARN] WSL shutdown returned an error.
timeout /t 5 /nobreak >nul

:START_DOCKER
echo [START] Starting Docker Desktop...
set "DD=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if not exist "%DD%" set "DD=%ProgramFiles(x86)%\Docker\Docker\Docker Desktop.exe"
if not exist "%DD%" (
    echo [ERROR] Docker Desktop executable not found.
    pause
    exit /b 6
)
start "" "%DD%"
echo [WAIT] Waiting for Docker Engine (up to 180s)...
set /a WAIT=0
:WAITLOOP
timeout /t 5 /nobreak >nul
set /a WAIT+=5
docker info >nul 2>&1
if not errorlevel 1 goto HEALTHY
if %WAIT% GEQ 180 goto FAILED
goto WAITLOOP
:HEALTHY
echo [OK] Docker Engine is healthy.
pause
exit /b 0
:FAILED
echo [FAIL] Docker Engine did not become healthy within 180 seconds.
pause
exit /b 1
