@echo off
cd /d "%~dp0"
echo === Reset_Node_Network ===
echo Using ExecutionPolicy Bypass (avoids "not digitally signed")
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Reset_Node_Network.ps1" %*
set ERR=%ERRORLEVEL%
echo.
echo Exit code: %ERR%
pause
exit /b %ERR%
