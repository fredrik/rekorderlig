# Sourced, not run: puts a psql/pg_dump matching the server first on PATH.
#
# Ubuntu 24.04 ships postgresql-client 16, and `pg_dump` refuses point blank to
# dump a newer server ("aborting because of server version mismatch"). That is
# a good refusal and a bad failure here: the preview seed treats a failed dump
# as a warning and carries on with an empty database.
#
# Installing postgresql-client-17 is not enough on its own, which cost a second
# run to learn: the GitHub runner image ships PostgreSQL 16 and puts its bin
# directory on PATH ahead of Debian's version-dispatching wrapper in /usr/bin,
# so `pg_dump` stayed at 16 while `psql` came back 17. The version to use is
# therefore named outright rather than resolved.
#
# Sourced because a child process cannot change its parent's PATH, and
# $GITHUB_PATH only reaches *later* steps, not the one doing the dumping.
#
# The version is pinned to the image in fly.db.toml. Move one and move both.

: "${PG_MAJOR:=17}"

if [ ! -x "/usr/lib/postgresql/$PG_MAJOR/bin/pg_dump" ]; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
  echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq "postgresql-client-$PG_MAJOR"
fi

PATH="/usr/lib/postgresql/$PG_MAJOR/bin:$PATH"
export PATH
# Later steps in the same job get it too, without sourcing this again.
[ -n "${GITHUB_PATH:-}" ] && echo "/usr/lib/postgresql/$PG_MAJOR/bin" >> "$GITHUB_PATH"

# Assert rather than hope. A client older than the server is an environment
# bug, not a transient — and the caller's fallback would turn it into a green
# run with an empty preview, which is exactly how it went unnoticed the first
# time.
pg_dump --version
psql --version
if [ "$(pg_dump --version | grep -oE '[0-9]+' | head -1)" -lt "$PG_MAJOR" ]; then
  echo "::error title=pg_dump is older than the server::Wanted $PG_MAJOR, got $(pg_dump --version)."
  return 1 2>/dev/null || exit 1
fi
