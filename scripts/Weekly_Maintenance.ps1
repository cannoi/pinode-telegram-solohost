# Pi Node Weekly Maintenance v13.2 - PowerShell full
param()
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) { $ScriptDir = $PWD.Path }
$fromController = ($env:PINODE_CONTROLLER -eq '1')
$logFile = Join-Path $ScriptDir 'pinode_safe_maintenance.log'
$sendTele = Join-Path $ScriptDir 'send_tele.ps1'
$monthlyStatus = 'Chua den lich'

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

Set-Content -Path $logFile -Value "==== $(Get-Date) admin=$isAdmin controller=$fromController ====" -Encoding UTF8
WL "Weekly Maintenance start"

WL "[1/10] Dong bo thoi gian"
cmd /c "w32tm /resync" >$null 2>&1

WL "[2/10] Tat app rac"
foreach ($n in @('chrome','msedge','OneDrive','Copilot','SearchApp','SearchIndexer','TabTip','TextInputHost','RuntimeBroker','ApplicationFrameHost')) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
if ($isAdmin) { try { Stop-Service Spooler -Force -ErrorAction SilentlyContinue } catch {} }

WL "[3/10] Xoa Temp"
Get-ChildItem -Path $env:TEMP -Force -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
if ($isAdmin) {
  $wt = Join-Path $env:SystemRoot 'Temp'
  Get-ChildItem -Path $wt -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}

WL "[4/10] Cache + Docker volume"
if ($isAdmin) {
  $paths = @(
    "$env:LOCALAPPDATA\Microsoft\Windows\WER\ReportArchive",
    "C:\ProgramData\Microsoft\Windows\WER\ReportArchive",
    "$env:LOCALAPPDATA\D3DSCache"
  )
  foreach ($p in $paths) {
    if (Test-Path $p) { Get-ChildItem $p -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
cmd /c "docker volume prune -f" >$null 2>&1

WL "[5/10] Thung rac"
if ($isAdmin) { try { Clear-RecycleBin -Force -ErrorAction SilentlyContinue } catch {} }

WL "[6/10] Docker image prune"
cmd /c "docker image prune -f" >$null 2>&1

WL "[7/10] DNS"
cmd /c "ipconfig /flushdns" >$null 2>&1
if (-not $fromController) {
  Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
  Start-Process explorer.exe
}

WL "[8/10] Anti-sleep"
if ($isAdmin) {
  foreach ($x in @('monitor-timeout-ac','disk-timeout-ac','standby-timeout-ac','hibernate-timeout-ac')) {
    cmd /c "powercfg /change $x 0" >$null 2>&1
  }
}

WL "[9/10] Docker priority + TRIM"
try {
  Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue | ForEach-Object { $_.PriorityClass = 'AboveNormal' }
} catch {}
$cpu = 0
try { $cpu = [int]((Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average) } catch {}
if ($isAdmin -and $cpu -lt 75) {
  try { defrag C: /O /H 2>$null | Out-Null; WL "TRIM OK" } catch {}
} else { WL "Bo qua TRIM (cpu=$cpu admin=$isAdmin)" }

WL "[10/10] SFC/DISM dau thang"
$day = (Get-Date).Day
$dow = [int](Get-Date).DayOfWeek
$freeGB = 0
try { $freeGB = [int][math]::Round((Get-PSDrive C).Free/1GB,0) } catch {}
if ($isAdmin -and $day -le 7 -and $dow -eq 0 -and $freeGB -ge 15) {
  $monthlyStatus = 'Da quet SFC/DISM'
  cmd /c "dism /online /cleanup-image /startcomponentcleanup /quiet" >$null 2>&1
  cmd /c "sfc /scannow" >$null 2>&1
  WL "Monthly SFC/DISM done"
} else { WL "Monthly skip day=$day dow=$dow free=$freeGB" }

$dockerStatus = if (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue) { '[RUNNING]' } else { '[STOPPED]' }
$piStatus = if (Get-Process 'Pi Network' -ErrorAction SilentlyContinue) { '[RUNNING]' } else { '[STOPPED]' }
WL "Done Docker=$dockerStatus Pi=$piStatus"

if (Test-Path $sendTele) {
  try {
    $ts = Get-Date -Format 'dd/MM/yyyy HH:mm:ss'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sendTele -DockerStatus $dockerStatus -PiStatus $piStatus -MonthlyStatus $monthlyStatus -TimeStr $ts
  } catch { WL "send_tele: $($_.Exception.Message)" }
}

WL "[OK] Weekly Maintenance completed."
exit 0
