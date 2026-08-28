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

# sqlite is for scripts/pull-prod-db.sh: VACUUM INTO over `fly ssh console`
# needs a CLI on the machine, and the image no longer ships node.
FROM alpine:3.20
RUN apk add --no-cache sqlite

WORKDIR /app
COPY --from=build /app/target/release/rekorderlig ./rekorderlig
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=4173 \
    REKORDERLIG_DB=/data/rekorderlig.db \
    REKORDERLIG_PUBLIC=/app/public

EXPOSE 4173
CMD ["/app/rekorderlig", "serve"]
