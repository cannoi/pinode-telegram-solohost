# SoloHost v2.6.26

- Default: no docker.sock
- Mount `./:/solohost-config:rw` (install dir only) so after **Operator consent** the app can overwrite **app-root** `docker-compose.yml`
- UI: small chat tip only (no large Docker panel)
- After consent: SoloHost **Stop → Start**

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.26`
