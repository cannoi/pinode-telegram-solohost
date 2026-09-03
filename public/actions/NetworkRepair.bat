@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [INFO] Requesting Administrator permission...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title Pi Node - Network Repair
echo.
echo ============================================================
echo   PI NODE - NETWORK REPAIR
echo   DHCP refresh + Winsock/IP reset + DNS
echo ============================================================
echo.
echo [INFO] This refreshes the active network stack.
echo [INFO] It does NOT force a static IP. This avoids accidental
echo        loss of DHCP reservations or network configuration.
echo.
choice /C YN /N /M "Continue? [Y/N] "
if errorlevel 2 exit /b 0

ipconfig /release
ipconfig /renew
ipconfig /flushdns
netsh winsock reset
netsh int ip reset
echo.
echo [WAIT] Refreshing adapter state...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$a=Get-NetAdapter ^| Where-Object {$_.Status -eq 'Up' -and $_.HardwareInterface} ^| Sort-Object ifIndex ^| Select-Object -First 1; if($a){Restart-NetAdapter -Name $a.Name -Confirm:$false -ErrorAction SilentlyContinue; Write-Host ('Adapter refreshed: '+$a.Name)}else{Write-Host 'No active adapter found.'}"
timeout /t 5 /nobreak >nul
echo.
echo [RESULT]
ipconfig
echo.
echo [DONE] Network repair completed. A reboot may be required after Winsock/IP reset.
pause
