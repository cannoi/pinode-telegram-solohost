@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  echo [INFO] Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
echo PI NODE - CleanRAM_PiNode
echo When: RAM high / host sluggish. Does not stop Pi Node or Docker.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0CleanRAM_PiNode.ps1"
echo.
pause
