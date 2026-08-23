# Pi Node Telegram Controller — SoloHost PRO v2.4.0

Giám sát Pi Node 24/7 trên SoloHost / Pi Desktop qua Telegram.

## Điểm mới v2.4

- **Không docker.sock** → hết lỗi SoloHost bind-mount
- Đọc dữ liệu **HTTP đa nguồn** (`/info` + cổng 31401–3), chống báo OFFLINE giả
- **`/status` ngắn gọn** — đúng nhu cầu người dùng thường
- Cảnh báo **thông minh** (chỉ khi thật sự cần)
- **Lịch sử dài hạn** `/data/history/YYYY-MM-DD.jsonl`
- **`/analyze`** phân tích lịch sử (+ Gemini AI tùy chọn)
- **Log** `/data/logs/controller.log`
- **Donate** số tài khoản MB Bank (không chỉ link)
- Script Windows: CleanRAM / Maintenance / Reset-PiNode (tải về tự chạy)

## Image

```bash
docker pull ghcr.io/cannoi/pinode-telegram-solohost:v2.4.0
```

## Cài SoloHost

Dùng `docker-compose.yml` + `config_options.yml` trong repo.

## Lệnh Telegram

| Lệnh | Ý nghĩa |
|------|---------|
| `/status` | Trạng thái ngắn |
| `/sync` | Đồng bộ |
| `/ports` | Cổng node |
| `/diagnostic` | Kiểm tra sâu |
| `/analyze` | Phân tích lịch sử / AI |
| `/scripts` | Script bảo trì Windows |
| `/donate` | Ủng hộ MB Bank |

## Windows PRO

https://github.com/cannoi/pinode-telegram-controller
