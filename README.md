# SoloHost v2.6.19 — Auto docker.sock compose

## How it works
1. **Install** package: compose has NO `/var/run/docker.sock` (SoloHost validation OK).
2. Mounts `./:/solohost-config:rw` (path inside install dir — allowed).
3. On **first container start**, `loader.js` → `auto-compose.js` overwrites host `docker-compose.yml` to add docker.sock.
4. **Restart app once** → SoloHost applies sock; `docker-probe` + exec work.

Disable: `AUTO_DOCKER_SOCK=0`

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.19`
