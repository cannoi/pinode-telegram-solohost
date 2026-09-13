# SoloHost Controller — Pi Node Telegram Controller PRO
# Node.js runtime, no privileged access, sandbox by default.
#
# IMPORTANT: every .js file used by require() must be listed in COPY below.
# If you add a new module (e.g. host-metrics.js), add it here too.

FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better Docker layer caching)
COPY package.json ./
# No runtime npm dependencies — skip npm install to shrink build/attack surface.

# Application source files — every require() target must be here.
COPY package.json app.js loader.js auto-compose.js status-monitor.js \
     pi-node-discovery.js optimized-pi-node-reader.js optimized-http-reader.js \
     horizon-sync-label.js data-validator.js docker-probe.js data-frame.js \
     telemetry-lite.js host-metrics.js pi-browser-bridge.js ./

# Static assets served by the app
COPY public ./public
COPY scripts ./scripts
COPY agent ./agent

# Data directory (usually a volume at runtime)
RUN mkdir -p /data/history /data/hourly /data/daily /data/state /data/logs

EXPOSE 8080

CMD ["node", "app.js"]
