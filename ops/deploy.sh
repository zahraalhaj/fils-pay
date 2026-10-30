#!/usr/bin/env bash
# One-command (re)deploy of the production stack:  ops/deploy.sh
#
# 1. builds every image first, so nothing stops until the new code is ready;
# 2. runs migrations (idempotent; already-applied files are skipped);
# 3. replaces containers. Settlement gets SIGTERM and up to 10 minutes to
#    finish the merchant it is closing (stop_grace_period); runs are an
#    advisory-locked singleton, so the new daemon can never overlap it.
# 4. waits until every long-running service reports healthy.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=.env.prod
[[ -f $ENV_FILE ]] || { echo "missing ops/$ENV_FILE (copy .env.prod.example)" >&2; exit 1; }
compose() { docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml "$@"; }

compose config --quiet                       # fails fast on any missing secret
compose build --pull
compose up -d postgres
compose run --rm migrate
compose up -d --remove-orphans --wait --wait-timeout 180 proxy api settlement reporting
compose ps
