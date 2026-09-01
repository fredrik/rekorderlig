#!/usr/bin/env bash
# Set the secrets that point everything at the database: DATABASE_URL on the
# app and the two preview passwords the PR workflow builds its own URLs from.
# Run it after the roles exist (scripts/fly-db-setup.sh prints the SQL), and
# again whenever a password is rotated.
#
# The nightly backup needs no secret of its own: it opens a `fly proxy`, which
# only an org-scoped token can do, so it shares FLY_ORG_API_TOKEN with the
# preview workflow.
#
# Passwords are read without echo and never appear in a command line, so they
# stay out of shell history and out of the process list. Each one is tried
# against the database before any secret is set: a typo here would otherwise
# surface as a failed deploy or, worse, as a preview workflow that only breaks
# on someone else's PR.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/fly-pg-proxy.sh
. scripts/fly-pg-proxy.sh

APP="${FLY_APP:-rekorderlig}"
DB_APP="${DB_APP:-rekorderlig-db}"
# Its own port, so a proxy left running from the role setup does not collide.
PORT="${PG_PROXY_PORT:-15434}"

command -v fly  >/dev/null || { echo "fly CLI not found" >&2; exit 1; }
command -v gh   >/dev/null || { echo "gh CLI not found" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 1; }

ask() {
  local var="$1" prompt="$2" value
  read -rsp "$prompt: " value
  echo
  [ -n "$value" ] || { echo "empty; aborting" >&2; exit 1; }
  printf -v "$var" '%s' "$value"
}

ask APP_PASSWORD     "APP_PASSWORD (role rekorderlig)"
ask PREVIEW_PASSWORD "PREVIEW_PASSWORD (role preview_admin)"
ask READER_PASSWORD  "READER_PASSWORD (role preview_reader)"

echo "==> Opening a proxy to $DB_APP on localhost:$PORT"
pg_proxy_start "$DB_APP" "$PORT"

check() {
  local label="$1" url="$2" want="$3"
  # PGPASSWORD-free: the URL carries it, and it is a local variable in this
  # shell rather than an argument to anything.
  if ! psql "$url" -tAc 'SELECT current_user' 2>/dev/null | grep -qx "$want"; then
    echo "    $label: FAILED to connect as $want" >&2
    return 1
  fi
  echo "    $label: ok"
}

echo "==> Checking the three credentials"
check "rekorderlig"    "postgres://rekorderlig:$APP_PASSWORD@localhost:$PORT/rekorderlig"     rekorderlig
check "preview_admin"  "postgres://preview_admin:$PREVIEW_PASSWORD@localhost:$PORT/postgres"  preview_admin
check "preview_reader" "postgres://preview_reader:$READER_PASSWORD@localhost:$PORT/rekorderlig" preview_reader

# The one thing worth asserting beyond "it connects": preview_admin exists to
# be unable to read production. If this ever passes, the CI credential has
# quietly become a production credential.
echo "==> Checking preview_admin cannot reach production"
if psql "postgres://preview_admin:$PREVIEW_PASSWORD@localhost:$PORT/rekorderlig" \
     -tAc 'SELECT 1' >/dev/null 2>&1; then
  echo "preview_admin can connect to the rekorderlig database; it must not." >&2
  echo "Run: REVOKE ALL ON DATABASE rekorderlig FROM preview_admin, PUBLIC;" >&2
  exit 1
fi
echo "    refused, as it should be"

# And the mirror image: preview_reader exists to pg_dump production, which
# reads every table *and* every sequence (the identity column on models owns
# one). Connecting proves nothing about that — the first preview seed connected
# fine and died on the sequence — so list what it cannot read, as the owner,
# who sees every object whether or not the reader can.
echo "==> Checking preview_reader can read everything pg_dump will ask for"
UNREADABLE=$(psql "postgres://rekorderlig:$APP_PASSWORD@localhost:$PORT/rekorderlig" -tA <<'SQL'
  SELECT format('%I.%I', schemaname, tablename) FROM pg_tables
   WHERE schemaname = 'public'
     AND NOT has_table_privilege('preview_reader', format('%I.%I', schemaname, tablename), 'SELECT')
  UNION ALL
  SELECT format('%I.%I', schemaname, sequencename) FROM pg_sequences
   WHERE schemaname = 'public'
     AND NOT has_sequence_privilege('preview_reader', format('%I.%I', schemaname, sequencename), 'SELECT')
SQL
)
if [ -n "$UNREADABLE" ]; then
  echo "preview_reader cannot SELECT from:" >&2
  echo "$UNREADABLE" | sed 's/^/    /' >&2
  echo "pg_dump will fail there and the preview seed will fall through to empty." >&2
  echo "Run the GRANT block from scripts/fly-db-setup.sh against the rekorderlig database." >&2
  exit 1
fi
echo "    every table and sequence, as it should be"

echo "==> Setting DATABASE_URL on $APP"
# .internal, not localhost: the app reaches the database over 6PN, and the
# proxy above only exists for this laptop.
fly secrets set --app "$APP" \
  "DATABASE_URL=postgres://rekorderlig:$APP_PASSWORD@$DB_APP.internal:5432/rekorderlig"

echo "==> Setting the repo secrets"
# The workflow needs both a localhost URL (through its own proxy) and an
# .internal one (for the preview app), so it takes passwords and builds both.
printf '%s' "$PREVIEW_PASSWORD" | gh secret set PREVIEW_PG_PASSWORD
printf '%s' "$READER_PASSWORD"  | gh secret set PREVIEW_PG_READER_PASSWORD

echo "==> Done."
gh secret list | grep PREVIEW_PG || true
