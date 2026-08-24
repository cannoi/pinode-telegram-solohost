@echo off
cd /d "%~dp0"
echo Running Reset_Node_Network.ps1 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Reset_Node_Network.ps1"
echo.
echo Exit code: %ERRORLEVEL%
pause
