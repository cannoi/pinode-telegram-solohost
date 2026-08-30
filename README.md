# SoloHost v2.6.18

Data sources (max):
1. Horizon root `/` (optimized, primary)
2. Horizon `/ledgers` (detailed)
3. Core HTTP host ports
4. TCP 31401–31403
5. **Docker socket API** (optional — if `/var/run/docker.sock` mounted)
6. **docker exec** into Pi Node container → Core `/info`, `/peers`, Horizon inside
7. State file fallback

SoloHost default compose: **no sock** (platform restriction).
Optional: `docker-compose.with-docker.yml` mounts sock (`DOCKER_PROBE=1`).

Env: `DOCKER_PROBE=auto|1|0`
