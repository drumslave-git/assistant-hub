# syntax=docker/dockerfile:1

# Multi-stage build for the self-hosted Next.js app.
# Native deps (lightningcss, tailwind oxide) are installed inside the image so
# they match the container's platform — never copy host node_modules in.

FROM node:24-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- deps: full install (incl. dev) for building ---
# `npm install` (not `npm ci`) so platform-specific optional native deps
# (musl builds of lightningcss / tailwind-oxide) resolve at build time even when
# package-lock.json was generated on another OS.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# --- builder: compile the production build ---
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runner: slim production runtime from Next standalone output ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3200
# Standalone server binds to HOSTNAME; use 0.0.0.0 so it is reachable in-container.
ENV HOSTNAME=0.0.0.0

# System packages resolved at runtime:
# - ffmpeg: the vision feature samples video/GIF frames with it
#   (features/vision/server/frames.ts), voice transcodes both ways with it, and the
#   browser agent muxes HLS/DASH streams with it.
# - yt-dlp: the browser agent's browser_download_media tool. A media site's player
#   derives ciphered per-session stream URLs in its own JavaScript, so there is no
#   file to GET and no manifest to mux — yt-dlp is the only way to download from
#   one. It pulls python3 in. Note the distro package is frozen per Alpine release
#   while these sites change often; if downloads start failing, rebuild against a
#   newer base image.
# - chromium (+ nss/freetype/harfbuzz/fonts/ca-certificates): the read-link tool
#   drives headless Chromium via Playwright. Playwright's own download is a glibc
#   build that won't run on Alpine (musl), so we install the distro browser and
#   point the app at it with CHROMIUM_EXECUTABLE_PATH below.
# sharp ships its own musl libvips binary via npm, so it needs no system package.
RUN apk add --no-cache \
    ffmpeg \
    yt-dlp \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji

# Launch the distro Chromium instead of Playwright's (absent) bundled browser.
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Self-contained app server: only traced runtime deps, no full node_modules.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Playwright is a serverExternalPackage, so Next's file tracer copies only the JS
# it can statically resolve into the standalone node_modules — it misses data
# files read from disk at runtime (e.g. playwright-core/browsers.json). Copy the
# full packages over the partial traced copies so the read-link tool can load
# them. Chromium itself comes from the apk package above, not these.
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core

# Isolated migration runner: drizzle's programmatic migrator + the SQL files,
# in its own dir so its two small deps never touch the app's traced node_modules.
COPY docker/migrate/package.json ./migrate/package.json
COPY docker/migrate/migrate.mjs ./migrate/migrate.mjs
COPY --from=builder /app/db/migrations ./migrate/db/migrations
RUN cd migrate && npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Trace/debug logs (TRACES_DIR) and browser-agent downloads (DOWNLOADS_DIR) are
# written here at runtime. Create both up front so the default path / a named volume
# is writable by the non-root app user; a host bind mount must be made writable by
# that user on the host side.
RUN mkdir -p /app/data/traces /app/data/downloads

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3200

# Apply pending migrations, then serve. Migrations complete before the app
# accepts traffic; a failed migration fails the start.
CMD ["sh", "-c", "node migrate/migrate.mjs && node server.js"]
