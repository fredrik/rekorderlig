#!/usr/bin/env bash
# Copy the production database down to ./data/ as a pg_dump custom archive.
#
# `pg_dump -Fc` is the counterpart of the VACUUM INTO this replaced: a
# consistent snapshot taken while the app keeps serving, in a format
# `pg_restore` can put back selectively and in parallel. It runs locally over
# `fly proxy`, so the database machine needs no tools of its own and nothing is
# written to its volume — the failure mode the old script had a trap for
# (leaving a copy behind on a 1 GB volume) cannot happen.
#
# Usage: scripts/pull-prod-db.sh [output-path]
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/fly-pg-proxy.sh
. scripts/fly-pg-proxy.sh

DB_APP="${DB_APP:-rekorderlig-db}"
PORT="${PG_PROXY_PORT:-15432}"
# The role and password come from the environment so the script holds no
# credential. scripts/setup/fly-db.sh prints the URL to export.
DB_URL="${PROD_DATABASE_URL:-}"
# Timestamped so repeated pulls on the same day sit side by side instead of
# silently overwriting each other. ISO 8601 basic format in UTC: basic keeps the
# colons out of the filename, and UTC means the names still sort correctly
# across a daylight-saving change.
DEST="${1:-data/rekorderlig-prod-$(date -u +%Y%m%dT%H%M%SZ).dump}"

command -v pg_dump >/dev/null || { echo "pg_dump not found (brew install libpq)" >&2; exit 1; }
[ -n "$DB_URL" ] || {
  echo "set PROD_DATABASE_URL, e.g." >&2
  echo "  export PROD_DATABASE_URL='postgres://rekorderlig:PASSWORD@localhost:$PORT/rekorderlig'" >&2
  exit 1
}

echo "==> Opening a proxy to $DB_APP on localhost:$PORT"
pg_proxy_start "$DB_APP" "$PORT"

echo "==> Dumping to $DEST"
mkdir -p "$(dirname "$DEST")"
pg_dump -Fc --no-owner --no-privileges -f "$DEST" "$DB_URL"

# Read-only: this is a snapshot of production, so nothing local can amend it by
# accident. Copy it before restoring anywhere you intend to change.
chmod a-w "$DEST"

ls -lh "$DEST"
cat <<DONE
==> Done. Restore it into a local database with:
      createdb rekorderlig_local
      pg_restore --no-owner -d rekorderlig_local "$DEST"
      DATABASE_URL=postgres://localhost/rekorderlig_local cargo run -- serve
DONE
