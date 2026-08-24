#requires -Version 5.1
<#
Pi Node Diagnostic PRO - Fixed Syntax & Fast Execution
Windows PowerShell 5.1 Compatible
#>

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference   = 'SilentlyContinue'
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

$HistoryPath = Join-Path $ScriptDir 'node_history.json'
$JsonPath    = Join-Path $ScriptDir 'diagnostic_latest.json'
$Now         = Get-Date

# Collections
$Good     = [System.Collections.Generic.List[string]]::new()
$Warnings = [System.Collections.Generic.List[string]]::new()
$Issues   = [System.Collections.Generic.List[string]]::new()

function Add-Good  ([string]$t) { if ($t) { [void]$Good.Add($t) } }
function Add-Warn  ([string]$t) { if ($t) { [void]$Warnings.Add($t) } }
function Add-Issue ([string]$t) { if ($t) { [void]$Issues.Add($t) } }

function Section ([string]$Title) {
    Write-Output ""
    Write-Output "==== $Title ===="
}

function Test-PortFast ([string]$Address, [int]$Port, [int]$TimeoutMs = 1000) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($Address, $Port, $null, $null)
        $success = $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if (-not $success) { return $false }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
        $client.Dispose()
    }
}

function To-Number ($Value) {
    if ($null -eq $Value) { return $null }
    $s = ([string]$Value).Trim() -replace '[%°C]',''
    $n = 0.0
    if ([double]::TryParse($s, [Globalization.NumberStyles]::Any, [Globalization.CultureInfo]::InvariantCulture, [ref]$n)) {
        return $n
    }
    return $null
}

function Get-PropertyValue ($Object, [string[]]$Names) {
    foreach ($name in $Names) {
        $prop = $Object.PSObject.Properties[$name]
        if ($null -ne $prop -and $null -ne $prop.Value -and ([string]$prop.Value).Trim()) {
            return $prop.Value
        }
    }
    return $null
}

function Get-TimeValue ($Object) {
    $v = Get-PropertyValue $Object @('Timestamp','Time','DateTime','Date','RecordedAt','Recorded','timestamp','time')
    if ($null -eq $v) { return $null }
    try { return [datetime]$v } catch { return $null }
}

function Get-MetricValues ($Rows, [string[]]$Names) {
    $out = [System.Collections.Generic.List[double]]::new()
    foreach ($row in $Rows) {
        $n = To-Number (Get-PropertyValue $row $Names)
        if ($null -ne $n) { [void]$out.Add($n) }
    }
    return $out.ToArray()
}

function Stats ([double[]]$Values) {
    if (-not $Values -or $Values.Count -eq 0) { return $null }
    $m = $Values | Measure-Object -Minimum -Maximum -Average
    $sorted = $Values | Sort-Object
    $mid = [math]::Floor($sorted.Count / 2)
    $median = if ($sorted.Count % 2) { $sorted[$mid] } else { ($sorted[$mid-1] + $sorted[$mid]) / 2 }

    [pscustomobject]@{
        Count   = $Values.Count
        Min     = [math]::Round($m.Minimum, 2)
        Max     = [math]::Round($m.Maximum, 2)
        Average = [math]::Round($m.Average, 2)
        Median  = [math]::Round($median, 2)
    }
}

# ===== HEADER =====
Write-Output "=============================================="
Write-Output " PI NODE DIAGNOSTIC PRO (Optimized)"
Write-Output "=============================================="
Write-Output "Time : $($Now.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Output "Host : $env:COMPUTERNAME"
Write-Output "Path : $ScriptDir"

$Report = [ordered]@{
    schema      = 'PiNodeDiagnosticPRO.v1'
    timestamp   = $Now.ToString('o')
    host        = $env:COMPUTERNAME
    result      = $null
    score       = 100
    system      = [ordered]@{}
    nodeProcess = [ordered]@{}
    docker      = [ordered]@{}
    wsl         = [ordered]@{}
    ports       = @()
    network     = [ordered]@{}
    history     = [ordered]@{}
    good        = @()
    warnings    = @()
    issues      = @()
}

# ===== SYSTEM =====
Section 'SYSTEM'
try {
    $os  = Get-CimInstance Win32_OperatingSystem -Property Caption,Version,FreePhysicalMemory,LastBootUpTime
    $cs  = Get-CimInstance Win32_ComputerSystem  -Property TotalPhysicalMemory
    $cpu = Get-CimInstance Win32_Processor       -Property LoadPercentage

    $ramTotal   = [math]::Round($cs.TotalPhysicalMemory / 1GB, 2)
    $ramFree    = [math]::Round(($os.FreePhysicalMemory * 1KB) / 1GB, 2)
    $ramUsedPct = if ($ramTotal -gt 0) { [math]::Round((($ramTotal - $ramFree) / $ramTotal) * 100, 1) } else { $null }
    $cpuAvg     = if ($cpu) { [math]::Round(($cpu | Measure-Object LoadPercentage -Average).Average, 1) } else { $null }
    $uptime     = $Now - $os.LastBootUpTime

    Write-Output "OS       : $($os.Caption) $($os.Version)"
    Write-Output "Uptime   : $([int]$uptime.TotalDays)d $($uptime.Hours)h $($uptime.Minutes)m"
    Write-Output "RAM      : $ramUsedPct% used | $ramFree GB free / $ramTotal GB"
    Write-Output "CPU      : $cpuAvg%"

    $Report.system.os             = "$($os.Caption) $($os.Version)"
    $Report.system.uptimeHours    = [math]::Round($uptime.TotalHours, 1)
    $Report.system.ramUsedPercent = $ramUsedPct
    $Report.system.ramFreeGB      = $ramFree
    $Report.system.ramTotalGB     = $ramTotal
    $Report.system.cpuPercent     = $cpuAvg

    if ($ramUsedPct -ge 90)     { Add-Issue "RAM rất cao: $ramUsedPct%" }
    elseif ($ramUsedPct -ge 80) { Add-Warn  "RAM cao: $ramUsedPct%" }
    else                        { Add-Good  "RAM ổn: $ramUsedPct%" }

    if ($cpuAvg -ge 90)         { Add-Issue "CPU rất cao: $cpuAvg%" }
    elseif ($cpuAvg -ge 75)     { Add-Warn  "CPU cao: $cpuAvg%" }
    else                        { Add-Good  "CPU ổn: $cpuAvg%" }
}
catch {
    Add-Warn "Không đọc đầy đủ thông tin hệ thống"
}

# Disk C
try {
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -Property FreeSpace,Size
    $freeGB  = [math]::Round($disk.FreeSpace / 1GB, 1)
    $freePct = [math]::Round(($disk.FreeSpace / $disk.Size) * 100, 1)
    Write-Output "Disk C   : $freePct% free | $freeGB GB"

    $Report.system.diskCFreeGB      = $freeGB
    $Report.system.diskCFreePercent = $freePct

    if ($freePct -lt 10)     { Add-Issue "Ổ C gần đầy: $freePct% còn trống" }
    elseif ($freePct -lt 20) { Add-Warn  "Ổ C còn ít: $freePct% còn trống" }
    else                     { Add-Good  "Ổ C dung lượng ổn: $freePct% trống" }
}
catch {
    Add-Warn "Không kiểm tra được ổ C"
}

# ===== PI NODE PROCESS =====
Section 'PI NODE PROCESS'
$processNames = @('Pi Network', 'PiNode', 'Pi Node', 'PiDesktop', 'PiDesktopApp')
$nodeProcs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $pName = $_.ProcessName
    foreach ($pn in $processNames) {
        if ($pName -like "*$pn*") { return $true }
    }
    return $false
}

$Report.nodeProcess.detected  = ($nodeProcs.Count -gt 0)
$Report.nodeProcess.processes = @()

if ($nodeProcs) {
    foreach ($p in $nodeProcs) {
        $memMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
        Write-Output "Process  : $($p.ProcessName) | PID=$($p.Id) | RAM=$memMB MB"
        $Report.nodeProcess.processes += [ordered]@{
            name = $p.ProcessName; pid = $p.Id; memoryMB = $memMB
        }
    }
    Add-Good "Đã phát hiện tiến trình Pi Node/Pi Desktop"
}
else {
    Write-Output "Process  : Pi Node/Pi Desktop không được phát hiện"
    Add-Warn "Không phát hiện tiến trình Pi Node/Pi Desktop"
}

# ===== DOCKER =====
Section 'DOCKER'
$dockerOK = $false
$dockerVersion = $null

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $verOut = docker version --format 'Client={{.Client.Version}} Server={{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $verOut) {
        $dockerOK = $true
        $dockerVersion = $verOut.Trim()
        Write-Output "Docker   : OK"
        Write-Output $dockerVersion
        Add-Good "Docker Client/Server phản hồi"
    }
}

if (-not $dockerOK) {
    Write-Output "Docker   : unavailable"
    Add-Issue "Docker không phản hồi hoặc chưa được cài đặt"
}

$Report.docker.available = $dockerOK
$Report.docker.version   = $dockerVersion
$Report.docker.running   = @()
$Report.docker.stopped   = @()

if ($dockerOK) {
    $NormalOneShot = @('pi-port-checker','portschecker','port-checker','node-port-test')

    $fmtRunning = '{{.Names}}#{{.Status}}#{{.Image}}'
    $running = @(docker ps --format $fmtRunning 2>$null)
    foreach ($line in $running) {
        if (-not $line) { continue }
        Write-Output "RUNNING  : $line"
        $parts = $line -split '#', 3
        $Report.docker.running += [ordered]@{
            name = $parts[0]; status = $parts[1]; image = $parts[2]
        }
    }

    if ($Report.docker.running.Count -eq 0) {
        Add-Issue "Không có Docker container đang chạy"
    } else {
        Add-Good "Có $($Report.docker.running.Count) Docker container đang chạy"
    }

    $fmtAll = '{{.Names}}#{{.Status}}'
    $all = @(docker ps -a --format $fmtAll 2>$null)
    foreach ($line in $all) {
        if ($line -match '#(Exited|Created|Dead|Restarting)') {
            $parts = $line -split '#', 2
            $cname = $parts[0].ToLower()
            $isOneShot = $false
            foreach ($n in $NormalOneShot) {
                if ($cname -like "*$n*") { $isOneShot = $true; break }
            }
            if ($isOneShot) {
                Write-Output "ONESHOT  : $line (bình thường)"
            } else {
                Write-Output "PROBLEM  : $line"
                $Report.docker.stopped += [ordered]@{
                    name = $parts[0]; status = $parts[1]
                }
            }
        }
    }

    if ($Report.docker.stopped.Count -gt 0) {
        Add-Warn "Có $($Report.docker.stopped.Count) container stopped/problem"
    }
}

# ===== WSL =====
Section 'WSL'
$wslLines = $null
if (Get-Command wsl -ErrorAction SilentlyContinue) {
    $wslLines = wsl --list --verbose 2>$null
}

if ($LASTEXITCODE -eq 0 -and $wslLines) {
    $Report.wsl.available = $true
    $Report.wsl.lines = $wslLines
    $wslLines | ForEach-Object { Write-Output $_ }
    Add-Good "WSL phản hồi"
}
else {
    $Report.wsl.available = $false
    Write-Output "WSL: unavailable/not detected"
    Add-Warn "Không đọc được WSL"
}

# ===== PORTS =====
Section 'PI NODE PORTS'
foreach ($port in 31401,31402,31403) {
    $open = Test-PortFast -Address '127.0.0.1' -Port $port -TimeoutMs 800
    Write-Output "Port $port : $open"
    $Report.ports += [ordered]@{ port = $port; open = $open }

    if ($open) { Add-Good "Port $port đang mở" }
    else       { Add-Warn "Port $port không mở" }
}

# ===== NETWORK =====
Section 'NETWORK'
$netOk = Test-PortFast -Address '1.1.1.1' -Port 443 -TimeoutMs 1500
$Report.network.internet443 = $netOk
Write-Output "Internet TCP/443 : $netOk"

if ($netOk) { Add-Good "Internet TCP/443 OK" }
else        { Add-Issue "Không kết nối được Internet TCP/443" }

# ===== HISTORY =====
Section 'NODE HISTORY'
$history = @()
if (Test-Path -LiteralPath $HistoryPath) {
    try {
        $raw = Get-Content -LiteralPath $HistoryPath -Raw -Encoding UTF8
        $obj = $raw | ConvertFrom-Json
        $history = if ($obj -is [array]) { @($obj) } else { @($obj) }

        Write-Output "File     : $HistoryPath"
        Write-Output "Records  : $($history.Count)"

        $Report.history.file    = $HistoryPath
        $Report.history.records = $history.Count

        if ($history.Count -gt 0) {
            $last = $history[-1]
            Write-Output "Latest   :"
            Write-Output ($last | ConvertTo-Json -Depth 6 -Compress)

            $temps = Get-MetricValues $history @('Temperature','Temp','temperature','temp')
            $rams  = Get-MetricValues $history @('RAM','Ram','ram','MemoryPercent','Memory')
            $cpus  = Get-MetricValues $history @('CPU','Cpu','cpu','CPUPercent')

            $Report.history.metrics = [ordered]@{}

            foreach ($item in @(
                @{Key='temperature'; Name='Temperature'; Values=$temps},
                @{Key='ram';         Name='RAM';         Values=$rams},
                @{Key='cpu';         Name='CPU';         Values=$cpus}
            )) {
                $s = Stats $item.Values
                if ($s) {
                    $Report.history.metrics[$item.Key] = $s
                    Write-Output "$($item.Name): min=$($s.Min) max=$($s.Max) avg=$($s.Average) median=$($s.Median) n=$($s.Count)"
                }
            }

            $dated = $history | Where-Object { $null -ne (Get-TimeValue $_) }
            if ($dated) {
                $cut = $Now.AddDays(-7)
                $recent = $dated | Where-Object { (Get-TimeValue $_) -ge $cut }
                $Report.history.recent7dRecords = $recent.Count
                Write-Output "Recent 7d records: $($recent.Count)"

                if ($recent) {
                    $recentTemps = Get-MetricValues $recent @('Temperature','Temp','temperature','temp')
                    if ($recentTemps) {
                        $s7 = Stats $recentTemps
                        $Report.history.recent7dTemperature = $s7
                        Write-Output "Recent 7d temperature: min=$($s7.Min) max=$($s7.Max) avg=$($s7.Average) median=$($s7.Median)"
                    }
                }
            }

            Add-Good "Đọc được node_history.json: $($history.Count) record"
        }
        else {
            Add-Warn "node_history.json tồn tại nhưng không có record"
        }
    }
    catch {
        Write-Output "History error: $($_.Exception.Message)"
        Add-Warn "Không đọc được node_history.json"
    }
}
else {
    Write-Output "No node_history.json"
    Add-Warn "Chưa có node_history.json"
}

# ===== SUMMARY =====
Section 'SMART DIAGNOSTIC SUMMARY'

$score = 100 - ($Issues.Count * 25) - ($Warnings.Count * 8)
if ($score -lt 0) { $score = 0 }

$result = if ($Issues.Count -eq 0 -and $Warnings.Count -eq 0) { 'HEALTHY' }
          elseif ($Issues.Count -eq 0) { 'HEALTHY_WITH_WARNINGS' }
          else { 'NEEDS_ATTENTION' }

$Report.score    = $score
$Report.result   = $result
$Report.good     = $Good.ToArray()
$Report.warnings = $Warnings.ToArray()
$Report.issues   = $Issues.ToArray()

Write-Output "Score    : $score/100"
Write-Output "Result   : $result"
Write-Output ""
Write-Output "OK       : $($Good.Count)"
$Good | ForEach-Object { Write-Output "  [OK] $_" }
Write-Output ""
Write-Output "WARNING  : $($Warnings.Count)"
$Warnings | ForEach-Object { Write-Output "  [WARN] $_" }
Write-Output ""
Write-Output "ISSUES   : $($Issues.Count)"
$Issues | ForEach-Object { Write-Output "  [ERROR] $_" }

# Save JSON Report
try {
    $Report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $JsonPath -Encoding UTF8
    Write-Output ""
    Write-Output "JSON     : $JsonPath"
}
catch {
    Write-Output "JSON     : failed to write"
}

Write-Output ""
Write-Output "=============================================="
Write-Output " AI_READY: diagnostic_latest.json created"
Write-Output " Diagnostic completed - READ ONLY"
Write-Output " No system changes were made."
Write-Output "=============================================="

switch ($result) {
    'HEALTHY'               { exit 0 }
    'HEALTHY_WITH_WARNINGS' { exit 1 }
    default                 { exit 2 }
}
