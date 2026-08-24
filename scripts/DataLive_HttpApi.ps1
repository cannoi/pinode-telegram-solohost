# DataLive HTTP API v2.5.7 - ASCII only for PS 5.1
# Read-only. Serves MonitorLive latest.json
# Console dashboard refreshes every 60s
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
    (Join-Path $env:USERPROFILE 'AppData\Roaming\Pi Node Telegram Controller PRO\Data\PiNodeMonitorLive\latest.json'),
    (Join-Path $env:USERPROFILE 'AppData\Roaming\PiNode Telegram Controller PRO\Data\PiNodeMonitorLive\latest.json')
  )
  foreach ($c in $candidates) {
    try {
      $full = [System.IO.Path]::GetFullPath($c)
      if (Test-Path -LiteralPath $full) { return $full }
    } catch {}
  }
  $probe = $ScriptDir
  for ($i = 0; $i -lt 8; $i++) {
    $try = Join-Path $probe 'Data\PiNodeMonitorLive\latest.json'
    if (Test-Path -LiteralPath $try) { return ([System.IO.Path]::GetFullPath($try)) }
    $parent = Split-Path -Parent $probe
    if (-not $parent -or $parent -eq $probe) { break }
    $probe = $parent
  }
  return $null
}

function Convert-ToNullableNumber($v) {
  if ($null -eq $v) { return $null }
  $s = [string]$v
  if ([string]::IsNullOrWhiteSpace($s) -or $s -eq 'N/A' -or $s -eq 'Unavailable') { return $null }
  $n = 0.0
  if ([double]::TryParse($s, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$n)) { return $n }
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
  if ($synced -or ($syncRaw -and ($syncRaw -match '(?i)^Synced'))) { $o.sync = 'Synced!' }
  elseif ($syncRaw -and ($syncRaw -match '(?i)catch|syncing|joining|boot')) { $o.sync = 'Syncing' }
  elseif ($syncRaw -and $syncRaw -ne 'Unavailable' -and $syncRaw -ne 'N/A') { $o.sync = [string]$syncRaw }
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
  try { if ($raw.docker -and $raw.docker -ne 'UNKNOWN') { $o.docker = [string]$raw.docker } } catch {}
  try { if ($raw.pi_container) { $o.container = [string]$raw.pi_container } elseif ($raw.container) { $o.container = [string]$raw.container } } catch {}
  $cpu = Convert-ToNullableNumber $(try { $raw.cpu_sys } catch { $null })
  if ($null -eq $cpu) { $cpu = Convert-ToNullableNumber $(try { $raw.cpu } catch { $null }) }
  if ($null -ne $cpu) { $o.cpu = [math]::Round([double]$cpu, 1) }
  $ram = Convert-ToNullableNumber $(try { $raw.ram_sys } catch { $null })
  if ($null -eq $ram) { $ram = Convert-ToNullableNumber $(try { $raw.ram } catch { $null }) }
  if ($null -ne $ram) { $o.ram = [math]::Round([double]$ram, 1) }
  $temp = Convert-ToNullableNumber $(try { $raw.temp } catch { $null })
  if ($null -ne $temp) { $o.temp = [math]::Round([double]$temp, 1) }
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
  if (-not $script:ResolvedLatest -or -not (Test-Path -LiteralPath $script:ResolvedLatest)) { return $null }
  try {
    $json = Get-Content -LiteralPath $script:ResolvedLatest -Raw -Encoding UTF8
    return (Normalize-FromObject ($json | ConvertFrom-Json))
  } catch { return $null }
}

function Show-Dashboard {
  $st = Read-NormalizedStatus
  $line = (Get-Date).ToString('HH:mm:ss')
  Write-Host ""
  Write-Host "======== DataLive dashboard $line ========"
  if (-not $st) {
    Write-Host " latest.json: NOT FOUND (start MonitorLive first)"
    Write-Host " path: $script:ResolvedLatest"
  } else {
    Write-Host (" path: " + $script:ResolvedLatest)
    if ($st.sync) { Write-Host (" Sync: " + $st.sync) }
    if ($null -ne $st.ledger) { Write-Host (" Ledger: " + $st.ledger) }
    if ($null -ne $st.ledger_age) { Write-Host (" Age: " + $st.ledger_age + "s") }
    if ($null -ne $st.peer_in -or $null -ne $st.peer_out) {
      Write-Host (" Peers IN/OUT: " + $st.peer_in + " / " + $st.peer_out)
    }
    if ($st.docker) { Write-Host (" Docker: " + $st.docker) }
    if ($st.container) { Write-Host (" Container: " + $st.container) }
    if ($null -ne $st.cpu) { Write-Host (" CPU: " + $st.cpu + "%") }
    if ($null -ne $st.ram) { Write-Host (" RAM: " + $st.ram + "%") }
    if ($null -ne $st.temp) { Write-Host (" Temp: " + $st.temp + "C") }
    if ($null -ne $st.data_age_sec) { Write-Host (" Data age: " + $st.data_age_sec + "s") }
  }
  Write-Host " API: GET /v1/health  GET /v1/status"
  Write-Host "=========================================="
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
Write-Host "DataLive HTTP API - v2.5.7"
Write-Host ("  Prefix : " + $ListenPrefix)
Write-Host ("  Latest : " + $(if ($script:ResolvedLatest) { $script:ResolvedLatest } else { '(not found)' }))
Write-Host ("  Token  : " + $(if ($Token) { 'YES' } else { 'NO (open local)' }))
Write-Host "  Dashboard every 60s. Ctrl+C to stop."
Write-Host "  SoloHost: http://host.docker.internal:18790"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($ListenPrefix)
try { $listener.Start() } catch {
  Write-Host ("ERROR bind " + $ListenPrefix)
  Write-Host $_.Exception.Message
  Write-Host ("  netsh http add urlacl url=" + $ListenPrefix + " user=" + $env:USERNAME)
  exit 1
}

Show-Dashboard
$lastDash = Get-Date

while ($listener.IsListening) {
  try {
    if (((Get-Date) - $lastDash).TotalSeconds -ge 60) {
      Show-Dashboard
      $lastDash = Get-Date
    }
    $ar = $listener.BeginGetContext($null, $null)
    while (-not $ar.AsyncWaitHandle.WaitOne(500)) {
      if (((Get-Date) - $lastDash).TotalSeconds -ge 60) {
        Show-Dashboard
        $lastDash = Get-Date
      }
    }
    $ctx = $listener.EndGetContext($ar)
    $req = $ctx.Request
    $res = $ctx.Response
    $path = $req.Url.AbsolutePath.TrimEnd('/').ToLowerInvariant()
    if ($req.HttpMethod -ne 'GET') { Send-Json $res 405 @{ error = 'method_not_allowed' }; continue }
    if (-not (Test-Auth $req)) { Send-Json $res 401 @{ error = 'unauthorized' }; continue }
    if ($path -eq '/v1/health' -or $path -eq '/health') {
      $st = Read-NormalizedStatus
      Send-Json $res 200 @{ ok = $true; service = 'DataLive'; version = '2.5.7'; latest_found = [bool]$st; latest_path = $script:ResolvedLatest; data_age_sec = $(if ($st) { $st.data_age_sec } else { $null }) }
      continue
    }
    if ($path -eq '/v1/status' -or $path -eq '/status') {
      $st = Read-NormalizedStatus
      if (-not $st) { Send-Json $res 503 @{ ok = $false; error = 'latest_unavailable'; latest_path = $script:ResolvedLatest }; continue }
      $st['ok'] = $true
      Send-Json $res 200 $st
      continue
    }
    Send-Json $res 404 @{ error = 'not_found' }
  } catch { Start-Sleep -Milliseconds 200 }
}
