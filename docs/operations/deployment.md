# Deployment

The platform is designed to be **self-hosted with Docker Compose** on a home server,
NAS or VPS: the core's image, one image per transport it runs, a Redis instance that
carries the queues between them, and a Postgres instance. Everything else in the
architecture follows from that: in-process schedulers, in-process singletons pinned to
`globalThis`, and advisory locks for the brief moments two core processes overlap.

Transports are **additive**: each is a separate image that registers itself, so
running one more is one more service and no change to the rest.

## Docker Compose

```bash
docker compose up -d
```

Four services, every one of them a **released image** — nothing is built on the
host:

| Service | Image | Notes |
| --- | --- | --- |
| `app` | `ghcr.io/assistant-hub-swarm/ahw-core:${AHW_VERSION}` | The dashboard, the web chat and the whole pipeline. Publishes `${PORT:-3200}:3200` |
| `tg` | `ghcr.io/assistant-hub-swarm/ahw-transport-telegram:${AHW_TELEGRAM_VERSION}` | The Telegram transport: stateless pollers that register with the core, forward every update as transport events, perform the sends, and host the platform's MCP tools. Its own repository and its own version, so it does **not** follow `AHW_VERSION`. **No published port** — its internal API is for the core only |
| `redis` | `redis:7-alpine`, started with `--appendonly yes` | The cross-app bus and the two queues (`transport-updates`, `inbound-messages`). Publishes `${REDIS_PORT:-6379}:6379` |
| `db` | `pgvector/pgvector:pg17` | The one database. Publishes `${POSTGRES_PORT:-5432}:5432` |

`AHW_VERSION` defaults to the version this checkout releases, so a clone runs a
known-good core rather than a moving `latest`. Set it in `.env` to run another
one; `npm run release:*` rewrites the default when the version is bumped, and
the release workflow refuses to ship if the two ever drift. Each transport
carries its own variable (`AHW_TELEGRAM_VERSION`) because each releases on its
own schedule; the only thing the two sides must agree on is the wire's
`CONTRACT_MAJOR`.

To build the working tree instead of pulling, add the dev override — it adds a
`build:` to the core and changes nothing else. A transport is never built here:
to run one from source, start it from its own checkout against this stack.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

`app` waits for `db` (healthcheck `pg_isready`) and `redis` (`redis-cli ping`) to be
**healthy**. It waits for **no transport at all**: the core boots without any, and a
transport registers itself whenever it comes up — which is what lets an operator add
one without touching the core's service. `tg` waits for `redis` to be healthy. All
four restart `unless-stopped`.

### Adding a transport

A transport (Discord, Signal, Matrix, …) is its own repository and its own image.
Running one is **one service**, and no change to anything else in the file:

```yaml
  discord:
    image: ghcr.io/someone/ahw-transport-discord:1.0.0
    depends_on:
      redis: { condition: service_healthy }
    environment:
      NODE_ENV: production
      PORT: 3220
      # What the transport ANNOUNCES at registration — the core calls it here.
      SELF_URL: http://discord:3220
      REDIS_URL: redis://redis:6379
      CORE_API_URL: http://app:3200
      INTERNAL_API_TOKEN: ${INTERNAL_API_TOKEN:-change-me}
      TZ: ${TZ:-UTC}
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3220/health >/dev/null 2>&1 || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s
    restart: unless-stopped
```

Three things that are easy to get wrong:

- **The same `INTERNAL_API_TOKEN` as the core.** It authenticates both
  directions; a mismatch shows as a transport that never finishes registering.
- **No published port.** Its internal API is the core's alone.
- **Do not add it to `app`'s `depends_on`.** The core has no dependency on any
  transport by design, and adding one only makes the stack's startup order your
  problem.

Then `docker compose up -d discord`. It registers itself, the dashboard grows a
connection section built from the config fields it announced, and its platform
actions appear as tools. Nothing in the core is edited — if something has to be,
that is a core bug (see
[Adding a transport](../development/adding-a-transport.md)).

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
`${…}` substitutions in `docker-compose.yml`. There is no root `.env.example`:
`apps/core/.env.example` documents local (non-Docker) development, and each
transport ships its own.

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

The Telegram transport ([its own repository](https://github.com/assistant-hub-swarm/ahw-transport-telegram)) reads — as any transport
does, these are the contract's variables:

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

### A transport's image

Not built here — each transport builds its own, in its own repository, and this
repo's release workflow has one entry: the core. The Telegram one
([Dockerfile](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/Dockerfile)) is the shape to copy: `node:24-alpine`,
`npm install` (its own manifest, no workspace context), the SDK pulled from
GitHub Packages, `ffmpeg` from apk for video frame sampling, a non-root user,
`EXPOSE 3210`, and `npx tsx src/index.ts`. No migrations and no volumes:
stateless is the contract.

## Upgrading

Bump `AHW_VERSION` in `.env` (or pull a new checkout, whose pinned default moves
with each release), then:

```bash
docker compose pull && docker compose up -d
```

Or, when running the dev override, rebuild:
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`.
The core's entrypoint applies any new migrations first; each transport
re-registers with the core at boot and reconciles from the desired state the
core answers with.

A transport upgrades on **its own** schedule — its image and version are its
repository's, not this one's. The only thing the two sides must agree on is the
wire's `CONTRACT_MAJOR`; when they do not, the core refuses that transport by
name and says so on the dashboard rather than failing quietly.

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

`.github/workflows/release.yml` ships two kinds of artifact, each on its own
version field: the **app images** on the root `package.json` version, and the
**transport SDK** on `packages/transport-sdk/package.json`'s. A version field
that changed on `main` is a release; neither waits for the other.

```bash
npm run release:patch
```

(or `release:minor` / `release:major` — they bump the version without creating a git
tag), then commit and push to `main`. Actions → Release → *Run workflow* forces a
release of the current version instead (re-runs, or proving a fresh repo); every
step below is idempotent, so a manual run is safe to repeat.

A release is all-or-nothing: nothing reaches the registry and no tag is created
unless every image built. This repository's image is
`ghcr.io/assistant-hub-swarm/ahw-core`; each transport publishes its own from
its own repository (`ahw-transport-telegram`, …). The workflow:

1. **version** — wakes only when a version manifest is touched (the root
   `package.json` or the SDK's), then diffs each `version` field against
   `HEAD~1`. Unchanged → that artifact does not ship. A manual dispatch skips
   the diff and releases the current versions.
2. **verify** — `npm install`, `npm run lint`, `npm run typecheck`, `npm run test`
   (fanned out across the workspaces via turbo. Unit tests only; the integration
   suite needs Docker and is not part of the gate.) Then one release-shaped
   check: `docker-compose.yml`'s image pins must name the version being
   released, so a compose file that would start operators on an older build
   cannot ship. `npm run release:*` keeps them in step; this catches a version
   bumped any other way.
3. **build** — a matrix with one entry per app image in this repository
   (`ahw-core` from `apps/core/Dockerfile`) builds each with GitHub Actions
   layer caching and hands it to the next job as an artifact — nothing is
   pushed. One failing image fails the release. Transports are not in the
   matrix: each releases from its own repository, on its own version.
4. **publish** — runs only when every build succeeded: loads all images, pushes
   every `ghcr.io/<org>/<image>:<version>` first, then moves every `:latest`, and finally
   creates the `v<version>` git tag (skipped if it already exists). The ordering
   means a push failure mid-way can never leave `latest` pointing at a mixed set,
   and a tag exists only for a version whose every image is in the registry.

And, when the SDK's version changed:

5. **publish-sdk** — builds `packages/transport-sdk` (ESM + `.d.ts`, with the
   private workspace packages bundled in, so nothing published resolves to a
   package that exists only in this repo), publishes it to the org's npm
   registry on GitHub Packages, and tags `transport-sdk-v<version>`. Skips the
   publish when that version is already there, so a re-run is a no-op.

The SDK carries its own semver because a transport author pins the package,
not a core release, and the two move at different speeds. The number the two
sides must actually agree on is neither version: it is `CONTRACT_MAJOR` in the
code, announced at registration and refused by name on a mismatch.

No registry secrets: the publish jobs authenticate with the workflow's own
`GITHUB_TOKEN` (`packages: write` for the push, `contents: write` for the tag).
A package's first push makes it private to the org — flip both the container
images and the npm package to public in their settings once, so operators and
transport authors can pull without a token.

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
- [ ] Overview's **Bots** card reads Running, and each assistant's
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
