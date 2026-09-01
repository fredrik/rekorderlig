#!/usr/bin/env bash
# Restore a production snapshot into a PR preview's database.
#
# Previews are seeded from production automatically on first deploy; this is
# the manual path for refreshing one that has drifted, or that was created
# before the seed worked. Never point it at production: the target must look
# like a preview app.
#
# Everything the SQLite version needed — integrity_check, mv over the live
# file, restarting the machine so the process picked up the new inode — is
# gone with the file. A restore is a transaction against a running server.
#
# Usage: scripts/push-db-to-preview.sh <app-name> [dump-file]
#        dump-file defaults to the newest data/rekorderlig-prod-*.dump.
#        Pass --pull as the dump-file to take a fresh one first.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/fly-pg-proxy.sh
. scripts/fly-pg-proxy.sh

APP="${1:-}"
SRC="${2:-}"
DB_APP="${DB_APP:-rekorderlig-db}"
PORT="${PG_PROXY_PORT:-15433}"
ADMIN_URL="${PREVIEW_PG_ADMIN:-}"

[ -n "$APP" ] || { echo "usage: $0 <app-name> [dump-file|--pull]" >&2; exit 1; }
# Guard rail, not a permission check: this replaces the target's whole
# database, and the only place that is acceptable is a preview.
case "$APP" in
  *-pr-*) ;;
  *) echo "refusing: '$APP' is not a PR preview app (expected a *-pr-* name)" >&2; exit 1;;
esac

command -v pg_restore >/dev/null || { echo "pg_restore not found (brew install libpq)" >&2; exit 1; }
[ -n "$ADMIN_URL" ] || {
  echo "set PREVIEW_PG_ADMIN to the preview_admin connection URL (see scripts/fly-db-setup.sh)" >&2
  exit 1
}

if [ "$SRC" = "--pull" ]; then
  echo "==> Pulling a fresh production snapshot"
  scripts/pull-prod-db.sh
  SRC=""
fi
if [ -z "$SRC" ]; then
  SRC=$(ls -t data/rekorderlig-prod-*.dump 2>/dev/null | head -1 || true)
  [ -n "$SRC" ] || { echo "no data/rekorderlig-prod-*.dump; run scripts/pull-prod-db.sh" >&2; exit 1; }
fi
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

# rekorderlig-pr-42 → preview_pr_42. Database names cannot carry dashes
# unquoted, and the prefix is what the preview_admin role is scoped to.
DBNAME="preview_$(echo "${APP##*-pr-}" | tr -cd '0-9')"
DBNAME="preview_pr_${DBNAME#preview_}"

echo "==> Opening a proxy to $DB_APP on localhost:$PORT"
pg_proxy_start "$DB_APP" "$PORT"

echo "==> Recreating $DBNAME"
# FORCE: the preview app holds a connection whenever it is awake, and a plain
# DROP would fail on it. The app reconnects by itself (src/db.rs) — it has to,
# since Fly suspends it, so a dropped connection is a case it already handles.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $DBNAME WITH (FORCE)" \
  -c "CREATE DATABASE $DBNAME"

echo "==> Restoring $SRC ($(du -h "$SRC" | cut -f1))"
RESTORE_URL="${ADMIN_URL%/*}/$DBNAME"
pg_restore --no-owner --no-privileges --single-transaction -d "$RESTORE_URL" "$SRC"
psql "$RESTORE_URL" -v ON_ERROR_STOP=1 -c "ANALYZE"

echo "==> Done. Open https://$APP.fly.dev/?token=<the PR comment's token>"
