# Build the release binary with musl, so the runtime stage is a bare Alpine.
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev

WORKDIR /app
# Dependencies first, so a source-only change doesn't recompile the world.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && echo 'fn main() {}' > src/main.rs \
    && echo '' > src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src
# Which commit this is and when it was built, baked into the binary
# (src/version.rs reads them with option_env!). Declared *after* the
# dependency layer on purpose: an ARG invalidates every layer below it, and
# these change on every deploy, so above the line they would recompile the
# world each time. Absent in a local `docker build`, which makes a dev build.
ARG GIT_SHA
ARG BUILD_TIME
COPY src ./src
RUN touch src/main.rs src/lib.rs && cargo build --release --locked

# The front end, bundled into one minified chunk by
# scripts/bundle-frontend.sh — the reasoning, the flags and the pinned esbuild
# version live in that script's header, because tests.yml runs it too. Only
# the image is bundled: `public/` in the repository stays the module graph,
# which is what `cargo run -- serve` serves and what the front-end tests boot.
# Debian rather than Alpine because this stage is thrown away — nothing ships
# from it but the one file it writes.
FROM node:22-slim AS web
WORKDIR /web
COPY public ./public
COPY scripts/bundle-frontend.sh ./scripts/
RUN scripts/bundle-frontend.sh /web/app.js

# Nothing to install. The database lives on its own machine now, so this image
# needs no client tools — `scripts/pull-prod-db.sh` runs pg_dump locally over
# `fly proxy` rather than over `fly ssh console`.
FROM alpine:3.20

WORKDIR /app
COPY --from=build /app/target/release/rekorderlig ./rekorderlig
COPY public ./public
# The modules are inside the bundle now, and a copy of each one beside it
# would only serve a version of the front end that is not the one running.
# Before the bundle lands, not after: it is called app.js too, which is what
# lets index.html, the tests and a dev server all keep pointing at /app.js.
RUN rm -f public/*.js
COPY --from=web /web/app.js ./public/app.js

# DATABASE_URL is deliberately not defaulted here: it carries a password and is
# set with `fly secrets set`. Without it the binary falls back to a local
# server, which is right for development and unreachable in production — a
# missing secret fails loudly at boot instead of quietly running on nothing.
ENV HOST=0.0.0.0 \
    PORT=4173 \
    REKORDERLIG_PUBLIC=/app/public

EXPOSE 4173
CMD ["/app/rekorderlig", "serve"]
