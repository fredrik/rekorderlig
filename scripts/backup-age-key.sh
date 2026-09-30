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
# The key file is never written where a commit could pick it up: the first
# run of this script wrote it into the checkout, and a later `git add -A`
# shipped the private key to a public repository (a merge since reverted). A
# key that has been in a commit is burned even after the file is removed. So
# the script refuses any path that git would accept — inside a repository
# and not ignored — and defaults to ~/.ssh/, which is private by convention
# and ignored even when $HOME is itself a repository.
#
# Usage: scripts/backup-age-key.sh [--rotate] [key file]   (default: ~/.ssh/rekorderlig-backup.key)
set -euo pipefail

ROTATE=0
if [ "${1:-}" = "--rotate" ]; then ROTATE=1; shift; fi
KEY="${1:-$HOME/.ssh/rekorderlig-backup.key}"
REPO="${GH_REPO:-fredrik/rekorderlig}"

for tool in age-keygen gh; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed (brew install age gh)" >&2; exit 1; }
done
if [ -e "$KEY" ]; then
  echo "$KEY already exists; move it into 1Password first, or name another file" >&2
  exit 1
fi
dir=$(dirname "$KEY")
[ -d "$dir" ] || { echo "$dir does not exist" >&2; exit 1; }
here=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
# This checkout is refused outright, ignore rules or not: it is the public
# repository, and `*.key` in .gitignore is a seat belt, not a place to sit.
if [ -n "$root" ] && [ "$root" = "$here" ]; then
  echo "$KEY is inside this checkout ($here). The key never goes in the repository, ignored or not." >&2
  exit 1
fi
if [ -n "$root" ] && ! git -C "$dir" check-ignore -q "$(basename "$KEY")"; then
  echo "$KEY could be committed: it is inside the git repository at $root and not ignored there. Name a path git ignores, or one outside any repository." >&2
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
