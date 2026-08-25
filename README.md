# SoloHost v2.6.4

- AI uses **HISTORY_24H** aggregates + recent samples (technician-style)
- getUpdates **conflict** handling: backoff + deleteWebhook(drop_pending)
- Only **one** bot instance may use the same BOT_TOKEN (stop old SoloHost / Windows bot if shared)

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.4`
