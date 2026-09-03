# Configuration

Configuration lives in **two** layers, and the split is deliberate.

| Layer | Holds | Changed by | Takes effect |
| --- | --- | --- | --- |
| Environment variables | Bootstrap plumbing only: where the database and Redis are, the shared secret the two apps present to each other, the process timezone | Editing each app's `.env` / compose, then restarting | On restart |
| DB-backed configuration | All runtime product configuration: backends, models, settings, assistants and their personas, bot tokens, tasks, tool connections | The dashboard, or the API | Immediately — background jobs and the pipeline re-read per run/turn; a transport reconciles on the change event |

Runtime setup is **not** in env vars. An operator should never have to edit a
file and restart a container to change the model an assistant uses.

Paths are relative to `apps/core/` unless they start with `apps/` or `packages/`.

---

## Environment variables

### The core (`apps/core`)

The full list, as parsed by `server/env.ts`. Every variable also accepts a
`<NAME>_FILE` variant whose file contents are used instead — that is the Docker
secrets path (`DATABASE_URL_FILE=/run/secrets/database_url`).

Nothing is required at process boot. Requirements are enforced at the point of
use (`requireEnv`), so the dashboard still starts and reports what is missing
rather than crash-looping.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres (with `vector` and `pg_trgm`) connection string. Required for anything that touches persistence, which is nearly everything |
| `REDIS_URL` | — | The queue every incoming message travels on and the bus the apps talk over. Unset, the core boots but starts no queue consumers and processes **no messages** — the log says so loudly |
| `INTERNAL_API_TOKEN` | — | The shared secret authenticating every core ↔ transport HTTP call (`x-internal-token`). Must equal the transports'. Unset, every internal route answers 401 and no transport can register |
| `TZ` | `UTC` | Process timezone. The *operator* timezone used for rendering and scheduling is the DB setting, not this |
| `NODE_ENV` | — | `development` \| `production` \| `test` |

### The Telegram transport (`apps/tg`)

Read directly from the environment (`packages/service`'s `requireEnv` /
`optionalEnv`; no `_FILE` variants):

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDIS_URL` | — | Required. Same Redis as the core |
| `INTERNAL_API_TOKEN` | — | Required. Must equal the core's |
| `PORT` | `3210` | The service's HTTP port (health, the internal API, the MCP server) |
| `CORE_API_URL` | `http://localhost:3200` | Where the core's internal API is |
| `SELF_URL` | `http://localhost:<PORT>` | The base URL the service **announces** at registration — what the core calls back. Set it whenever the core cannot reach the service on localhost (compose: `http://tg:3210`) |

Everything else the service needs — bot tokens, which assistants to run —
comes from the core at registration and on every change event.

### Compose-only variables

Read by `docker-compose.yml`, not by application code:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AHW_VERSION` | The version this checkout releases | Which released image tag the `app` and `tg` services run (`ghcr.io/assistant-hub-swarm/ahw-*`). The default is rewritten by `npm run release:*`, so a clone runs a known-good set rather than a moving `latest` |
| `PORT` | `3200` | Host port published for the core |
| `INTERNAL_API_TOKEN` | `change-me` | Passed to every app. **Set a real value** — it is what a transport authenticates with too |
| `POSTGRES_USER` | `bot` | Bundled Postgres user |
| `POSTGRES_PASSWORD` | `bot` | Bundled Postgres password |
| `POSTGRES_DB` | `bot` | Bundled Postgres database |
| `POSTGRES_PORT` | `5432` | Host port published for Postgres |
| `REDIS_PORT` | `6379` | Host port published for Redis |
| `TZ` | `UTC` | Process timezone for every service |

Under Compose, `DATABASE_URL` is built from the `POSTGRES_*` variables and points
at the bundled `db` service, `REDIS_URL` points at the bundled `redis`, and the
transport's `SELF_URL` / `CORE_API_URL` are the compose service names. Set
`DATABASE_URL` explicitly to use an external database instead.

`docker-compose.dev.yml` is the override that builds the two application images
from the working tree instead of pulling them; it changes nothing else.

### Runtime variables set by the core image

| Variable | Set to | Why |
| --- | --- | --- |
| `HOSTNAME` | `0.0.0.0` | The Next standalone server binds `HOSTNAME`; the default would not be reachable in-container |
| `CHROMIUM_EXECUTABLE_PATH` | `/usr/bin/chromium-browser` | Playwright's bundled browser is a glibc build and cannot run on Alpine, so the distro Chromium is installed and pointed at |
| `NEXT_TELEMETRY_DISABLED` | `1` | No build telemetry |

`NEXT_PUBLIC_APP_NAME` and `NEXT_PUBLIC_APP_VERSION` are inlined at build time by
`next.config.ts` from the root `package.json` and read through `lib/build-info.ts`.
They exist so client-reachable code never imports `package.json` (which shipped
the whole dependency manifest into the browser bundle).

---

## Backends catalog

LLM endpoints are first-class rows in the `backends` table, managed as a CRUD
on the **Backends** page (`/api/backends`). Each backend is a named
inference server:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string (≤100) | Display name, unique case-insensitively |
| `baseUrl` | URL (≤500) | The endpoint (e.g. `…/v1`) |
| `apiKey` | secret | Optional; write-only, exposed as `apiKeyConfigured` |
| `type` | enum | Which inference server answers there (`ollama`, `llamacpp`, `vllm`, `anthropic`, `google`, `zai`, `openai-compatible`) — feeds the backend-normalization adapters. A **Detect** button fingerprints the endpoint as a suggestion; the operator picks. Two speak a native API rather than the OpenAI wire shape: `anthropic` (chat-shaped roles only; API key required) and `google` (chat, embeddings and images; API key required). `zai` speaks the OpenAI shape off its own base with its own thinking switch |

Each backend card has **Test connection** — one `/v1/models` call that proves
the host answers and the key is accepted, and doubles as the model-list
preview. A backend cannot be deleted while a settings role points at it (the
error names the roles); repointing a backend's URL or key verifies every role
model riding on it and clears what the new endpoint verifiably does not serve
(same doctrine as a settings save, below).

## DB-backed Settings

One typed row (`settings`, `id = 'singleton'`). Read with `GET /api/settings`,
written with `PATCH /api/settings`; the dashboard form (Settings page) has one
tab per concern — **Models**, **Telegram**, **General**, **Integrations**,
**Security** — and one Save button that persists every changed field
regardless of which tab is open. The exception is the **Security** tab: the
password change there posts to its own endpoint
(`POST /api/auth/change-password`) with its own button, because it is an auth
action on the signed-in account, not a settings patch.

Secrets are **write-only**. They are accepted on input and never returned — the
client-facing shape exposes only a `…Configured: boolean`. Omitting a secret key
from a PATCH leaves the stored value alone; sending `null` clears it.

### LLM roles (Models tab)

LLM configuration is per **role**. Every role stores a backend id from the
catalog plus a model id; endpoint URLs and keys live on the backend rows only.
A null backend id means "use the chat backend". Model dropdowns are searchable
and fed by the selected backend's live `/v1/models` listing.

| Role | Backend field | Model field | Model unset means |
| --- | --- | --- | --- |
| Chat (main) | `chatBackendId` | `model` | Unconfigured: no replies, every background LLM job settles as a no-op. Pick a model that supports tool calls |
| Embeddings | `embeddingBackendId` | `embeddingModel` | Semantic recall off |
| Images | `imageBackendId` | `imageModel` | `image_generate` tool off |
| Speech (TTS) | `speechBackendId` | `speechModel` (+ `speechVoice`) | Voice replies off (text only) |
| Audio (STT) | `audioBackendId` | `audioModel` (+ `audioTranscriptionMode`) | Voice messages transcribed by the chat model via `input_audio` (main by default) |
| Vision | `visionBackendId` | `visionModel` | The chat model describes media (main by default) |
| Browser agent | `browserBackendId` | `browserModel` | Browsing thinks on the chat model (main by default) |
| Classifiers | `classifierBackendId` | `classifierModel` | The per-message checks run on the chat model (main by default) |
| Background jobs | `backgroundBackendId` | `backgroundModel` | The nightly jobs run on the chat model (main by default) |

`audioTranscriptionMode` is `transcriptions` (a whisper-class
`/v1/audio/transcriptions` endpoint) or `chat` (an audio-capable chat model
takes the bytes as `input_audio`).

The last two are the **auxiliary** roles: everything the bot asks a model that
is not a reply. They are split because the two workloads pull in opposite
directions, and one setting for both would force a bad trade.

- **Classifiers** — the addressing analyzer, its verifier, the standing task
  match, and the honesty gate over a drafted reply. One question about one piece
  of text, answered as a small JSON verdict, with no tools, history or persona.
  Every group message pays at least one of these before a reply is even
  considered, so this is the reply path's latency floor: a small fast model here
  is a direct speed win, and a wrong verdict costs a missed summons, not a bad
  answer. Call bounds (thinking off, token cap) live in
  `server/llm/classifier.ts` and are shared with the probe.
- **Background jobs** — history summarization, memory extraction and
  consolidation, analytics insights, and self-improvement reflection. Long
  transcripts in, structured output out, at background priority. Nobody waits for
  these, but what they write is what later replies recall, so quality outranks
  latency and a long-context model belongs here.

Deliberately **not** auxiliary: replies, and tasks — a task fires a real
user-facing message through the tool loop, so it holds the same quality bar as
an answer to a person and stays on the chat role. Vision, audio and browsing
have their own roles already.

A model id is only meaningful on the backend it was picked from, so a PATCH
that repoints a role — its own backend id changes, or the chat backend changes
and the role inherits it — verifies the stored selections now served there: the
newly effective backend is asked for its `/v1/models` list and any stored model
it verifiably does not serve is **cleared in the same write** (recorded as warn
events on the update trace, and named next to the Save button in the form).
Two deliberate limits: a model sent in the same PATCH is trusted as an explicit
choice, and when the new backend cannot be listed nothing is cleared — absence
is only acted on when proven. The audio model is exempt only in
`transcriptions` mode (whisper-class servers often expose no listing; its field
is free-text in the UI for the same reason) — in `chat` mode it is an ordinary
chat model and is verified like the rest.

### Role probes

Every role card has a probe (`POST /api/settings/test-<role>`: `chat`,
`classifier`, `background`, `vision`, `browser`, `embeddings`, `images`,
`speech`, `audio`). Each takes `{ backendId?, model? }` (omitted fields fall
back to what is stored, a null `backendId` means "use the chat backend") and
resolves through the same runtime resolver the feature uses — a passing test
means the real connection works, not a test-only variant of it.

- The chat-shaped probes (**chat**, **classifier**, **background**, **vision**,
  **browser**) run one real completion in that role's call shape and report
  the model that answered and the latency.
- **Test embeddings** embeds a real string and reports the vector width it got
  back. Every stored vector must be **1024** wide (`lib/embeddings.ts`,
  `EMBEDDING_DIMENSIONS` — a code constant, not a setting: pgvector cannot
  index a vector of unspecified width), so a mismatched model surfaces as a
  clear message instead of an opaque Postgres error inside a nightly job.
- **Test images** / **Test speech** check the configured model is actually
  served rather than generating anything.
- **Test audio** transcribes a fraction of a second of generated silence — a
  real call in the configured mode, because whisper-class servers often serve
  it without `/v1/models`.

### Telegram tab

| Field | Type | Effect when unset |
| --- | --- | --- |
| `maintenanceModeEnabled` | boolean | `false`. When on, only senders holding owner rights (the assistant's owning account, admins) are answered — and only through deterministic addressing — everyone else gets a static notice, and no task fires |

Bot tokens are **not** settings: each assistant carries its own Telegram
connection, entered in the assistant editor on `/assistants` (the tab links
there). The token is stored as the connection's opaque config and handed to the
transport at registration and on every change.

### General tab

| Field | Type | Effect when unset |
| --- | --- | --- |
| `timezone` | IANA name | `UTC`. Governs every rendered timestamp, task wall-clock times, the daily-job run time, and analytics period boundaries |
| `dailyJobsRunTime` | `HH:MM` | `04:00`. The local time in `timezone` that **all** daily jobs run at |
| `browserDownloadLimitGb` | int 1–100 | `10`. Hard ceiling on a single browser-agent download, for every download tool. A disk guard — it never lowers the quality the agent fetches |
| `assistantLoopGuardTurns` | int 0–10 | `3`. In a chat with several assistants, how many assistant-authored messages in a row are allowed before the assistants fall silent until a person speaks (user decision, 2026-08-24) |

The chat-attach ceiling is not a setting: it is fixed at 50 MB, Telegram's bot
upload limit (`TELEGRAM_MAX_UPLOAD_MB` in `lib/telegram.ts`; user decision,
2026-08-01 — the old `browserDownloadMaxMb` setting only ever restated a fact
about Telegram).

### Integrations tab

| Field | Type | Notes |
| --- | --- | --- |
| `tavilyApiKey` | secret | The browsing agent's search fallback, used only when no search engine loads in the browser. Unset, a run whose engines are all blocked reports the search as failed |

## Configuration that is not a setting

Everything else a person configures is its own feature with its own page,
because it is a collection rather than one row:

| What | Where | Doc |
| --- | --- | --- |
| Accounts, roles, passwords | `/accounts`, `/profile` | [Accounts](features/accounts.md) |
| Assistants: name, persona, owner, tool selection | `/assistants` | [Assistants](features/assistants.md) |
| Transport connections (bot tokens) | The assistant editor; rendered from the field schema each transport announces at registration; stored in `assistant_transports.config` | [Adding a transport](development/adding-a-transport.md) |
| Transport-level config | `PUT /api/transports/{id}/config`; the Telegram transport announces no fields today | — |
| Tasks | `/tasks` | [Tasks](features/tasks.md) |
| Tool connections | `/tools` | [Tool connections](features/tool-connections.md) |
| Per-person and per-chat reply language, aliases, group notes | `/users`, `/groups` | [Users and groups](features/known-users-and-groups.md) |

---

## Verifying configuration honestly

Nothing in this system reports "configured" from the presence of a variable.

- **Overview** runs a real `SELECT 1` and a real `/v1/models` call, probes both
  filesystem write paths (the trace directory by opening the current month's
  file for append, the downloads directory by creating and removing a file),
  and shows each Telegram connection's live poller state as the transport
  reports it on its `/health` — "Not tracked" when the service is not running.
- **`GET /api/health`** returns `200`/`503` on the database probe alone.
  Configuration presence, trace-storage health and download-storage health are
  reported in the body but are deliberately *not* readiness gates: restart-looping
  on an unwritable trace volume would drop the settled traces still buffered in
  RAM, and an unwritable downloads mount breaks only the browser agent's
  downloads.
- **Connection probes** (`POST /api/backends/test`, and the nine role probes)
  each make a real call and are recorded as traces (`backends` / `settings`
  features).
- **The assistant editor** shows a connection as Running only when the
  transport's health report says its poller is polling under that bot account.

## Changing configuration

| Change | How |
| --- | --- |
| Any runtime setting | Settings page, or `PATCH /api/settings`. Effective immediately |
| A bot token, starting or stopping a bot | The assistant editor; the transport reconciles within a second of the change event |
| Database or Redis location | `DATABASE_URL` / `REDIS_URL`, then restart the app(s) that read them |
| The internal token | `INTERNAL_API_TOKEN` in **both** apps, then restart both |
| Your password | `/profile` (requires the current password). An admin resets another account from `/accounts` with a temporary password. A locked-out sole admin: see [Security](architecture/security.md#recovery-for-a-locked-out-sole-admin) |
