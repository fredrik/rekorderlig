#!/usr/bin/env bash
# Copy the production SQLite database down to ./data/.
#
# VACUUM INTO is the only safe way to grab a live WAL database: it writes a
# consistent, fully-checkpointed copy without stopping the app. Alpine has no
# sqlite3 CLI in the image, so the vacuum runs through node:sqlite instead.
#
# Usage: scripts/pull-prod-db.sh [output-path]
set -euo pipefail

APP="${FLY_APP:-rekorderlig}"
REMOTE_DB="${REMOTE_DB:-/data/rekorderlig.db}"
REMOTE_COPY="/data/pull-prod-db.tmp"
# Timestamped so repeated pulls on the same day sit side by side instead of
# silently overwriting each other. ISO 8601 basic format in UTC: basic keeps the
# colons out of the filename, and UTC means the names still sort correctly
# across a daylight-saving change.
DEST="${1:-data/rekorderlig-prod-$(date -u +%Y%m%dT%H%M%SZ).db}"

cd "$(dirname "$0")/.."

command -v fly >/dev/null || { echo "fly CLI not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

machine_states() { fly machines list -a "$APP" --json | jq -r '.[] | "\(.id) \(.state)"'; }

# The machine stops/suspends when idle, and `fly ssh console` will not wake it
# ("app has no started VMs") -- only an inbound request or an explicit start
# does. Start it ourselves so the script does not depend on someone browsing.
wake_machines() {
  local id state started=1
  while read -r id state; do
    [ "$state" = started ] || { echo "    starting $id ($state)"; fly machine start "$id" -a "$APP" >/dev/null; started=0; }
  done < <(machine_states)
  [ "$started" = 1 ] && return 0

  local waited=0
  until [ -z "$(machine_states | grep -v ' started$' || true)" ]; do
    [ "$waited" -ge 60 ] && { echo "machines did not reach started within ${waited}s" >&2; return 1; }
    sleep 2
    waited=$((waited + 2))
  done
}

echo "==> Waking $APP"
wake_machines

remove_remote_copy() { fly ssh console -a "$APP" -C "rm -f $REMOTE_COPY" >/dev/null 2>&1 || true; }
# Safety net: the volume is only 1 GB, so never leave the copy behind on a failure.
trap remove_remote_copy EXIT

echo "==> Vacuuming $REMOTE_DB on $APP"
fly ssh console -a "$APP" -C "node -e \"\
const {DatabaseSync}=require('node:sqlite');\
const db=new DatabaseSync('$REMOTE_DB');\
db.exec(\\\"VACUUM INTO '$REMOTE_COPY'\\\");\
db.close();\""

echo "==> Downloading to $DEST"
mkdir -p "$(dirname "$DEST")"
# fly sftp get resolves the local path relative to the working directory.
fly sftp get "$REMOTE_COPY" "$DEST" -a "$APP"

# Read-only: this is a snapshot of production, so opening it with a tool that
# writes (a stray `npm start`, a checkpoint on open) must not alter it. Copy it
# before using it as a working database.
chmod a-w "$DEST"

echo "==> Removing $REMOTE_COPY from the volume"
remove_remote_copy
trap - EXIT

ls -lh "$DEST"
echo "==> Done. Point the app at it with: REKORDERLIG_DB=$DEST npm start"
