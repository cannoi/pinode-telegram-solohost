@echo off
cd /d "%~dp0"
echo Running CleanRAM_PiNode.ps1 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0CleanRAM_PiNode.ps1"
echo.
echo Exit code: %ERRORLEVEL%
pause
