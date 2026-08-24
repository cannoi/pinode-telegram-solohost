# Pi Node Telegram Controller — SoloHost Bridge v2.5.0

Architecture per approved spec: **Windows Data Live (sensor)** + **SoloHost Controller (brain)** + **Telegram (UI)**.

## What was changed vs Windows PRO

| Component | Change |
|-----------|--------|
| PiNodeMonitorLive_Service.ps1 | **Unchanged** — still writes `latest.json` |
| Smart_Pipeline.ps1 | **Unchanged** on Windows PRO |
| DataLive_HttpApi.ps1 | **NEW** — read-only HTTP over `latest.json` |
| SoloHost app.js | **NEW adapter** — does not replace Windows Controller |
| docker.sock | **Not mounted** in SoloHost package |

## Windows setup (Data Live)

1. Run MonitorLive service as usual (60s telemetry).
2. Run `DataLive/Start-DataLive.bat` → `http://127.0.0.1:18790`
3. Test: `curl http://127.0.0.1:18790/v1/status`

Optional token: set env `DATA_LIVE_TOKEN`.

## SoloHost setup

Install package with `SoloHost/docker-compose.yml` + `config_options.yml` (BOT_TOKEN + CHAT_ID only).

Env defaults:
- `DATA_LIVE_URL=http://host.docker.internal:18790`
- `TELEMETRY_SEC=60`
- Telegram uses **long polling** (independent of 60s)

## Polling separation

- **Telegram:** long poll ~25s timeout (responsive)
- **Node telemetry:** 60s loop only
- Commands read **cache** — do not wait for full scan

## Fallback

Data Live → Horizon :31401 → Port probe  

**Data Live offline ≠ Node offline**

## Scripts

Download from Web UI; run on Windows as Admin. No remote action in Phase 1.

## Image

`ghcr.io/cannoi/pinode-telegram-solohost:v2.5.0`
