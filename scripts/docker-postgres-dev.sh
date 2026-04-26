#!/usr/bin/env bash
# Pull and run PostgreSQL in Docker with the same database/user/password as
# backend/src/API/appsettings.Development.json (DefaultConnection).
#
#   Host=localhost;Port=5432;Username=analyser;Password=analyser_password;Database=analyzer
#
# Usage:
#   ./scripts/docker-postgres-dev.sh
#   ./scripts/docker-postgres-dev.sh --stop
set -euo pipefail

IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
NAME="${POSTGRES_CONTAINER:-devpilot-postgres}"
USER="analyser"
PASSWORD="analyser_password"
DB="analyzer"
PORT="${POSTGRES_PORT:-5432}"

if [[ "${1:-}" == "--stop" ]]; then
  docker rm -f "$NAME" 2>/dev/null || true
  echo "Removed container $NAME"
  exit 0
fi

echo "==> Pulling $IMAGE …"
docker pull "$IMAGE"

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "==> Container $NAME already exists. Removing and recreating…"
  docker rm -f "$NAME"
fi

echo "==> Starting $NAME (port $PORT → 5432)…"
docker run -d --name "$NAME" \
  -e POSTGRES_USER="$USER" \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB="$DB" \
  -p "${PORT}:5432" \
  --health-cmd "pg_isready -U $USER -d $DB" --health-interval 5s --health-timeout 5s --health-retries 10 \
  "$IMAGE"

echo ""
echo "PostgreSQL is running."
echo "  Connection (matches appsettings.Development.json):"
echo "    Host=localhost;Port=$PORT;Username=$USER;Password=$PASSWORD;Database=$DB"
echo ""
echo "Stop:  $0 --stop  (or: docker rm -f $NAME)"
