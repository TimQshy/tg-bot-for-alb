#!/usr/bin/env bash
# Create the database and role for one salon.  Usage:
#   scripts/new-salon-db.sh <slug> <password>
#
# db.init() creates the schema itself on first boot, so nothing else is
# needed here. The rest of onboarding (env file, compose service, nginx
# location, public/config.json) is in VPS_MIGRATION_PLAN.md.
set -euo pipefail

SLUG="${1:?usage: new-salon-db.sh <slug> <password>}"
PASSWORD="${2:?usage: new-salon-db.sh <slug> <password>}"

if ! [[ "$SLUG" =~ ^[a-z0-9_]+$ ]]; then
  echo "slug must be lowercase letters, digits and underscores only" >&2
  exit 1
fi

DB="salon_$SLUG"

psql() { docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 "$@"; }
exists() { [ "$(psql -tAc "$1")" = "1" ]; }

# $DB is regex-checked above; the password is passed as a psql variable so it
# is never interpolated into SQL text. The statement goes in on stdin because
# psql expands :'pw' only while reading input — with -c the colon reaches the
# server verbatim and it fails with a syntax error at ":".
if exists "SELECT 1 FROM pg_roles WHERE rolname = '$DB'"; then
  echo "role $DB already exists, leaving it alone"
else
  printf '%s\n' "CREATE ROLE \"$DB\" LOGIN PASSWORD :'pw'" | psql -v pw="$PASSWORD"
fi

if exists "SELECT 1 FROM pg_database WHERE datname = '$DB'"; then
  echo "database $DB already exists, leaving it alone"
else
  # CREATE DATABASE cannot run inside a transaction block.
  psql -c "CREATE DATABASE \"$DB\" OWNER \"$DB\""
fi

echo "ready: DATABASE_URL=postgresql://$DB:<password>@postgres:5432/$DB"
