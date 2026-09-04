@echo off
setlocal EnableExtensions
title Pi Node - Firewall 31401-31410
if /I "%~1"=="/scheduled" goto RUN
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting Administrator...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo ============================================================
echo  FIREWALL CHECK
echo ============================================================
echo  Will do:
echo   - Allow inbound/outbound TCP 31401-31410
echo   - Test local 31401 31402 31403
echo  Will NOT:
echo   - Change LAN IP or DHCP
echo   - Change modem port-forward
echo  Use when: ports stay closed for many samples while the PC is online.
echo ============================================================
echo.
choice /C YN /N /M "Run this script? [Y/N] "
if errorlevel 2 exit /b 0
:RUN
netsh advfirewall firewall delete rule name="Pi_Node_Inbound_Ports" >nul 2>&1
netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Ports" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Inbound_Ports" dir=in action=allow protocol=TCP localport=31401-31410 profile=any
netsh advfirewall firewall add rule name="Pi_Node_Outbound_Ports" dir=out action=allow protocol=TCP localport=31401-31410 profile=any
echo [OK] Firewall rules for 31401-31410 applied.
echo.
echo Local port test:
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "foreach($p in 31401,31402,31403){$ok=$false; try{$c=New-Object Net.Sockets.TcpClient; $iar=$c.BeginConnect('127.0.0.1',$p,$null,$null); $ok=$iar.AsyncWaitHandle.WaitOne(400,$false); $c.Close()}catch{}; Write-Host ('  '+$p+'  '+$(if($ok){'OPEN'}else{'CLOSED'}))}"
echo.
echo If local ports are OPEN but the internet cannot reach them, check modem forward to THIS same LAN IP.
if /I not "%~1"=="/scheduled" pause
exit /b 0
