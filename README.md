# SoloHost v2.6.13 — Fast Core-first data reader

- Core `/info` is authoritative for sync and ledger.
- Core endpoint discovery is parallel and cached after the first successful read.
- `/info` and `/peers` reuse the same Core endpoint; peers never block Core status.
- Port probes run in parallel and reuse the last successful host.
- Horizon is supplementary and refreshed every 5 minutes by default; it is queried immediately when Core is unavailable.
- Telegram/UI reads use the in-memory telemetry cache and do not trigger a full scan while fresh.
- No `docker.sock` and no Windows DataLive dependency.

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.13`
