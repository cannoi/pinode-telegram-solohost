@echo off
cd /d "%~dp0"
echo Running Pi_Node_Diagnostic_PRO.ps1 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Pi_Node_Diagnostic_PRO.ps1"
echo.
echo Exit code: %ERRORLEVEL%
pause
