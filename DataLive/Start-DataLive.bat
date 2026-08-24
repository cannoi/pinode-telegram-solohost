@echo off
cd /d "%~dp0"
echo Starting DataLive HTTP API on http://127.0.0.1:18790/
echo Require: PiNodeMonitorLive Service already writing latest.json
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0DataLive_HttpApi.ps1"
pause
