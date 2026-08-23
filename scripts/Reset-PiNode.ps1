# Reset-PiNode.ps1 — Restart container Pi Node (cần Docker CLI)
# Mặc định: testnet2 — đổi tên nếu máy bạn khác
param(
  [string]$Container = "testnet2"
)

Write-Host "=== Reset Pi Node: $Container ===" -ForegroundColor Cyan
try {
  $id = docker ps -aq -f "name=^/${Container}$" 2>$null
  if (-not $id) {
    Write-Host "Không thấy container '$Container'." -ForegroundColor Yellow
    Write-Host "Danh sách container đang chạy:"
    docker ps --format "table {{.Names}}\t{{.Status}}"
    exit 1
  }
  Write-Host "Đang restart $Container ..."
  docker restart $Container
  Start-Sleep -Seconds 5
  docker ps -f "name=^/${Container}$" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
  Write-Host "Xong." -ForegroundColor Green
} catch {
  Write-Host "Lỗi: $_" -ForegroundColor Red
  Write-Host "Cần Docker Desktop / docker CLI và quyền đủ."
}
