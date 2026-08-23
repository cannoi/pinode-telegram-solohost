# Pi Node Telegram Controller — SoloHost Edition PRO v2.3.0

## Cải tiến so với v2.2

| v2.2 | v2.3 |
|------|------|
| Tìm container theo regex đơn giản | **Chấm điểm** tự chọn testnet2 / mainnet / pi-node-docker |
| Chỉ biết synced / catching | **stellar-core info**: state, ledger, age, peers, quorum, network |
| Docker stream decode cơ bản | **decodeDockerStream** frame 8-byte chắc hơn |
| PI_CONTAINER bắt buộc nếu nhiều node | **Tùy chọn** — để trống = tự dò |
| Socket không bắt buộc | **Khuyến nghị mount docker.sock:ro** để đọc đồng bộ thật |

## Image

```bash
docker pull ghcr.io/cannoi/pinode-telegram-solohost:v2.3.0
```

## SoloHost

Dùng `docker-compose.yml` + `config_options.yml`.

Bắt buộc volume (để đọc đồng bộ):

```yaml
- /var/run/docker.sock:/var/run/docker.sock:ro
```

## Windows PRO

https://github.com/cannoi/pinode-telegram-controller
