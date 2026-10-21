#!/usr/bin/env bash
# One-time creation of the backup app: the `rekorderlig-backup` Fly app, its
# private Tigris bucket, the read-only database URL as a secret, the
# scheduled machine via scripts/fly-backup-machine.sh, and last the bucket's
# retention rule.
#
# Idempotent — every step checks first — so it doubles as the repair script.
# The one step that cannot simply repeat is the retention rule: `fly storage
# create` prints the bucket's keys exactly once, and this script applies the
# rule in that same run. It is the last step so that a failure there leaves
# everything else in place, and it tells you how to re-run it with the keys
# that were printed. On any later run the rule is only checked or set when
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are in the environment.
#
# Needs in the environment:
#   PREVIEW_PG_READER_PASSWORD  the `preview_reader` role's password
#                               (scripts/setup/fly-db.sh made the role; the
#                               password is in 1Password and in the GitHub
#                               secret of the same name). The backup reads
#                               production with that role and nothing more.
#                               Rotations go through scripts/setup/fly-secrets.sh,
#                               which sets the same secret again.
# Needs on the PATH: fly, jq, aws (brew install awscli — only for the
# retention rule; Tigris speaks S3 and the rule is S3's), gh (to read the
# age recipient).
#
# Usage: scripts/setup/fly-backup.sh [--dry-run]
set -euo pipefail

cd "$(dirname "$0")/../.."

APP="${BACKUP_APP:-rekorderlig-backup}"
BUCKET="${BACKUP_BUCKET:-rekorderlig-backups}"
DB_HOST="${DB_HOST:-rekorderlig-db.internal}"
# Days an object lives before Tigris deletes it. The old workflow's ninety
# was GitHub's artifact ceiling; here it is a free choice — a year of 10 MB
# nightly dumps is under 4 GB and costs cents — kept at ninety because older
# backups of a database whose votes are append-only add nothing a newer one
# lacks, and because anything kept must stay decryptable with a key that may
# since have been rotated (scripts/backup-age-key.sh --rotate).
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-90}"
# Tigris's public endpoint, for this laptop. The machine gets the Fly-internal
# one (AWS_ENDPOINT_URL_S3, set by `fly storage create`); same bucket.
ENDPOINT="${TIGRIS_ENDPOINT:-https://t3.storage.dev}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

for tool in fly jq aws gh; do
  command -v "$tool" >/dev/null || { echo "$tool not found" >&2; exit 1; }
done

run() {
  if [ "$DRY_RUN" = 1 ]; then echo "would: $*"; else "$@"; fi
}

echo "==> App $APP"
if fly status --app "$APP" >/dev/null 2>&1; then
  echo "    exists"
else
  run fly apps create "$APP"
fi

echo "==> Bucket $BUCKET"
HAVE_KEYS=0
if fly storage status "$BUCKET" >/dev/null 2>&1; then
  echo "    exists"
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && HAVE_KEYS=1
elif [ "$DRY_RUN" = 1 ]; then
  echo "would: fly storage create -n $BUCKET -a $APP -y"
else
  # Private (the default), attached to the app: this sets BUCKET_NAME,
  # AWS_ENDPOINT_URL_S3, AWS_REGION, AWS_ACCESS_KEY_ID and
  # AWS_SECRET_ACCESS_KEY as secrets on $APP, and prints them once. The keys
  # are an Editor on this one bucket and nothing else in the organisation.
  created=$(fly storage create -n "$BUCKET" -a "$APP" -y | tee /dev/stderr)
  AWS_ACCESS_KEY_ID=$(printf '%s\n' "$created" | awk '$1 == "AWS_ACCESS_KEY_ID:" { print $2 }')
  AWS_SECRET_ACCESS_KEY=$(printf '%s\n' "$created" | awk '$1 == "AWS_SECRET_ACCESS_KEY:" { print $2 }')
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] && HAVE_KEYS=1
fi

echo "==> Secret BACKUP_DATABASE_URL on $APP"
if fly secrets list -a "$APP" --json 2>/dev/null | jq -e '.[] | select(.name == "BACKUP_DATABASE_URL")' >/dev/null; then
  echo "    set"
else
  : "${PREVIEW_PG_READER_PASSWORD:?the preview_reader password, from 1Password}"
  # The read-only role, over 6PN, no TLS: see fly.db.toml and docs/design/deploy.md.
  url="postgres://preview_reader:$PREVIEW_PG_READER_PASSWORD@$DB_HOST:5432/rekorderlig"
  if [ "$DRY_RUN" = 1 ]; then
    echo "would: fly secrets set -a $APP BACKUP_DATABASE_URL=${url/$PREVIEW_PG_READER_PASSWORD/***}"
  else
    fly secrets set -a "$APP" "BACKUP_DATABASE_URL=$url"
  fi
fi

echo "==> Machine"
if [ "$DRY_RUN" = 1 ]; then
  scripts/fly-backup-machine.sh --dry-run
else
  scripts/fly-backup-machine.sh
fi

echo "==> Retention: expire objects after $RETENTION_DAYS days"
if [ "$HAVE_KEYS" = 1 ]; then
  export AWS_REGION=auto
  current=$(aws s3api get-bucket-lifecycle-configuration --endpoint-url "$ENDPOINT" \
    --bucket "$BUCKET" --query "Rules[?ID=='expire'].Expiration.Days | [0]" --output text 2>/dev/null || echo None)
  if [ "$current" = "$RETENTION_DAYS" ]; then
    echo "    already $RETENTION_DAYS days"
  else
    # Only the fields Tigris documents; anything else is rejected.
    rule=$(jq -n --argjson days "$RETENTION_DAYS" '{Rules: [{ID: "expire", Status: "Enabled", Filter: {}, Expiration: {Days: $days}}]}')
    if ! run aws s3api put-bucket-lifecycle-configuration --endpoint-url "$ENDPOINT" \
         --bucket "$BUCKET" --lifecycle-configuration "$rule"; then
      cat >&2 <<EOF
Setting the rule failed; everything else above is done. Without it the
bucket keeps every backup forever, which costs cents but is not the plan.
Re-run with the bucket's keys in the environment (printed above by
fly storage create, or make a new Editor key in the Tigris dashboard):
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... scripts/setup/fly-backup.sh
EOF
      exit 1
    fi
  fi
elif [ "$DRY_RUN" = 1 ]; then
  echo "would: aws s3api put-bucket-lifecycle-configuration --bucket $BUCKET (expire after $RETENTION_DAYS days)"
else
  echo "    not checked: no AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY in the environment (an Editor key for the bucket; see the header)"
fi

cat <<EOF

Done. Two things remain, both by hand:

1. The check workflow (.github/workflows/backup-check.yml) needs a key that
   can only read this bucket. In the Tigris dashboard
   (fly storage dashboard $BUCKET) create an access key with the ReadOnly
   role on $BUCKET alone, then:
     gh secret set BACKUP_READER_ACCESS_KEY_ID
     gh secret set BACKUP_READER_SECRET_ACCESS_KEY
   The Editor key the machine holds is never put in GitHub.

2. Watch the first run — creating the machine ran it once:
     fly logs -a $APP
   It ends in "backup ok: rekorderlig-<stamp>.dump.age (<bytes> bytes)".
EOF
