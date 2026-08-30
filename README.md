# SoloHost v2.6.15

Universal Pi Node discovery (SoloHost-safe, no docker.sock) + parallel reads.

Discovery strategies: env → sticky → host.docker.internal → bridge IPs → port sweep 31401–31410
Then: parallel Horizon + Core + Ports (sticky race)

GET /api/discover — discovery report

Image: `ghcr.io/cannoi/pinode-telegram-solohost:v2.6.15`
