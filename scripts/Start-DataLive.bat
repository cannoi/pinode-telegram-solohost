@echo off
cd /d "%~dp0"
echo Starting DataLive (ExecutionPolicy Bypass)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0DataLive_HttpApi.ps1"
pause
