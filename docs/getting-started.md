# Getting started

Two ways to run it: local Node dev servers against your own Postgres and Redis,
or the bundled Docker Compose stack. Both end at the same place — a dashboard on
port 3200 that you must claim with the first admin account before anyone else
does, and a Telegram transport that registers with it.

## Prerequisites

| Requirement | Why |
| --- | --- |
| Node.js ≥ 24 | Enforced by `package.json` `engines`; the runtime targets Node 24 |
| Postgres with `pgvector` | Semantic recall over history summaries and memories stores `vector(1024)` columns; the search index uses `pg_trgm` |
| Redis | The queue every incoming message travels on and the bus the core and its transports talk over. Without it the core boots but processes no messages |
| `ffmpeg` on `PATH` | Audio transcoding for voice both ways and HLS/DASH muxing for the browser agent (in the core); a transport needs its own for video frame sampling |
| `yt-dlp` on `PATH` | The browser agent's `browser_download_media` tool. Optional — without it that one tool reports it is not installed. The app also keeps a self-updated copy in `data/bin` and prefers it |
| Chromium (via Playwright) | The browser agent drives a headless browser |
| Docker | For `npm run test:integration` (Testcontainers) and for the Compose stack. Also the easiest way to get Postgres and Redis for local development |
| A Telegram bot token | From [@BotFather](https://t.me/BotFather); entered per assistant in the dashboard, not in env |
| An OpenAI-compatible LLM endpoint | Anything serving `/v1/chat/completions` and `/v1/models` — Ollama, llama.cpp, vLLM, LocalAI, or a hosted API. Anthropic, Google and Z.ai are supported natively as backend types |

Env holds bootstrap plumbing only — where the database and Redis are, and the
shared secret the core and its transports present to each other. Everything else — LLM
endpoints, models, bot tokens, personas, tasks — lives in the database and is
entered through the dashboard. See [Configuration](configuration.md).

## Local development

```bash
npm install
```

Start Postgres and Redis. The compose file's own services will do:

```bash
docker compose up -d db redis
```

Each app reads its own `.env`:

```bash
cp apps/core/.env.example apps/core/.env
```

In `apps/core/.env` set `DATABASE_URL`, `REDIS_URL` and `INTERNAL_API_TOKEN`.
That token is what lets a transport register with the core — with it unset,
every internal route answers 401 and any transport retries registration
forever. A transport is a separate service with its own checkout and its own
`.env` carrying the **same** token (Telegram's is
[ahw-transport-telegram](https://github.com/assistant-hub-swarm/ahw-transport-telegram)); the core runs fine with none, it just has
no platform to speak on. Then apply the schema:

```bash
npm run db:migrate
```

Start the core (turbo runs every workspace's `dev` script):

```bash
npm run dev
```

The dashboard is at <http://localhost:3200>. On first contact it redirects to
`/setup`.

To talk to Telegram as well, run its transport from its own checkout against
the same Redis and token ([ahw-transport-telegram](https://github.com/assistant-hub-swarm/ahw-transport-telegram)): it listens on 3210
and logs `registered with the core` once the dashboard is up. The core runs
fine without it — there is simply no platform to speak on.

The core's boot-time modules (the queue consumers, the schedulers) do not
hot-reload the way a page does, and neither does a transport's registration —
restart before judging a live check.

### Chromium for local runs

Playwright is a declared dependency but its browser binaries are not installed by
`npm install`. Install Chromium once:

```bash
npx playwright install chromium
```

Without it, the browser agent (the assistants' only web access) fails with a clear
launch error; nothing else is affected. To point at an already-installed browser
instead, set `CHROMIUM_EXECUTABLE_PATH` (this is what the Docker image does).

## Docker Compose

```bash
docker compose up -d
```

That starts four services: `db` (the `pgvector/pgvector:pg17` image), `redis`,
`app` (the core) and `tg` (the Telegram service). The two application services
run **released images** pinned to one version, so this needs nothing on the
host but Docker. Building this working tree instead is the dev override:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Compose has working defaults, so a `.env` at the repo root is optional — create
one to set a real `INTERNAL_API_TOKEN` (the default is the placeholder
`change-me`), to pin a different `AHW_VERSION`, or to change credentials, ports,
or the host data directories.

The core container runs pending migrations before it serves, so it never answers
requests against an unmigrated database. The Telegram service has no database;
it registers with the core and retries until the core answers. Details, volumes
and the upgrade procedure are in [Deployment](operations/deployment.md).

- Dashboard: <http://localhost:3200>
- Health probe: <http://localhost:3200/api/health>

## First run

1. **Create the first admin.** Visit the dashboard; a fresh install forces
   `/setup`. Choose a username and a password (hashed with scrypt into the
   `accounts` table). Do this **before** exposing the port beyond localhost or
   your LAN: until an account exists the app is open, and whoever reaches
   `/setup` first owns the dashboard.
2. **Add an LLM backend.** Backends → New: the base URL of your endpoint
   (including `/v1` if your server serves it there), an API key if it needs
   one, and the backend type (**Detect** fingerprints it). Press **Test
   connection** — it calls `/v1/models` for real.
3. **Pick the chat model.** Settings → Models → Chat: choose the backend and a
   model from its live listing, then Save. Pick a model that supports tool
   calls (and thinking, if you want it).
4. **Set the timezone.** Settings → General. An IANA name; it governs every
   rendered timestamp, every task's wall-clock time, and the daily-job run time.
5. **Create an assistant and connect Telegram.** Assistants → New: a name (the
   name people summon it by in a group) and a persona. In its editor, the
   **Telegram connection** section appears as soon as the Telegram service has
   registered; paste the bot token and press Connect. The section shows
   **Running** with the bot's @username within a few seconds — the poller
   starts as soon as the service reconciles.
6. **Say something to the bot.** In a private chat it always answers. In a group
   it answers when addressed — see
   [Using the bot in chat](operations/using-the-bot.md).
7. **Check the trace.** Debug → filter Bot messaging: the newest `reply` trace
   shows the composed system prompt, the history window, every tool call, and
   the complete request and response bodies, with the ingest's `inbound` and
   the service's `deliver` traces on the same correlation id.
8. **Link your own chat identity** (optional). Profile → mint a link code and
   send it to the bot in a private chat: from then on memory and owner rights
   follow you across the web chat and Telegram.

Overview shows honest, probed state throughout: a real `SELECT 1` against the
database, a real `/v1/models` call against the LLM, and each Telegram
connection's live poller state as the service reports it.

## Optional capabilities

Endpoints live in the Backends catalog (add each server once on the Backends
page); each capability below is off until its role under Settings → Models picks
a backend and model, and each role card has a real probe button:

| Capability | Needs | Enables |
| --- | --- | --- |
| Embeddings | An endpoint serving `/v1/embeddings` and a model emitting 1024-wide vectors | Semantic recall over history summaries; semantic memory search; meaning-based history search |
| Images | An endpoint serving `/v1/images/generations` | The `image_generate` tool |
| Speech | An endpoint serving `/v1/audio/speech` | Voice replies |
| Audio (STT) | An endpoint serving `/v1/audio/transcriptions` | Voice-message transcription (falls back to the audio-capable chat model when unset) |
| Vision, browser agent, classifiers, background jobs | A chat backend and model | Dedicated models for those workloads; each runs on the chat model until set |
| Web search fallback | A Tavily API key (Settings → Integrations) | Searching when no engine loads in the browser |

## Scripts

Root scripts fan out across the workspaces through turbo.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev servers: the core on 3200 and the Telegram service on 3210 |
| `npm run build` | Production build of every workspace (`next build`, standalone output, for the core) |
| `npm run start` | Serve the core's production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run test` | Vitest unit tests — no Docker, no database |
| `npm run test:watch` | Vitest watch mode (core) |
| `npm run test:integration` | Integration tests against real Postgres and Redis (Testcontainers; **Docker required**) |
| `npm run test:linux` | The whole suite inside a Linux container (`docker-compose.test.yml`), for a lockfile generated on Windows |
| `npm run db:generate` | Generate a SQL migration from `apps/core/store/schema.ts` |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:studio` | Drizzle Studio |
| `npm run release:patch\|minor\|major` | Bump the root `package.json` version without a git tag. The release workflow then ships whatever that version is missing from the registry |

`db:generate` and `db:migrate` are two halves of one job — generating the SQL
without applying it leaves your dev database on the old schema.

## Where to go next

- [Configuration](configuration.md) — every setting, what it does, what breaks
  without it.
- [Operator guide](operations/operator-guide.md) — a tour of every dashboard page.
- [Architecture overview](architecture/overview.md) — how the pieces fit.
- [Adding a transport](development/adding-a-transport.md) — connecting another
  messaging platform.
