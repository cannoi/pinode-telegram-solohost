# ============================================================
# DataLive_HttpApi.ps1 — READ-ONLY HTTP API for SoloHost
# Reuses PiNodeMonitorLive latest.json — does NOT replace the service
# Listen: 127.0.0.1:18790  GET /v1/status  GET /v1/health
# Auth: optional Authorization: Bearer <token>  (env DATA_LIVE_TOKEN or -Token)
# PowerShell 5.1+  UTF-8
# ============================================================
param(
  [string]$ListenPrefix = 'http://127.0.0.1:18790/',
  [string]$Token = $env:DATA_LIVE_TOKEN,
  [string]$AppRoot = '',
  [string]$LatestPath = ''
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $AppRoot) {
  # Prefer sibling of this script: ../../ from DataLive if installed under package Data/
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  # Try common layouts
  foreach ($cand in @(
      (Join-Path $here '..\..\Data\PiNodeMonitorLive\latest.json'),
      (Join-Path $here '..\PiNodeMonitorLive\latest.json'),
      (Join-Path $env:USERPROFILE 'AppData\Roaming\Pi Node Telegram Controller PRO\Data\PiNodeMonitorLive\latest.json'),
      (Join-Path $env:USERPROFILE 'Documents\PiNodeMonitorLive\latest.json')
    )) {
    if (Test-Path -LiteralPath $cand) { $LatestPath = $cand; break }
  }
  if (-not $LatestPath) {
    # Walk up looking for Data\PiNodeMonitorLive\latest.json
    $probe = $here
    for ($i = 0; $i -lt 6; $i++) {
      $try = Join-Path $probe 'Data\PiNodeMonitorLive\latest.json'
      if (Test-Path -LiteralPath $try) { $LatestPath = $try; break }
      $probe = Split-Path -Parent $probe
      if (-not $probe) { break }
    }
  }
}

function Convert-ToNullableNumber($v) {
  if ($null -eq $v) { return $null }
  $s = [string]$v
  if ([string]::IsNullOrWhiteSpace($s) -or $s -eq 'N/A' -or $s -eq 'Unavailable') { return $null }
  $n = 0.0
  if ([double]::TryParse($s, [ref]$n)) { return $n }
  return $null
}

function Normalize-FromLatest([hashtable]$raw) {
  # Unified schema — omit missing fields (do not emit null)
  $o = [ordered]@{}
  $o.timestamp = if ($raw.time) { [string]$raw.time } else { (Get-Date).ToString('o') }
  $o.source = 'DataLive'

  # sync
  $syncRaw = $raw.sync_raw
  if (-not $syncRaw) { $syncRaw = $raw.Node }
  if ($raw.synced -eq $true -or ($syncRaw -match '(?i)^Synced')) {
    $o.sync = 'Synced!'
  } elseif ($syncRaw -match '(?i)catch|syncing|joining|boot') {
    $o.sync = 'Syncing'
  } elseif ($syncRaw -and $syncRaw -ne 'Unavailable' -and $syncRaw -ne 'N/A') {
    $o.sync = [string]$syncRaw
  }

  $ledger = Convert-ToNullableNumber $raw.local
  if ($null -eq $ledger) { $ledger = Convert-ToNullableNumber $raw.latest }
  if ($null -ne $ledger) { $o.ledger = [long]$ledger }

  $age = Convert-ToNullableNumber $raw.ledger_age
  if ($null -ne $age) { $o.ledger_age = [int][math]::Round($age) }

  $pin = Convert-ToNullableNumber $raw.peer_in
  if ($null -eq $pin) { $pin = Convert-ToNullableNumber $raw.incoming }
  if ($null -ne $pin) { $o.peer_in = [int]$pin }

  $pout = Convert-ToNullableNumber $raw.peer_out
  if ($null -eq $pout) { $pout = Convert-ToNullableNumber $raw.outgoing }
  if ($null -ne $pout) { $o.peer_out = [int]$pout }

  if ($raw.docker -and $raw.docker -ne 'UNKNOWN') { $o.docker = [string]$raw.docker }
  if ($raw.pi_container) { $o.container = [string]$raw.pi_container }
  elseif ($raw.container) { $o.container = [string]$raw.container }
  if ($raw.container_status) { $o.container_status = [string]$raw.container_status }

  # ports: "OPEN" string or object
  if ($raw.port -eq 'OPEN' -or $raw.Ports -eq 'OPEN') {
    $o.ports = @{ '31401' = 'OPEN'; '31402' = 'OPEN'; '31403' = 'OPEN' }
  } elseif ($raw.port -eq 'CLOSED' -or $raw.Ports -eq 'CLOSED') {
    $o.ports = @{ '31401' = 'CLOSED'; '31402' = 'CLOSED'; '31403' = 'CLOSED' }
  } elseif ($raw.ports -is [hashtable] -or $raw.ports -is [pscustomobject]) {
    $o.ports = $raw.ports
  }

  $cpu = Convert-ToNullableNumber $raw.cpu_sys
  if ($null -eq $cpu) { $cpu = Convert-ToNullableNumber $raw.cpu }
  if ($null -ne $cpu) { $o.cpu = [math]::Round([double]$cpu, 1) }

  $ram = Convert-ToNullableNumber $raw.ram_sys
  if ($null -eq $ram) { $ram = Convert-ToNullableNumber $raw.ram }
  if ($null -ne $ram) { $o.ram = [math]::Round([double]$ram, 1) }

  $temp = Convert-ToNullableNumber $raw.temp
  if ($null -ne $temp) { $o.temp = [math]::Round([double]$temp, 1) }

  $disk = Convert-ToNullableNumber $raw.disk_used
  if ($null -ne $disk) { $o.disk = [math]::Round([double]$disk, 1) }

  $vmm = Convert-ToNullableNumber $raw.vmmem_gb
  if ($null -ne $vmm) { $o.vmmem = [math]::Round([double]$vmm, 2) }

  # age of data
  try {
    if ($raw.time) {
      $dt = [datetime]::Parse([string]$raw.time)
      $o.data_age_sec = [int][math]::Max(0, ((Get-Date) - $dt).TotalSeconds)
    }
  } catch {}

  $o.confidence = if ($o.sync -eq 'Synced!' -and $o.ledger) { 'high' }
                  elseif ($o.ledger -or $o.sync) { 'medium' }
                  else { 'low' }

  return $o
}

function Read-NormalizedStatus {
  if (-not $LatestPath -or -not (Test-Path -LiteralPath $LatestPath)) {
    return $null
  }
  try {
    $json = Get-Content -LiteralPath $LatestPath -Raw -Encoding UTF8
    $obj = $json | ConvertFrom-Json
    $ht = [ordered]@{}
    $obj.PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value }
    return (Normalize-FromLatest $ht)
  } catch {
    return $null
  }
}

function Test-Auth($req) {
  if ([string]::IsNullOrWhiteSpace($Token)) { return $true }
  $h = $req.Headers['Authorization']
  if (-not $h) { return $false }
  if ($h -eq "Bearer $Token") { return $true }
  if ($h -eq $Token) { return $true }
  return $false
}

function Send-Json($res, $code, $obj) {
  $json = ($obj | ConvertTo-Json -Depth 8 -Compress)
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $res.StatusCode = $code
  $res.ContentType = 'application/json; charset=utf-8'
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.OutputStream.Close()
}

Write-Host "DataLive HTTP API"
Write-Host "  Prefix : $ListenPrefix"
Write-Host "  Latest : $LatestPath"
Write-Host "  Token  : $(if ($Token) { 'YES' } else { 'NO (open local)' })"
Write-Host "  Endpoints: GET /v1/health  GET /v1/status"
Write-Host "  Ctrl+C to stop"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($ListenPrefix)
try {
  $listener.Start()
} catch {
  Write-Host "ERROR: Cannot bind $ListenPrefix — $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Tip: run as same user; ensure port 18790 free; URL ACL if needed:"
  Write-Host "  netsh http add urlacl url=$ListenPrefix user=$env:USERNAME"
  exit 1
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $path = $req.Url.AbsolutePath.TrimEnd('/').ToLowerInvariant()

    if ($req.HttpMethod -ne 'GET') {
      Send-Json $res 405 @{ error = 'method_not_allowed' }
      continue
    }

    if (-not (Test-Auth $req)) {
      Send-Json $res 401 @{ error = 'unauthorized' }
      continue
    }

    if ($path -eq '/v1/health' -or $path -eq '/health' -or $path -eq '/healthz') {
      $st = Read-NormalizedStatus
      Send-Json $res 200 @{
        ok = $true
        service = 'DataLive'
        latest_found = [bool]$st
        data_age_sec = if ($st -and $st.data_age_sec -ne $null) { $st.data_age_sec } else { $null }
        time = (Get-Date).ToString('o')
      }
      continue
    }

    if ($path -eq '/v1/status' -or $path -eq '/status') {
      $st = Read-NormalizedStatus
      if (-not $st) {
        Send-Json $res 503 @{
          ok = $false
          error = 'latest_unavailable'
          hint = 'Start PiNodeMonitorLive_Service first so latest.json is written'
          latest_path = $LatestPath
        }
        continue
      }
      $st.ok = $true
      Send-Json $res 200 $st
      continue
    }

    Send-Json $res 404 @{ error = 'not_found'; paths = @('/v1/health', '/v1/status') }
  } catch {
    Start-Sleep -Milliseconds 200
  }
}
