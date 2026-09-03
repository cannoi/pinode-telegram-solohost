@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [INFO] Requesting Administrator permission...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title Pi Node - Firewall Check
echo.
echo ============================================================
echo   PI NODE - FIREWALL 31401-31410
echo ============================================================
echo.
netsh advfirewall firewall delete rule name="Pi_Node_Inbound_Ports" >nul 2>&1
netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Ports" >nul 2>&1
netsh advfirewall firewall add rule name="Pi_Node_Inbound_Ports" dir=in action=allow protocol=TCP localport=31401-31410 profile=any
netsh advfirewall firewall add rule name="Pi_Node_Outbound_Ports" dir=out action=allow protocol=TCP localport=31401-31410 profile=any
echo.
echo [VERIFY] Local ports:
for %%P in (31401 31402 31403) do (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$x=Test-NetConnection 127.0.0.1 -Port %%P -WarningAction SilentlyContinue; if($x.TcpTestSucceeded){'%%P OPEN'}else{'%%P CLOSED'}"
)
echo.
echo [DONE] Firewall rules applied.
pause
