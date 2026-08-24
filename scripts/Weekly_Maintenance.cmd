@echo off
cd /d "%~dp0"
echo === Weekly_Maintenance ===
echo Using ExecutionPolicy Bypass (avoids "not digitally signed")
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Weekly_Maintenance.ps1" %*
set ERR=%ERRORLEVEL%
echo.
echo Exit code: %ERR%
pause
exit /b %ERR%
