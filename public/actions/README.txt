PI NODE ACTION SCRIPTS  (normalized)
====================================
Short English names. One file per job. BAT is the operator entry.
Matching .ps1 exists only where a controller/automation caller needs it.

CleanRam.bat / CleanRam.ps1
    Close extra desktop apps + stop heavy services + clear TEMP + TRIM + flush DNS.
    Does NOT stop Pi Network / Docker.

CleanTemp.bat
    Delete user/system temp older than 6 hours + Recycle Bin. Gentle daily clean.

DnsFlush.bat
    ipconfig /flushdns + /registerdns only.

Firewall.bat
    Recreate Windows Firewall rules for TCP 31401-31410 and test local listen.

DockerRecover.bat
    Soft restart Docker Desktop, or ordered WSL shutdown AFTER Docker is confirmed dead.

Reboot.bat
    Controlled shutdown /r with delay + reason. Cancel: shutdown /a

LanSetup.bat
    Detect current LAN IPv4. Optional lock THAT SAME address as static + Google DNS + firewall.
    Never forces 192.168.1.222.

Maintain.bat / Maintain.ps1
    Weekly safe maintenance (v13.2 steps). Optional Sunday 03:00 task.
    Optional send_tele.ps1 in the same folder (no token inside these scripts).

NodeReset.bat
    Restart the Pi container only, then DNS + firewall + anti-sleep + Docker priority.

NetRepair.bat / NetRepair.ps1
    Keep-IP internet repair ladder: DNS/ARP/firewall -> adapter restart -> winsock reset.
    Interactive BAT stops between phases. PS auto-runs the ladder for the controller.

Monitor.bat
    Observe-only stub.

FLAGS
  /scheduled   skip confirm (Task Scheduler)
  /quiet       skip confirm and skip pause
  env PINODE_CONTROLLER=1  skip Explorer restart

RENAME MAP (old -> new)
  CleanRAM.bat / CleanRAM_PiNode.bat / CleanRAM_PiNode.ps1  -> CleanRam.*
  CleanTemp.bat                                             -> CleanTemp.bat
  DnsRefresh.bat                                            -> DnsFlush.bat
  DockerRecovery.bat                                        -> DockerRecover.bat
  FirewallCheck.bat                                         -> Firewall.bat
  HostReboot.bat                                            -> Reboot.bat
  CauHinhMang_PiNode.bat                                    -> LanSetup.bat
  Maintenance.bat / Weekly_Maintenance.bat/.ps1             -> Maintain.*
  NODE_LOI_RESET.bat / NodeRecovery.bat                     -> NodeReset.bat
  NetworkRepair.bat/.ps1 / Reset_Node_Network.bat/.ps1      -> NetRepair.*
  MonitorActions.bat                                        -> Monitor.bat

REMOVED ON PURPOSE (dangerous on a live node)
  - Hardcoded 192.168.1.222
  - Hardcoded Telegram bot token / chat id
  - docker rm ALL + docker image prune -a
  - wsl --shutdown while Docker Desktop is running
  - ipconfig /release /renew
  - netsh int ip reset

LOGIC FIX (not an omitted command)
  LanSetup no longer guesses gateway as "%CURIP:~0,-1%1"
  (that turned 192.168.1.100 into 192.168.1.101). If gateway is missing, static
  is set without inventing a wrong default.

ADDED (does not replace any old command)
  - Firewall outbound remoteport 31401-31410  (Pi peers; old localport rule kept)
  - /quiet flag, PINODE_CONTROLLER Explorer guard on BAT
  - NodeReset looks at stopped containers and verifies running after restart
  - wmic fallback via PowerShell on Maintain
  - Reboot delay must be numeric
