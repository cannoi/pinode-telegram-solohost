# Pi Node Weekly Maintenance - PowerShell
param()
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) { $ScriptDir = $PWD.Path }
$fromController = ($env:PINODE_CONTROLLER -eq '1')
$logFile = Join-Path $ScriptDir 'pinode_safe_maintenance.log'
$sendTele = Join-Path $ScriptDir 'send_tele.ps1'
$monthlyStatus = 'Not due'

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

WL "[1/10] Sync time"
cmd /c "w32tm /resync" >$null 2>&1

WL "[2/10] Close extra apps"
foreach ($n in @('chrome','msedge','OneDrive','Copilot','SearchApp','SearchIndexer','TabTip','TextInputHost','RuntimeBroker','ApplicationFrameHost')) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
if ($isAdmin) { try { Stop-Service Spooler -Force -ErrorAction SilentlyContinue } catch {} }

WL "[3/10] Clean Temp"
Get-ChildItem -Path $env:TEMP -Force -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
if ($isAdmin) {
  $wt = Join-Path $env:SystemRoot 'Temp'
  Get-ChildItem -Path $wt -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}

WL "[4/10] Cache + Docker volume prune"
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

WL "[5/10] Recycle Bin"
if ($isAdmin) {
  try { Clear-RecycleBin -Force -ErrorAction SilentlyContinue } catch {}
  cmd /c "rd /s /q $env:SystemDrive\`$Recycle.Bin" >$null 2>&1
}

WL "[6/10] Docker image prune (not -a)"
cmd /c "docker image prune -f" >$null 2>&1

WL "[7/10] Flush DNS"
cmd /c "ipconfig /flushdns" >$null 2>&1
if (-not $fromController) {
  Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
  Start-Process explorer.exe
}

WL "[8/10] Anti-sleep on AC"
if ($isAdmin) {
  foreach ($x in @('monitor-timeout-ac','disk-timeout-ac','standby-timeout-ac','hibernate-timeout-ac')) {
    cmd /c "powercfg /change $x 0" >$null 2>&1
  }
}

WL "[9/10] Docker priority + TRIM"
try {
  Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue | ForEach-Object { $_.PriorityClass = 'AboveNormal' }
} catch {}
try { cmd /c "wmic process where name=`"Docker Desktop.exe`" CALL setpriority `"above normal`"" >$null 2>&1 } catch {}
$cpu = 100
try { $cpu = [int]((Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average) } catch {}
if ($isAdmin -and $cpu -lt 75) {
  try { & defrag.exe $env:SystemDrive /O /H 2>$null | Out-Null; WL "TRIM OK" } catch {}
} else { WL "Skip TRIM (cpu=$cpu admin=$isAdmin)" }

WL "[10/10] Monthly SFC/DISM first Sunday"
$day = (Get-Date).Day
$dow = [int](Get-Date).DayOfWeek
$freeGB = 0
try { $freeGB = [int][math]::Round((Get-PSDrive C).Free/1GB,0) } catch {}
if ($isAdmin -and $day -le 7 -and $dow -eq 0 -and $freeGB -ge 15) {
  $monthlyStatus = 'SFC/DISM ran'
  cmd /c "dism /online /cleanup-image /startcomponentcleanup /quiet" >$null 2>&1
  cmd /c "sfc /scannow" >$null 2>&1
  WL "Monthly SFC/DISM done"
} else { WL "Monthly skip day=$day dow=$dow free=$freeGB" }

$dockerStatus = if (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue) { 'RUNNING' } else { 'STOPPED' }
$piStatus = if (Get-Process 'Pi Network' -ErrorAction SilentlyContinue) { 'RUNNING' } else { 'STOPPED' }
WL "Done Docker=$dockerStatus Pi=$piStatus Monthly=$monthlyStatus"

if (Test-Path $sendTele) {
  try {
    $ts = Get-Date -Format 'dd/MM/yyyy HH:mm:ss'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sendTele -DockerStatus $dockerStatus -PiStatus $piStatus -MonthlyStatus $monthlyStatus -TimeStr $ts
  } catch { WL "send_tele: $($_.Exception.Message)" }
}

WL "[OK] Weekly Maintenance completed."
exit 0
