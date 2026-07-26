# Configuration

Configuration lives in **two** layers, and the split is deliberate.

| Layer | Holds | Changed by | Takes effect |
| --- | --- | --- | --- |
| Environment variables | Bootstrap plumbing only: where the database is, where trace files go, the process timezone | Editing `.env` / compose, then restarting | On restart |
| DB-backed Settings | All runtime product configuration: LLM connections, models, bot token, owner, timezone, schedules | The dashboard (Settings page) or `PATCH /api/settings` | Immediately — background jobs and the bot re-read settings per run/turn |

Runtime setup is **not** in env vars. An operator should never have to edit a
file and restart a container to change the model the bot uses.

---

## Environment variables

The full list, as parsed by `server/env.ts`. Every variable also accepts a
`<NAME>_FILE` variant whose file contents are used instead — that is the Docker
secrets path (`DATABASE_URL_FILE=/run/secrets/database_url`).

Nothing is required at process boot. Requirements are enforced at the point of
use (`requireEnv`), so the dashboard still starts and reports what is missing
rather than crash-looping.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres (with pgvector) connection string. Required for anything that touches persistence, which is nearly everything. |
| `TRACES_DIR` | `<cwd>/data/traces` | Directory the file-backed trace store appends monthly NDJSON logs to. A filesystem mount, not product config. |
| `TZ` | `UTC` | Process timezone. The *operator* timezone used for rendering and scheduling is the DB setting, not this. |
| `NODE_ENV` | — | `development` \| `production` \| `test`. |

One more bootstrap override is read directly rather than through `server/env.ts`, so it
has no `_FILE` variant:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOWNLOADS_DIR` | `<cwd>/downloads` | Where the browser agent streams downloaded files. Deploy-time plumbing, like `TRACES_DIR`. Under Compose it is set to `/app/data/downloads` and bind-mounted, because a file too large to attach to the chat exists **only** here. |

### Compose-only variables

Read by `docker-compose.yml`, not by application code:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3200` | Host port published for the app |
| `POSTGRES_USER` | `bot` | Bundled Postgres user |
| `POSTGRES_PASSWORD` | `bot` | Bundled Postgres password |
| `POSTGRES_DB` | `bot` | Bundled Postgres database |
| `POSTGRES_PORT` | `5432` | Host port published for Postgres |
| `PG_DATA_DIR` | `./data/pg` | Host directory Postgres persists into (bind mount) |
| `TRACES_DATA_DIR` | `./data/traces` | Host directory mapped to the container's `/app/data/traces` |
| `DOWNLOADS_DATA_DIR` | `./data/downloads` | Host directory mapped to the container's `/app/data/downloads` |

Under Compose, `DATABASE_URL` is built from the `POSTGRES_*` variables and points
at the bundled `db` service. Set `DATABASE_URL` explicitly to use an external
database instead.

### Runtime variables set by the image

| Variable | Set to | Why |
| --- | --- | --- |
| `HOSTNAME` | `0.0.0.0` | The Next standalone server binds `HOSTNAME`; the default would not be reachable in-container |
| `CHROMIUM_EXECUTABLE_PATH` | `/usr/bin/chromium-browser` | Playwright's bundled browser is a glibc build and cannot run on Alpine, so the distro Chromium is installed and pointed at |
| `NEXT_TELEMETRY_DISABLED` | `1` | No build telemetry |

`NEXT_PUBLIC_APP_NAME` and `NEXT_PUBLIC_APP_VERSION` are inlined at build time by
`next.config.ts` from `package.json` and read through `lib/build-info.ts`. They
exist so client-reachable code never imports `package.json` (which shipped the
whole dependency manifest into the browser bundle).

---

## DB-backed Settings

One typed row (`settings`, `id = 'singleton'`). Read with `GET /api/settings`,
written with `PATCH /api/settings`; the dashboard form (Settings page) has six
tabs and one Save button that persists every changed field regardless of which
tab is open.

Secrets are **write-only**. They are accepted on input and never returned — the
client-facing shape exposes only a `…Configured: boolean`. Omitting a secret key
from a PATCH leaves the stored value alone; sending `null` clears it.

### Core

| Field | Type | Effect when unset |
| --- | --- | --- |
| `llmBaseUrl` | URL (≤500 chars) | No replies, no background LLM job does work — every job settles as a no-op |
| `model` | string (≤200) | Same: the reply path needs a chosen model |
| `apiKey` | secret | Sent as the bearer token when present; many self-hosted endpoints need none |
| `telegramBotToken` | secret (≤200) | The poller cannot start; Overview says so |
| `ownerUserId` | numeric string | Owner-gated behavior is off (maintenance mode then closes the bot to everyone; browser-agent downloads stay disabled) |
| `maintenanceModeEnabled` | boolean | `false`. When on, only the owner is answered (and only through deterministic addressing), and no scheduled task fires |
| `timezone` | IANA name | `UTC`. Governs every rendered timestamp, scheduled-task wall-clock times, daily-job run time, and analytics period boundaries |
| `dailyJobsRunTime` | `HH:MM` | `04:00`. The local time in `timezone` that **all** daily jobs run at |
| `browserDownloadMaxMb` | int 1–50 | `20`. Largest browser-agent download also attached to the chat; 50 is Telegram's bot upload ceiling |

`ownerUsername` is stored denormalized from the chosen known user, for display
only.

### Embeddings

Powers semantic recall over history summaries and semantic memory search.

| Field | Type | Notes |
| --- | --- | --- |
| `embeddingBaseUrl` | URL | Null reuses the Core LLM connection |
| `embeddingApiKey` | secret | Null reuses the Core key |
| `embeddingModel` | string | Null turns semantic recall off — summaries are still written, just not embedded |

Every stored vector must be **1024** wide (`lib/embeddings.ts`,
`EMBEDDING_DIMENSIONS`). This is a code constant, not a setting: pgvector cannot
index a vector of unspecified width, so the column type commits to a size. The
**Test embeddings** button embeds a real string and reports the width it got
back, so a mismatched model surfaces as a clear message instead of an opaque
Postgres error inside a nightly job.

### Images

| Field | Type | Notes |
| --- | --- | --- |
| `imageBaseUrl` | URL | Null reuses the Core LLM connection |
| `imageApiKey` | secret | Null reuses the Core key |
| `imageModel` | string | Null disables the `image_generate` tool (it returns a clear error result rather than silently doing nothing) |

**Test image endpoint** checks the configured model is actually served rather
than generating a picture.

### Speech

| Field | Type | Notes |
| --- | --- | --- |
| `speechBaseUrl` | URL | Null reuses the Core LLM connection |
| `speechApiKey` | secret | Null reuses the Core key |
| `speechModel` | string | Null disables voice replies |
| `speechVoice` | string (≤100) | Null uses the endpoint default |

### Transcription

| Field | Type | Notes |
| --- | --- | --- |
| `transcriptionBaseUrl` | URL | Null reuses the Core LLM connection |
| `transcriptionApiKey` | secret | Null reuses the Core key |
| `transcriptionModel` | string | Null falls back to transcribing with the audio-capable chat model |

**Test transcription** transcribes a fraction of a second of generated silence —
a real `/v1/audio/transcriptions` call, because whisper-class servers often serve
it without `/v1/models`.

### Integrations

| Field | Type | Notes |
| --- | --- | --- |
| `tavilyApiKey` | secret | Enables the `search_web` tool. Unset, the tool returns a clear error result |

### Not on the form

Two columns on the same row are managed by other flows and never editable here:

| Column | Owner |
| --- | --- |
| `operator_password_hash`, `session_secret` | `/setup` and the auth service (see [Security](architecture/security.md)) |
| `active_personality_id` | The Personalities page (`PUT /api/personalities/active`) |

---

## Verifying configuration honestly

Nothing in this app reports "configured" from the presence of a variable.

- **Overview** runs a real `SELECT 1` and a real `/v1/models` call, and probes
  the trace directory by opening the current month's file for append — exactly
  the operation the flusher performs.
- **`GET /api/health`** returns `200`/`503` on the database probe alone.
  Configuration presence and trace-storage health are reported in the body but
  are deliberately *not* readiness gates: restart-looping on an unwritable trace
  volume would drop the settled traces still buffered in RAM.
- **Settings probes** (`test-connection`, `test-embeddings`, `test-images`,
  `test-speech`, `test-transcription`) each make a real call and are recorded as
  traces under the `settings` feature.

## Changing configuration

| Change | How |
| --- | --- |
| Any runtime setting | Settings page, or `PATCH /api/settings`. Effective immediately |
| Database location | `DATABASE_URL`, then restart |
| Trace directory | `TRACES_DIR`, then restart |
| Operator password | Clear `operator_password_hash` and `session_secret` in the database, then run `/setup` again — there is deliberately no authenticated change-password flow yet. Rotating invalidates every session. See [Security](architecture/security.md) |
