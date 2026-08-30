# SoloHost v2.6.13

Multi-source status (network-agnostic):
1. Horizon HTTP (31401/8000)
2. Core HTTP (11626/11826/31400…) — authoritative sync when available
3. Local state file fallback
4. TCP ports 31401–31403

No dependency on container name (testnet2/mainnet).

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.13`
