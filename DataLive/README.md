# Data Live (Windows) — Read-Only API for SoloHost

## Role
- Does **not** replace `PiNodeMonitorLive_Service.ps1`
- Reads `Data/PiNodeMonitorLive/latest.json` written by MonitorLive every ~60s
- Exposes normalized schema on `http://127.0.0.1:18790`

## Setup
1. Run Windows PRO MonitorLive service as usual (`Run-PiNodeMonitorLive_Service.bat`)
2. Run `Start-DataLive.bat` (keep window open) or register as scheduled task
3. Test:
   ```
   curl http://127.0.0.1:18790/v1/health
   curl http://127.0.0.1:18790/v1/status
   ```

## Security
- Binds **127.0.0.1 only** (not Internet)
- Optional: set env `DATA_LIVE_TOKEN` then send header `Authorization: Bearer <token>`

## SoloHost
Controller uses:
```
DATA_LIVE_URL=http://host.docker.internal:18790
DATA_LIVE_TOKEN=...
```

## Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/health | Service + age |
| GET | /v1/status | Normalized telemetry |

No POST /restart in Phase 1.
