@echo off
setlocal EnableExtensions
title Pi Node - Reboot
cd /d "%~dp0"

REM ============================================================
REM SELF-ELEVATION
REM ============================================================
if /I "%~1"=="/scheduled" goto GOTADMIN
if /I "%~1"=="/quiet" goto GOTADMIN
if /I "%~1"=="/elevated" goto GOTADMIN

fltmc >nul 2>&1
if not errorlevel 1 goto GOTADMIN

echo.
echo Requesting Administrator permission...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
 "$p='%~f0'; $w='%~dp0'; Start-Process -FilePath $p -WorkingDirectory $w -Verb RunAs -ArgumentList '/elevated'"

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to request Administrator permission.
    echo Please right-click this file and select:
    echo RUN AS ADMINISTRATOR
    pause
)

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
