# DataLive_HttpApi.ps1 - READ-ONLY HTTP for SoloHost
# Reuses PiNodeMonitorLive latest.json - does NOT replace MonitorLive service
# Listen: http://127.0.0.1:18790/   GET /v1/health  GET /v1/status
# Optional: env DATA_LIVE_TOKEN  or  -Token
# PowerShell 5.1 - ASCII source only (no smart quotes / em-dash)
# ============================================================
param(
  [string]$ListenPrefix = 'http://+:18790/',
  [string]$Token = $env:DATA_LIVE_TOKEN,
  [string]$LatestPath = ''
)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) { $ScriptDir = $PWD.Path }

function Find-LatestJson {
  param([string]$Explicit)
  if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }

  $candidates = @(
    (Join-Path $ScriptDir 'latest.json'),
    (Join-Path $ScriptDir '..\PiNodeMonitorLive\latest.json'),
    (Join-Path $ScriptDir '..\..\Data\PiNodeMonitorLive\latest.json'),
    (Join-Path $ScriptDir '..\..\..\Data\PiNodeMonitorLive\latest.json'),
    (Join-Path $env:USERPROFILE 'AppData\Roaming\Pi Node Telegram Controller PRO\Data\PiNodeMonitorLive\latest.json'),
    (Join-Path $env:USERPROFILE 'AppData\Roaming\PiNode Telegram Controller PRO\Data\PiNodeMonitorLive\latest.json'),
    (Join-Path $env:USERPROFILE 'Documents\PiNodeMonitorLive\latest.json'),
    (Join-Path $env:USERPROFILE 'Desktop\PiNodeMonitorLive\latest.json')
  )

  foreach ($c in $candidates) {
    try {
      $full = [System.IO.Path]::GetFullPath($c)
      if (Test-Path -LiteralPath $full) { return $full }
    } catch {}
  }

  # Walk up from script looking for Data\PiNodeMonitorLive\latest.json
  $probe = $ScriptDir
  for ($i = 0; $i -lt 8; $i++) {
    $try = Join-Path $probe 'Data\PiNodeMonitorLive\latest.json'
    try {
      if (Test-Path -LiteralPath $try) { return ([System.IO.Path]::GetFullPath($try)) }
    } catch {}
    $parent = Split-Path -Parent $probe
    if (-not $parent -or $parent -eq $probe) { break }
    $probe = $parent
  }

  # Search under common PRO install roots (shallow)
  $roots = @(
    (Join-Path $env:USERPROFILE 'AppData\Roaming'),
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:USERPROFILE 'Documents')
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    try {
      $hit = Get-ChildItem -Path $root -Filter 'latest.json' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -match 'PiNodeMonitorLive' } |
        Select-Object -First 1
      if ($hit) { return $hit.FullName }
    } catch {}
  }
  return $null
}

function Convert-ToNullableNumber($v) {
  if ($null -eq $v) { return $null }
  $s = [string]$v
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  if ($s -eq 'N/A' -or $s -eq 'Unavailable') { return $null }
  $n = 0.0
  if ([double]::TryParse($s, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$n)) {
    return $n
  }
  return $null
}

function Normalize-FromObject($raw) {
  $o = [ordered]@{}
  $timeVal = $null
  try { $timeVal = $raw.time } catch {}
  if (-not $timeVal) { try { $timeVal = $raw.timestamp } catch {} }
  $o.timestamp = if ($timeVal) { [string]$timeVal } else { (Get-Date).ToString('o') }
  $o.source = 'DataLive'

  $syncRaw = $null
  try { $syncRaw = $raw.sync_raw } catch {}
  if (-not $syncRaw) { try { $syncRaw = $raw.Node } catch {} }
  $synced = $false
  try { if ($raw.synced -eq $true) { $synced = $true } } catch {}
  if ($synced -or ($syncRaw -and ($syncRaw -match '(?i)^Synced'))) {
    $o.sync = 'Synced!'
  } elseif ($syncRaw -and ($syncRaw -match '(?i)catch|syncing|joining|boot')) {
    $o.sync = 'Syncing'
  } elseif ($syncRaw -and $syncRaw -ne 'Unavailable' -and $syncRaw -ne 'N/A') {
    $o.sync = [string]$syncRaw
  } else {
    try {
      $syncLabel = $raw.sync
      if ($syncLabel -and $syncLabel -ne 'N/A') { $o.sync = [string]$syncLabel }
    } catch {}
  }

  $ledger = Convert-ToNullableNumber $(try { $raw.local } catch { $null })
  if ($null -eq $ledger) { $ledger = Convert-ToNullableNumber $(try { $raw.latest } catch { $null }) }
  if ($null -eq $ledger) { $ledger = Convert-ToNullableNumber $(try { $raw.ledger } catch { $null }) }
  if ($null -ne $ledger) { $o.ledger = [long]$ledger }

  $age = Convert-ToNullableNumber $(try { $raw.ledger_age } catch { $null })
  if ($null -ne $age) { $o.ledger_age = [int][math]::Round($age) }

  $pin = Convert-ToNullableNumber $(try { $raw.peer_in } catch { $null })
  if ($null -eq $pin) { $pin = Convert-ToNullableNumber $(try { $raw.incoming } catch { $null }) }
  if ($null -ne $pin) { $o.peer_in = [int]$pin }

  $pout = Convert-ToNullableNumber $(try { $raw.peer_out } catch { $null })
  if ($null -eq $pout) { $pout = Convert-ToNullableNumber $(try { $raw.outgoing } catch { $null }) }
  if ($null -ne $pout) { $o.peer_out = [int]$pout }

  try {
    if ($raw.docker -and $raw.docker -ne 'UNKNOWN') { $o.docker = [string]$raw.docker }
  } catch {}
  try {
    if ($raw.pi_container) { $o.container = [string]$raw.pi_container }
    elseif ($raw.container) { $o.container = [string]$raw.container }
  } catch {}
  try {
    if ($raw.container_status) { $o.container_status = [string]$raw.container_status }
  } catch {}

  $portVal = $null
  try { $portVal = $raw.port } catch {}
  if (-not $portVal) { try { $portVal = $raw.Ports } catch {} }
  if ($portVal -eq 'OPEN') {
    $o.ports = @{ '31401' = 'OPEN'; '31402' = 'OPEN'; '31403' = 'OPEN' }
  } elseif ($portVal -eq 'CLOSED') {
    $o.ports = @{ '31401' = 'CLOSED'; '31402' = 'CLOSED'; '31403' = 'CLOSED' }
  }

  $cpu = Convert-ToNullableNumber $(try { $raw.cpu_sys } catch { $null })
  if ($null -eq $cpu) { $cpu = Convert-ToNullableNumber $(try { $raw.cpu } catch { $null }) }
  if ($null -ne $cpu) { $o.cpu = [math]::Round([double]$cpu, 1) }

  $ram = Convert-ToNullableNumber $(try { $raw.ram_sys } catch { $null })
  if ($null -eq $ram) { $ram = Convert-ToNullableNumber $(try { $raw.ram } catch { $null }) }
  if ($null -ne $ram) { $o.ram = [math]::Round([double]$ram, 1) }

  $temp = Convert-ToNullableNumber $(try { $raw.temp } catch { $null })
  if ($null -ne $temp) { $o.temp = [math]::Round([double]$temp, 1) }

  $disk = Convert-ToNullableNumber $(try { $raw.disk_used } catch { $null })
  if ($null -ne $disk) { $o.disk = [math]::Round([double]$disk, 1) }

  $vmm = Convert-ToNullableNumber $(try { $raw.vmmem_gb } catch { $null })
  if ($null -ne $vmm) { $o.vmmem = [math]::Round([double]$vmm, 2) }

  try {
    if ($timeVal) {
      $dt = [datetime]::Parse([string]$timeVal)
      $o.data_age_sec = [int][math]::Max(0, ((Get-Date) - $dt).TotalSeconds)
    }
  } catch {}

  if ($o.sync -eq 'Synced!' -and $o.ledger) { $o.confidence = 'high' }
  elseif ($o.ledger -or $o.sync) { $o.confidence = 'medium' }
  else { $o.confidence = 'low' }

  return $o
}

function Read-NormalizedStatus {
  if (-not $script:ResolvedLatest -or -not (Test-Path -LiteralPath $script:ResolvedLatest)) {
    $script:ResolvedLatest = Find-LatestJson -Explicit $LatestPath
  }
  if (-not $script:ResolvedLatest -or -not (Test-Path -LiteralPath $script:ResolvedLatest)) {
    return $null
  }
  try {
    $json = Get-Content -LiteralPath $script:ResolvedLatest -Raw -Encoding UTF8
    $obj = $json | ConvertFrom-Json
    return (Normalize-FromObject $obj)
  } catch {
    return $null
  }
}

function Test-Auth($req) {
  if ([string]::IsNullOrWhiteSpace($Token)) { return $true }
  $h = $req.Headers['Authorization']
  if (-not $h) { return $false }
  if ($h -eq ("Bearer " + $Token)) { return $true }
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

$script:ResolvedLatest = Find-LatestJson -Explicit $LatestPath

Write-Host "DataLive HTTP API - v2.5.2"
Write-Host "  Note: prefix http://+:18790/ so SoloHost (host.docker.internal) can connect"
Write-Host ("  Prefix : " + $ListenPrefix)
Write-Host ("  Latest : " + $(if ($script:ResolvedLatest) { $script:ResolvedLatest } else { '(not found - start MonitorLive first)' }))
Write-Host ("  Token  : " + $(if ($Token) { 'YES' } else { 'NO (open local)' }))
Write-Host "  Endpoints: GET /v1/health  GET /v1/status"
Write-Host "  Ctrl+C to stop"
Write-Host ""
Write-Host "Test:  curl http://127.0.0.1:18790/v1/status"
Write-Host "SoloHost uses: http://host.docker.internal:18790"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($ListenPrefix)
try {
  $listener.Start()
} catch {
  Write-Host ("ERROR: Cannot bind " + $ListenPrefix)
  Write-Host $_.Exception.Message
  Write-Host "Tip: free port 18790, or run:"
  Write-Host ("  netsh http add urlacl url=" + $ListenPrefix + " user=" + $env:USERNAME)
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
        version = '2.5.2'
        latest_found = [bool]$st
        latest_path = $script:ResolvedLatest
        data_age_sec = $(if ($st -and $null -ne $st.data_age_sec) { $st.data_age_sec } else { $null })
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
          hint = 'Start PiNodeMonitorLive_Service so latest.json is written'
          latest_path = $script:ResolvedLatest
        }
        continue
      }
      $st['ok'] = $true
      Send-Json $res 200 $st
      continue
    }

    Send-Json $res 404 @{ error = 'not_found'; paths = @('/v1/health', '/v1/status') }
  } catch {
    Start-Sleep -Milliseconds 200
  }
}
