@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [INFO] Requesting Administrator permission...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title Pi Node - Clean RAM
echo.
echo ============================================================
echo   PI NODE - SMART RAM CLEANUP
echo   Independent BAT / Administrator
echo ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$protected='PiNode','Pi Node','Docker Desktop','com.docker.backend','com.docker.proxy','vmmem','vmmemWSL','wslhost','System','Registry','csrss','wininit','services','lsass','svchost','explorer'; ^
$candidates='chrome','msedge','OneDrive','Copilot','SearchApp','SearchIndexer','Teams','Discord','Telegram','WhatsApp','firefox','opera','brave','RuntimeBroker'; ^
$k=0; Get-Process -ErrorAction SilentlyContinue ^| Where-Object { $candidates -contains $_.ProcessName -and $protected -notcontains $_.ProcessName -and $_.WorkingSet64 -ge 500MB } ^| Sort-Object WorkingSet64 -Descending ^| Select-Object -First 8 ^| ForEach-Object { $mb=[math]::Round($_.WorkingSet64/1MB); try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; Write-Host ('[CLEAN] '+$_.ProcessName+' '+$mb+' MB'); $k++ } catch {} }; ^
Get-ChildItem $env:TEMP -Force -ErrorAction SilentlyContinue ^| Where-Object {$_.LastWriteTime -lt (Get-Date).AddHours(-6)} ^| ForEach-Object { try {Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop} catch {}}; ^
ipconfig /flushdns >nul; ^
Write-Host ('[DONE] Processes cleaned: '+$k)"
echo.
echo Completed. Pi Node / Docker processes were protected.
pause
