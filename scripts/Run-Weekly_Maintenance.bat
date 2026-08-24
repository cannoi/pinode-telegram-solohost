@echo off
cd /d "%~dp0"
echo Running Weekly_Maintenance.ps1 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Weekly_Maintenance.ps1"
echo.
echo Exit code: %ERRORLEVEL%
pause
