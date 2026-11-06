# syntax=docker/dockerfile:1

# ---- deps: install full dependency tree ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: static frontend (out/, precompressed) + one-file server bundle (dist/server.mjs) ----
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- rust: the server front (backend/), a static musl binary ----
FROM rust:1.98-alpine AS rust
WORKDIR /src
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/unimaps /unimaps

# ---- runner: the bundle needs no node_modules ----
FROM node:24-alpine AS runner
WORKDIR /app
# unimaps listens on PORT and starts the Node API (still the whole /api) on 127.0.0.1:8090 with KB_NODE_CMD
ENV NODE_ENV=production \
    PORT=8080 \
    KB_NODE_CMD="node server.mjs"

RUN addgroup -S unimaps -g 1001 && adduser -S unimaps -u 1001 -G unimaps

COPY --from=build --chown=unimaps:unimaps /app/dist/server.mjs ./server.mjs
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
