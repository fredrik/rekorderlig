#!/usr/bin/env bash
# One-time creation of the database app: the app itself, its volume, the
# superuser password, the two roles the rest of the system uses, and the
# DATABASE_URL secret on the app that reads it.
#
# Idempotent — every step checks first — so it doubles as the repair script
# when something has been deleted by hand. It does NOT deploy; run
# `fly deploy -c fly.db.toml` after it, or before it on a fresh app (the roles
# step needs a running server, and says so).
#
# Two roles, because the CI credential must not be able to touch production:
#   rekorderlig     owns and reads/writes the `rekorderlig` database only
#   preview_admin   may CREATEDB, and owns nothing else — the PR preview
#                   workflow uses it to create and drop `preview_pr_<n>`
#                   databases and cannot reach `rekorderlig` at all
#
# Usage: scripts/fly-db-setup.sh [--dry-run]
set -euo pipefail

cd "$(dirname "$0")/.."

DB_APP="${DB_APP:-rekorderlig-db}"
APP="${FLY_APP:-rekorderlig}"
REGION="${REGION:-arn}"
VOLUME="rekorderlig_pg"
# The database itself is tens of megabytes; what actually consumes this volume
# is the preview databases, since every open PR gets a full pg_restore of
# production onto this same machine, plus a few hundred megabytes of pg_wal.
# One gigabyte holds production and a handful of previews at once, which is
# more previews than are ever open.
#
# It is the one number here that can only go up: a Fly volume extends and never
# shrinks. If previews ever crowd it, `fly volumes extend <id> -s 2` is online
# and takes seconds — so this is sized for the normal case rather than the
# worst one. `df -h /var/lib/postgresql/data` over `fly ssh console` is the
# check, and `preview_pr_%` databases whose PR has closed are the first thing
# to sweep (the preview workflow's close job does it, when it runs).
VOLUME_SIZE_GB="${VOLUME_SIZE_GB:-1}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

command -v fly >/dev/null || { echo "fly CLI not found" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq not found" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = 1 ]; then echo "would: $*"; else "$@"; fi
}

echo "==> App $DB_APP"
if fly status --app "$DB_APP" >/dev/null 2>&1; then
  echo "    exists"
else
  run fly apps create "$DB_APP"
fi

echo "==> Volume $VOLUME"
if fly volumes list --app "$DB_APP" --json 2>/dev/null \
    | jq -e --arg v "$VOLUME" 'map(select(.name == $v)) | length > 0' >/dev/null; then
  echo "    exists"
else
  run fly volumes create "$VOLUME" --app "$DB_APP" --region "$REGION" \
      --size "$VOLUME_SIZE_GB" --yes
fi

echo "==> Superuser password"
# POSTGRES_PASSWORD is only consumed by initdb on the very first boot, but the
# image also refuses to start without it, so it stays set.
if fly secrets list --app "$DB_APP" --json 2>/dev/null | jq -e 'map(.Name) | index("POSTGRES_PASSWORD")' >/dev/null; then
  echo "    already set (leaving it alone — rotating it after initdb does nothing)"
else
  PG_SUPERUSER_PASSWORD="$(openssl rand -hex 24)"
  run fly secrets set --app "$DB_APP" "POSTGRES_PASSWORD=$PG_SUPERUSER_PASSWORD"
  echo "    set. Keep this somewhere safe — it is not recoverable from Fly:"
  echo "    POSTGRES_PASSWORD=$PG_SUPERUSER_PASSWORD"
fi

cat <<'NEXT'

==> Next, by hand, because these need a running server and a password you hold

  fly deploy -c fly.db.toml

  # A local port onto the private network; leave it running in another shell.
  fly proxy 15432:5432 -a rekorderlig-db

  # Then, as the superuser (the POSTGRES_PASSWORD above):
  psql "postgres://postgres:PASSWORD@localhost:15432/postgres" <<'SQL'
    CREATE ROLE rekorderlig LOGIN PASSWORD 'APP_PASSWORD';
    CREATE DATABASE rekorderlig OWNER rekorderlig;

    -- CREATEDB and nothing else. It can make preview_pr_<n> databases and own
    -- them; it has no rights on `rekorderlig`, which is the point.
    CREATE ROLE preview_admin LOGIN CREATEDB PASSWORD 'PREVIEW_PASSWORD';
    REVOKE ALL ON DATABASE rekorderlig FROM preview_admin, PUBLIC;

    -- pg_dump of production for the preview seed needs to read it, and only
    -- read it. A separate role again, so the CI credential that writes
    -- previews is not the one that reads production.
    CREATE ROLE preview_reader LOGIN PASSWORD 'READER_PASSWORD';
    GRANT CONNECT ON DATABASE rekorderlig TO preview_reader;
SQL

  psql "postgres://postgres:PASSWORD@localhost:15432/rekorderlig" <<'SQL'
    GRANT USAGE ON SCHEMA public TO preview_reader;
    ALTER DEFAULT PRIVILEGES FOR ROLE rekorderlig IN SCHEMA public
      GRANT SELECT ON TABLES TO preview_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO preview_reader;

    -- Sequences too, or pg_dump fails: it reads `last_value` off every
    -- sequence to emit the `setval` that restores it, and an identity column
    -- (models.rev) owns one. Tables alone let the reader connect and query,
    -- so nothing noticed until the first preview seed died with "permission
    -- denied for sequence models_rev_seq". SELECT on a sequence is read-only:
    -- it allows currval and last_value, not nextval.
    ALTER DEFAULT PRIVILEGES FOR ROLE rekorderlig IN SCHEMA public
      GRANT SELECT ON SEQUENCES TO preview_reader;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO preview_reader;
SQL

  # Then the three secrets that point everything at it. Prompts for the
  # passwords without echoing them, and tries each one against the database
  # before setting anything:
  scripts/fly-db-secrets.sh

  # scripts/pull-prod-db.sh reads a whole URL from the environment instead,
  # so it holds no credential:
  export PROD_DATABASE_URL='postgres://rekorderlig:APP_PASSWORD@localhost:15432/rekorderlig'

NEXT
