# Pi Node Network repair - KEEP current LAN IP
# Params kept for controller compatibility. This script never resets Docker.
param([switch]$SkipDockerReset,[switch]$NetworkOnly)
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) { $ScriptDir = $PWD.Path }
$logFile = Join-Path $ScriptDir 'pinode_network_repair.log'

function WL([string]$t) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | $t"
  Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  Write-Output $t
}

$isAdmin = $false
try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  $isAdmin = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}

Set-Content -Path $logFile -Value "==== REPAIR $(Get-Date) admin=$isAdmin ====" -Encoding UTF8
WL "==== Network repair (keep LAN IP) admin=$isAdmin ===="

function Get-PrimaryAdapter {
  $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface -eq $true })
  if (-not $adapters) { $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' }) }
  $pref = $adapters | Sort-Object { if ($_.Name -match '(?i)ethernet|local area') { 0 } elseif ($_.Name -match '(?i)wi-?fi|wireless') { 1 } else { 2 } }
  return $pref | Select-Object -First 1
}

$adapter = Get-PrimaryAdapter
if (-not $adapter) { WL '[FAIL] No Up adapter'; exit 2 }
$iface = $adapter.Name
$ipCfg = Get-NetIPAddress -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1
$currentIP = if ($ipCfg) { $ipCfg.IPAddress } else { $null }
$gw = $null
try { $gw = (Get-NetRoute -InterfaceAlias $iface -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop } catch {}
WL "[1/5] Adapter=$iface  IP=$currentIP  Gateway=$gw"
WL '      This IP must stay the same so modem port-forward still works.'

WL '[2/5] Enable adapter if needed + DNS/ARP + register DNS'
try { Get-NetAdapter | Where-Object { $_.Status -eq 'Disabled' -and $_.HardwareInterface } | Enable-NetAdapter -Confirm:$false } catch {}
cmd /c 'ipconfig /flushdns' >$null 2>&1
cmd /c 'ipconfig /registerdns' >$null 2>&1
cmd /c 'netsh interface ip delete arpcache' >$null 2>&1

WL '[3/5] Firewall TCP 31401-31410'
if ($isAdmin) {
  cmd /c 'netsh advfirewall firewall delete rule name="Pi_Node_Inbound_Ports"' >$null 2>&1
  cmd /c 'netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Ports"' >$null 2>&1
  cmd /c 'netsh advfirewall firewall delete rule name="Pi_Node_Outbound_Peers"' >$null 2>&1
  cmd /c 'netsh advfirewall firewall add rule name="Pi_Node_Inbound_Ports" dir=in action=allow protocol=TCP localport=31401-31410 profile=any' >$null 2>&1
  cmd /c 'netsh advfirewall firewall add rule name="Pi_Node_Outbound_Ports" dir=out action=allow protocol=TCP localport=31401-31410 profile=any' >$null 2>&1
  cmd /c 'netsh advfirewall firewall add rule name="Pi_Node_Outbound_Peers" dir=out action=allow protocol=TCP remoteport=31401-31410 profile=any' >$null 2>&1
  WL '      Firewall rules OK'
} else { WL '      Skip firewall (need Admin)' }

WL '[4/5] Ping tests'
$okGw = $false; $okNet = $false
if ($gw) { try { $okGw = [bool](Test-Connection -ComputerName $gw -Count 1 -Quiet -ErrorAction SilentlyContinue) } catch {} }
try { $okNet = [bool](Test-Connection -ComputerName '8.8.8.8' -Count 1 -Quiet -ErrorAction SilentlyContinue) } catch {}
WL "      Ping gateway=$okGw  Ping 8.8.8.8=$okNet"

if (-not $okNet) {
  WL "[4b] Internet still down - restart adapter (IP should stay $currentIP)"
  try {
    Restart-NetAdapter -Name $iface -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 8
  } catch {}
  $ip2 = (Get-NetIPAddress -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
  WL "      IP after adapter restart: $ip2"
  if ($currentIP -and $ip2 -and $currentIP -ne $ip2) { WL '[WARN] IP changed. Re-check modem forward.' }
  try { $okNet = [bool](Test-Connection -ComputerName '8.8.8.8' -Count 1 -Quiet -ErrorAction SilentlyContinue) } catch {}
  WL "      Ping 8.8.8.8 after restart=$okNet"
}

if (-not $okNet -and $isAdmin) {
  WL '[4c] Last resort: winsock reset only (NO int ip reset, NO release/renew)'
  cmd /c 'netsh winsock reset' >$null 2>&1
  WL '      Winsock reset requested. Reboot Windows, then check /status.'
}

WL '[5/5] Local ports 31401-31403'
foreach ($pt in 31401,31402,31403) {
  $ok = $false
  try {
    $c = New-Object Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $pt, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(400, $false)
    if ($ok) { try { $c.EndConnect($iar) | Out-Null } catch {} }
    $c.Close()
  } catch {}
  WL "      Port $pt : $ok"
}

if ($isAdmin) {
  foreach ($x in @('monitor-timeout-ac','standby-timeout-ac','hibernate-timeout-ac')) {
    cmd /c "powercfg /change $x 0" >$null 2>&1
  }
}

$ipEnd = (Get-NetIPAddress -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
WL "[OK] Done. Final LAN IP=$ipEnd  (modem forward must target this address)"
WL 'Skipped on purpose: ipconfig /release /renew, netsh int ip reset, static IP rewrite, docker reset.'
exit 0
