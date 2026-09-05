@echo off
setlocal EnableExtensions
title Pi Node - LanSetup
cd /d "%~dp0"

if /I "%~1"=="/scheduled" goto GOTADMIN
if /I "%~1"=="/quiet" goto GOTADMIN
net session >nul 2>&1
if %errorLevel%==0 goto GOTADMIN
echo Requesting Administrator...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -LiteralPath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs"
exit /b
:GOTADMIN
echo.
echo ============================================================
echo  LAN SETUP FOR PI NODE
echo ============================================================
echo  Detects the IPv4 this PC already uses.
echo  Optional: lock THAT same IP as static so modem forward stays valid.
echo ============================================================
echo.

for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -Command "$a=Get-NetAdapter|?{$_.Status -eq 'Up' -and $_.HardwareInterface}|Sort-Object {if($_.Name -match 'ether|local area'){0}elseif($_.Name -match 'wi'){1}else{2}}|Select -First 1; if(-not $a){Write-Output '|||'; exit}; $ip=Get-NetIPAddress -InterfaceAlias $a.Name -AddressFamily IPv4 -EA SilentlyContinue|?{$_.IPAddress -notlike '169.254.*'}|Select -First 1; $gw=(Get-NetRoute -InterfaceAlias $a.Name -DestinationPrefix '0.0.0.0/0' -EA SilentlyContinue|Sort RouteMetric|Select -First 1).NextHop; Write-Output ($a.Name+'|'+$ip.IPAddress+'|'+$ip.PrefixLength+'|'+$gw)"`) do set "NETINFO=%%I"
for /f "tokens=1-4 delims=|" %%A in ("%NETINFO%") do (
  set "IFACE=%%A"
  set "CURIP=%%B"
  set "PREFIX=%%C"
  set "GW=%%D"
)

if "%CURIP%"=="" (
  echo [FAIL] Could not read current IPv4. Connect Ethernet/Wi-Fi first.
  pause
  exit /b 2
)

set "MASK="
if "%PREFIX%"=="32" set "MASK=255.255.255.255"
if "%PREFIX%"=="24" set "MASK=255.255.255.0"
if "%PREFIX%"=="16" set "MASK=255.255.0.0"
if "%PREFIX%"=="8"  set "MASK=255.0.0.0"
if "%MASK%"=="" (
  for /f "usebackq delims=" %%M in (`powershell.exe -NoProfile -Command "$p=%PREFIX%; if(-not $p){$p=24}; $b=[Convert]::ToUInt32(('1'*$p).PadRight(32,'0'),2); $bytes=[BitConverter]::GetBytes($b); if([BitConverter]::IsLittleEndian){[Array]::Reverse($bytes)}; Write-Output (($bytes | ForEach-Object {$_}) -join '.')"`) do set "MASK=%%M"
)
if "%MASK%"=="" set "MASK=255.255.255.0"

echo  Adapter : %IFACE%
echo  LAN IP  : %CURIP%
echo  Prefix  : %PREFIX%
echo  Mask    : %MASK%
if "%GW%"=="" (
  echo  Gateway : ^(not detected - will not invent one^)
) else (
  echo  Gateway : %GW%
)
echo.
echo  Modem Virtual Server / Static Lease must point to %CURIP%
echo.
choice /C YN /N /M "Lock this SAME IP as static + firewall + Google DNS? [Y/N] "
if errorlevel 2 goto GUIDE

echo [1/5] Disable IPv6 on %IFACE%
powershell.exe -NoProfile -Command "Disable-NetAdapterBinding -Name '%IFACE%' -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue"

echo [2/5] Set STATIC to current IP %CURIP%  (not a different address)
if "%GW%"=="" (
  netsh interface ip set address name="%IFACE%" static %CURIP% %MASK%
) else (
  netsh interface ip set address name="%IFACE%" static %CURIP% %MASK% %GW% 1
)

echo [3/5] DNS 8.8.8.8 / 8.8.4.4
netsh interface ip set dns name="%IFACE%" static 8.8.8.8 validate=no
netsh interface ip add dns name="%IFACE%" 8.8.4.4 index=2 validate=no

echo [4/5] Profile Private
powershell.exe -NoProfile -Command "Set-NetConnectionProfile -InterfaceAlias '%IFACE%' -NetworkCategory Private -ErrorAction SilentlyContinue"

echo [5/5] Firewall TCP 31401-31410
netsh advfirewall firewall delete rule name="Pi_Node_Inbound_Ports" >nul 2>&1
netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Ports" >nul 2>&1
netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Peers" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Inbound_Ports" dir=in action=allow protocol=TCP localport=31401-31410 profile=any
netsh advfirewall firewall add rule name="Pi_Node_Outbound_Ports" dir=out action=allow protocol=TCP localport=31401-31410 profile=any
netsh advfirewall firewall add rule name="Pi_Node_Outbound_Peers" dir=out action=allow protocol=TCP remoteport=31401-31410 profile=any

echo.
echo [RESULT] Windows side done. IP should still be %CURIP%
ipconfig | findstr /I "IPv4 Gateway"
echo.

:GUIDE
echo ============================================================
echo  MODEM CHECKLIST  (you do this in the router UI)
echo ============================================================
echo  1. Confirm public WAN IP on ping.eu matches modem WAN page.
echo  2. Static Lease: bind this PC MAC to %CURIP%
echo  3. Virtual Server / NAT: TCP 31401-31410 -^> %CURIP%
echo  4. Open Docker Desktop, then Pi Node Doctor - Check Now.
echo ============================================================
pause
exit /b 0
