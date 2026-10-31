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

# ---- runner: the bundle needs no node_modules ----
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

RUN addgroup -S unimaps -g 1001 && adduser -S unimaps -u 1001 -G unimaps

COPY --from=build --chown=unimaps:unimaps /app/dist/server.mjs ./server.mjs
COPY --from=build --chown=unimaps:unimaps /app/out ./out

# writable GTFS output dir: pre-created (owned by uid 1001, as before) so the named volume
# mounted here inherits the ownership and the in-process nightly build can write
RUN mkdir -p /app/output && chown unimaps:unimaps /app/output

USER unimaps
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
