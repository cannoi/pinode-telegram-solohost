@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  echo [INFO] Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
echo PI NODE - Reset_Node_Network
echo When: ports closed a long time AND Horizon/Core also fail. Review before run.
echo Safer first step: NetworkRepair.bat (no static IP).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Reset_Node_Network.ps1"
echo.
pause
