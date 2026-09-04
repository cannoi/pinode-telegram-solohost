@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Pi Node - Maintain
cd /d "%~dp0"

if /I "%~1"=="/scheduled" goto GOTADMIN
if /I "%~1"=="/quiet" goto GOTADMIN
fltmc >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)
:GOTADMIN

set "LOG_FILE=%~dp0pinode_safe_maintenance.log"
set "MONTHLY_STATUS=Not due"
if /I "%~1"=="/scheduled" goto RUN
if /I "%~1"=="/quiet" goto RUN

echo.
echo ============================================================
echo  WEEKLY MAINTENANCE
echo ============================================================
echo  WILL: time sync, close extra apps, clean temp/cache,
echo         unused docker volume/image prune, recycle bin,
echo         flush DNS, anti-sleep, Docker priority, TRIM if CPU low,
echo         monthly SFC/DISM only first Sunday if disk free ^>= 15GB.
echo  WILL NOT: change LAN IP, stop Pi Node container, reboot,
echo            send Telegram from a hardcoded token.
echo ============================================================
choice /C YN /N /M "Run weekly maintenance now? [Y/N] "
if errorlevel 2 exit /b 0

:RUN
echo Pi Node Safe Maintenance %date% %time% > "%LOG_FILE%"
echo [1/10] Sync Windows time
w32tm /resync >nul 2>&1
echo Time synchronized >> "%LOG_FILE%"

echo [2/10] Close extra apps
for %%A in (
  msedge.exe chrome.exe OneDrive.exe Copilot.exe ApplicationFrameHost.exe
  SearchApp.exe SearchIndexer.exe TabTip.exe TextInputHost.exe RuntimeBroker.exe
) do taskkill /F /IM %%A >nul 2>&1
net stop spooler >nul 2>&1

echo [3/10] Clean TEMP
powershell.exe -NoProfile -Command "Remove-Item $env:TEMP\* -Force -Recurse -ErrorAction SilentlyContinue; Remove-Item $env:SystemRoot\Temp\* -Force -Recurse -ErrorAction SilentlyContinue"

echo [4/10] Cache + unused Docker volumes
powershell.exe -NoProfile -Command "Remove-Item $env:LOCALAPPDATA\Microsoft\Windows\WER\ReportArchive\* -Force -Recurse -ErrorAction SilentlyContinue; Remove-Item C:\ProgramData\Microsoft\Windows\WER\ReportArchive\* -Force -Recurse -ErrorAction SilentlyContinue; Remove-Item $env:LOCALAPPDATA\D3DSCache\* -Force -Recurse -ErrorAction SilentlyContinue"
docker volume prune -f >nul 2>&1

echo [5/10] Recycle Bin
powershell.exe -NoProfile -Command "try{Clear-RecycleBin -Force -ErrorAction SilentlyContinue}catch{}"
rd /s /q %SystemDrive%\$Recycle.Bin >nul 2>&1

echo [6/10] Unused Docker images only (not prune -a)
docker image prune -f >nul 2>&1

echo [7/10] Flush DNS
ipconfig /flushdns >nul 2>&1
if /I not "%~1"=="/scheduled" if /I not "%~1"=="/quiet" if /I not "%PINODE_CONTROLLER%"=="1" (
  taskkill /F /IM explorer.exe >nul 2>&1
  timeout /t 2 /nobreak >nul
  start explorer.exe
)

echo [8/10] Anti-sleep on AC power
powercfg /change monitor-timeout-ac 0 >nul 2>&1
powercfg /change disk-timeout-ac 0 >nul 2>&1
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1

echo [9/10] Docker priority + TRIM if CPU low
wmic process where name="Docker Desktop.exe" CALL setpriority "above normal" >nul 2>&1
powershell.exe -NoProfile -Command "try{(Get-Process 'Docker Desktop' -EA SilentlyContinue)|ForEach-Object{$_.PriorityClass='AboveNormal'}}catch{}"
set "CPU_USAGE=100"
for /f "skip=1 tokens=2 delims==" %%A in ('wmic cpu get LoadPercentage /value 2^>nul') do set "CPU_USAGE=%%A"
if "%CPU_USAGE%"=="" (
  for /f "usebackq delims=" %%A in (`powershell.exe -NoProfile -Command "try{[int]((Get-CimInstance Win32_Processor|Measure-Object LoadPercentage -Average).Average)}catch{100}"`) do set "CPU_USAGE=%%A"
)
if not "%CPU_USAGE%"=="" if %CPU_USAGE% LSS 75 (
  defrag %SystemDrive% /O /H >nul 2>&1
  echo TRIM done >> "%LOG_FILE%"
) else (
  echo Skip TRIM CPU=%CPU_USAGE% >> "%LOG_FILE%"
)

echo [10/10] Monthly SFC/DISM only first Sunday + 15GB free
for /f "usebackq delims=" %%A in (`powershell.exe -NoProfile -Command "[math]::Round((Get-PSDrive C).Free/1GB,0)"`) do set "FreeGB=%%A"
set "DAY="
set "DOW="
for /f "tokens=2 delims==" %%I in ('wmic path win32_localtime get day /value 2^>nul') do set "DAY=%%I"
for /f "tokens=2 delims==" %%I in ('wmic path win32_localtime get dayofweek /value 2^>nul') do set "DOW=%%I"
if "%DAY%"=="" (
  for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -Command "(Get-Date).Day"`) do set "DAY=%%I"
)
if "%DOW%"=="" (
  for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -Command "[int](Get-Date).DayOfWeek"`) do set "DOW=%%I"
)
if "%DAY%"=="" set DAY=99
if "%FreeGB%"=="" set FreeGB=0
if %DAY% LEQ 7 if "%DOW%"=="0" if %FreeGB% GEQ 15 (
  set "MONTHLY_STATUS=SFC/DISM ran"
  dism /online /cleanup-image /startcomponentcleanup /quiet >> "%LOG_FILE%" 2>&1
  sfc /scannow >nul 2>&1
)

tasklist /FI "IMAGENAME eq Docker Desktop.exe" 2>nul | find /I "Docker Desktop.exe" >nul
if %errorLevel%==0 (set "DOCKER_STATUS=RUNNING") else (set "DOCKER_STATUS=STOPPED")
tasklist /FI "IMAGENAME eq Pi Network.exe" 2>nul | find /I "Pi Network.exe" >nul
if %errorLevel%==0 (set "PI_STATUS=RUNNING") else (set "PI_STATUS=STOPPED")

echo.
echo [RESULT] Maintenance finished.
echo          Docker=%DOCKER_STATUS%  Pi Desktop=%PI_STATUS%  Monthly=%MONTHLY_STATUS%
echo          LAN IP unchanged. Log: %LOG_FILE%
if exist "%~dp0send_tele.ps1" (
  echo Optional send_tele.ps1 found - calling WITHOUT embedding any token in this BAT.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0send_tele.ps1" -DockerStatus "%DOCKER_STATUS%" -PiStatus "%PI_STATUS%" -MonthlyStatus "%MONTHLY_STATUS%" -TimeStr "%date% %time%"
)

if /I "%~1"=="/scheduled" exit /b 0
if /I "%~1"=="/quiet" exit /b 0
echo.
choice /C YN /N /M "Install Sunday 03:00 weekly task? [Y/N] "
if errorlevel 2 goto END
schtasks /Create /TN "PiNode_Weekly_Maintenance" /TR "\"%~f0\" /scheduled" /SC WEEKLY /D SUN /ST 03:00 /RL HIGHEST /F
echo Task installed. Scheduled runs skip the Y prompt.
:END
pause
exit /b 0
