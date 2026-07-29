# Getting started

Two ways to run the app: a local Node dev server against your own Postgres, or
the bundled Docker Compose stack. Both end at the same place — a dashboard on
port 3200 that you must claim with a password before anyone else does.

## Prerequisites

| Requirement | Why |
| --- | --- |
| Node.js ≥ 24 | Enforced by `package.json` `engines`; the runtime targets Node 24 |
| Postgres with `pgvector` | Semantic recall over history summaries and user memories stores `vector(1024)` columns |
| `ffmpeg` on `PATH` | Video/GIF frame sampling for vision, audio transcoding for voice messages, and HLS/DASH muxing for the browser agent |
| `yt-dlp` on `PATH` | The browser agent's `browser_download_media` tool (YouTube, YouTube Music, SoundCloud, …). Optional — without it that one tool reports it is not installed |
| Chromium (via Playwright) | The read-link tool and the browser agent drive a headless browser |
| Docker | Only for `npm run test:integration` (Testcontainers) and for the Compose stack |
| A Telegram bot token | From [@BotFather](https://t.me/BotFather); entered in the dashboard, not in env |
| An OpenAI-compatible LLM endpoint | Anything serving `/v1/chat/completions` and `/v1/models` — Ollama, llama.cpp, vLLM, LocalAI, or a hosted API |

The database is the only thing configured by environment variable. Everything
else — LLM endpoint, model, bot token, prompts, schedules — lives in DB-backed
Settings and is entered through the dashboard. See
[Configuration](configuration.md).

## Local development

```bash
npm install
```

```bash
cp .env.example .env
```

Set `DATABASE_URL` in `.env` to your Postgres instance, then apply the schema:

```bash
npm run db:migrate
```

Start the dev server:

```bash
npm run dev
```

The dashboard is at <http://localhost:3200>. On first contact it redirects to
`/setup`.

### Chromium for local runs

Playwright is a declared dependency but its browser binaries are not installed by
`npm install`. Install Chromium once:

```bash
npx playwright install chromium
```

Without it, the browser agent (the bot's only web access) fails with a clear
launch error; nothing else is affected. To point at an already-installed browser
instead, set `CHROMIUM_EXECUTABLE_PATH` (this is what the Docker image does).

## Docker Compose

```bash
docker compose up -d --build
```

That starts two services: `db` (the `pgvector/pgvector:pg17` image) and `app`.
Compose has working defaults, so a `.env` is optional — copy `.env.example` if
you want to change credentials, ports, or the host data directories.

The app container runs pending migrations before it serves, so it never answers
requests against an unmigrated database. Details, volumes and upgrade procedure
are in [Deployment](operations/deployment.md).

- Dashboard: <http://localhost:3200>
- Health probe: <http://localhost:3200/api/health>

## First run

1. **Set the operator password.** Visit the dashboard; a fresh install forces
   `/setup`. Choose a password — it is hashed (scrypt) into the `settings` row.
   Do this **before** exposing the port beyond localhost or your LAN: until a
   password exists the app is open, and whoever reaches `/setup` first owns the
   dashboard.
2. **Configure the LLM connection.** Settings → Core: enter the base URL of your
   OpenAI-compatible endpoint (including `/v1` if your server serves it there)
   and an API key if it needs one. Press **Test connection** — it calls
   `/v1/models` for real — then pick a model from the returned list and save.
3. **Add the Telegram bot token.** Settings → Core, same Save button. The bot
   reads its token from the database.
4. **Set the owner and timezone.** Owner is picked from known users, so it can
   only be set after that person has messaged the bot at least once. Timezone is
   an IANA name and governs every rendered timestamp, every scheduled-task fire
   time, and the daily-job run time.
5. **Start the bot.** Overview → the bot control card, or restart the process —
   the poller autostarts at boot when a token is stored. Overview shows honest,
   probed state: a real `SELECT 1` against the database and a real `/v1/models`
   call against the LLM.
6. **Say something to the bot.** In a private chat it always answers. In a group
   it answers when addressed — see
   [Using the bot in chat](operations/using-the-bot.md).
7. **Check the trace.** Debug → the newest `bot-messaging` / `reply` trace shows
   the composed system prompt, the history window, every tool call, and the
   complete request and response bodies.

## Optional capabilities

Each of these is off until configured, and each has its own Settings tab with a
real probe button:

| Capability | Needs | Enables |
| --- | --- | --- |
| Embeddings | An endpoint serving `/v1/embeddings` and a model emitting 1024-wide vectors | Semantic recall over history summaries; semantic memory search |
| Images | An endpoint serving `/v1/images/generations` | The `image_generate` tool |
| Speech | An endpoint serving `/v1/audio/speech` | Voice replies |
| Transcription | An endpoint serving `/v1/audio/transcriptions` | Voice-message transcription (falls back to the audio-capable chat model when unset) |
| Web search fallback | A Tavily API key | Searching when no engine loads in the browser (optional — Bing works today) |

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server on port 3200 |
| `npm run build` | Production build (`next build`, standalone output) |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit tests — no Docker, no database |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:integration` | Integration tests against real Postgres (Testcontainers; **Docker required**) |
| `npm run db:generate` | Generate a SQL migration from `db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:studio` | Drizzle Studio |
| `npm run release:patch\|minor\|major` | Bump the `package.json` version without a git tag |

`db:generate` and `db:migrate` are two halves of one job — generating the SQL
without applying it leaves your dev database on the old schema.

## Where to go next

- [Configuration](configuration.md) — every setting, what it does, what breaks
  without it.
- [Operator guide](operations/operator-guide.md) — a tour of every dashboard page.
- [Architecture overview](architecture/overview.md) — how the pieces fit.
