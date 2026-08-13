# Endpoint reference

Every route under `app/api/`. Conventions (envelope, error codes, auth) are in
[API conventions](README.md); the machine-readable contract is
[`openapi.yaml`](openapi.yaml).

All routes require an operator session except the four marked **public**.
Success bodies are shown *unwrapped* — the wire format is `{ "data": … }`.

---

## Auth

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/auth/setup` | `{ password }` (≥8 chars) | `{ ok: true }` + `Set-Cookie`. **Public.** Refuses if a password is already set |
| `POST` | `/api/auth/login` | `{ password }` | `{ ok: true }` + `Set-Cookie`. **Public** |
| `POST` | `/api/auth/logout` | — | `{ ok: true }` + cleared cookie. **Public** |

## Health

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/health` | **Public.** `200` when ready, `503` when not |

```json
{
  "status": "ok",
  "time": "2026-07-26T09:12:03.114Z",
  "version": "1.11.4",
  "checks": {
    "database":        { "ok": true, "detail": "Connected" },
    "configuration":   { "configured": true, "detail": "LLM endpoint and model set — see Overview for live status." },
    "traceStorage":    { "ok": true, "detail": "/app/data/traces", "pendingCount": 0, "lastFlushError": null },
    "downloadStorage": { "ok": true, "detail": "/app/data/downloads" }
  }
}
```

Readiness is the **database probe alone** (`SELECT 1`). The other three checks are
informational, each for its own reason:

| Check | Why it is not a gate |
| --- | --- |
| `configuration` | The LLM being down must not make the dashboard "unhealthy" |
| `traceStorage` | While the volume is unwritable, the only copy of the unflushed traces is this process's RAM — restart-looping would destroy exactly the data still savable |
| `downloadStorage` | The app serves fine without it; only browser-agent downloads fail, and they report it on the run that attempted one |

Both storage checks are **real filesystem probes**: `traceStorage` opens the current
month's file for append (the operation the flusher performs), `downloadStorage` creates
and removes a file in the downloads directory. Neither is an env-presence or
`access(W_OK)` guess — a Docker bind mount the container user cannot write to satisfies
both of those and still fails.

## Realtime

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/events` | `text/event-stream`. Every topic; clients filter on `topic` |

---

## Backends

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/backends` | — | `Backend[]` (masked — the key appears only as `apiKeyConfigured`) |
| `POST` | `/api/backends` | `{ name, baseUrl, apiKey?, type }` | The created `Backend` |
| `PATCH` | `/api/backends/{id}` | Partial update, ≥1 field | `{ backend, clearedModels: string[] }` |
| `DELETE` | `/api/backends/{id}` | — | `{ deleted: true }` (409 while a settings role uses it) |
| `GET` | `/api/backends/{id}/models` | — | `{ models: string[] }` |
| `POST` | `/api/backends/test` | `{ backendId? \| baseUrl?, apiKey? }` | `{ models: string[] }` |
| `POST` | `/api/backends/detect` | `{ baseUrl }` | `{ backend: type \| null, detail }` |

Omitting `apiKey` when testing a stored backend reuses the stored key, so a URL
can be re-tested without resending the secret.

## Settings

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/settings` | — | `Settings` (masked — secrets appear only as `…Configured`) |
| `PATCH` | `/api/settings` | Partial `Settings` update, ≥1 field | The updated `Settings` |
| `POST` | `/api/settings/test-chat` | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-embeddings` | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-images` | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-speech` | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-audio` | `{ backendId?, model?, transcriptionMode? }` | `ProbeReport` |
| `POST` | `/api/settings/test-vision` | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-browser` | `{ backendId?, model? }` | `ProbeReport` |

Every role probe performs the role's real work and returns the same
**`ProbeReport`**: `{ model, latencyMs, input[], output[] }`, where each part is
one of `{ kind: "text", label, text }`, `{ kind: "image", label, dataUrl }`,
`{ kind: "audio", label, dataUrl }`, or
`{ kind: "vector", label, dimensions, preview[] }`. Image and audio parts carry
the actual bytes as `data:` URLs, so a caller can render what the endpoint
produced.

Probes merge the input over the stored configuration (omitted fields fall
back; `backendId: null` means "use the chat backend") and resolve exactly as
the runtime does — including the chat-model fallback, so the audio, vision and
browser probes work with no model of their own set. Every field's meaning is in
[Configuration](../configuration.md#db-backed-settings).

## Telegram bot control

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/telegram/bot` | — | `BotStatus` |
| `POST` | `/api/telegram/bot` | `{ action: "start" \| "stop" }` | `BotStatus` |

`BotStatus` = `{ state, username, since, error }`. The token comes from settings, so
`start` needs no body.

## Tools

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/tools` | `{ tools: [{ name, description, feature }] }` |

Read-only. Every registered tool is always available to the model; there is no
per-tool switch.

---

## Users

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/users` | — | `KnownUser[]` |
| `PATCH` | `/api/users/{id}` | `{ aliases: string[] }` **or** `{ language: string }` | The updated `KnownUser` |

`{id}` is the Telegram user id. Aliases are trimmed, blank-stripped and
case-insensitively deduplicated, then bounded (≤20, ≤60 chars each). An empty
`language` clears to null (→ default).

## Groups

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/groups` | — | `KnownGroupSummary[]` (a group plus `memberCount`) |
| `PATCH` | `/api/groups/{id}` | `{ notes: string }` **or** `{ language: string }` | The updated `KnownGroup` |

`{id}` is the Telegram chat id. Notes are trimmed (≤2000 chars); empty clears to null.

## Personalities

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/personalities` | — | `{ personalities, activeId }` |
| `POST` | `/api/personalities` | `{ name, prompt? }` | The created `Personality` — **201** |
| `PATCH` | `/api/personalities/{id}` | `{ name?, prompt? }`, ≥1 field | The updated view |
| `DELETE` | `/api/personalities/{id}` | — | `{ deleted: true }` |
| `PUT` | `/api/personalities/active` | `{ personalityId: string \| null }` | The updated view |

Names are case-insensitively unique (`conflict` otherwise); at most 32 personalities;
name ≤64 chars, prompt ≤32 000.

---

## History

| Method | Path | Body/Query | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/history/summaries` | — | `SummaryJobInfo` |
| `POST` | `/api/history/summaries/run` | — | `SummaryJobInfo` immediately (fire-and-forget) |
| `GET` | `/api/history/search-index` | — | `SearchIndexStatus` |
| `POST` | `/api/history/search-index` | — | `SearchIndexStatus` immediately (fire-and-forget) |
| `DELETE` | `/api/history/search-index` | — | `SearchIndexStatus` + `{ cleared }` |
| `GET` | `/api/history/export` | `?chatId=` (optional) | A CSV attachment: `history-<scope>.csv` |
| `POST` | `/api/history/import` | `{ csv, mapping, delimiter? }` | `ImportResult` |

`SummaryJobInfo` = `DailyJobInfoBase` + `{ pendingDays, embeddingsConfigured }`.

`SearchIndexStatus` = `{ status: IdleJobStatus, pending }`. `DELETE` empties the
index and re-arms a rebuild — the recovery path after configuring an embedding
model, since rows indexed without one keep their null vector otherwise.

`ImportResult` = `{ totalRows, imported, skippedDuplicates, errors: [{ line, message }], chatIds }`.
Import is idempotent — rows whose `(chatId, telegramMessageId)` already exists are
skipped, not overwritten — so a partially-applied file can be safely re-run. The
column mapping keys are the canonical CSV fields; see
[History](../features/history.md#csv-transfer).

## Memory

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/memory` | — | `MemoryView` + `{ job: MemoryJobInfo }` |
| `POST` | `/api/memory/run` | — | `MemoryJobInfo` immediately (fire-and-forget) |
| `DELETE` | `/api/memory/entries/{id}` | — | `{ deleted: true }` — discards a pending note |
| `PATCH` | `/api/memory/users/{userId}` | `{ content }` | The rewritten document (re-embedded) |
| `DELETE` | `/api/memory/users/{userId}` | — | `{ deleted: true }` — forgets the person **and**, by cascade, their pending notes |
| `PATCH` | `/api/memory/general` | `{ content }` | The general document (upsert — the first edit creates it) |
| `DELETE` | `/api/memory/general` | — | `{ deleted: true }` |

`MemoryView` = `{ entries, users, general, generalPendingNotes }`.
`MemoryJobInfo` = `DailyJobInfoBase` + `{ pendingNotes, pendingExtractionDays, embeddingsConfigured }`.

General knowledge has no id in its path and no `POST`: it is **one** document, so
writing it is an upsert and there is nothing to address individually.

## Vision

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/vision/backfill` | `{ status: IdleJobStatus, pending: number }` |
| `POST` | `/api/vision/backfill` | The same, after triggering a run |

## Scheduled tasks

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/scheduled-tasks` | — | `{ tasks: ScheduledTask[] }` |
| `POST` | `/api/scheduled-tasks` | `{ chatId, threadId?, instruction, scheduleKind, timeOfDay, weekdays?, runDate?, enabled? }` | The created task — **201** |
| `PATCH` | `/api/scheduled-tasks/{id}` | Any subset of the editable fields, ≥1 | The updated task |
| `DELETE` | `/api/scheduled-tasks/{id}` | — | `{ deleted: true }` |
| `GET` | `/api/scheduled-tasks/run` | — | `TaskSchedulerJobInfo` |
| `POST` | `/api/scheduled-tasks/run` | — | The same, after one immediate tick |

`TaskSchedulerJobInfo` = `{ status, paused, overdue, nextRunAt, asOf }`. `paused` is
`true` while maintenance mode is on — due tasks stay due and deliver once it ends.

A dashboard-created task has `createdByUserId: null`, so the chat tools (which are
author-scoped) cannot mutate it — except for the owner, who is exempt from the
author rule and may cancel or edit any task in a chat they are in. Schedule
coherence — a `once` task needs a
`runDate`, a `weekly` task needs `weekdays` — is enforced by the service, which also
computes `nextRunAt` in the operator timezone.

## Self-improvement

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/self-improvement` | `SelfImprovementView` + `{ job: DailyJobInfoBase }` |
| `POST` | `/api/self-improvement/run` | The job info immediately (fire-and-forget) |
| `DELETE` | `/api/self-improvement/exclusions/{id}` | `{ deleted: true, exclusion }` — `not_found` for an unknown id |

`SelfImprovementView` = `{ feedbacks, preferences, correction, exclusions }`, each
row resolved with a `userLabel`.

## Browser agent

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/browser` | — | `{ runs: BrowserAgentRun[] }` |
| `POST` | `/api/browser` | `{ goal }` (4–4000 chars) | The queued `BrowserAgentRun` — **201** |
| `GET` | `/api/browser/{id}` | — | `BrowserAgentRunDetail` |
| `GET` | `/api/browser/{id}/screenshot/{seq}` | — | `image/jpeg`, `Cache-Control: private, max-age=3600` |
| `POST` | `/api/browser/ytdlp/run` | — | The yt-dlp updater's job info immediately (fire-and-forget) |

A dashboard-started run has `chatId: null` and delivers nothing — its report is read
on the page. It is treated as the **operator's own**, so `isOwner` is true and the
download tools are enabled.

`BrowserAgentRunDetail` adds `activity` (the ordered step feed), `screenshotSeqs`,
and `live` (`{ currentAction, progress }` while running, `null` once settled).

## Analytics

All the card endpoints share the filter query:

| Param | Values |
| --- | --- |
| `unit` | `day` \| `week` \| `month` \| `year` \| `all` (default `day`) |
| `anchor` | The period key: `2026-07-18`, `2026-07`, `2026`, `all`. Defaults to the current period |
| `chatId` | Optional — restrict to one chat |
| `userId` | Optional — restrict to one user's own messages |

| Method | Path | Extra params | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/analytics/metrics` | — | `TotalsPayload` — the traffic tiles |
| `GET` | `/api/analytics/series` | `section` = `volume` \| `tokens` \| `users` \| `mood` | `SeriesPayload` — `{ buckets, series, bucketUnit, yMax? }` |
| `GET` | `/api/analytics/models` | — | `ModelsPayload` — per model, per call kind |
| `GET` | `/api/analytics/top-users` | — | `TopUsersPayload` |
| `GET` | `/api/analytics/insights` | `chatId` **required** | `PeriodInsight` or `null` when the period is not rolled up yet |
| `GET` | `/api/analytics/availability` | `source` = `messages` \| `traces` \| `insights`; `from`, `to` **required** | `string[]` — the anchors in range that hold data |
| `GET` | `/api/analytics/insights/run` | — | `AnalyticsJobInfo` |
| `POST` | `/api/analytics/insights/run` | — | The same, after one run |
| `POST` | `/api/analytics/insights/regenerate` | Body `{ granularity, bucket }` | `AnalyticsJobInfo`. **Destructive and billable** |

Every section answers with the same `{ buckets, series }` shape, so one client card
component drives them all. `mood` requires a `chatId`.

## Traces / Debug

| Method | Path | Query/Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/traces` | `feature?`, `status?`, `limit?` (1–200), `offset?` | `{ traces, total, features }` — headers only, newest first |
| `GET` | `/api/traces/{id}` | — | The full `Trace` with ordered events; `not_found` for an unknown id |
| `GET` | `/api/traces/bundle` | Same filters | JSON attachment `traces-<scope>.json` |
| `GET` | `/api/traces/{id}/bundle` | — | JSON attachment `trace-<id>.json` |
| `POST` | `/api/traces/prune` | `{ beforeMonth: "YYYY-MM" }` | `{ months: string[], traces: number }`. **Destructive** |

`status` is one of `pending`, `running`, `success`, `error`, `skipped`. Bundles carry
`{ schema: "llm-tg-bot/trace-bundle@1", exportedAt, traces }` and include full event
payloads — which is to say complete conversation content. Handle accordingly.

---

## Quick reference: all routes

```
POST   /api/auth/setup                             public
POST   /api/auth/login                             public
POST   /api/auth/logout                            public
GET    /api/health                                 public
GET    /api/events                                 SSE

GET    /api/backends
POST   /api/backends
PATCH  /api/backends/{id}
DELETE /api/backends/{id}
GET    /api/backends/{id}/models
POST   /api/backends/test
POST   /api/backends/detect

GET    /api/settings
PATCH  /api/settings
POST   /api/settings/test-embeddings
POST   /api/settings/test-images
POST   /api/settings/test-chat
POST   /api/settings/test-speech
POST   /api/settings/test-audio
POST   /api/settings/test-vision
POST   /api/settings/test-browser

GET    /api/telegram/bot
POST   /api/telegram/bot
GET    /api/tools

GET    /api/users
PATCH  /api/users/{id}
GET    /api/groups
PATCH  /api/groups/{id}

GET    /api/personalities
POST   /api/personalities
PATCH  /api/personalities/{id}
DELETE /api/personalities/{id}
PUT    /api/personalities/active

GET    /api/history/summaries
POST   /api/history/summaries/run
GET    /api/history/search-index
POST   /api/history/search-index
DELETE /api/history/search-index
GET    /api/history/export
POST   /api/history/import

GET    /api/memory
POST   /api/memory/run
DELETE /api/memory/entries/{id}
PATCH  /api/memory/users/{userId}
DELETE /api/memory/users/{userId}
PATCH  /api/memory/general
DELETE /api/memory/general

GET    /api/vision/backfill
POST   /api/vision/backfill

GET    /api/scheduled-tasks
POST   /api/scheduled-tasks
PATCH  /api/scheduled-tasks/{id}
DELETE /api/scheduled-tasks/{id}
GET    /api/scheduled-tasks/run
POST   /api/scheduled-tasks/run

GET    /api/self-improvement
POST   /api/self-improvement/run
DELETE /api/self-improvement/exclusions/{id}

GET    /api/browser
POST   /api/browser
GET    /api/browser/{id}
GET    /api/browser/{id}/screenshot/{seq}
POST   /api/browser/ytdlp/run

GET    /api/analytics/metrics
GET    /api/analytics/series
GET    /api/analytics/models
GET    /api/analytics/top-users
GET    /api/analytics/insights
GET    /api/analytics/availability
GET    /api/analytics/insights/run
POST   /api/analytics/insights/run
POST   /api/analytics/insights/regenerate

GET    /api/traces
GET    /api/traces/{id}
GET    /api/traces/bundle
GET    /api/traces/{id}/bundle
POST   /api/traces/prune
```
