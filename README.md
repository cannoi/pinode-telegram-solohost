# Pi Node Telegram Controller SoloHost PRO v2.4.2

## Nguồn dữ liệu (theo diagnostic máy thật)

| Tầng | Nguồn | Ghi chú |
|------|--------|---------|
| 1 | **Horizon :31401** (`8000` trong container) | PRIMARY — ledger, network |
| 2 | Core HTTP 11626/info | Chỉ khi publish ra host hoặc docker exec |
| 3 | Cổng 31401–31403 | OPEN/CLOSED — không suy ra Synced |
| 4 | docker.sock | TÙY CHỌN — SoloHost mặc định không mount |

**Quan trọng (diagnostic):** Core 11626 **không** publish ra Windows host.  
Controller SoloHost lấy ledger qua Horizon 31401.

## Tin nhắn

Đúng mẫu icon: Đồng bộ · Ledger · Peer · Docker · Cổng · Container · RAM/CPU · lời nhận xét.

## Image

`ghcr.io/cannoi/pinode-telegram-solohost:v2.4.2`
