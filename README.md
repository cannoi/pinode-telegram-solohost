# SoloHost v2.6.21 — Official sandbox-friendly

## Default (SoloHost listing compliant)
- **No docker.sock** in install compose
- Sources: Horizon `/` → Core HTTP → TCP ports → state files
- Multi-source consensus (HEALTHY / DEGRADED / PARTIAL)
- Full Horizon fields for Telegram + AI

## Optional (user opts in after install)
Overwrite compose with `docker-compose.with-docker.yml` or set:
`DOCKER_PROBE=1` + mount `/var/run/docker.sock:ro`

`AUTO_DOCKER_SOCK=0` by default (no auto privilege escalation)

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.21`
