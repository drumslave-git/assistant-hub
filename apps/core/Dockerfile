# syntax=docker/dockerfile:1

# Multi-stage build for the self-hosted core app (assistant-hub-core).
# Build context is the REPO ROOT (workspace install needs every manifest):
#   docker build -f apps/core/Dockerfile .
# Native deps (lightningcss, tailwind oxide) are installed inside the image so
# they match the container's platform — never copy host node_modules in.

FROM node:24-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- deps: full workspace install (incl. dev) for building ---
# `npm install` (not `npm ci`) so platform-specific optional native deps
# (musl builds of lightningcss / tailwind-oxide) resolve at build time even when
# package-lock.json was generated on another OS.
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/core/package.json apps/core/
# The shell composes source-app ui subpackages at build time (the extension
# registry), so their manifests join the workspace install.
COPY apps/tg/ui/package.json apps/tg/ui/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
RUN npm install --no-audit --no-fund

# --- builder: compile the production build ---
# Builds FROM deps (not a fresh copy) so the workspace node_modules layout —
# root modules plus per-workspace symlinks — carries over intact.
FROM deps AS builder
COPY . .
RUN npm run build --workspace @assistant-hub/core

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
# - chromium (+ nss/freetype/harfbuzz/fonts/ca-certificates): the read-link tool
#   drives headless Chromium via Playwright. Playwright's own download is a glibc
#   build that won't run on Alpine (musl), so we install the distro browser and
#   point the app at it with CHROMIUM_EXECUTABLE_PATH below.
# yt-dlp is installed separately below — not from apk.
# sharp ships its own musl libvips binary via npm, so it needs no system package.
RUN apk add --no-cache \
    ffmpeg \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji

# yt-dlp: the browser agent's browser_download_media tool. A media site's player
# derives ciphered per-session stream URLs in its own JavaScript, so there is no
# file to GET and no manifest to mux — yt-dlp is the only way to download from one.
#
# Upstream's self-contained musllinux build, not the apk package: yt-dlp extracts
# from sites that change on purpose, and a stale build fails *every* media page at
# once rather than degrading. Alpine's package is frozen per release and was four
# months behind upstream when this was written, so a rebuild would not reliably
# make it current. This binary is only the floor — the app's daily updater keeps a
# newer copy in data/bin and prefers it (features/browser-agent/server/
# ytdlp-binary.ts). Pin + checksum so the image itself stays reproducible; bump
# both together, or just let the updater do it at runtime.
#
# PyInstaller bundle, so no python3 in the image at all (the apk package pulled it
# in). The .zip assets are skipped deliberately — a single file is what makes the
# runtime swap atomic.
ARG YTDLP_VERSION=2026.07.04
ARG YTDLP_SHA256_x86_64=f7439ec2e3ffe69e06ac233f83f0d9687b89105939129bddcbf74e5de0f2b40e
ARG YTDLP_SHA256_aarch64=9a6a4de88f35dc68c1763945fbb417e092ebd9afc5d66052ac31b68d405a12a7
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) asset=yt-dlp_musllinux; sha="$YTDLP_SHA256_x86_64" ;; \
      aarch64) asset=yt-dlp_musllinux_aarch64; sha="$YTDLP_SHA256_aarch64" ;; \
      *) echo "no upstream yt-dlp build for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    wget -q -O /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}"; \
    echo "${sha}  /usr/local/bin/yt-dlp" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version

# Launch the distro Chromium instead of Playwright's (absent) bundled browser.
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Self-contained app server: only traced runtime deps, no full node_modules.
# Traced from the monorepo root (outputFileTracingRoot), so the standalone
# output mirrors the workspace layout: server.js under apps/core, shared
# node_modules at the root.
COPY --from=builder /app/apps/core/.next/standalone ./
COPY --from=builder /app/apps/core/.next/static ./apps/core/.next/static
COPY --from=builder /app/apps/core/public ./apps/core/public

# Playwright is a serverExternalPackage, so Next's file tracer copies only the JS
# it can statically resolve into the standalone node_modules — it misses data
# files read from disk at runtime (e.g. playwright-core/browsers.json). Copy the
# full packages over the partial traced copies so the read-link tool can load
# them. Chromium itself comes from the apk package above, not these.
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core

# Isolated migration runner: drizzle's programmatic migrator + the SQL files,
# in its own dir so its two small deps never touch the app's traced node_modules.
COPY packages/db/migrate/package.json ./migrate/package.json
COPY packages/db/migrate/migrate.mjs ./migrate/migrate.mjs
COPY --from=builder /app/apps/core/db/migrations ./migrate/db/migrations
RUN cd migrate && npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Trace/debug logs, browser-agent downloads and self-updating tool binaries are
# written here at runtime. The standalone server chdirs to its own directory
# (apps/core), so the app resolves all three relative to it — they land in
# /app/apps/core/data/{traces,downloads,bin} — not configurable. Created up
# front so they are writable by the non-root app user; a host bind mount must be
# made writable by that user on the host side. `bin` is deliberately not
# mounted: a recreated container falls back to the pinned binary above and the
# updater re-fetches on boot.
RUN mkdir -p /app/apps/core/data/traces /app/apps/core/data/downloads /app/apps/core/data/bin

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3200

# Apply pending migrations, then serve. Migrations complete before the app
# accepts traffic; a failed migration fails the start.
CMD ["sh", "-c", "node migrate/migrate.mjs && node apps/core/server.js"]
