#!/bin/sh
# The nightly backup, as it runs inside the `rekorderlig-backup` machine:
# `pg_dump` production over 6PN, encrypt it with age, PUT it in the private
# Tigris bucket. One file in, one object out; the retention is a lifecycle
# rule on the bucket (scripts/setup/fly-backup.sh), not this script's job.
#
# This replaced `.github/workflows/backup.yml`, which did the same dump from
# a GitHub runner and kept it as a workflow artifact. Two things were wrong
# with that shape and the move fixes both: the artifact store of a public
# repository is readable by every GitHub account, so the dump had to be
# encrypted *and* was still on display; and reaching the database from
# outside Fly needs `fly proxy`, which needs an org-scoped token in GitHub —
# a credential that could destroy every app, held to do a read-only dump.
# Here the machine is already on the private network and holds nothing but
# a read-only database role and the keys to one bucket.
#
# Encryption stays even though the bucket is private: a bucket is one
# misclick from public, and the private key is in 1Password, nowhere on
# this machine. `age -r` only needs the public half (BACKUP_AGE_RECIPIENT).
#
# Everything it needs is in the environment. Secrets on the app, set by
# scripts/setup/fly-backup.sh and `fly storage create`:
#   BACKUP_DATABASE_URL     postgres://preview_reader:...@rekorderlig-db.internal:5432/rekorderlig
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, BUCKET_NAME, AWS_ENDPOINT_URL_S3
# Plain env on the machine, set by scripts/fly-backup-machine.sh:
#   BACKUP_AGE_RECIPIENT    the age public key (age1...)
#
# busybox sh, because the image is postgres:17-alpine and bash would be one
# more package for a script this size. It has `pipefail`, which is the one
# bashism this needs: without it a pg_dump that dies mid-stream still leaves
# age exiting 0 and a truncated ciphertext uploaded as if it were a backup.
set -eu
# shellcheck disable=SC3040  # not POSIX, but busybox ash has it (checked in the image)
set -o pipefail

: "${BACKUP_DATABASE_URL:?set on the app by scripts/setup/fly-backup.sh}"
: "${BUCKET_NAME:?set on the app by fly storage create}"
: "${AWS_ACCESS_KEY_ID:?set on the app by fly storage create}"
: "${AWS_SECRET_ACCESS_KEY:?set on the app by fly storage create}"
ENDPOINT="${AWS_ENDPOINT_URL_S3:-https://fly.storage.tigris.dev}"
REGION="${AWS_REGION:-auto}"
case "${BACKUP_AGE_RECIPIENT:-}" in
  age1*) ;;
  *) echo "BACKUP_AGE_RECIPIENT is not an age public key; the dump is only ever uploaded encrypted" >&2; exit 1 ;;
esac

name="rekorderlig-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
out="$tmp/$name"

# The ciphertext is written to disk rather than streamed into curl, because
# a SigV4 request signs the body and needs its length and hash up front —
# and the disk is this machine's rootfs, which is thrown away with the
# machine. No plaintext ever exists: pg_dump goes straight into age.
echo "dumping production as $name"
pg_dump -Fc --no-owner --no-privileges "$BACKUP_DATABASE_URL" \
  | age -r "$BACKUP_AGE_RECIPIENT" -o "$out"

# age's header is enough to prove the file is a ciphertext without the
# private key: a plaintext dump would fail this, and so would an empty one.
head -c 21 "$out" | grep -q '^age-encryption.org/v1' || {
  echo "$out is not an age ciphertext" >&2; exit 1; }
size=$(wc -c <"$out" | tr -d ' ')

# curl speaks SigV4 natively (--aws-sigv4), so the image needs no S3 client.
# Path-style addressing, bucket in the path, which Tigris accepts on both of
# its endpoints. The region is "auto" on Tigris; the sigv4 string carries
# whatever AWS_REGION says so a different S3 would work unchanged.
echo "uploading $size bytes to $ENDPOINT/$BUCKET_NAME/$name"
curl -fsS --retry 3 \
  --aws-sigv4 "aws:amz:$REGION:s3" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  -T "$out" "$ENDPOINT/$BUCKET_NAME/$name" -o /dev/null

# Read it back by HEAD and compare sizes: an upload that returned 200 for a
# truncated body is the failure a backup must not have. This is the one
# read the job does, so the key needs GetObject as well as PutObject.
stored=$(curl -fsSI \
  --aws-sigv4 "aws:amz:$REGION:s3" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  "$ENDPOINT/$BUCKET_NAME/$name" \
  | tr -d '\r' | awk 'tolower($1) == "content-length:" { print $2 }')
[ "$stored" = "$size" ] || {
  echo "stored object is $stored bytes, expected $size" >&2; exit 1; }
echo "backup ok: $name ($size bytes)"
