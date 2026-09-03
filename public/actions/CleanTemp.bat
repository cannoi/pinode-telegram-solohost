@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [INFO] Requesting Administrator permission...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title Pi Node - Clean TEMP
echo.
echo ============================================================
echo   PI NODE - CLEAN TEMP / RECYCLE BIN / SAFE DOCKER PRUNE
echo ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$count=0; foreach($root in @($env:TEMP,(Join-Path $env:SystemRoot 'Temp')) { if(Test-Path $root){ Get-ChildItem $root -Force -ErrorAction SilentlyContinue ^| ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop; $count++ } catch {} } } }; ^
try { Clear-RecycleBin -Force -ErrorAction SilentlyContinue } catch {}; ^
Write-Host ('[DONE] Temp items removed: '+$count); ^
if(Get-Command docker.exe -ErrorAction SilentlyContinue){ docker volume prune -f; docker image prune -f } else { Write-Host '[INFO] Docker CLI not found - Docker prune skipped.' }"
echo.
pause
