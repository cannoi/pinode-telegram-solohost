PI NODE ACTION SCRIPTS (SoloHost)
================================
Double-click any .BAT. It asks for Administrator, shows what it will do, then waits for Y.

SAFE (keep your current LAN IP, do not touch modem port-forward):
  DnsRefresh.bat
  FirewallCheck.bat
  NetworkRepair.bat     flush DNS + test gateway/internet. NEVER changes IPv4.
  CleanRAM_PiNode.bat
  Weekly_Maintenance.bat  /scheduled skips the Y prompt

ONLY IF THE PROBLEM LASTS (hours) and safer scripts failed:
  DockerRecovery.bat
  NodeRecovery.bat
  HostReboot.bat

DO NOT RUN Reset_Node_Network.ps1  -- it can change LAN IP and break modem forwards.
Use NetworkRepair.bat instead.
