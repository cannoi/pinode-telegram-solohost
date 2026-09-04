@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Pi Node - Network Repair (keep LAN IP)
if /I "%~1"=="/scheduled" goto PHASE1
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo ============================================================
echo  NETWORK REPAIR  -  KEEP CURRENT LAN IP
echo ============================================================
echo  Phase 1  Common internet loss (safe)
echo    - Show current IPv4 / gateway
echo    - Enable adapter if disabled
echo    - Flush DNS + register DNS + clear ARP
echo    - Ping gateway and 8.8.8.8
echo    - Re-apply firewall 31401-31410
echo.
echo  Phase 2  If internet still down (ask again)
echo    - Restart network adapter  (keeps the same IPv4)
echo.
echo  Phase 3  Last resort (ask again, reboot may be needed)
echo    - netsh winsock reset
echo.
echo  NEVER:
echo    - ipconfig /release or /renew
echo    - netsh int ip reset  (this can wipe static LAN IP)
echo    - Change DHCP / static address
echo    - Change modem port-forward
echo ============================================================
echo.
choice /C YN /N /M "Run Phase 1 (safe troubleshoot)? [Y/N] "
if errorlevel 2 exit /b 0

:PHASE1
echo.
echo -------- PHASE 1 / SAFE --------
echo [IP now]
ipconfig | findstr /I "IPv4 Gateway Ethernet Wi-Fi Wireless adapter Description"
echo.
echo [Enable adapter if disabled]
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {$_.Status -eq 'Disabled' -and $_.HardwareInterface} | ForEach-Object { Enable-NetAdapter -Name $_.Name -Confirm:$false; Write-Host ('Enabled: '+$_.Name) }"
echo [DNS + ARP]
ipconfig /flushdns
ipconfig /registerdns >nul
netsh interface ip delete arpcache >nul 2>&1
echo [Firewall 31401-31410]
netsh advfirewall firewall delete rule name="Pi_Node_Inbound_Ports" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Inbound_Ports" dir=in action=allow protocol=TCP localport=31401-31410 profile=any >nul
netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Ports" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Outbound_Ports" dir=out action=allow protocol=TCP localport=31401-31410 profile=any >nul
echo [Ping]
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$ip=(Get-NetIPAddress -AddressFamily IPv4 -EA SilentlyContinue | Where-Object {$_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown'} | Select-Object -First 1).IPAddress; $gw=(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -EA SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop; Write-Host ('LAN IP : '+$ip); Write-Host ('Gateway: '+$gw); $okGw=$false; if($gw){ $okGw=[bool](Test-Connection -ComputerName $gw -Count 1 -Quiet -EA SilentlyContinue) }; $okNet=[bool](Test-Connection -ComputerName '8.8.8.8' -Count 1 -Quiet -EA SilentlyContinue); Write-Host ('Ping GW: '+$(if($okGw){'OK'}else{'FAIL'})); Write-Host ('Ping 8.8.8.8: '+$(if($okNet){'OK'}else{'FAIL'})); if($okNet){ exit 0 } else { exit 7 }"
if not errorlevel 1 (
  echo [OK] Internet reachable. LAN IP was not changed.
  if /I not "%~1"=="/scheduled" pause
  exit /b 0
)
if /I "%~1"=="/scheduled" exit /b 7
echo.
echo [WARN] Phase 1 could not reach 8.8.8.8
choice /C YN /N /M "Run Phase 2 - restart adapter, KEEP same IP? [Y/N] "
if errorlevel 2 goto END

echo.
echo -------- PHASE 2 / RESTART ADAPTER --------
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$a=Get-NetAdapter -EA SilentlyContinue | Where-Object {$_.Status -eq 'Up' -and $_.HardwareInterface} | Sort-Object ifIndex | Select-Object -First 1; if(-not $a){ $a=Get-NetAdapter -EA SilentlyContinue | Where-Object {$_.HardwareInterface} | Select-Object -First 1 }; if($a){ $before=(Get-NetIPAddress -InterfaceAlias $a.Name -AddressFamily IPv4 -EA SilentlyContinue | Where-Object {$_.IPAddress -notlike '169.254.*'} | Select-Object -First 1).IPAddress; Write-Host ('Adapter: '+$a.Name+'  IP before: '+$before); Restart-NetAdapter -Name $a.Name -Confirm:$false; Start-Sleep 8; $after=(Get-NetIPAddress -InterfaceAlias $a.Name -AddressFamily IPv4 -EA SilentlyContinue | Where-Object {$_.IPAddress -notlike '169.254.*'} | Select-Object -First 1).IPAddress; Write-Host ('IP after : '+$after); if($before -and $after -and $before -ne $after){ Write-Host '[WARN] IP changed after adapter restart. Re-check modem forward.' } }"
ipconfig /flushdns
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"if(Test-Connection -ComputerName '8.8.8.8' -Count 2 -Quiet -EA SilentlyContinue){ Write-Host '[OK] Internet reachable after adapter restart.'; exit 0 } else { Write-Host '[WARN] Still no internet.'; exit 7 }"
if not errorlevel 1 (
  if /I not "%~1"=="/scheduled" pause
  exit /b 0
)
echo.
choice /C YN /N /M "Run Phase 3 - winsock reset (reboot recommended, IP kept)? [Y/N] "
if errorlevel 2 goto END
echo.
echo -------- PHASE 3 / WINSOCK RESET --------
echo This does NOT change your LAN IP.
echo It does NOT run: ipconfig /release, /renew, or netsh int ip reset.
netsh winsock reset
echo [OK] Winsock reset requested. Reboot Windows, then check /status.
echo Cancel reboot if scheduled by mistake: shutdown /a
:END
echo.
echo [IP now]
ipconfig | findstr /I "IPv4 Gateway"
echo Done. Modem port-forward must still point to THIS same LAN IP.
pause
exit /b 0
