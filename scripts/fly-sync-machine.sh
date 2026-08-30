#!/usr/bin/env bash
# Create or repair the hourly sync trigger: a Fly *scheduled machine* that runs
# `rekorderlig sync-remote` once an hour.
#
# It is a second machine in the same app, not a second app, for one reason:
# Fly injects the app's secrets into every machine it owns, so the trigger gets
# AUTH_TOKEN for free and there is no copy to keep in step. It cannot run
# `sync` directly against the database — a volume attaches to exactly one
# machine and the app machine holds it — so it pokes the app over its public
# URL, which is also what wakes the machine out of suspend.
#
# `fly deploy` does not know about this machine (a schedule cannot be expressed
# in fly.toml, and declaring a process group for it would have deploy start a
# machine that exits immediately). Depending on flyctl's mood a deploy may
# leave it alone, wipe its schedule, or destroy it outright — so this script is
# a *reconciler*, safe to run on every deploy, and .github/workflows/deploy.yml
# runs it there. It only touches the machine when something actually differs,
# because recreating it restarts the hourly interval from zero: the schedule is
# anchored at machine creation, not to the clock, so a machine rebuilt at :50
# next fires at :50.
#
# Usage: scripts/fly-sync-machine.sh [--dry-run]
set -euo pipefail

APP="${FLY_APP:-rekorderlig}"
NAME="${SYNC_MACHINE_NAME:-rekorderlig-sync}"
REGION="${SYNC_REGION:-arn}"
SCHEDULE="${SYNC_SCHEDULE:-hourly}"
# Days back to fetch per run. 1 is today, which is all an hourly run needs;
# every run refetches it, and upserts keep the highest points and comments.
DAYS="${SYNC_DAYS:-1}"
URL="${SYNC_URL:-https://$APP.fly.dev}"
# 256 MB is a curl with extra steps. The app machine's 512 is for SQLite.
MEMORY="${SYNC_MEMORY:-256}"
CMD=("/app/rekorderlig" "sync-remote")

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

# The binary has two names: a workstation install is `fly`, while
# superfly/flyctl-actions/setup-flyctl (what the deploy workflow uses) puts it
# on the PATH as `flyctl` only. Take whichever is there.
FLY=$(command -v fly || command -v flyctl || true)
[ -n "$FLY" ] || { echo "fly CLI not found (looked for fly and flyctl)" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

MACHINES=$("$FLY" machines list -a "$APP" --json)

# The image to run: whatever the app machine is on, so the trigger is never
# left pointing at a deployment image old enough to have been pruned.
IMAGE=$(printf '%s' "$MACHINES" | jq -r --arg n "$NAME" '
  [.[] | select(.name != $n) | .config.image // empty] | first // empty')
if [ -z "$IMAGE" ]; then
  echo "no app machine in $APP to take an image from — deploy the app first" >&2
  exit 1
fi

EXISTING=$(printf '%s' "$MACHINES" | jq -r --arg n "$NAME" '
  [.[] | select(.name == $n)] | first // empty')

# What the machine has to look like. Anything else and it gets rebuilt.
matches() {
  printf '%s' "$EXISTING" | jq -e \
    --arg image "$IMAGE" --arg schedule "$SCHEDULE" \
    --arg url "$URL" --arg days "$DAYS" \
    --argjson cmd "$(printf '%s\n' "${CMD[@]}" | jq -R . | jq -s .)" '
      .config.image == $image
      and .config.schedule == $schedule
      and .config.restart.policy == "no"
      and (.config.init.cmd // .config.init.exec) == $cmd
      and .config.env.REKORDERLIG_URL == $url
      and .config.env.REKORDERLIG_SYNC_DAYS == $days
    ' >/dev/null
}

if [ -n "$EXISTING" ] && matches; then
  echo "$NAME is already on $IMAGE, $SCHEDULE — nothing to do"
  exit 0
fi

echo "${EXISTING:+re}creating $NAME: $SCHEDULE, ${CMD[*]}, $DAYS day(s) against $URL"
echo "  image $IMAGE"
if [ "$DRY_RUN" = true ]; then
  echo "  (dry run, nothing changed)"
  exit 0
fi

if [ -n "$EXISTING" ]; then
  ID=$(printf '%s' "$EXISTING" | jq -r .id)
  "$FLY" machine destroy "$ID" -a "$APP" --force
fi

# `--` so flyctl stops reading flags and hands the rest to the machine; the
# image is the first of those. --restart no because a scheduled machine that
# retries on failure retries within the hour, against an app that is either
# still fetching (it answers `busy`) or genuinely broken — the next hour is a
# better retry than the next minute. Creating it also runs it once, which is
# the deploy's proof that the wiring works.
"$FLY" machine run \
  -a "$APP" \
  --name "$NAME" \
  --region "$REGION" \
  --schedule "$SCHEDULE" \
  --restart no \
  --vm-memory "$MEMORY" \
  --env REKORDERLIG_URL="$URL" \
  --env REKORDERLIG_SYNC_DAYS="$DAYS" \
  -- "$IMAGE" "${CMD[@]}"
