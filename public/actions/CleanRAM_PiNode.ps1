# Pi Node CleanRAM - full (tu bat CleanRAM_PiNode)
param()
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$fromController = ($env:PINODE_CONTROLLER -eq '1')
$isAdmin = $false
try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  $isAdmin = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}

Write-Output "==== Pi Node CleanRAM ===="
Write-Output "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') admin=$isAdmin controller=$fromController"

# Tat app rac (KHONG dung Pi Network / Docker / PiCheck)
$kill = @('chrome','msedge','SearchApp','SearchIndexer','TabTip','TextInputHost','RuntimeBroker','OneDrive','Copilot','ApplicationFrameHost')
foreach ($n in $kill) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($isAdmin) {
  foreach ($svc in @('Spooler','DiagTrack','dmwappushservice','SysMain','wuauserv','BITS')) {
    try {
      if ($svc -in @('DiagTrack','dmwappushservice')) {
        & sc.exe config $svc start= disabled 2>$null | Out-Null
      }
      Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
    } catch {}
  }
}

# Temp user
Get-ChildItem -Path $env:TEMP -Force -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
if ($isAdmin) {
  $wt = Join-Path $env:SystemRoot 'Temp'
  Get-ChildItem -Path $wt -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
  try { defrag C: /O /H 2>$null | Out-Null } catch {}
}

cmd /c "ipconfig /flushdns" >$null 2>&1

# Restart Explorer chi khi KHONG goi tu Controller
if (-not $fromController) {
  Get-Process -Name explorer -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-Process explorer.exe
}

Write-Output "[OK] CleanRAM completed. Pi Node/Docker an toan."
exit 0
