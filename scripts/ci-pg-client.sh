#!/usr/bin/env bash
# Install a psql/pg_dump matching the server, on a GitHub runner.
#
# Ubuntu 24.04 ships postgresql-client 16, and `pg_dump` refuses point blank to
# dump a newer server ("aborting because of server version mismatch"). That is
# a good refusal and a bad failure here: the preview seed treats a failed dump
# as a warning and carries on with an empty database, so the job goes green and
# the preview is silently empty. It cost one run to notice.
#
# The version is pinned to the image in fly.db.toml. Move one and move both.
set -euo pipefail

PG_MAJOR="${PG_MAJOR:-17}"

if command -v pg_dump >/dev/null && [ "$(pg_dump --version | grep -oE '[0-9]+' | head -1)" -ge "$PG_MAJOR" ]; then
  echo "pg_dump $(pg_dump --version) already new enough"
  exit 0
fi

curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq "postgresql-client-$PG_MAJOR"

# The PGDG packages install beside the distro's and the wrapper picks the
# newest, but say so out loud — a mismatch here is exactly what this exists to
# prevent, and it should be visible in the log without being hunted for.
pg_dump --version
psql --version
