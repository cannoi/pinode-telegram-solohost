# Pi Node Telegram Controller SoloHost v2.5.3

## AI (same principles as Windows PRO)
1. Rules engine first (intent + evidence)
2. Gemini only for deep analysis when GEMINI_API_KEY set
3. Never invent missing metrics
4. Not called every 60s telemetry tick

## Build image
docker build -t ghcr.io/cannoi/pinode-telegram-solohost:v2.5.3 .
docker push ghcr.io/cannoi/pinode-telegram-solohost:v2.5.3

## Data Live (Windows host)
Download from Web UI /scripts/ or use Start-DataLive.bat after MonitorLive is running.
