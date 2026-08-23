# Maintenance.ps1 — Bảo trì nhẹ máy chạy Pi Node (PowerShell as Admin)
Write-Host "=== Maintenance ===" -ForegroundColor Cyan

Write-Host "`n[1] Dọn file tạm user..."
$temp = $env:TEMP
Get-ChildItem $temp -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-3) } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "  Đã dọn TEMP cũ hơn 3 ngày."

Write-Host "`n[2] Disk space:"
Get-PSDrive -PSProvider FileSystem | ForEach-Object {
  if ($_.Used -ne $null) {
    $freeGB = [math]::Round($_.Free/1GB, 1)
    $usedGB = [math]::Round($_.Used/1GB, 1)
    Write-Host ("  {0}: dùng {1} GB · trống {2} GB" -f $_.Name, $usedGB, $freeGB)
  }
}

Write-Host "`n[3] Docker containers (nếu có):"
try {
  docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>$null
} catch {
  Write-Host "  Không gọi được docker CLI."
}

Write-Host "`nXong bảo trì." -ForegroundColor Green
