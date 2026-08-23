# Pi Node Telegram Controller — SoloHost PRO v2.4.1

## Fix v2.4.1

- Khôi phục đọc **stellar-core qua docker.sock** khi socket có sẵn (như v2.3)
- Compose **SoloHost mặc định không mount sock** (hết lỗi bind-mount)
- HTTP `/info` thử nhiều cổng: 11626, 31400, 31401–3…
- 3 cổng node mở đủ → coi **ONLINE ổn định** (không báo “Cần theo dõi” chỉ vì thiếu /info)

## Image

```bash
docker pull ghcr.io/cannoi/pinode-telegram-solohost:v2.4.1
```

## SoloHost

Dùng `docker-compose.yml` (không sock).

Muốn sync đầy đủ như v2.3 trên máy tự quản lý Docker: xem `docker-compose.with-sock.yml`.

## Lệnh

`/status` `/sync` `/ports` `/diagnostic` `/analyze` `/scripts` `/donate`
