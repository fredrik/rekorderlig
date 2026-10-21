#!/usr/bin/env bash
# One-time creation of the backup app: the `rekorderlig-backup` Fly app, its
# private Tigris bucket with a retention rule, the read-only database URL
# as a secret, and then the scheduled machine via scripts/fly-backup-machine.sh.
#
# Idempotent — every step checks first — so it doubles as the repair script.
# The one step it cannot repeat is the bucket's lifecycle rule: `fly storage
# create` prints the bucket's keys exactly once, and this script applies the
# rule in that same moment. On a later run it needs AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY in the environment to touch the rule at all, and
# otherwise leaves it alone and says so.
#
# Needs in the environment:
#   PREVIEW_PG_READER_PASSWORD  the `preview_reader` role's password
#                               (scripts/setup/fly-db.sh made the role; the
#                               password is in 1Password and in the GitHub
#                               secret of the same name). The backup reads
#                               production with that role and nothing more.
# Needs on the PATH: fly, jq, aws (brew install awscli — only for the
# lifecycle rule; Tigris speaks S3 and the rule is S3's), gh (to read the
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
# The public endpoint; the machine uses the Fly-internal one it is given.
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
if fly storage status "$BUCKET" >/dev/null 2>&1; then
  echo "    exists"
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    APPLY_LIFECYCLE=1
  else
    echo "    (lifecycle rule left as is: no AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY in the environment to check it with)"
    APPLY_LIFECYCLE=0
  fi
else
  # Private (the default), attached to the app: this sets BUCKET_NAME,
  # AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as
  # secrets on $APP, and prints them once. The keys are an Editor on this
  # one bucket and nothing else in the organisation.
  if [ "$DRY_RUN" = 1 ]; then
    echo "would: fly storage create -n $BUCKET -a $APP -y"
    APPLY_LIFECYCLE=0
  else
    created=$(fly storage create -n "$BUCKET" -a "$APP" -y | tee /dev/stderr)
    AWS_ACCESS_KEY_ID=$(printf '%s\n' "$created" | awk '$1 == "AWS_ACCESS_KEY_ID:" { print $2 }')
    AWS_SECRET_ACCESS_KEY=$(printf '%s\n' "$created" | awk '$1 == "AWS_SECRET_ACCESS_KEY:" { print $2 }')
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
    [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] || {
      echo "could not read the keys out of fly storage create's output; set the lifecycle rule by hand: see the aws s3api call in this script" >&2
      exit 1
    }
    APPLY_LIFECYCLE=1
  fi
fi

if [ "$APPLY_LIFECYCLE" = 1 ]; then
  echo "==> Retention: expire objects after $RETENTION_DAYS days"
  export AWS_REGION=auto
  current=$(aws s3api get-bucket-lifecycle-configuration --endpoint-url "$ENDPOINT" \
    --bucket "$BUCKET" --query "Rules[?ID=='expire'].Expiration.Days | [0]" --output text 2>/dev/null || echo None)
  if [ "$current" = "$RETENTION_DAYS" ]; then
    echo "    already $RETENTION_DAYS days"
  else
    # Only the fields Tigris documents; anything else is rejected.
    rule=$(jq -n --argjson days "$RETENTION_DAYS" '{Rules: [{ID: "expire", Status: "Enabled", Filter: {}, Expiration: {Days: $days}}]}')
    run aws s3api put-bucket-lifecycle-configuration --endpoint-url "$ENDPOINT" \
      --bucket "$BUCKET" --lifecycle-configuration "$rule"
  fi
fi

echo "==> Secret BACKUP_DATABASE_URL on $APP"
if fly secrets list -a "$APP" --json 2>/dev/null | jq -e '.[] | select(.name == "BACKUP_DATABASE_URL")' >/dev/null; then
  echo "    set"
else
  : "${PREVIEW_PG_READER_PASSWORD:?the preview_reader password, from 1Password}"
  # The read-only role, over 6PN, no TLS: see fly.db.toml and docs/design/deploy.md.
  run fly secrets set -a "$APP" \
    "BACKUP_DATABASE_URL=postgres://preview_reader:$PREVIEW_PG_READER_PASSWORD@$DB_HOST:5432/rekorderlig"
fi

echo "==> Machine"
if [ "$DRY_RUN" = 1 ]; then
  scripts/fly-backup-machine.sh --dry-run
else
  scripts/fly-backup-machine.sh
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
