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
# Re-running is refused once a recipient is set, because replacing it
# silently would leave every later artifact readable only with a key you may
# not have kept. `--rotate` replaces it on purpose: a new pair, a new
# variable. Older artifacts stay readable with the older private key, so keep
# it until they expire (90 days). Restore with:
#   age -d -i rekorderlig-backup.key rekorderlig-*.dump.age | pg_restore --no-owner -d <db>
#
# The key file is written to $HOME by default and never inside a git work
# tree: the first run of this script wrote it into the checkout, and a later
# `git add -A` shipped the private key to a public repository (c1b57a0). A key
# that has been in a commit is burned even after the file is removed.
#
# Usage: scripts/backup-age-key.sh [--rotate] [key file]   (default: ~/rekorderlig-backup.key)
set -euo pipefail

ROTATE=0
if [ "${1:-}" = "--rotate" ]; then ROTATE=1; shift; fi
KEY="${1:-$HOME/rekorderlig-backup.key}"
REPO="${GH_REPO:-fredrik/rekorderlig}"

for tool in age-keygen gh; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed (brew install age gh)" >&2; exit 1; }
done
if [ -e "$KEY" ]; then
  echo "$KEY already exists; move it into 1Password first, or name another file" >&2
  exit 1
fi
if git -C "$(dirname "$KEY")" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "$KEY is inside a git work tree; a private key must never be where a commit can reach it. Write it under \$HOME instead." >&2
  exit 1
fi
current=$(gh variable get BACKUP_AGE_RECIPIENT --repo "$REPO" 2>/dev/null || true)
if [ -n "$current" ] && [ "$ROTATE" = 0 ]; then
  cat >&2 <<EOF
BACKUP_AGE_RECIPIENT is already set on $REPO:
  $current
Backups are being encrypted to that key. Re-run with --rotate to replace it,
and keep the old private key until the last artifact encrypted to it expires.
EOF
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
