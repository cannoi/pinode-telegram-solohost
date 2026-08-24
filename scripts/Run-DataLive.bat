@echo off
cd /d "%~dp0"
echo DataLive API on http://+:18790/
echo Require: MonitorLive writing latest.json (temp/CPU/RAM come from MonitorLive + OHM)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0DataLive_HttpApi.ps1"
pause
