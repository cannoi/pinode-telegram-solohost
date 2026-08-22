# Pi Node Telegram Controller — SoloHost Edition PRO v2.3.0

Giám sát & điều khiển **Pi Node** 24/7 trên **SoloHost / Pi Desktop**, cảnh báo qua **Telegram**.

## Cải tiến v2.3.0

- **Tự dò container** Pi Node (testnet2 / mainnet / pi-node-docker) bằng hệ thống chấm điểm
- **Không bắt buộc** nhập tên container (`PI_CONTAINER` chỉ là override tùy chọn)
- Lấy **stellar-core info** chi tiết: Sync, Ledger, Ledger Age, Peers, Quorum, Network
- Chỉ hiển thị field hữu ích (bỏ baseReserve, hash, cost…)
- Parser Docker stream chắc chắn hơn
- Mount Docker socket **read-only**

## Image

```bash
docker pull ghcr.io/cannoi/pinode-telegram-solohost:v2.3.0
```

## Cài SoloHost

Dùng `docker-compose.yml` + `config_options.yml` trong repo.

**Bắt buộc:** volume Docker socket read-only:

```yaml
- /var/run/docker.sock:/var/run/docker.sock:ro
```

## Bản Windows PRO

https://github.com/cannoi/pinode-telegram-controller
