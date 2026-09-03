
PI NODE MAINTENANCE - BAT EDITION
=================================

All scripts in this package are standalone .BAT files.
They do NOT load or call any of the original .PS1 action files.

Administrator elevation:
- Scripts that change protected Windows settings automatically request Run as Administrator.
- MonitorActions.bat does not require elevation.

Built-in Windows components:
- CMD commands, netsh, ipconfig, schtasks, shutdown, WSL and Docker CLI where applicable.
- PowerShell.exe is used inline by a few BAT files for Windows-native process/network operations.
  No external .PS1 file is required.

Scripts:
- CleanRAM.bat        Smart cleanup of selected high-memory user apps; protects Pi Node/Docker/critical processes.
- CleanTemp.bat       Cleans user/System TEMP, Recycle Bin and unused Docker image/volume data.
- DnsRefresh.bat      Flushes DNS.
- FirewallCheck.bat   Allows TCP 31401-31410 and verifies local 31401-31403.
- DockerRecovery.bat  Docker recovery ladder; refuses WSL shutdown while Docker Desktop is still running.
- NodeRecovery.bat    Restarts the Pi container only; never performs WSL shutdown.
- NetworkRepair.bat   DHCP/network stack refresh. It intentionally does NOT force a static IP.
- Maintenance.bat    Weekly-style maintenance; offers to install a Sunday 03:00 scheduled task.
- HostReboot.bat     Controlled reboot with explicit confirmation.
- MonitorActions.bat Observe-only placeholder; makes no system changes.

IMPORTANT:
1. Review any recovery action before running it on a production Pi Node.
2. NetworkRepair no longer forces the current DHCP address into a static configuration.
   This is intentional: automatically converting DHCP to static can break networks.
3. HostReboot always requires an explicit Y/N confirmation.
4. Maintenance weekly task runs the same BAT with /scheduled, so it will not ask the
   interactive scheduling question again.
