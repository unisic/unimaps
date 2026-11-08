# syntax=docker/dockerfile:1

# ---- deps: install full dependency tree ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: static frontend (out/, precompressed) ----
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- rust: the server front (backend/), a static musl binary ----
FROM rust:1.98-alpine AS rust
WORKDIR /src/backend
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
# data shared with the TypeScript side, compiled in with include_str!
COPY lib/shared/cities.json lib/shared/detours.json /src/lib/shared/
COPY lib/mzk-fleet.json lib/phototrans.json /src/lib/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/backend/target \
    cargo build --release --locked && cp target/release/unimaps /unimaps

# ---- runner: the binary and the static build, nothing else ----
# the musl binary is static; this base already has the CA bundle (ca-certificates-bundle) rustls reads, and
# jiff bundles its own tzdb, so no apk add
FROM alpine:3.24 AS runner
WORKDIR /app
ENV PORT=8080

RUN addgroup -S unimaps -g 1001 && adduser -S unimaps -u 1001 -G unimaps

COPY --from=build --chown=unimaps:unimaps /app/out ./out
COPY --from=rust /unimaps ./unimaps

# writable GTFS output dir: pre-created (owned by uid 1001, as before) so the named volume
# mounted here inherits the ownership and the in-process nightly build can write
RUN mkdir -p /app/output && chown unimaps:unimaps /app/output

USER unimaps
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/app/unimaps", "healthcheck"]

CMD ["/app/unimaps"]
