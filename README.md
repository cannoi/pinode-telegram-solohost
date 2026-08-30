# SoloHost v2.6.17

Optimized status (from live Horizon analysis):
- Primary: single GET Horizon `/` (~150–200ms) — ledger, versions, protocol, network
- Optional: `/ledgers?limit=1` for tx/fee/precise age
- Core + ports still probed in parallel when available
- Full field set fed to Telegram formatters + AI `buildFacts`

Endpoints: `/api/status` `/api/status/fast` `/api/status/detailed`

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.17`
