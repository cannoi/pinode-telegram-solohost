DataLive v2.5.1 - Read-only HTTP API for SoloHost Controller

1. Run Windows PRO MonitorLive service (writes latest.json every ~60s)
2. Double-click Start-DataLive.bat
3. Test:  curl http://127.0.0.1:18790/v1/status
4. SoloHost Controller uses: http://host.docker.internal:18790

Optional token:
  set DATA_LIVE_TOKEN=your_secret
  then set same token in SoloHost env DATA_LIVE_TOKEN

If Latest path is empty:
  - Find latest.json under Data\PiNodeMonitorLive\
  - Or: powershell -File DataLive_HttpApi.ps1 -LatestPath "C:\full\path\to\latest.json"
