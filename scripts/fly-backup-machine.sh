#!/usr/bin/env bash
# Create or repair the nightly backup: a Fly *scheduled machine* in the
# `rekorderlig-backup` app that runs scripts/backup/run.sh once a day.
#
# It is its own app, not a third machine in `rekorderlig`, because Fly
# injects an app's secrets into every machine it owns, and the bucket's keys
# must not reach the app machine: the thing being backed up should not be
# able to delete its backups. The sync machine shares the app for the
# opposite reason (scripts/fly-sync-machine.sh). Its secrets are set once by
# scripts/setup/fly-backup.sh and `fly storage create`; this script only
# checks they are there.
#
# Like the sync machine it is a reconciler: run it after changing
# Dockerfile.backup or scripts/backup/run.sh, or whenever `fly machines
# list -a rekorderlig-backup` looks wrong, and it does nothing when the
# machine already matches. Recreating the machine restarts the daily
# interval from the moment of creation (Fly schedules are anchored there,
# not to the clock), so it only happens when something differs.
#
# The image is built here, not by a deploy: `fly deploy --build-only --push`
# into the app's own registry, tagged with a hash of the two files that make
# it, so an unchanged recipe is never rebuilt and a changed one is never
# missed. No deploy workflow runs this — the GitHub FLY_API_TOKEN is scoped
# to `rekorderlig` and cannot see this app, which is the point of the app.
#
# Needs: fly, jq, and either BACKUP_AGE_RECIPIENT in the environment or gh
# to read the repository variable of that name (scripts/backup-age-key.sh
# sets it).
#
# Usage: scripts/fly-backup-machine.sh [--dry-run]
set -euo pipefail

cd "$(dirname "$0")/.."

APP="${BACKUP_APP:-rekorderlig-backup}"
NAME="${BACKUP_MACHINE_NAME:-rekorderlig-backup}"
REGION="${BACKUP_REGION:-arn}"
SCHEDULE="${BACKUP_SCHEDULE:-daily}"
# pg_dump of an 80 MB database plus age: a few tens of megabytes resident.
MEMORY="${BACKUP_MEMORY:-256}"
REPO="${GH_REPO:-fredrik/rekorderlig}"
CONFIG=fly.backup.toml

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

FLY=$(command -v fly || command -v flyctl || true)
[ -n "$FLY" ] || { echo "fly CLI not found (looked for fly and flyctl)" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
if [ -z "$RECIPIENT" ] && command -v gh >/dev/null; then
  RECIPIENT=$(gh variable get BACKUP_AGE_RECIPIENT --repo "$REPO" 2>/dev/null || true)
fi
case "$RECIPIENT" in
  age1*) ;;
  *) echo "BACKUP_AGE_RECIPIENT is not set and the repository variable could not be read; mint one with scripts/backup-age-key.sh" >&2; exit 1 ;;
esac

# The secrets the job reads (scripts/backup/run.sh). Their values are not
# readable from here, only their presence; a missing one means the setup
# script has not run, and the machine would only fail every night. A dry
# run reports it and carries on, so the setup script's own dry run can show
# the whole sequence before the app exists.
missing=""
if SECRETS=$("$FLY" secrets list -a "$APP" --json 2>/dev/null | jq -r '.[].name'); then
  for s in BACKUP_DATABASE_URL BUCKET_NAME AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3; do
    grep -qx "$s" <<<"$SECRETS" || missing="$missing $s"
  done
else
  missing=" (no app $APP, or no secrets on it)"
fi
if [ -n "$missing" ]; then
  echo "secrets not set on $APP:$missing — run scripts/setup/fly-backup.sh" >&2
  [ "$DRY_RUN" = true ] || exit 1
fi

# One tag per recipe. shasum rather than git, so an uncommitted edit builds too.
TAG="backup-$(cat Dockerfile.backup scripts/backup/run.sh | shasum -a 256 | cut -c1-12)"
IMAGE="registry.fly.io/$APP:$TAG"
CMD=("/backup.sh")

if ! MACHINES=$("$FLY" machines list -a "$APP" --json 2>/dev/null); then
  [ "$DRY_RUN" = true ] || { echo "no app $APP — run scripts/setup/fly-backup.sh" >&2; exit 1; }
  MACHINES='[]'
fi
EXISTING=$(printf '%s' "$MACHINES" | jq -r --arg n "$NAME" '
  [.[] | select(.name == $n)] | first // empty')

matches() {
  printf '%s' "$EXISTING" | jq -e \
    --arg image "$IMAGE" --arg schedule "$SCHEDULE" --arg recipient "$RECIPIENT" \
    --argjson cmd "$(printf '%s\n' "${CMD[@]}" | jq -R . | jq -s .)" '
      .config.image == $image
      and .config.schedule == $schedule
      and .config.restart.policy == "no"
      and (.config.init.cmd // .config.init.exec) == $cmd
      and .config.env.BACKUP_AGE_RECIPIENT == $recipient
    ' >/dev/null
}

if [ -n "$EXISTING" ] && matches; then
  echo "$NAME is already on $IMAGE, $SCHEDULE — nothing to do"
  exit 0
fi

echo "${EXISTING:+re}creating $NAME: $SCHEDULE, ${CMD[*]}, encrypting to $RECIPIENT"
echo "  image $IMAGE"
if [ "$DRY_RUN" = true ]; then
  echo "  (dry run, nothing changed)"
  exit 0
fi

# Ask the registry itself whether the tag is there, by tag and then by the
# digest the tag resolves to — the latter being what flyd fetches when it
# launches a machine. Two reasons to ask rather than infer: a tag built on
# an earlier run that never got as far as a machine is already there and
# need not be rebuilt; and registry.fly.io is eventually consistent after a
# push, so the first launch on a fresh tag has failed with MANIFEST_UNKNOWN
# for a digest that answered 200 a moment later. Launching waits for both.
TOKEN=$("$FLY" auth token 2>/dev/null)
ACCEPT='Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'
manifest_ready() {
  local digest
  digest=$(curl -fsS -o /dev/null -D - -u "x:$TOKEN" -H "$ACCEPT" \
    "https://registry.fly.io/v2/$APP/manifests/$TAG" 2>/dev/null \
    | tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }')
  [ -n "$digest" ] || return 1
  curl -fsS -o /dev/null -u "x:$TOKEN" -H "$ACCEPT" \
    "https://registry.fly.io/v2/$APP/manifests/$digest" 2>/dev/null
}

if manifest_ready; then
  echo "  $IMAGE is already in the registry"
else
  # --remote-only: a laptop build on Apple silicon would produce an arm64
  # image for an x86 machine. The deploy workflow builds the app the same way.
  "$FLY" deploy -c "$CONFIG" -a "$APP" --build-only --push --remote-only --image-label "$TAG"
  waited=0
  until manifest_ready; do
    if [ "$waited" -ge 90 ]; then
      echo "$IMAGE was pushed but the registry still does not serve it after ${waited}s; re-run in a minute" >&2
      exit 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
  [ "$waited" -gt 0 ] && echo "  registry served it after ${waited}s"
fi

if [ -n "$EXISTING" ]; then
  ID=$(printf '%s' "$EXISTING" | jq -r .id)
  "$FLY" machine destroy "$ID" -a "$APP" --force
fi

# --restart no: a backup that failed at 03:00 against a database that was
# restarting should try tomorrow, not every minute until then; the check
# workflow (.github/workflows/backup-check.yml) is what notices a missed
# night. Creating the machine also runs it once, which is the proof that the
# wiring works: watch `fly logs -a rekorderlig-backup` for "backup ok".
"$FLY" machine run \
  -a "$APP" \
  --name "$NAME" \
  --region "$REGION" \
  --schedule "$SCHEDULE" \
  --restart no \
  --vm-memory "$MEMORY" \
  --env BACKUP_AGE_RECIPIENT="$RECIPIENT" \
  -- "$IMAGE" "${CMD[@]}"
