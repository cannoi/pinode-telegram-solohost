@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Pi Node - CleanRam
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

if /I "%~1"=="/scheduled" goto RUN
if /I "%~1"=="/quiet" goto RUN
echo.
echo ============================================================
echo  CLEAN RAM
echo ============================================================
echo  WILL:
echo   - Close Search, virtual keyboard, RuntimeBroker, remote assist
echo   - Close Chrome / Edge / OneDrive / Copilot extra frames
echo   - Stop Spooler, DiagTrack, dmwappush, Windows Update, BITS, SysMain
echo   - Clear user and Windows TEMP
echo   - TRIM SSD (defrag /O)
echo   - Flush DNS and restart Explorer
echo  WILL NOT:
echo   - Stop Pi Network / Docker / Pi container
echo   - Change LAN IP
echo ============================================================
choice /C YN /N /M "Run CleanRam now? [Y/N] "
if errorlevel 2 exit /b 0

:RUN
echo [1/6] Close extra desktop apps
for %%P in (
  SearchApp.exe SearchIndexer.exe TabTip.exe TextInputHost.exe
  RuntimeBroker.exe remoting_host.exe remote_assistance_host.exe
  chrome.exe msedge.exe OneDrive.exe Copilot.exe ApplicationFrameHost.exe
) do taskkill /F /IM %%P >nul 2>&1

echo [2/6] Stop extra services
net stop spooler >nul 2>&1
sc config DiagTrack start= disabled >nul 2>&1
net stop DiagTrack >nul 2>&1
sc config dmwappushservice start= disabled >nul 2>&1
net stop dmwappushservice >nul 2>&1
net stop wuauserv >nul 2>&1
net stop bits >nul 2>&1
net stop SysMain >nul 2>&1

echo [3/6] Clear TEMP
del /s /f /q "%TEMP%\*.*" >nul 2>&1
del /s /f /q "%SystemRoot%\Temp\*.*" >nul 2>&1

echo [4/6] TRIM SSD
defrag %SystemDrive% /O /H >nul 2>&1

echo [5/6] Flush DNS
ipconfig /flushdns >nul

echo [6/6] Restart Explorer
if /I not "%~1"=="/scheduled" if /I not "%~1"=="/quiet" if /I not "%PINODE_CONTROLLER%"=="1" (
  taskkill /F /IM explorer.exe >nul 2>&1
  timeout /t 2 /nobreak >nul
  start explorer.exe
)

echo.
echo [RESULT] CleanRam finished. Pi Node and Docker were not stopped.
echo          LAN IP was not changed.
if /I not "%~1"=="/scheduled" if /I not "%~1"=="/quiet" pause
exit /b 0
