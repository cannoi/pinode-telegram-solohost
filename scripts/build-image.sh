#!/bin/sh
# Build and optionally push the SoloHost image (GitHub / local Docker).
# Usage:
#   ./scripts/build-image.sh
#   PUSH=1 ./scripts/build-image.sh
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TAG="$(tr -d '[:space:]' < VERSION 2>/dev/null || echo 2.6.59-solohost)"
VER="$(echo "$TAG" | sed 's/-solohost//')"
IMAGE="${IMAGE:-ghcr.io/cannoi/pinode-telegram-solohost}"
echo "Building $IMAGE:v$VER from $ROOT"
docker build -t "$IMAGE:v$VER" -t "$IMAGE:latest" -f Dockerfile .
if [ "$PUSH" = "1" ]; then
  docker push "$IMAGE:v$VER"
  docker push "$IMAGE:latest"
fi
echo "Done. Local tags: $IMAGE:v$VER  $IMAGE:latest"
