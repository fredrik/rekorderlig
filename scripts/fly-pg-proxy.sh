#!/usr/bin/env bash
# Sourced, not run: opens a local port onto the database machine over 6PN and
# arranges for it to close again. Both database scripts need it and neither
# should own it.
#
# `fly proxy` is how anything outside the organisation's private network
# reaches a machine that publishes no services — which is the whole security
# property of fly.db.toml, so this is not a workaround but the front door.

pg_proxy_start() {
  local app="${1:?app}" port="${2:?port}"
  command -v fly >/dev/null || { echo "fly CLI not found" >&2; return 1; }
  fly proxy "$port:5432" -a "$app" >/dev/null 2>&1 &
  PG_PROXY_PID=$!
  # shellcheck disable=SC2317
  trap 'kill "$PG_PROXY_PID" 2>/dev/null || true' EXIT

  local waited=0
  until nc -z localhost "$port" 2>/dev/null; do
    kill -0 "$PG_PROXY_PID" 2>/dev/null || { echo "fly proxy exited" >&2; return 1; }
    [ "$waited" -ge 30 ] && { echo "fly proxy did not open localhost:$port within ${waited}s" >&2; return 1; }
    sleep 1
    waited=$((waited + 1))
  done
}
