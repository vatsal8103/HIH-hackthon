#!/usr/bin/env bash
# Build and start a throwaway Bayora stack (project bayora-test, UI on 127.0.0.1:18080),
# run the container and network tests against it, then remove it and its volumes.
# Uses the secrets in .env. Does not touch the main `bayora` stack or its data.
set -euo pipefail
cd "$(dirname "$0")/.."

export BAYORA_COMPOSE_PROJECT=bayora-test BAYORA_UI_PORT=18080 BAYORA_COMPOSE_TESTS=1
trap 'docker compose -p "$BAYORA_COMPOSE_PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true' EXIT

docker compose -p "$BAYORA_COMPOSE_PROJECT" up -d --build --wait --wait-timeout 120
(cd backend && uv run pytest tests_compose -v "$@")
