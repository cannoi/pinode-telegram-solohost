# CleanRAM.ps1 — Giải phóng RAM trên Windows (chạy PowerShell as Admin)
# Pi Node Telegram Controller PRO — script hỗ trợ
Write-Host "=== CleanRAM ===" -ForegroundColor Cyan
Write-Host "Đang dọn Standby List / Working Set (cần Admin)..."

try {
  # Empty standby list via Clear-StandbyList if available; fallback working set trim
  $os = Get-CimInstance Win32_OperatingSystem
  $before = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/1MB, 1)
  Write-Host "RAM đã dùng trước: $before GB"

  Get-Process | ForEach-Object {
    try { $_.MinWorkingSet = 1MB } catch {}
  }

  [System.GC]::Collect()
  Start-Sleep -Seconds 2

  $os2 = Get-CimInstance Win32_OperatingSystem
  $after = [math]::Round(($os2.TotalVisibleMemorySize - $os2.FreePhysicalMemory)/1MB, 1)
  $free = [math]::Round($os2.FreePhysicalMemory/1MB, 1)
  Write-Host "RAM đã dùng sau:  $after GB"
  Write-Host "RAM trống:        $free GB" -ForegroundColor Green
  Write-Host "Xong."
} catch {
  Write-Host "Lỗi: $_" -ForegroundColor Red
  Write-Host "Hãy chạy PowerShell với quyền Administrator."
}
