FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache wget

COPY package.json app.js loader.js ./
COPY public/ ./public/

ENV DATA_DIR=/data \
    PORT=8080 \
    NODE_HOST=host.docker.internal

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=12s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "loader.js"]
