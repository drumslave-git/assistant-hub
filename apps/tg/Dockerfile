# syntax=docker/dockerfile:1

# Multi-stage build for the Telegram source app (assistant-hub-tg).
# Build context is the REPO ROOT (workspace install needs every manifest):
#   docker build -f apps/tg/Dockerfile .
#
# A plain long-running Node service (no Next). It runs from TypeScript source
# via tsx — the app's own `start` script — because the shared packages export
# TS sources directly and the entrypoint uses top-level await, which rules out
# a plain CJS compile; a build step here would only add a second module
# resolution to keep correct.

FROM node:24-alpine AS base
WORKDIR /app

# --- deps: workspace install for this app + the packages it links ---
# `npm install` (not `npm ci`) so platform-specific optional native deps
# (musl builds of sharp) resolve at build time even when package-lock.json
# was generated on another OS. Only the manifests this app's tree needs are
# copied, so the install skips the other apps' dependencies.
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/tg/package.json apps/tg/
COPY packages/contracts/package.json packages/contracts/
COPY packages/bus/package.json packages/bus/
COPY packages/media/package.json packages/media/
COPY packages/service/package.json packages/service/
RUN npm install --no-audit --no-fund

# --- runner ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3210

# ffmpeg: media ingestion samples video/GIF frames and probes durations with it
# (src/media/ffmpeg.ts; user decision — system ffmpeg over a bundled binary).
# sharp ships its own musl libvips binary via npm, so it needs no system package.
RUN apk add --no-cache ffmpeg

# The whole deps tree (root node_modules plus per-workspace links), then the
# sources the links point at.
COPY --from=deps /app ./
COPY packages/contracts packages/contracts
COPY packages/bus packages/bus
COPY packages/media packages/media
COPY packages/service packages/service
COPY apps/tg apps/tg


# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3210

# Stateless (Phase 7): no database, no migrations — register with the core and go.
WORKDIR /app/apps/tg
CMD ["npx", "tsx", "src/index.ts"]
