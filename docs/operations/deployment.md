# Deployment

The app is designed to be **self-hosted as a single container** on a home server,
NAS or VPS, next to a Postgres instance. Everything else in the architecture follows
from that: in-process schedulers, in-process singletons, and advisory locks for the
brief moments two processes overlap.

## Docker Compose

```bash
docker compose up -d --build
```

Two services:

| Service | Image | Notes |
| --- | --- | --- |
| `app` | Built from the repo `Dockerfile` | Publishes `${PORT:-3200}` |
| `db` | `pgvector/pgvector:pg17` | Publishes `${POSTGRES_PORT:-5432}` |

`app` waits on `db`'s healthcheck (`pg_isready`) before starting. Both restart
`unless-stopped`.

### Volumes

Both are **bind mounts to host directories**, not named volumes, so you can see and
back up the data with ordinary tools:

| Host path (default) | Container path | Holds |
| --- | --- | --- |
| `./data/pg` | `/var/lib/postgresql/data` | The database |
| `./data/traces` | `/app/data/traces` | Monthly trace NDJSON logs |
| `./data/downloads` | `/app/data/downloads` | Browser-agent downloads |

All three are mounted, and all three hold the only copy of what they contain. The
downloads mount matters for a non-obvious reason: a file the browser agent fetched that
was **too large to attach to the chat** exists nowhere else, so an unmounted container
path would silently lose it on the next image replacement.

`/app/data/bin` — where the yt-dlp updater keeps the current binary — is deliberately
**not** mounted (user decision, 2026-08-01). It is a cache, not data: a recreated
container falls back to the build the image pins and re-downloads a current one on
boot, which costs ~40 MB per redeploy and saves a host directory whose ownership would
have to be kept right for the non-root `app` user.

A host bind mount must be writable by the container's non-root `app` user. If it is
not, trace flushing fails — which surfaces as a global dashboard alert rather than a
crash, because failing readiness there would drop the traces still buffered in RAM —
and downloads fail per-run, reported on the run row.

### Environment

Compose has working defaults; a `.env` is optional. `DATABASE_URL` is composed from
the `POSTGRES_*` variables and points at the bundled `db`. Override it to use an
external database. `TZ` defaults to
`UTC` — note that the *operator* timezone used for rendering and scheduling is a
database setting, not this.

Full variable reference: [Configuration](../configuration.md#environment-variables).

### Health

```
GET /api/health   → 200 when ready, 503 when the database is unreachable
```

The container healthcheck polls it every 10s with a 40s start period. It uses
`127.0.0.1`, not `localhost`, deliberately: the standalone server binds IPv4
`0.0.0.0`, and `localhost` can resolve to IPv6 `::1`, which would refuse the
connection.

## The image

Multi-stage, from `node:24-alpine`.

```
base ──► deps (npm install, incl. dev) ──► builder (npm run build) ──► runner
```

Deliberate choices worth knowing before you change them:

| Choice | Why |
| --- | --- |
| `npm install`, not `npm ci` | `package-lock.json` is generated on Windows and omits Linux-only optional native deps (musl builds of `lightningcss` / `tailwind-oxide`, `@emnapi/*`), which `npm ci`'s strict sync check rejects |
| Native deps installed **inside** the image | Host `node_modules` must never be copied in — they are built for the wrong platform |
| `output: "standalone"` | The runner ships only traced runtime deps (`.next/standalone`), not a full `node_modules` |
| `ffmpeg` from apk | Vision samples video frames with it, voice transcodes both ways, and the browser agent muxes streams with it (user decision: system ffmpeg over a bundled/WASM build) |
| `yt-dlp` from **upstream**, not apk | The browser agent's media downloader; a media site's player has no file URL to fetch (user decision, 2026-07-29). The apk package is frozen per Alpine release while these sites change on purpose, so the image pins upstream's self-contained `musllinux` build (checksum-verified, no python3) and the app's daily updater keeps a newer copy in `/app/data/bin` (user decision, 2026-08-01) |
| `chromium` + `nss`/`freetype`/`harfbuzz`/fonts from apk | Playwright's own download is a glibc build that will not run on Alpine (musl). `CHROMIUM_EXECUTABLE_PATH` points at the distro browser |
| `playwright` and `playwright-core` copied **whole** over the traced copies | They are `serverExternalPackages`, so Next's file tracer copies only statically resolvable JS and misses runtime data files like `playwright-core/browsers.json` |
| `sharp` needs no apk package | It ships its own musl libvips binary via npm |
| Non-root `app` user | Standard hardening; `/app/data/traces` is created and chowned up front |

### Startup command

```sh
node migrate/migrate.mjs && node server.js
```

Migrations complete **before** the app accepts traffic, and a failed migration fails
the start — so the app never serves against an unmigrated database.

The migration runner is isolated on purpose: `docker/migrate/` has its own tiny
`package.json` and uses drizzle's **programmatic** migrator
(`drizzle-orm/node-postgres/migrator`) rather than the drizzle-kit CLI, which is
intentionally absent from the slim image. Its two dependencies live in their own
directory so they never touch the app's traced `node_modules`. With `DATABASE_URL`
unset it warns and exits 0 rather than failing the container.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Or, for a locally-built image, `docker compose up -d --build`. The entrypoint
applies any new migrations first.

During the overlap window two app processes may briefly co-exist. That is handled:

- Background jobs take **Postgres advisory locks**, so a job never
  double-processes. A lock miss is a benign skip.
- The browser-agent runner sweeps any run left `running` by the previous process to
  `failed` at boot.
- The Telegram poller releases its `getUpdates` lock on `SIGTERM` (capped at 3s), so
  the new process does not collide with the old one.
- The trace store flushes buffered traces on graceful shutdown, so at most one flush
  interval (60s) of settled traces is at risk on a hard kill.

## Releases

`.github/workflows/release.yml` ships an image whenever the `version` field in
`package.json` changes on `main`.

```bash
npm run release:patch
```

(or `release:minor` / `release:major` — they bump the version without creating a git
tag), then commit and push to `main`.

The workflow:

1. **version** — wakes only when `package.json` is touched, then diffs the `version`
   field against `HEAD~1`. Unchanged → nothing ships.
2. **verify** — `npm install`, `npm run lint`, `npm run typecheck`, `npm run test`.
   (Unit tests only; the integration suite needs Docker and is not part of the gate.)
3. **release** — creates and pushes the `v<version>` tag if it does not already
   exist, then builds and pushes the image to Docker Hub as
   `<user>/<repo>:<version>` and `:latest`, with GitHub Actions layer caching.

Required repository secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`. The release job
needs `contents: write` to push the tag.

Note that `verify` uses `npm install` rather than `npm ci` for the same lockfile
reason as the Dockerfile.

## Running behind a reverse proxy

Two things need care:

- **SSE.** `/api/events` sets `X-Accel-Buffering: no` and
  `Cache-Control: no-cache, no-transform`, which nginx honours. Make sure your proxy
  does not buffer responses or apply a short read timeout — the stream is
  long-lived, with a heartbeat comment every 25s.
- **TLS.** The session cookie is `HttpOnly` and `SameSite=Lax` but is **not** marked
  `Secure`, so terminate TLS at the proxy if the dashboard is reachable from outside
  your LAN.

## Production checklist

- [ ] Claim `/setup` and set the operator password before exposing the port.
- [ ] `DATABASE_URL` points where you intend (or you are using the bundled `db`).
- [ ] `./data/traces` and `./data/downloads` are on a disk with room and are
      writable by the container user. Overview's **Trace storage** and **Downloads**
      cards probe this for real — check them rather than assuming.
- [ ] Do not publish `POSTGRES_PORT` beyond localhost.
- [ ] Configure the LLM connection and model, then confirm Overview shows a live
      probe result — not just "configured".
- [ ] Set the operator timezone and the daily-jobs run time.
- [ ] Set the owner (requires that person to have messaged the bot once).
- [ ] `GET /api/health` returns 200.
- [ ] The bot shows as running on Overview.
- [ ] A backup routine exists for both the database **and** the trace directory —
      see [Backup and restore](backup-and-restore.md).

## Scaling

This is a single-instance design, and several parts assume it:

| Component | Assumption |
| --- | --- |
| Telegram poller | Telegram permits exactly one `getUpdates` consumer per token |
| Realtime hub | In-process pub/sub. Multiple replicas would need an external fan-out (e.g. Postgres `LISTEN`/`NOTIFY`) behind the same API |
| Trace store | In-process, file-backed. Multiple replicas would need an external store behind the same API |
| Job schedulers | One ticker per process; cross-process overlap is *tolerated* via advisory locks, not designed for |

Scaling vertically (a bigger box, a faster LLM endpoint) is the supported direction.
Running multiple replicas is not, without the two API-level replacements above.
