@echo off
cd /d "%~dp0"
echo === CleanRAM_PiNode ===
echo Using ExecutionPolicy Bypass (avoids "not digitally signed")
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0CleanRAM_PiNode.ps1" %*
set ERR=%ERRORLEVEL%
echo.
echo Exit code: %ERR%
pause
exit /b %ERR%
