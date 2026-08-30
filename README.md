# SoloHost v2.6.20

1. Install (no sock in package — validation OK)
2. First start: overwrites `docker-compose.yml` with docker.sock
3. Best-effort **auto recreate** (`docker compose up --force-recreate` / `docker restart`) when engine reachable
4. If sock still missing: Telegram hint + `APPLY_DOCKER_SOCK.bat` in app folder

`AUTO_DOCKER_SOCK=0` to disable
