@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  echo [INFO] Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
echo PI NODE - Weekly_Maintenance
echo When: Sunday quiet hours, node already synced. Cleans temp/DNS. Does not reboot node.
if /I "%~1"=="/scheduled" goto RUN
echo.
echo Install Sunday 03:00 weekly task? [Y/N]
set /p ANS=
if /I "%ANS%"=="Y" (
  schtasks /Create /TN "PiNode_Weekly_Maintenance" /TR "\"%~f0\" /scheduled" /SC WEEKLY /D SUN /ST 03:00 /RL HIGHEST /F
  echo Task PiNode_Weekly_Maintenance installed.
)
:RUN
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Weekly_Maintenance.ps1"
echo.
if /I not "%~1"=="/scheduled" pause
