#!/usr/bin/env bash
# Push a production database snapshot into a PR preview app's volume.
#
# Previews are throwaway apps seeded with three days of stories and no votes.
# Copying prod down into one is how a change gets tried against a real corpus.
# Never point this at production: the target must look like a preview app.
#
# The copy lands beside the live file and is moved into place, then the machine
# is restarted so the process reopens the new inode (a running SQLite keeps the
# old one otherwise). The -wal/-shm of the replaced database are removed with
# it -- they belong to the file that just went away, and a VACUUM INTO snapshot
# is already fully checkpointed.
#
# Usage: scripts/push-db-to-preview.sh <app-name> [db-file]
#        db-file defaults to the newest data/rekorderlig-prod-*.db snapshot.
#        Pass --pull as the db-file to take a fresh one first.
set -euo pipefail

cd "$(dirname "$0")/.."

APP="${1:-}"
SRC="${2:-}"
REMOTE_DB="${REMOTE_DB:-/data/rekorderlig.db}"
REMOTE_TMP="/data/push-db.tmp"

[ -n "$APP" ] || { echo "usage: $0 <app-name> [db-file|--pull]" >&2; exit 1; }
# Guard rail, not a permission check: this script restarts the app and replaces
# its database, and the only place that is acceptable is a preview.
case "$APP" in
  *-pr-*) ;;
  *) echo "refusing: '$APP' is not a PR preview app (expected a *-pr-* name)" >&2; exit 1;;
esac

command -v fly >/dev/null || { echo "fly CLI not found" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq not found" >&2; exit 1; }

if [ "$SRC" = "--pull" ]; then
  echo "==> Pulling a fresh production snapshot"
  scripts/pull-prod-db.sh
  SRC=""
fi
if [ -z "$SRC" ]; then
  SRC=$(ls -t data/rekorderlig-prod-*.db 2>/dev/null | head -1 || true)
  [ -n "$SRC" ] || { echo "no data/rekorderlig-prod-*.db snapshot; run scripts/pull-prod-db.sh" >&2; exit 1; }
fi
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

machine_states() { fly machines list -a "$APP" --json | jq -r '.[] | "\(.id) \(.state)"'; }

# Same wake as pull-prod-db.sh: a suspended machine refuses ssh/sftp until an
# inbound request or an explicit start brings it back.
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

remove_remote_tmp() { fly ssh console -a "$APP" -C "rm -f $REMOTE_TMP" >/dev/null 2>&1 || true; }
# The preview volume is 1 GB; never leave a half-uploaded copy behind.
trap remove_remote_tmp EXIT

echo "==> Uploading $SRC ($(du -h "$SRC" | cut -f1)) to $APP:$REMOTE_TMP"
fly sftp put -a "$APP" "$SRC" "$REMOTE_TMP"

echo "==> Checking the upload arrived intact"
# integrity_check on the far side catches a truncated transfer before the live
# file is replaced -- after the mv there is nothing to fall back to.
fly ssh console -a "$APP" -C "sqlite3 $REMOTE_TMP 'PRAGMA integrity_check'" | grep -q ok

echo "==> Swapping it into $REMOTE_DB"
# chmod: the local snapshot is read-only (pull-prod-db.sh makes it so) and the
# mode can ride along, which would leave the app unable to write a single vote.
fly ssh console -a "$APP" -C "sh -c 'chmod 644 $REMOTE_TMP && mv $REMOTE_TMP $REMOTE_DB && rm -f $REMOTE_DB-wal $REMOTE_DB-shm'"
trap - EXIT

echo "==> Restarting so the app reopens the new file"
fly machines list -a "$APP" --json | jq -r '.[].id' | while read -r id; do
  fly machine restart "$id" -a "$APP" >/dev/null
done

echo "==> Done. Open https://$APP.fly.dev/?token=<the PR comment's token>"
