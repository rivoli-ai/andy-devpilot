#!/bin/bash
set -e

echo "[DevPilot] Running database migrations..."
./efbundle --connection "$ConnectionStrings__Postgres"

echo "[DevPilot] Starting API..."
exec dotnet DevPilot.API.dll
