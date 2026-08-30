FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache wget tzdata \
 && cp /usr/share/zoneinfo/Asia/Ho_Chi_Minh /etc/localtime \
 && echo "Asia/Ho_Chi_Minh" > /etc/timezone
COPY package.json app.js loader.js status-monitor.js pi-node-discovery.js ./
COPY public/ ./public/
COPY scripts/ ./scripts/
ENV DATA_DIR=/data PORT=8080 TZ=Asia/Ho_Chi_Minh TELEMETRY_SEC=60
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "loader.js"]
