@echo off
setlocal EnableExtensions
title Pi Node - Reset network? NO - this is the safe redirect
echo.
echo ============================================================
echo  Reset_Node_Network is DISABLED
echo ============================================================
echo  The old script released DHCP and reset Winsock/TCP-IP.
echo  That changed LAN IP (example .222 -> .5) and broke modem
echo  port-forward to the original address.
echo.
echo  Use NetworkRepair.bat instead. It keeps your current LAN IP.
echo ============================================================
echo.
choice /C YN /N /M "Open NetworkRepair.bat now? [Y/N] "
if errorlevel 2 exit /b 0
call "%~dp0NetworkRepair.bat"
exit /b 0
