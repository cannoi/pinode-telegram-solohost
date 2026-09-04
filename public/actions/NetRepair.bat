@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Pi Node - NetRepair keep LAN IP
cd /d "%~dp0"

if /I "%~1"=="/scheduled" goto GOTADMIN
if /I "%~1"=="/quiet" goto GOTADMIN
fltmc >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)
:GOTADMIN

if /I "%~1"=="/scheduled" goto PHASE1
if /I "%~1"=="/quiet" goto PHASE1
echo.
echo ============================================================
echo  NETWORK REPAIR  - KEEP CURRENT LAN IP
echo ============================================================
echo  Phase 1: DNS/ARP/firewall/ping  (safe)
echo  Phase 2: restart adapter if offline  (same IP)
echo  Phase 3: winsock reset if still offline
echo  NEVER: ipconfig /release /renew
echo  NEVER: netsh int ip reset   (wipes static IP)
echo  NEVER: force 192.168.1.222
echo ============================================================
choice /C YN /N /M "Run Phase 1 now? [Y/N] "
if errorlevel 2 exit /b 0

:PHASE1
echo [1] Current addresses
ipconfig | findstr /I "IPv4 Gateway Ethernet Wi-Fi"
echo [2] Enable disabled adapters + DNS/ARP
powershell.exe -NoProfile -Command "Get-NetAdapter -EA SilentlyContinue | ?{$_.Status -eq 'Disabled' -and $_.HardwareInterface} | Enable-NetAdapter -Confirm:$false"
ipconfig /flushdns
ipconfig /registerdns >nul
netsh interface ip delete arpcache >nul 2>&1
echo [3] Firewall 31401-31410
netsh advfirewall firewall delete rule name="Pi_Node_Inbound_Ports" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Inbound_Ports" dir=in action=allow protocol=TCP localport=31401-31410 profile=any >nul
netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Ports" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Outbound_Ports" dir=out action=allow protocol=TCP localport=31401-31410 profile=any >nul
netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Peers" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Outbound_Peers" dir=out action=allow protocol=TCP remoteport=31401-31410 profile=any >nul
echo [4] Ping
ping -n 2 8.8.8.8 | find "TTL=" >nul
if not errorlevel 1 (
  echo [RESULT] Internet OK. LAN IP was not changed.
  if /I not "%~1"=="/scheduled" if /I not "%~1"=="/quiet" pause
  exit /b 0
)
if /I "%~1"=="/scheduled" exit /b 7
if /I "%~1"=="/quiet" exit /b 7
echo [WARN] Phase 1 could not reach 8.8.8.8
choice /C YN /N /M "Phase 2 - restart adapter, KEEP IP? [Y/N] "
if errorlevel 2 goto END
echo [5] Restart adapter
powershell.exe -NoProfile -Command "$a=Get-NetAdapter|?{$_.Status -eq 'Up' -and $_.HardwareInterface}|Sort-Object {if($_.Name -match 'ether|local area'){0}elseif($_.Name -match 'wi'){1}else{2}}|Select -First 1; $b=(Get-NetIPAddress -InterfaceAlias $a.Name -AddressFamily IPv4 -EA SilentlyContinue|?{$_.IPAddress -notlike '169.254.*'}|Select -First 1).IPAddress; Write-Host ('Before '+$b); Restart-NetAdapter -Name $a.Name -Confirm:$false; Start-Sleep 8; $c=(Get-NetIPAddress -InterfaceAlias $a.Name -AddressFamily IPv4 -EA SilentlyContinue|?{$_.IPAddress -notlike '169.254.*'}|Select -First 1).IPAddress; Write-Host ('After  '+$c); if($b -and $c -and $b -ne $c){Write-Host '[WARN] IP changed. Re-check modem forward.'}"
ipconfig /flushdns
ping -n 2 8.8.8.8 | find "TTL=" >nul
if not errorlevel 1 (
  echo [RESULT] Internet OK after adapter restart.
  pause
  exit /b 0
)
choice /C YN /N /M "Phase 3 - winsock reset (reboot later, no IP change)? [Y/N] "
if errorlevel 2 goto END
echo [6] netsh winsock reset
echo     Skipped on purpose: netsh int ip reset
netsh winsock reset
echo [RESULT] Winsock reset requested. Reboot Windows, then /status.
:END
echo Final IPv4:
ipconfig | findstr /I "IPv4 Gateway"
pause
exit /b 0
