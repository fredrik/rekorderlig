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
COPY src ./src
RUN touch src/main.rs src/lib.rs && cargo build --release --locked

# Nothing to install. The database lives on its own machine now, so this image
# needs no client tools — `scripts/pull-prod-db.sh` runs pg_dump locally over
# `fly proxy` rather than over `fly ssh console`.
FROM alpine:3.20

WORKDIR /app
COPY --from=build /app/target/release/rekorderlig ./rekorderlig
COPY public ./public

# DATABASE_URL is deliberately not defaulted here: it carries a password and is
# set with `fly secrets set`. Without it the binary falls back to a local
# server, which is right for development and unreachable in production — a
# missing secret fails loudly at boot instead of quietly running on nothing.
ENV HOST=0.0.0.0 \
    PORT=4173 \
    REKORDERLIG_PUBLIC=/app/public

EXPOSE 4173
CMD ["/app/rekorderlig", "serve"]
