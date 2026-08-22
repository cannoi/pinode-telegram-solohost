# Pi Node Telegram Controller — SoloHost Edition PRO

Giám sát & điều khiển **Pi Node** 24/7 ngay trên **SoloHost / Pi Desktop**, cảnh báo + điều khiển qua **Telegram**, giao diện web nội bộ.

Bản này mang **tối đa** các chức năng của [Pi Node Telegram Controller PRO (Windows)](https://github.com/cannoi/pinode-telegram-controller) vào môi trường container SoloHost.

| Nhóm tính năng | SoloHost Edition PRO | Bản Windows PRO |
|----------------|----------------------|-----------------|
| Giám sát cổng 31401–3 | ✅ | ✅ |
| CPU / RAM / Uptime | ✅ (trong container + Docker info) | ✅ host |
| Trạng thái Docker node | ✅ (nếu mount sock) | ✅ |
| Cảnh báo Soft / Warning / Critical | ✅ | ✅ |
| Auto-alert khi offline/online | ✅ | ✅ |
| Báo cáo định kỳ (scheduler) | ✅ | ✅ |
| Lệnh Telegram tiếng Việt | ✅ | ✅ |
| /reset node (docker restart) | ✅ khi có sock | ✅ |
| /docker /logs /disk | ✅ | ✅ |
| Lịch sử sự cố | ✅ | ✅ |
| Web UI trong Pi Desktop | ✅ | — |
| CleanRAM / screenshot PiCheck / OHM nhiệt độ | ❌ (Windows-only) | ✅ |
| AI Gemini chẩn đoán sâu | ❌ (có thể thêm key sau) | ✅ |

> Tính năng Windows-only (CleanRAM, screenshot cửa sổ, OpenHardwareMonitor…) **không** đưa vào container vì phụ thuộc host Windows và quyền cao. Link bản đầy đủ Windows luôn hiển thị trong bot & UI.

---

## Cài đặt nhanh trên SoloHost / Pi Desktop

### Cách 1 — Cài từ image công khai (khuyến nghị)

1. Đưa repo này lên GitHub của bạn.
2. GitHub Actions tự build → image `ghcr.io/<user>/pinode-telegram-solohost:latest`.
3. Trên Pi Desktop → SoloHost → thêm app (hoặc dùng `docker-compose.yml`).
4. Điền form:
   - **Telegram Bot Token** (từ [@BotFather](https://t.me/BotFather))
   - **Chat ID** (từ [@userinfobot](https://t.me/userinfobot) hoặc nhóm)
5. Mở giao diện app hoặc gửi `/status` trên Telegram.

### Cách 2 — Chạy local bằng Docker

```bash
git clone <repo-của-bạn>
cd pinode-telegram-solohost

# Tạo .env
cat > .env << EOF
BOT_TOKEN=123456:ABC-DEF...
CHAT_ID=123456789
ALERT_ON_START=true
REPORT_HOURS=7,19
EOF

# Không mount docker.sock (an toàn)
docker compose up -d

# Hoặc có docker.sock (máy tin cậy, được reset node)
# Bỏ comment dòng sock trong docker-compose.yml rồi:
docker compose up -d
```

Mở http://127.0.0.1:18780

### Cách 3 — Build image thủ công

```bash
docker build -t pinode-telegram-solohost:local .
docker run -d --name PiNode-TG \
  -p 127.0.0.1:18780:8080 \
  -e BOT_TOKEN=... -e CHAT_ID=... \
  -v $(pwd)/data:/data \
  --add-host=host.docker.internal:host-gateway \
  pinode-telegram-solohost:local
```

---

## Lệnh Telegram

| Lệnh | Mô tả |
|------|--------|
| `/start` `/help` | Trợ giúp + link bản Windows PRO |
| `/status` `/s` | Trạng thái đầy đủ |
| `/monitor` `/m` | Quét nhanh + mức cảnh báo |
| `/ports` | Cổng 31401–3 |
| `/docker` | Trạng thái container node |
| `/disk` | Dung lượng ổ trong container |
| `/logs` | Log gần nhất của container node (cần sock) |
| `/reset` | Restart container node (cần sock + xác nhận) |
| `/report` | Báo cáo tổng hợp ngay |
| `/history` | Lịch sử sự cố gần đây |
| `/ping` | Kiểm tra bot còn sống |
| Chat tự nhiên | “node thế nào”, “cổng mở chưa”, “reset giúp”… |

---

## Bảo mật

- Mặc định **không** mount `/var/run/docker.sock`.
- Chỉ trả lời đúng `CHAT_ID` đã cấu hình.
- Token lưu trong volume `/data`, không nằm trong image.
- Lệnh `/reset` yêu cầu xác nhận trong 60 giây.

---

## Cấu trúc

```
├── Dockerfile
├── docker-compose.yml
├── config_options.yml      # form Pi Desktop
├── app.js                  # core PRO
├── loader.js
├── public/index.html       # web UI
├── .github/workflows/docker-publish.yml
└── README.md
```

## Phiên bản

**v2.0.0-solohost-pro** — tối đa hóa tính năng PRO vào SoloHost.
