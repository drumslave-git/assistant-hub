# Deployment

The platform is designed to be **self-hosted with Docker Compose** on a home server,
NAS or VPS: two application images (the core and the Telegram transport), a Redis
instance that carries the queues between them, and a Postgres instance. Everything
else in the architecture follows from that: in-process schedulers, in-process
singletons pinned to `globalThis`, and advisory locks for the brief moments two core
processes overlap.

## Docker Compose

```bash
docker compose up -d --build
```

Four services:

| Service | Image | Notes |
| --- | --- | --- |
| `app` | `ahw-core`, built from `apps/core/Dockerfile` (repo-root context) | The dashboard, the web chat and the whole pipeline. Publishes `${PORT:-3200}:3200` |
| `tg` | `ahw-tg`, built from `apps/tg/Dockerfile` (repo-root context) | The Telegram transport: stateless pollers that register with the core, forward every update as transport events, perform the sends, and host the platform's MCP tools. **No published port** — its internal API is for the core only |
| `redis` | `redis:7-alpine`, started with `--appendonly yes` | The cross-app bus and the two queues (`transport-updates`, `inbound-messages`). Publishes `${REDIS_PORT:-6379}:6379` |
| `db` | `pgvector/pgvector:pg17` | The one database. Publishes `${POSTGRES_PORT:-5432}:5432` |

`app` waits for `db` (healthcheck `pg_isready`) and `redis` (`redis-cli ping`) to be
**healthy**, and for `tg` merely to be **started** — the core boots, degraded, without
its transports, and the transport registers itself whenever it comes up. `tg` waits
for `redis` to be healthy. All four restart `unless-stopped`.

### Volumes

All four persisted paths are **bind mounts to host directories**, not named volumes, so
you can see and back up the data with ordinary tools:

| Host path (default) | Container path | Holds |
| --- | --- | --- |
| `./data/pg` | `/var/lib/postgresql/data` | The database |
| `./data/redis` | `/data` | The Redis append-only file: every queued transport event and inbound turn not yet consumed |
| `./data/traces` | `/app/apps/core/data/traces` | Monthly trace NDJSON logs |
| `./data/downloads` | `/app/apps/core/data/downloads` | Browser-agent downloads |

All four are mounted, and all four hold the only copy of what they contain. Two of
them matter for non-obvious reasons:

- The **Redis** mount is where the no-message-loss guarantee lives while a message is
  between the two apps. An inbound Telegram update that the transport has forwarded
  but the core has not yet consumed exists only in that AOF; drop the directory and
  those messages are gone.
- The **downloads** mount: a file the browser agent fetched that was **too large to
  attach to the chat** exists nowhere else, so an unmounted container path would
  silently lose it on the next image replacement.

`/app/apps/core/data/bin` — where the yt-dlp updater keeps the current binary — is
deliberately **not** mounted (user decision, 2026-08-01). It is a cache, not data: a
recreated container falls back to the build the image pins and re-downloads a current
one on boot, which costs ~40 MB per redeploy and saves a host directory whose ownership
would have to be kept right for the non-root `app` user.

A host bind mount must be writable by the container's non-root `app` user. If it is
not, trace flushing fails — which surfaces as a global dashboard alert rather than a
crash, because failing readiness there would drop the traces still buffered in RAM —
and downloads fail per-run, reported on the run row.

### Environment

Compose has working defaults; a root `.env` is optional and is read only for the
`${…}` substitutions in `docker-compose.yml`. There is no root `.env.example`: the
per-app examples are `apps/core/.env.example` and `apps/tg/.env.example`, and they
document local (non-Docker) development as well.

**One variable is not optional in production: `INTERNAL_API_TOKEN`.** It is the shared
secret the core and the transport present to each other (registration, desired state,
sends, menu operations). Compose defaults it to `change-me` on both services; set a real
value in `.env`, and set the **same** value for both — a mismatch makes the transport's
registration fail with `401` and retry every 10 seconds forever, and the dashboard says
the transport "has not announced itself yet".

The core (`apps/core/server/env.ts`) reads:

| Variable | Compose sets it to | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Composed from `POSTGRES_*`, pointing at the bundled `db` | Override to use an external database |
| `REDIS_URL` | `redis://redis:6379` | Unset → the core boots **without** its turn consumer and ingest and processes no messages (it logs `Inbound turn consumer NOT started`) |
| `INTERNAL_API_TOKEN` | `${INTERNAL_API_TOKEN:-change-me}` | Must match the transport's |
| `TZ` | `${TZ:-UTC}` | Container timezone only — the *operator* timezone used for rendering and scheduling is a database setting |
| `NODE_ENV` | `production` | |

Every core variable also accepts a `<NAME>_FILE` variant pointing at a file whose
contents are used instead (Docker secrets). Transport base URLs are **not** env on the
core side: a transport announces its own at registration.

The Telegram transport (`apps/tg`) reads:

| Variable | Compose sets it to | Notes |
| --- | --- | --- |
| `REDIS_URL` | `redis://redis:6379` | Required; the service does not start without it |
| `INTERNAL_API_TOKEN` | `${INTERNAL_API_TOKEN:-change-me}` | Required; must match the core's |
| `PORT` | `3210` | Its HTTP surface: `/health`, `/internal/*`, `/mcp` |
| `CORE_API_URL` | `http://app:3200` | Where it registers and fetches desired state; defaults to `http://localhost:3200` outside Compose |
| `SELF_URL` | `http://tg:3210` | The base URL it **announces** at registration — what the core uses to reach it for status and sends. Defaults to `http://localhost:<PORT>`; set it whenever the core cannot reach the service on localhost |
| `TZ` | `${TZ:-UTC}` | |

The transport has no database and no files: bot tokens and everything else it needs
arrive from the core at registration.

Full variable reference: [Configuration](../configuration.md#environment-variables).

### Health

```
GET /api/health   (core, :3200)  → 200 when ready, 503 when the database is unreachable
GET /health       (tg, :3210)    → { ok: true, connections: [...] } — every poller's live state
```

The transport's `/health` is unauthenticated (it carries no secrets) and is what the
dashboard's status surfaces read: the core fetches it at the base URL the transport
announced, with a 5 s timeout, whenever it renders connection state.

The container healthchecks poll these every 10 s (start period 40 s for the core, 20 s
for the transport). Both use `127.0.0.1`, not `localhost`, deliberately: the servers
bind IPv4 `0.0.0.0`, and `localhost` can resolve to IPv6 `::1`, which would refuse the
connection.

## The images

### `ahw-core`

Multi-stage, from `node:24-alpine`.

```
base ──► deps (npm install, incl. dev) ──► builder (npm run build) ──► runner
```

Deliberate choices worth knowing before you change them:

| Choice | Why |
| --- | --- |
| `npm install`, not `npm ci` | `package-lock.json` is generated on Windows and omits Linux-only optional native deps (musl builds of `lightningcss` / `tailwind-oxide`, `@emnapi/*`), which `npm ci`'s strict sync check rejects |
| Native deps installed **inside** the image | Host `node_modules` must never be copied in — they are built for the wrong platform |
| One manifest per workspace package the core depends on, copied before the install | The workspace install needs every manifest; the `deps` stage copies `apps/core/package.json` plus `packages/{bus,contracts,db,media,service,ui}/package.json` |
| `output: "standalone"` | The runner ships only traced runtime deps (`.next/standalone`), not a full `node_modules`; traced from the monorepo root, so the output mirrors the workspace layout |
| `ffmpeg` from apk | Vision samples video frames with it, voice transcodes both ways, and the browser agent muxes streams with it (user decision: system ffmpeg over a bundled/WASM build) |
| `yt-dlp` from **upstream**, not apk | The browser agent's media downloader; a media site's player has no file URL to fetch (user decision, 2026-07-29). The apk package is frozen per Alpine release while these sites change on purpose, so the image pins upstream's self-contained `musllinux` build (checksum-verified, no python3) and the app's daily updater keeps a newer copy in `/app/apps/core/data/bin` (user decision, 2026-08-01) |
| `chromium` + `nss`/`freetype`/`harfbuzz`/fonts from apk | Playwright's own download is a glibc build that will not run on Alpine (musl). `CHROMIUM_EXECUTABLE_PATH` points at the distro browser |
| `playwright` and `playwright-core` copied **whole** over the traced copies | They are `serverExternalPackages`, so Next's file tracer copies only statically resolvable JS and misses runtime data files like `playwright-core/browsers.json` |
| `sharp` needs no apk package | It ships its own musl libvips binary via npm |
| Non-root `app` user | Standard hardening; `data/traces`, `data/downloads` and `data/bin` are created and chowned up front |

#### Startup command

```sh
node migrate/migrate.mjs && node apps/core/server.js
```

Migrations complete **before** the app accepts traffic, and a failed migration fails
the start — so the app never serves against an unmigrated database.

The migration runner is isolated on purpose: `packages/db/migrate/` has its own tiny
`package.json` and uses drizzle's **programmatic** migrator
(`drizzle-orm/node-postgres/migrator`) rather than the drizzle-kit CLI, which is
intentionally absent from the slim image. The image copies the SQL chain from
`apps/core/store/migrations` next to it, and its two dependencies live in their own
directory so they never touch the app's traced `node_modules`. With `DATABASE_URL`
unset it warns and exits 0 rather than failing the container.

### `ahw-tg`

A plain long-running Node service, also from `node:24-alpine`, two stages:

```
base ──► deps (npm install of apps/tg + the packages it links) ──► runner
```

| Choice | Why |
| --- | --- |
| Runs from TypeScript source via `tsx` (`npx tsx src/index.ts`) — the app's own `start` script | The shared packages export TS sources directly and the entrypoint uses top-level await, which rules out a plain CJS compile; a build step would only add a second module resolution to keep correct |
| Only the manifests this app's tree needs are copied (`apps/tg`, `packages/{contracts,bus,media,service}`) | The install skips the other apps' dependencies |
| `ffmpeg` from apk | Media ingestion samples video/GIF frames and probes durations with it |
| No migrations, no volumes | Stateless: it registers with the core and goes |
| Non-root `app` user, `EXPOSE 3210` | Same hardening as the core |

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Or, for locally-built images, `docker compose up -d --build`. The core's entrypoint
applies any new migrations first; the transport re-registers with the core at boot
and reconciles its pollers from the desired state the core answers with.

During the overlap window two core processes may briefly co-exist. That is handled:

- Background jobs take **Postgres advisory locks**, so a job never
  double-processes. A lock miss is a benign skip.
- The browser-agent runner sweeps any run left `running` by the previous process to
  `failed` at boot.
- The trace store flushes buffered traces on graceful shutdown, so at most one flush
  interval (60s) of settled traces is at risk on a hard kill.

On the transport side, each poller releases its `getUpdates` lock on `SIGTERM` (the
stop drain is capped at 3 s), so a replacement `tg` container does not collide with the
old one. Anything the transport had forwarded but the core had not consumed waits in
the Redis queue across the restart.

## Releases

`.github/workflows/release.yml` ships every app image whenever the `version`
field in the root `package.json` changes on `main`.

```bash
npm run release:patch
```

(or `release:minor` / `release:major` — they bump the version without creating a git
tag), then commit and push to `main`. Actions → Release → *Run workflow* forces a
release of the current version instead (re-runs, or proving a fresh repo); every
step below is idempotent, so a manual run is safe to repeat.

A release is all-or-nothing: nothing reaches the registry and no tag is created
unless every image built. Images live in the org's GitHub Container Registry as
`ghcr.io/assistant-hub-swarm/ahw-core` and `ghcr.io/assistant-hub-swarm/ahw-tg`. The workflow:

1. **version** — wakes only when the root `package.json` is touched, then diffs the
   `version` field against `HEAD~1`. Unchanged → nothing ships. A manual dispatch
   skips the diff and releases the current version.
2. **verify** — `npm install`, `npm run lint`, `npm run typecheck`, `npm run test`
   (fanned out across the workspaces via turbo. Unit tests only; the integration
   suite needs Docker and is not part of the gate.)
3. **build** — a matrix with one entry per app image (`ahw-core` from
   `apps/core/Dockerfile`, `ahw-tg` from `apps/tg/Dockerfile`) builds
   each with GitHub Actions layer caching and hands it to the next job as an
   artifact — nothing is pushed. One failing image fails the release.
4. **publish** — runs only when every build succeeded: loads all images, pushes
   every `ghcr.io/<org>/<image>:<version>` first, then moves every `:latest`, and finally
   creates the `v<version>` git tag (skipped if it already exists). The ordering
   means a push failure mid-way can never leave `latest` pointing at a mixed set,
   and a tag exists only for a version whose every image is in the registry.

No registry secrets: the publish job logs in to `ghcr.io` with its own
`GITHUB_TOKEN` and needs `packages: write` for the push plus `contents: write`
for the tag. A package's first push makes it private to the org; flip it to
public in the package's settings once so operators can pull without a token.

Note that `verify` uses `npm install` rather than `npm ci` for the same lockfile
reason as the Dockerfiles.

## Running behind a reverse proxy

Only the core is exposed; the transport talks to Telegram outbound and to the core
over the Compose network. Two things need care on the core:

- **SSE.** `/api/events` sets `X-Accel-Buffering: no` and
  `Cache-Control: no-cache, no-transform`, which nginx honours. Make sure your proxy
  does not buffer responses or apply a short read timeout — the stream is
  long-lived, with a heartbeat comment every 25s.
- **TLS.** The session cookie is `HttpOnly` and `SameSite=Lax` but is **not** marked
  `Secure`, so terminate TLS at the proxy if the dashboard is reachable from outside
  your LAN.

## Production checklist

- [ ] `INTERNAL_API_TOKEN` is a real secret, identical on `app` and `tg`.
- [ ] Claim `/setup` and create the first admin account before exposing the port.
      `/setup` self-seals the moment any account exists; further accounts come from
      the Accounts page.
- [ ] `DATABASE_URL` points where you intend (or you are using the bundled `db`).
- [ ] `./data/traces` and `./data/downloads` are on a disk with room and are
      writable by the container user. Overview's **Trace storage** and **Downloads**
      cards probe this for real — check them rather than assuming.
- [ ] `./data/redis` and `./data/pg` are on the same backup regime — see
      [Backup and restore](backup-and-restore.md).
- [ ] Do not publish `POSTGRES_PORT` or `REDIS_PORT` beyond localhost.
- [ ] Add your LLM server on the Backends page, pick the chat model in Settings →
      Models, then confirm Overview shows a live probe result — not just "configured".
- [ ] Set the operator timezone and the daily-jobs run time (Settings → General).
- [ ] Create an assistant on `/assistants` and connect a bot token in its editor.
      Owner rights need no setting: the assistant's owning account holds them, and so
      does every admin; a person links their Telegram identity to their account by
      sending the code from `/profile` to the bot.
- [ ] `GET /api/health` returns 200.
- [ ] Overview's **Telegram bots** card reads Running, and each assistant's
      connection in its editor reads Running with the bot's `@username`.
- [ ] A backup routine exists for the database, the Redis directory **and** the
      trace directory — see [Backup and restore](backup-and-restore.md).

## Scaling

This is a single-instance design, and several parts assume it:

| Component | Assumption |
| --- | --- |
| Telegram pollers | Live in the `tg` service, one poller per connected bot token. Telegram permits exactly one `getUpdates` consumer per token, so still exactly one `tg` instance |
| Redis | One instance; the queues and the bus assume it, and its AOF is the only copy of in-flight events |
| Ingest and turn consumer | Per-chat ordering is an in-process promise chain per `(source, chat)`; a second core replica would interleave one chat's turns |
| Realtime hub | In-process pub/sub. Multiple replicas would need an external fan-out (e.g. Postgres `LISTEN`/`NOTIFY`) behind the same API |
| Trace store | In-process, file-backed. Multiple replicas would need an external store behind the same API |
| Job schedulers | One ticker per process; cross-process overlap is *tolerated* via advisory locks, not designed for |

Scaling vertically (a bigger box, a faster LLM endpoint) is the supported direction.
Running multiple replicas is not, without the API-level replacements above.

## Adding a transport

A new transport (Signal, …) is one more container next to `tg`: it registers with the
core at boot, announces the config fields its connections need, and the dashboard
renders them — no core change and no new Compose wiring beyond the service itself, the
`REDIS_URL`, the `INTERNAL_API_TOKEN` and its own `SELF_URL`. The contract, step by
step, is in [Adding a transport](../development/adding-a-transport.md).
