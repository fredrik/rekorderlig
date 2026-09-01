#!/usr/bin/env bash
# Sourced, not run: opens a local port onto the database machine over 6PN and
# arranges for it to close again. Both database scripts need it and neither
# should own it.
#
# `fly proxy` is how anything outside the organisation's private network
# reaches a machine that publishes no services — which is the whole security
# property of fly.db.toml, so this is not a workaround but the front door.

# Is anything listening? Bash's own /dev/tcp rather than `nc`, which is one
# more thing that has to be installed to be trusted — and when it is missing
# the loop below times out on a proxy that came up perfectly.
pg_proxy_listening() {
  (exec 3<>"/dev/tcp/127.0.0.1/${1:?port}") 2>/dev/null && exec 3>&-
}

pg_proxy_start() {
  local app="${1:?app}" port="${2:?port}" waited=0
  local log="${TMPDIR:-/tmp}/fly-proxy-$app-$port.log"
  command -v fly >/dev/null || { echo "fly CLI not found" >&2; return 1; }

  # Its output goes to a file rather than /dev/null. Discarding it once cost a
  # CI run that reported only "psql: connection to localhost:15432 refused",
  # thirty seconds after the real error had already been thrown away.
  fly proxy "$port:5432" -a "$app" >"$log" 2>&1 &
  PG_PROXY_PID=$!
  # shellcheck disable=SC2317
  trap 'kill "$PG_PROXY_PID" 2>/dev/null || true' EXIT

  # Generous, because the first `fly proxy` on a cold machine builds a
  # WireGuard peer before it listens, and on a CI runner that is routinely
  # slower than it ever is on a laptop.
  until pg_proxy_listening "$port"; do
    if ! kill -0 "$PG_PROXY_PID" 2>/dev/null; then
      echo "fly proxy exited:" >&2; cat "$log" >&2; return 1
    fi
    if [ "$waited" -ge 90 ]; then
      echo "fly proxy did not open localhost:$port within ${waited}s:" >&2
      cat "$log" >&2
      kill "$PG_PROXY_PID" 2>/dev/null || true
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}
