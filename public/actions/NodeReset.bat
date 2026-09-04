@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Pi Node - NodeReset
cd /d "%~dp0"

fltmc >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo ============================================================
echo  NODE RESET - SAFE
echo ============================================================
echo  WILL:
echo   - Restart Pi container only (testnet2 / mainnet / testnet)
echo   - Flush DNS
echo   - Re-apply firewall 31401-31410
echo   - Anti-sleep + Docker priority
echo  WILL NOT:
echo   - docker stop/rm ALL containers
echo   - docker image prune -a
echo   - wsl --shutdown while Docker Desktop is running
echo   - Force IP 192.168.1.222
echo   - netsh int ip reset / ipconfig release
echo ============================================================
choice /C YN /N /M "Run safe node reset? [Y/N] "
if errorlevel 2 exit /b 0

where docker.exe >nul 2>&1
if errorlevel 1 (
  echo [FAIL] Docker CLI not found.
  pause
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  echo [FAIL] Docker Engine not ready. Use DockerRecover.bat first.
  pause
  exit /b 2
)

echo [1/5] Find Pi container
set "TARGET="
for /f "delims=" %%C in ('docker ps --format "{{.Names}}" 2^>nul') do (
  echo %%C | findstr /I /R "^testnet2$ ^mainnet$ ^testnet$" >nul && if not defined TARGET set "TARGET=%%C"
)
if not defined TARGET (
  for /f "delims=" %%C in ('docker ps -a --format "{{.Names}}" 2^>nul') do (
    echo %%C | findstr /I /R "^testnet2$ ^mainnet$ ^testnet$" >nul && if not defined TARGET set "TARGET=%%C"
  )
)
if not defined TARGET (
  for /f "delims=" %%C in ('docker ps -a --format "{{.Names}}" 2^>nul') do (
    echo %%C | findstr /I "pi pinode stellar" >nul && if not defined TARGET set "TARGET=%%C"
  )
)
if not defined TARGET set "TARGET=testnet2"
echo     Target=%TARGET%

echo [2/5] Restart container only
docker restart --time 60 %TARGET%
if errorlevel 1 (
  echo [WARN] Restart failed. Trying start...
  docker start %TARGET%
)
timeout /t 12 /nobreak >nul
docker ps --filter "name=%TARGET%" --filter "status=running" --format "{{.Names}}" | findstr /I /X "%TARGET%" >nul
if errorlevel 1 (
  echo [FAIL] Container is still not running.
  echo [NEXT] Do not blindly reset WSL. Escalate to DockerRecover.bat.
) else (
  echo [OK] Container %TARGET% is running.
)

echo [3/5] Flush DNS
ipconfig /flushdns >nul

echo [4/5] Firewall 31401-31410
netsh advfirewall firewall delete rule name="Pi_Node_Inbound_Ports" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Inbound_Ports" dir=in action=allow protocol=TCP localport=31401-31410 profile=any >nul
netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Ports" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Outbound_Ports" dir=out action=allow protocol=TCP localport=31401-31410 profile=any >nul
netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Peers" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Outbound_Peers" dir=out action=allow protocol=TCP remoteport=31401-31410 profile=any >nul

echo [5/5] Anti-sleep + Docker priority
powercfg /change monitor-timeout-ac 0 >nul 2>&1
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
wmic process where name="Docker Desktop.exe" CALL setpriority "above normal" >nul 2>&1
powershell.exe -NoProfile -Command "try{(Get-Process 'Docker Desktop' -EA SilentlyContinue)|ForEach-Object{$_.PriorityClass='AboveNormal'}}catch{}"

echo.
echo [RESULT] Safe reset finished.
echo          Next: wait 5-10 min, open Pi Node Doctor - Check Now.
echo          If ports stay closed, run NetRepair.bat (keeps LAN IP).
pause
exit /b 0
