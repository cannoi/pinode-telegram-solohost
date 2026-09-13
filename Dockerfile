# SoloHost Controller — Pi Node Telegram Controller PRO
# Node.js runtime, no privileged access, sandbox by default.
#
# IMPORTANT: every .js file used by require() must be listed in COPY below.
# If you add a new module (e.g. host-metrics.js), add it here too.
#
# COMPLIANCE FIX: auto-compose.js removed. It silently rewrote the host's
# docker-compose.yml to add a docker.sock mount, then tried to force a
# container recreate (docker compose up --force-recreate / docker restart /
# Docker Engine API restart / host .bat-.ps1 helpers) with NO user consent
# step. docker-compose.with-sock.yml and docker-compose.with-docker.yml
# (both unreferenced duplicate sock-mount templates, one defaulting
# AUTO_DOCKER_SOCK=1, the other DOCKER_PROBE=1) were removed too. docker.sock
# is now reachable ONLY through the existing in-app consent flow in app.js
# (/docker/confirm) — unchanged, still requires an explicit user click plus
# a manual Stop -> Start in SoloHost.

FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better Docker layer caching)
COPY package.json ./
# No runtime npm dependencies — skip npm install to shrink build/attack surface.

# Application source files — every require() target must be here.
COPY package.json app.js loader.js status-monitor.js telemetry-lite.js \
     pi-node-discovery.js optimized-pi-node-reader.js optimized-http-reader.js \
     horizon-sync-label.js data-validator.js docker-probe.js data-frame.js \
     host-metrics.js pi-browser-bridge.js ./

# Static assets served by the app
COPY public ./public
COPY agent ./agent
# NOTE: scripts/ intentionally NOT copied into the image — it only holds a
# local build helper (scripts/build-image.sh) used from the host shell to
# build/push the image; the running container never needs it. It still
# ships in the repo/zip for maintainers.

# Data directory (usually a volume at runtime)
RUN mkdir -p /data/history /data/hourly /data/daily /data/state /data/logs

EXPOSE 8080

# Aligned with package.json "main": "loader.js". Previously CMD ran app.js
# directly, which meant loader.js (and therefore its auto-compose call,
# before this fix) never actually executed in the built image — the two
# entrypoints had silently drifted apart. Now consistent: loader.js
# supervises app.js and restarts it on crash.
CMD ["node", "loader.js"]
