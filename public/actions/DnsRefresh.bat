@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [INFO] Requesting Administrator permission...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title Pi Node - DNS Refresh
echo.
echo ============================================================
echo   PI NODE - DNS REFRESH
echo ============================================================
echo.
ipconfig /flushdns
echo.
echo [DONE] DNS cache refreshed.
pause
