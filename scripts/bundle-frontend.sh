#!/usr/bin/env bash
# Bundle the front end into one minified chunk.
#
# `public/` is sixteen ES modules and a browser fetches them one at a time, so
# a cold visit is eighteen requests to a machine that has usually just woken
# from suspend. esbuild walks the imports out of app.js and writes the lot as
# one file: three requests instead of eighteen, and 94.6 kB of JavaScript
# becomes about 37 kB. The request count is the point; the bytes are a bonus.
#
# Two callers, one copy of the flags and of the pinned version — a second copy
# is a thing to keep identical, and the one that drifts is the one in front of
# production:
#
#   - the Dockerfile's `web` stage builds what the image actually serves;
#   - .github/workflows/tests.yml builds it and throws it away, so an import
#     that no longer resolves fails a pull request instead of a deploy.
#
# Nothing bundles in development. `public/` in the repository stays the module
# graph: that is what `cargo run -- serve` serves and what the front-end tests
# boot, and it is why the bundle is only ever built into the image.
#
# Usage: scripts/bundle-frontend.sh <outfile>
set -euo pipefail

out="${1:-}"
if [[ -z $out ]]; then
  echo "usage: $(basename "$0") <outfile>" >&2
  exit 2
fi

public="$(cd "$(dirname "$0")/../public" && pwd)"

# `--format=esm` keeps index.html's `<script type="module">` honest, and
# `--target=esnext` downlevels nothing: the browser already runs these files as
# they are, so the bundle must not need anything more than they do. The version
# is pinned because a bundler that changes under a deploy is a front end nobody
# reviewed.
npx --yes esbuild@0.24.0 "$public/app.js" \
  --bundle \
  --minify \
  --format=esm \
  --target=esnext \
  --outfile="$out"
