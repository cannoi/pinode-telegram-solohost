# Pi Node SoloHost v2.6.13 — Fast Core-first Reader

Production-ready Docker/ GHCR package for SoloHost.

## Data reading architecture

- **Core `/info` is authoritative** for sync and ledger.
- Core endpoint discovery runs in parallel and the successful endpoint is cached.
- Core `/peers` is supplementary and never prevents `/info` from returning.
- Ports `31401/31402/31403` are probed in parallel.
- Horizon is a fallback/supplementary source and refreshes every 300 seconds by default.
- Telemetry is cached in memory; UI/API reads do not start a full scan when the cache is fresh.
- No `docker.sock` mount and no Windows DataLive dependency.

## Build locally

```bash
docker build -t ghcr.io/cannoi/pinode-telegram-solohost:v2.6.13 .
```

## Push to GHCR

The included GitHub Actions workflow publishes automatically:

- `latest` on pushes to `main`
- `vX.Y.Z` when a matching Git tag is pushed
- immutable `sha-...` tags for traceability

Create a release tag with:

```bash
git tag v2.6.13
git push origin v2.6.13
```

## SoloHost

The included `docker-compose.yml` uses:

`ghcr.io/cannoi/pinode-telegram-solohost:v2.6.13`

Default local UI/API binding:

`127.0.0.1:18780 -> 8080`

Telemetry interval: `60s`

Horizon refresh interval: `300s`

## Required configuration

`config_options.yml` exposes:

- `BOT_TOKEN` — Telegram bot token
- `CHAT_ID` — Telegram chat ID
- `GEMINI_API_KEY` — optional AI key
