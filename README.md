# SoloHost v2.6.24

After **Agree** (Telegram or http://127.0.0.1:18780/docker):
- Writes ready `data/docker-enable/docker-compose.yml` (+ APPLY scripts)
- If `./:/solohost-config` mounted, fills host `docker-compose.yml` (consent only)
- User Restarts SoloHost app

Default install: still no docker.sock.

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.24`
