@echo off
cd /d "%~dp0"
echo === Pi_Node_Diagnostic_PRO ===
echo Using ExecutionPolicy Bypass (avoids "not digitally signed")
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Pi_Node_Diagnostic_PRO.ps1" %*
set ERR=%ERRORLEVEL%
echo.
echo Exit code: %ERR%
pause
exit /b %ERR%
