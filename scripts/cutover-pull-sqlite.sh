#!/usr/bin/env bash
# TEMPORARY, for the cutover only. This is the SQLite puller as it stood before
# the Postgres migration, kept because the final snapshot has to come off the
# volume while the *old* image is still deployed — the new one ships no sqlite3
# CLI. scripts/cutover.sh calls it. Delete both with the `sqlite-import`
# feature once the cutover has settled.
#
# Copy the production SQLite database down to ./data/.
#
# VACUUM INTO is the only safe way to grab a live WAL database: it writes a
# consistent, fully-checkpointed copy without stopping the app. The image
# ships the sqlite3 CLI for exactly this (Dockerfile), so the vacuum runs
# through it.
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

# The app owns more than one machine: the server, which holds the volume, and
# the hourly `sync-remote` scheduled machine, which has none. Every fly command
# below therefore names its machine -- left to choose, fly picks either one, and
# on the trigger machine the vacuum fails with "unable to open database file"
# because there is no volume mounted there at all. Selection is by the *mount*
# rather than the process group: the scheduled machine is created outside the
# deploy and has no group, and a group name is the deploy's to rename.
DB_DIR="$(dirname "$REMOTE_DB")"

machines_holding_db() {
  fly machines list -a "$APP" --json |
    jq -r --arg dir "$DB_DIR" '.[] | select([(.config.mounts // [])[].path] | index($dir)) | "\(.id) \(.state)"'
}

MACHINE="$(machines_holding_db | awk '{print $1}')"
[ -n "$MACHINE" ] || { echo "no machine on $APP mounts $DB_DIR" >&2; exit 1; }
[ "$(printf '%s\n' "$MACHINE" | wc -l)" -eq 1 ] || { echo "more than one machine on $APP mounts $DB_DIR: $MACHINE" >&2; exit 1; }

# The machine stops/suspends when idle, and `fly ssh console` will not wake it
# ("app has no started VMs") -- only an inbound request or an explicit start
# does. Start it ourselves so the script does not depend on someone browsing.
wake_machine() {
  local state
  state="$(machines_holding_db | awk '{print $2}')"
  [ "$state" = started ] && return 0
  echo "    starting $MACHINE ($state)"
  fly machine start "$MACHINE" -a "$APP" >/dev/null

  local waited=0
  until [ "$(machines_holding_db | awk '{print $2}')" = started ]; do
    [ "$waited" -ge 60 ] && { echo "$MACHINE did not reach started within ${waited}s" >&2; return 1; }
    sleep 2
    waited=$((waited + 2))
  done
}

echo "==> Waking $APP ($MACHINE)"
wake_machine

remove_remote_copy() { fly ssh console -a "$APP" --machine "$MACHINE" -C "rm -f $REMOTE_COPY" >/dev/null 2>&1 || true; }
# Safety net: the volume is only 1 GB, so never leave the copy behind on a failure.
trap remove_remote_copy EXIT

echo "==> Vacuuming $REMOTE_DB on $APP"
fly ssh console -a "$APP" --machine "$MACHINE" -C "sqlite3 $REMOTE_DB \"VACUUM INTO '$REMOTE_COPY'\""

echo "==> Downloading to $DEST"
mkdir -p "$(dirname "$DEST")"
# fly sftp get resolves the local path relative to the working directory.
fly sftp get "$REMOTE_COPY" "$DEST" -a "$APP" --machine "$MACHINE"

# Read-only: this is a snapshot of production, so opening it with a tool that
# writes (a stray server start, a checkpoint on open) must not alter it. Copy
# it before using it as a working database.
chmod a-w "$DEST"

echo "==> Removing $REMOTE_COPY from the volume"
remove_remote_copy
trap - EXIT

ls -lh "$DEST"
echo "==> Done. Point the app at it with: REKORDERLIG_DB=$DEST cargo run -- serve"
