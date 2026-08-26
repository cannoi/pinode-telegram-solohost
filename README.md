# SoloHost v2.6.10

## Donate
Exact VietQR image: `public/donate-qr.jpg` (MB 0905428801 · TRAN HUU NGHI)
`/donate` sends text + QR + random thank-you.

## Security (community baseline)
- Port bound to `127.0.0.1:18780` only
- CHAT_ID whitelist for Telegram
- Secrets redacted in logs
- Rate limit on `/api/chat` and `/api/status`
- `/api/logs` local-only + redacted
- Path traversal blocked on static files
- `no-new-privileges` in compose
- No docker.sock

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.10`
