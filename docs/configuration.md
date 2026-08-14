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
| `TZ` | `UTC` | Process timezone. The *operator* timezone used for rendering and scheduling is the DB setting, not this. |
| `NODE_ENV` | — | `development` \| `production` \| `test`. |

One more bootstrap override is read directly rather than through `server/env.ts`, so it
has no `_FILE` variant:

| Variable | Default | Purpose |
| --- | --- | --- |

### Compose-only variables

Read by `docker-compose.yml`, not by application code:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3200` | Host port published for the app |
| `POSTGRES_USER` | `bot` | Bundled Postgres user |
| `POSTGRES_PASSWORD` | `bot` | Bundled Postgres password |
| `POSTGRES_DB` | `bot` | Bundled Postgres database |
| `POSTGRES_PORT` | `5432` | Host port published for Postgres |

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

## Backends catalog

LLM endpoints are first-class rows in the `backends` table, managed as a CRUD
on the **Backends** page (`/api/backends`). Each backend is a named
OpenAI-compatible server:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string (≤100) | Display name, unique case-insensitively |
| `baseUrl` | URL (≤500) | The OpenAI-compatible endpoint (e.g. `…/v1`) |
| `apiKey` | secret | Optional; write-only, exposed as `apiKeyConfigured` |
| `type` | enum | Which inference server answers there (`ollama`, `llamacpp`, `vllm`, `anthropic`, `google`, `openai-compatible`) — feeds the backend-normalization adapters. A **Detect** button fingerprints the endpoint as a suggestion; the operator picks. Two speak a native API rather than the OpenAI wire shape: `anthropic` (chat-shaped roles only; API key required) and `google` (chat, embeddings and images; API key required) |

Each backend card has **Test connection** — one `/v1/models` call that proves
the host answers and the key is accepted, and doubles as the model-list
preview. A backend cannot be deleted while a settings role points at it (the
error names the roles); repointing a backend's URL or key verifies every role
model riding on it and clears what the new endpoint verifiably does not serve
(same doctrine as a settings save, below).

## DB-backed Settings

One typed row (`settings`, `id = 'singleton'`). Read with `GET /api/settings`,
written with `PATCH /api/settings`; the dashboard form (Settings page) has one
tab per concern and one Save button that persists every changed field
regardless of which tab is open. The exception is the **Security** tab: the password change there
posts to its own endpoint (`POST /api/auth/change-password`) with its own
button, because it is an auth action, not a settings patch.

Secrets are **write-only**. They are accepted on input and never returned — the
client-facing shape exposes only a `…Configured: boolean`. Omitting a secret key
from a PATCH leaves the stored value alone; sending `null` clears it.

### LLM roles

LLM configuration is per **role**. Every role stores a backend id from the
catalog plus a model id; endpoint URLs and keys live on the backend rows only.
A null backend id means "use the chat backend". Model dropdowns are searchable
and fed by the selected backend's live `/v1/models` listing.

| Role | Backend field | Model field | Model unset means |
| --- | --- | --- | --- |
| Chat (main) | `chatBackendId` | `model` | Bot unconfigured: no replies, every background LLM job settles as a no-op. Pick a model that supports thinking and tool calls |
| Embeddings | `embeddingBackendId` | `embeddingModel` | Semantic recall off |
| Images | `imageBackendId` | `imageModel` | `image_generate` tool off |
| Speech (TTS) | `speechBackendId` | `speechModel` (+ `speechVoice`) | Voice replies off (text only) |
| Audio (STT) | `audioBackendId` | `audioModel` | Voice messages transcribed by the chat model via `input_audio` (main by default) |
| Vision | `visionBackendId` | `visionModel` | The chat model describes media (main by default) |
| Browser agent | `browserBackendId` | `browserModel` | Browsing thinks on the chat model (main by default) |
| Classifiers | `classifierBackendId` | `classifierModel` | The per-message checks run on the chat model (main by default) |
| Background jobs | `backgroundBackendId` | `backgroundModel` | The nightly jobs run on the chat model (main by default) |

The last two are the **auxiliary** roles: everything the bot asks a model that
is not a reply. They are split because the two workloads pull in opposite
directions, and one setting for both would force a bad trade.

- **Classifiers** — the addressing analyzer, its verifier, the standing chat-rule
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

Deliberately **not** auxiliary: replies, and scheduled tasks — a task fires a
real user-facing message through the tool loop, so it holds the same quality bar
as an answer to a person and stays on the chat role. Vision, audio and browsing
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

### Telegram

| Field | Type | Effect when unset |
| --- | --- | --- |
| `telegramBotToken` | secret (≤200) | The poller cannot start; Overview says so |
| `ownerUserId` | numeric string | Owner-gated behavior is off (maintenance mode then closes the bot to everyone; browser-agent downloads stay disabled) |
| `maintenanceModeEnabled` | boolean | `false`. When on, only the owner is answered (and only through deterministic addressing), and no scheduled task fires |

`ownerUsername` is stored denormalized from the chosen known user, for display
only.

### General

| Field | Type | Effect when unset |
| --- | --- | --- |
| `timezone` | IANA name | `UTC`. Governs every rendered timestamp, scheduled-task wall-clock times, daily-job run time, and analytics period boundaries |
| `dailyJobsRunTime` | `HH:MM` | `04:00`. The local time in `timezone` that **all** daily jobs run at |
| `browserDownloadLimitGb` | int 1–100 | `10`. Hard ceiling on a single browser-agent download, for every download tool. A disk guard — it never lowers the quality the agent fetches |

The chat-attach ceiling is not a setting: it is fixed at 50 MB, Telegram's bot
upload limit (`TELEGRAM_MAX_UPLOAD_MB` in `lib/telegram.ts`; user decision,
2026-08-01 — the old `browserDownloadMaxMb` setting only ever restated a fact
about Telegram).

### Role probes

Every probe takes `{ backendId?, model? }` (omitted fields fall back to what is
stored, a null `backendId` means "use the chat backend") and resolves through
the same runtime resolver the feature uses — a passing test means the real
connection works, not a test-only variant of it.

- **Test embeddings** embeds a real string and reports the vector width it got
  back. Every stored vector must be **1024** wide (`lib/embeddings.ts`,
  `EMBEDDING_DIMENSIONS` — a code constant, not a setting: pgvector cannot
  index a vector of unspecified width), so a mismatched model surfaces as a
  clear message instead of an opaque Postgres error inside a nightly job.
- **Test image endpoint** / **Test speech endpoint** check the configured model
  is actually served rather than generating anything.
- **Test audio** transcribes a fraction of a second of generated silence — a
  real `/v1/audio/transcriptions` call, because whisper-class servers often
  serve it without `/v1/models`.
- Vision and browser agent have no dedicated probe: they are chat-completion
  roles, verified by the backend's model listing (and the Overview probes).

### Integrations

| Field | Type | Notes |
| --- | --- | --- |
| `tavilyApiKey` | secret | The browsing agent's search fallback, used only when no search engine loads in the browser. Unset, a run whose engines are all blocked reports the search as failed |

### Not on the form

Two columns on the same row are managed by other flows and never editable here:

| Column | Owner |
| --- | --- |
| `operator_password_hash`, `session_secret` | `/setup`, the Security tab's password change, and the auth service (see [Security](architecture/security.md)) |
| `active_personality_id` | The Personalities page (`PUT /api/personalities/active`) |

---

## Verifying configuration honestly

Nothing in this app reports "configured" from the presence of a variable.

- **Overview** runs a real `SELECT 1` and a real `/v1/models` call, and probes both
  filesystem write paths: the trace directory by opening the current month's file for
  append (exactly what the flusher does), and the downloads directory by creating and
  removing a file (exactly what a download does). Neither is an `access(W_OK)` guess,
  which a bind mount the container user cannot write to would satisfy.
- **`GET /api/health`** returns `200`/`503` on the database probe alone.
  Configuration presence, trace-storage health and download-storage health are
  reported in the body but are deliberately *not* readiness gates: restart-looping on
  an unwritable trace volume would drop the settled traces still buffered in RAM, and
  an unwritable downloads mount breaks only the browser agent's downloads.
- **Connection probes** (`POST /api/backends/test`, and the role probes
  `test-embeddings`, `test-images`, `test-speech`, `test-audio`) each make a
  real call and are recorded as traces (`backends` / `settings` features).

## Changing configuration

| Change | How |
| --- | --- |
| Any runtime setting | Settings page, or `PATCH /api/settings`. Effective immediately |
| Database location | `DATABASE_URL`, then restart |
| Operator password | Settings → Security (requires the current password; signs out every other session). Forgotten password: clear `operator_password_hash` and `session_secret` in the database, then run `/setup` again. See [Security](architecture/security.md) |
