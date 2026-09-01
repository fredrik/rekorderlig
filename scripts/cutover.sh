#!/usr/bin/env bash
# The SQLite → Postgres cutover, in one re-runnable script.
#
# Order matters and is the whole reason this is scripted rather than a list:
# the final snapshot has to be taken while the *old* image is still deployed
# (the new one ships no sqlite3 CLI), and after writes have stopped, so that
# what lands in Postgres is the last state production was ever in.
#
# It stops short of `fly deploy`. Everything up to that point is reversible —
# the old machine and its volume are untouched, and the Postgres database can
# be dropped and rebuilt by running this again. The deploy is the step that
# changes what people see, so it stays a decision rather than a line here.
#
# Usage: scripts/cutover.sh --yes
#   PROD_DATABASE_URL must point at the *proxied* Postgres, e.g.
#   postgres://rekorderlig:PASSWORD@localhost:15432/rekorderlig
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/fly-pg-proxy.sh
. scripts/fly-pg-proxy.sh

APP="${FLY_APP:-rekorderlig}"
DB_APP="${DB_APP:-rekorderlig-db}"
PORT="${PG_PROXY_PORT:-15432}"
DB_URL="${PROD_DATABASE_URL:-}"

[ "${1:-}" = "--yes" ] || {
  cat >&2 <<USAGE
This stops production, takes a final SQLite snapshot and loads it into
Postgres. Re-run with --yes to confirm.

Before running:
  - scripts/fly-db-setup.sh has been run and `fly deploy -c fly.db.toml` done
  - the roles exist and the app's DATABASE_URL secret is set
  - export PROD_DATABASE_URL='postgres://rekorderlig:PASSWORD@localhost:$PORT/rekorderlig'
USAGE
  exit 1
}
[ -n "$DB_URL" ] || { echo "set PROD_DATABASE_URL (see --help output above)" >&2; exit 1; }

command -v fly >/dev/null || { echo "fly CLI not found" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq not found" >&2; exit 1; }

echo "==> Stopping $APP so no vote lands after the snapshot"
# The hourly sync machine included: a sync mid-snapshot would write stories
# that the import would then miss, which is harmless but muddies the row-count
# check at the end.
fly machines list -a "$APP" --json | jq -r '.[].id' | while read -r id; do
  fly machine stop "$id" -a "$APP" >/dev/null && echo "    stopped $id"
done

echo "==> Taking the final SQLite snapshot"
# The app is stopped, so wake it for the vacuum and stop it again after.
SNAPSHOT="data/rekorderlig-final-$(date -u +%Y%m%dT%H%M%SZ).db"
scripts/cutover-pull-sqlite.sh "$SNAPSHOT"
fly machines list -a "$APP" --json | jq -r '.[].id' | while read -r id; do
  fly machine stop "$id" -a "$APP" >/dev/null
done

echo "==> Building the importer"
cargo build --release --locked --features sqlite-import

echo "==> Opening a proxy to $DB_APP on localhost:$PORT"
pg_proxy_start "$DB_APP" "$PORT"

echo "==> Importing into Postgres"
# The importer is idempotent per row (ON CONFLICT DO NOTHING) and verifies row
# counts on both sides before it returns, so a re-run after a half-finished
# attempt converges rather than doubling.
DATABASE_URL="$DB_URL" ./target/release/rekorderlig import-sqlite "$SNAPSHOT"

# Reads the imported database back; it does not retrain, so it proves the rows
# arrived and nothing more. That is the right check here — these numbers are
# meant to be compared against the Brain tab as it was before the stop, and a
# retrain would add a revision production never had.
echo "==> Reading the imported database back — compare this with Brain"
DATABASE_URL="$DB_URL" ./target/release/rekorderlig stats

cat <<NEXT

==> Loaded. What is left, in order:

  fly deploy --remote-only          # the new image, no volume, DATABASE_URL
  scripts/fly-sync-machine.sh       # the hourly trigger, on the new image
  open https://$APP.fly.dev/        # Train, Explore, Feed, Votes, Brain
  curl -X POST .../api/sync         # or hit Fetch in Brain; then check Brain again

  Keep the old volume and $SNAPSHOT for two weeks. Rolling back is the old
  image plus that volume, and loses only votes cast after this moment — which
  POST /api/import/vote can put back one at a time.

NEXT
