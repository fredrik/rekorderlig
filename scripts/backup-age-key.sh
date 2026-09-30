#!/usr/bin/env bash
# Mint the key pair the nightly backup encrypts to, and publish its public half.
#
# `.github/workflows/backup.yml` pipes `pg_dump` through `age -r` before the
# artifact is uploaded, because the artifact is downloadable by every GitHub
# account (public repository). The public key is the repository variable
# BACKUP_AGE_RECIPIENT — a variable, not a secret, because it is not one: it
# can only encrypt. The private key is the thing that matters, and this
# script writes it to exactly one file and then tells you to move it into
# 1Password and delete the file. It is never a repository secret: a key the
# runner could read is a key any PR could read.
#
# Re-running rotates: a new pair, a new variable. Older artifacts stay
# readable with the older private key, so keep the old one until they expire
# (90 days). Restore with:
#   age -d -i rekorderlig-backup.key rekorderlig-*.dump.age | pg_restore --no-owner -d <db>
#
# Usage: scripts/backup-age-key.sh [key file]     (default: ./rekorderlig-backup.key)
set -euo pipefail

KEY="${1:-rekorderlig-backup.key}"
REPO="${GH_REPO:-fredrik/rekorderlig}"

for tool in age-keygen gh; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed (brew install age gh)" >&2; exit 1; }
done
if [ -e "$KEY" ]; then
  echo "$KEY already exists; move it into 1Password first, or name another file" >&2
  exit 1
fi

umask 077
age-keygen -o "$KEY" 2>/dev/null
recipient=$(age-keygen -y "$KEY")
gh variable set BACKUP_AGE_RECIPIENT --repo "$REPO" --body "$recipient"

cat <<EOF
Public key (now the repository variable BACKUP_AGE_RECIPIENT on $REPO):
  $recipient

Private key written to $KEY, mode 600. Now:
  1. Store its contents in 1Password (e.g. "rekorderlig backup key").
  2. rm $KEY
  3. gh workflow run backup.yml --repo $REPO, and check the artifact has a .dump.age file.
EOF
