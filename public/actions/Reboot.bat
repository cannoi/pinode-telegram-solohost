@echo off
setlocal EnableExtensions
title Pi Node - Reboot
cd /d "%~dp0"

if /I "%~1"=="/scheduled" goto GOTADMIN
if /I "%~1"=="/quiet" goto GOTADMIN
net session >nul 2>&1
if %errorLevel%==0 goto GOTADMIN
echo Requesting Administrator...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -LiteralPath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs"
exit /b
:GOTADMIN
echo.
echo ============================================================
echo   PI NODE - CONTROLLED WINDOWS REBOOT
echo   SAFETY: explicit confirmation required
echo ============================================================
echo.
set /p "DELAY=Reboot delay in seconds [60]: "
if "%DELAY%"=="" set "DELAY=60"
echo %DELAY%| findstr /R "^[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo [FAIL] Delay must be a number.
  pause
  exit /b 2
)
set /p "REASON=Reason [Pi Node maintenance]: "
if "%REASON%"=="" set "REASON=Pi Node maintenance"
echo.
echo WARNING: Windows will reboot in %DELAY% seconds.
choice /C YN /N /M "Continue? [Y/N] "
if errorlevel 2 exit /b 0
shutdown.exe /r /t %DELAY% /c "PiNode: %REASON%"
echo.
echo Reboot scheduled. Cancel with: shutdown /a
pause
exit /b 0
