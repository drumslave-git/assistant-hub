# syntax=docker/dockerfile:1

# Multi-stage build for the web-chat source app (assistant-hub-chat).
# Build context is the REPO ROOT (workspace install needs every manifest):
#   docker build -f apps/chat/Dockerfile .
#
# A plain long-running Node service (no Next — the chat dashboard UI ships
# inside the core image as apps/chat/ui). It runs from TypeScript source via
# tsx, for the same reasons as the tg image: the shared packages export TS
# sources directly.

FROM node:24-alpine AS base
WORKDIR /app

# --- deps: workspace install for this app + the packages it links ---
# `npm install` (not `npm ci`) so platform-specific optional native deps
# resolve at build time even when package-lock.json was generated on another
# OS. Only the manifests this app's tree needs are copied.
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/chat/package.json apps/chat/
COPY packages/contracts/package.json packages/contracts/
COPY packages/bus/package.json packages/bus/
COPY packages/db/package.json packages/db/
COPY packages/service/package.json packages/service/
RUN npm install --no-audit --no-fund

# --- runner ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3220

# The whole deps tree (root node_modules plus per-workspace links), then the
# sources the links point at.
COPY --from=deps /app ./
COPY packages/contracts packages/contracts
COPY packages/bus packages/bus
COPY packages/db packages/db
COPY packages/service packages/service
COPY apps/chat apps/chat

# Isolated migration runner (same shape as the other images): drizzle's
# programmatic migrator + THIS app's SQL chain, with its two small deps kept
# out of the app tree.
COPY packages/db/migrate/package.json ./migrate/package.json
COPY packages/db/migrate/migrate.mjs ./migrate/migrate.mjs
COPY apps/chat/store/migrations ./migrate/db/migrations
RUN cd migrate && npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3220

# Apply pending store migrations, then serve. Migrations complete before the
# app accepts traffic; a failed migration fails the start.
WORKDIR /app/apps/chat
CMD ["sh", "-c", "node /app/migrate/migrate.mjs && npx tsx src/index.ts"]
