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
COPY packages/db/package.json packages/db/
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
COPY packages/db packages/db
COPY apps/tg apps/tg

# Isolated migration runner (same shape as the core image): drizzle's
# programmatic migrator + THIS app's SQL chain (the tg store owns its own
# schema and migrations), with its two small deps kept out of the app tree.
COPY packages/db/migrate/package.json ./migrate/package.json
COPY packages/db/migrate/migrate.mjs ./migrate/migrate.mjs
COPY apps/tg/store/migrations ./migrate/db/migrations
RUN cd migrate && npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3210

# Apply pending store migrations, then serve. Migrations complete before the
# app accepts traffic; a failed migration fails the start.
WORKDIR /app/apps/tg
CMD ["sh", "-c", "node /app/migrate/migrate.mjs && npx tsx src/index.ts"]
