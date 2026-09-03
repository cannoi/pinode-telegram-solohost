# Pi Node Reset & Cau hinh Mang - ap dung moi may (IP dong)
# Gop: CAU_HINH_MANG + NODE_LOI_RESET + Network Troubleshoot
param(
  [switch]$SkipDockerReset,
  [switch]$NetworkOnly
)
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) { $ScriptDir = $PWD.Path }
$fromController = ($env:PINODE_CONTROLLER -eq '1')
$logFile = Join-Path $ScriptDir 'pinode_reset_network.log'

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

Set-Content -Path $logFile -Value "==== RESET $(Get-Date) admin=$isAdmin ====" -Encoding UTF8
WL "Pi Node Reset & Network start (admin=$isAdmin controller=$fromController)"

if (-not $isAdmin) {
  WL "[WARN] Can quyen Administrator de reset mang/firewall day du."
}

# ---------- Tim card mang + IP dang dung ----------
function Get-PrimaryAdapter {
  $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface -eq $true })
  if (-not $adapters) {
    $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' })
  }
  # Uu tien Ethernet, sau do Wi-Fi
  $pref = $adapters | Sort-Object {
    if ($_.Name -match '(?i)ethernet|local area') { 0 }
    elseif ($_.Name -match '(?i)wi-?fi|wireless') { 1 }
    else { 2 }
  }
  return $pref | Select-Object -First 1
}

$adapter = Get-PrimaryAdapter
if (-not $adapter) {
  WL "[LOI] Khong tim thay card mang dang Up."
  exit 2
}
$iface = $adapter.Name
WL "Card mang: $iface (Status=$($adapter.Status))"

$ipCfg = Get-NetIPAddress -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1

if (-not $ipCfg) {
  $ipCfg = Get-NetIPAddress -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1
}

$currentIP = if ($ipCfg) { $ipCfg.IPAddress } else { $null }
$prefix = if ($ipCfg) { [int]$ipCfg.PrefixLength } else { 24 }

$gw = $null
try {
  $gw = (Get-NetRoute -InterfaceAlias $iface -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop
} catch {}
if (-not $gw -and $currentIP) {
  # Doan gateway .1 cung subnet
  $parts = $currentIP.Split('.')
  if ($parts.Count -eq 4) { $gw = "$($parts[0]).$($parts[1]).$($parts[2]).1" }
}

if (-not $currentIP) {
  WL "[LOI] Khong doc duoc IPv4 hien tai. Thu Network Troubleshoot..."
} else {
  WL "IP hien tai: $currentIP /$prefix  Gateway: $gw"
}

# ---------- 1) Network Troubleshoot (tuong duong bam Troubleshoot card mang) ----------
WL "[1/6] Network Troubleshoot / Reset stack..."
try {
  # Restart adapter (giong disable/enable)
  Restart-NetAdapter -Name $iface -Confirm:$false -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
} catch {}
cmd /c "ipconfig /release" >$null 2>&1
cmd /c "ipconfig /renew" >$null 2>&1
cmd /c "ipconfig /flushdns" >$null 2>&1
if ($isAdmin) {
  cmd /c "netsh winsock reset" >$null 2>&1
  cmd /c "netsh int ip reset" >$null 2>&1
  # Troubleshoot network (Windows built-in)
  try {
    $tsPath = Join-Path $env:SystemRoot 'diagnostics\system\networking'
    if (Test-Path $tsPath) {
      # msdt co the interactive - chi goi khi khong tu controller
      if (-not $fromController) {
        Start-Process -FilePath 'msdt.exe' -ArgumentList '-id NetworkDiagnosticsNetworkAdapter' -Wait -ErrorAction SilentlyContinue
      }
    }
  } catch {}
}
WL "Network stack refreshed"

# Doc lai IP sau troubleshoot
Start-Sleep -Seconds 2
$ipCfg2 = Get-NetIPAddress -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1
if ($ipCfg2) {
  $currentIP = $ipCfg2.IPAddress
  $prefix = [int]$ipCfg2.PrefixLength
  WL "IP sau troubleshoot: $currentIP /$prefix"
}
if (-not $gw) {
  try { $gw = (Get-NetRoute -InterfaceAlias $iface -DestinationPrefix '0.0.0.0/0' -EA SilentlyContinue | Select-Object -First 1).NextHop } catch {}
}

if (-not $currentIP) {
  WL "[LOI] Van khong co IP. Thoat."
  exit 3
}

# ---------- 2) Gan IP tinh = IP dang dung (khong hardcode .222) ----------
WL "[2/6] Dat IP tinh = $currentIP (giu IP hien tai)..."
if ($isAdmin) {
  try {
    Disable-NetAdapterBinding -Name $iface -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue
  } catch {}
  try {
    # Xoa IP cu (DHCP) roi set static
    $existing = Get-NetIPAddress -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction SilentlyContinue
    foreach ($e in $existing) {
      try { Remove-NetIPAddress -InterfaceAlias $iface -IPAddress $e.IPAddress -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    }
    try { Remove-NetRoute -InterfaceAlias $iface -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    New-NetIPAddress -InterfaceAlias $iface -IPAddress $currentIP -PrefixLength $prefix -DefaultGateway $gw -ErrorAction SilentlyContinue | Out-Null
    # DNS Google
    Set-DnsClientServerAddress -InterfaceAlias $iface -ServerAddresses @('8.8.8.8','8.8.4.4') -ErrorAction SilentlyContinue
    try { Set-NetConnectionProfile -InterfaceAlias $iface -NetworkCategory Private -ErrorAction SilentlyContinue } catch {}
    WL "IP tinh OK: $currentIP gw=$gw dns=8.8.8.8"
  } catch {
    # Fallback netsh
    $mask = switch ($prefix) {
      8  { '255.0.0.0' }
      16 { '255.255.0.0' }
      24 { '255.255.255.0' }
      default { '255.255.255.0' }
    }
    if (-not $gw) { $gw = ($currentIP -replace '\.\d+$','.1') }
    cmd /c "netsh interface ip set address name=`"$iface`" static $currentIP $mask $gw 1" >$null 2>&1
    cmd /c "netsh interface ip set dns name=`"$iface`" static 8.8.8.8 validate=no" >$null 2>&1
    cmd /c "netsh interface ip add dns name=`"$iface`" 8.8.4.4 index=2 validate=no" >$null 2>&1
    WL "IP tinh (netsh): $currentIP $mask gw=$gw"
  }
} else {
  WL "Bo qua set IP tinh (can Admin)"
}

# ---------- 3) Mo firewall ports 31401-31410 ----------
WL "[3/6] Firewall ports 31401-31410..."
if ($isAdmin) {
  cmd /c "netsh advfirewall firewall delete rule name=`"Pi_Node_Inbound_Ports`"" >$null 2>&1
  cmd /c "netsh advfirewall firewall delete rule name=`"Pi_Node_Outbound_Ports`"" >$null 2>&1
  cmd /c "netsh advfirewall firewall add rule name=`"Pi_Node_Inbound_Ports`" dir=in action=allow protocol=TCP localport=31401-31410 profile=any" >$null 2>&1
  cmd /c "netsh advfirewall firewall add rule name=`"Pi_Node_Outbound_Ports`" dir=out action=allow protocol=TCP localport=31401-31410 profile=any" >$null 2>&1
  WL "Firewall rules OK"
}

# ---------- 4) Docker hard reset (neu khong Skip) ----------
# ---------- 4) Docker/WSL safe reset ----------
if (-not $NetworkOnly -and -not $SkipDockerReset) {
  WL "[4/6] Docker/WSL safe reset (tranh cat nua chung gay treo)..."
  try {
    $ctns = @(& docker ps -q 2>$null)
    if ($ctns -and $ctns.Count -gt 0) {
      WL ("Docker stop containers (" + $ctns.Count + ")...")
      & docker stop --time 30 $ctns 2>$null | Out-Null
      Start-Sleep -Seconds 5
    }
  } catch { WL ("docker stop: " + $_.Exception.Message) }
  try {
    Get-Process -Name 'Docker Desktop','com.docker.backend' -ErrorAction SilentlyContinue | ForEach-Object {
      try { $_.CloseMainWindow() | Out-Null } catch {}
    }
    Start-Sleep -Seconds 8
  } catch {}
  try {
    $svc = Get-Service -Name 'com.docker.service' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {
      WL "Stopping com.docker.service..."
      Stop-Service -Name 'com.docker.service' -Force -ErrorAction SilentlyContinue
      $waited = 0
      while ($waited -lt 60) {
        Start-Sleep -Seconds 3
        $waited = $waited + 3
        $svc.Refresh()
        if ($svc.Status -eq 'Stopped') { break }
      }
      WL ("Docker service status=" + $svc.Status + " after " + $waited + "s")
    }
  } catch { WL ("Docker service stop: " + $_.Exception.Message) }
  try {
    $dockerStill = Get-Process -Name 'com.docker.backend','Docker Desktop' -ErrorAction SilentlyContinue
    if ($dockerStill) {
      WL "Docker process con song - cho them 15s truoc wsl --shutdown"
      Start-Sleep -Seconds 15
      try { Stop-Process -Name 'com.docker.backend','Docker Desktop' -Force -ErrorAction SilentlyContinue } catch {}
      Start-Sleep -Seconds 5
    }
  } catch {}
  try {
    WL "wsl --shutdown (sau khi Docker da dung)..."
    & wsl --shutdown 2>$null
    Start-Sleep -Seconds 10
  } catch { WL ("wsl shutdown: " + $_.Exception.Message) }
  try {
    $ddCandidates = @()
    $ddCandidates += (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($pf86) { $ddCandidates += (Join-Path $pf86 'Docker\Docker\Docker Desktop.exe') }
    $dd = $ddCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if ($dd) {
      WL "Start Docker Desktop..."
      Start-Process -FilePath $dd -ErrorAction SilentlyContinue
      $okEngine = $false
      for ($i = 0; $i -lt 18; $i++) {
        Start-Sleep -Seconds 5
        try {
          $ver = & docker info 2>$null
          if ($ver) { $okEngine = $true; WL "Docker engine OK"; break }
        } catch {}
      }
      if (-not $okEngine) { WL "[WARN] Docker engine chua san sang - mo Docker Desktop thu cong" }
    } else {
      WL "Khong tim thay Docker Desktop.exe - hay mo thu cong"
    }
  } catch { WL ("Start Docker: " + $_.Exception.Message) }
  WL "Docker/WSL safe reset xong - mo Pi Node neu can"
} else {
  WL "[4/6] Bo qua Docker reset"
}

WL "[5/6] Anti-sleep + Docker priority..."
if ($isAdmin) {
  foreach ($x in @('monitor-timeout-ac','standby-timeout-ac','hibernate-timeout-ac')) {
    cmd /c "powercfg /change $x 0" >$null 2>&1
  }
}
try {
  Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue | ForEach-Object { $_.PriorityClass = 'AboveNormal' }
} catch {}

# ---------- 6) Kiem tra port local ----------
WL "[6/6] Kiem tra port local 31401-31403..."
foreach ($pt in 31401,31402,31403) {
  $ok = $false
  try { $ok = (Test-NetConnection 127.0.0.1 -Port $pt -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
  WL "Port $pt : $ok"
}

WL "[OK] Reset Node/Network xong. IP tinh=$currentIP iface=$iface"
WL "Huong dan modem: Static Lease + Virtual Server 31401-31410 -> $currentIP"
exit 0
