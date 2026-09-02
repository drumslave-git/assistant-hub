# Endpoint reference

Every route under `app/api/`. Conventions (envelope, error codes, auth) are in
[API conventions](README.md); the machine-readable contract is
[`openapi.yaml`](openapi.yaml).

The **Access** column is the route's level on `defineRoute`:

| Access | Who |
| --- | --- |
| **public** | No session |
| **account** | Any signed-in, active account - ownership-scoped for a user-role account (see [What a user-role account sees](README.md#what-a-user-role-account-sees)) |
| **admin** | A signed-in admin (the default) |
| **internal** | The `x-internal-token` header, no session - the transport services only |

Success bodies are shown *unwrapped* — the wire format is `{ "data": … }` (the
internal routes, the health probe, downloads and streams excepted).

---

## Auth

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `POST` | `/api/auth/setup` | public | `{ username, password }` | `{ ok: true }` + `Set-Cookie`. Creates the first **admin**; `conflict` once any account exists |
| `POST` | `/api/auth/login` | public | `{ username, password }` | `{ ok: true }` + `Set-Cookie`. `unauthorized` for wrong credentials or a deactivated account (one answer for both, after a flat delay); `bad_request` before setup ran |
| `POST` | `/api/auth/logout` | public | — | `{ ok: true }` + cleared cookie |
| `POST` | `/api/auth/change-password` | account | `{ currentPassword, newPassword }` | `{ ok: true }` + a **fresh** `Set-Cookie` (the session secret rotates; the account's other sessions are signed out). `unauthorized` on a wrong current password. The one route an account holding a temporary password may call |

Usernames: at least 3 characters, letters/digits/`.`/`-`/`_`. Passwords: at
least 8 characters.

## Health

| Method | Path | Access | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/health` | public | `200` when ready, `503` when not |

```json
{
  "status": "ok",
  "time": "2026-07-26T09:12:03.114Z",
  "version": "1.48.0",
  "checks": {
    "database":        { "ok": true, "detail": "Connected" },
    "configuration":   { "configured": true, "detail": "Chat backend and model set — see Overview for live status." },
    "traceStorage":    { "ok": true, "detail": "/app/apps/core/data/traces", "pendingCount": 0, "lastFlushError": null },
    "downloadStorage": { "ok": true, "detail": "/app/apps/core/data/downloads" }
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
both of those and still fails. `lastFlushError`, when set, is
`{ monthKey, message, at }`.

## Realtime

| Method | Path | Access | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/events` | account | `text/event-stream`. Every topic; clients filter on `topic` |

---

## Accounts

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/accounts` | admin | — | `{ accounts: AccountView[] }`, oldest first |
| `POST` | `/api/accounts` | admin | `{ username, displayName?, role: "admin" \| "user", temporaryPassword }` | `{ account: AccountView }` — **201**. `conflict` on a taken username |
| `PATCH` | `/api/accounts/{id}` | admin | `{ active: boolean }` **or** `{ role }` **or** `{ temporaryPassword }` | `{ account: AccountView }` |
| `DELETE` | `/api/accounts/{id}` | admin | — | `{ deleted: true }`. Only a **deactivated** account; cascades everything that was only theirs |

`AccountView` = `{ id, username, displayName, role, active, mustChangePassword, createdAt }`.
A created account, and one handed a fresh `temporaryPassword`, has
`mustChangePassword: true` until it calls `POST /api/auth/change-password`.
Guards answer `bad_request`: you cannot deactivate or delete your own account,
change your own role, or deactivate/demote the last active admin; a delete
requires the account to be deactivated first (the two steps are the confirm).
Deactivation silences the account's assistants (their transport connections
stop, their tasks do not fire) without deleting anything; reactivation restores
them as they were.

## Profile

The acting account's own surface. Everything is scoped to the session.

| Method | Path | Access | Body/Query | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/profile` | account | — | `{ account: { id, username, displayName, role }, identities: ProfileIdentity[], memory: ProfileMemoryDoc[] }` |
| `PATCH` | `/api/profile` | account | `{ displayName }` (≤120; blank clears) | `{ displayName: string \| null }` |
| `POST` | `/api/profile/link-code` | account | — | `{ code, expiresAt }` — a one-time `link-xxxxxxxx` code, valid 15 minutes |
| `DELETE` | `/api/profile/memory` | account | `?userId=<scoped ref>` | `{ deleted: true }`. `forbidden` unless the ref is one of the account's identities; `not_found` when no document exists |

`ProfileIdentity` = `{ ref, source, sourceLabel, label, self }` — every
identity the person-link graph joins to the account's own `chat:user:<id>`
ref, labelled from the directory when a source still knows it. `ProfileMemoryDoc`
= `{ userId, ref, content, updatedAt }` — the memory documents held under those
identities (`userId` is the key to delete by). Send the link code to any
connected bot within 15 minutes and that platform identity joins the account's
person link; minting again retires the previous unused code.

## Assistants

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/assistants` | account | — | `{ assistants: Assistant[] }`, oldest first (a user-role account: its own) |
| `POST` | `/api/assistants` | account | `{ name (≤64), persona? (≤32 000, default "") }` | The created `Assistant` — **201**. The creator owns it |
| `PATCH` | `/api/assistants/{id}` | account | `{ name?, persona? }`, ≥1 field | The updated `Assistant` |
| `DELETE` | `/api/assistants/{id}` | account | — | `{ deleted: true }`. Tasks cascade; transports drop their connections on the `assistant.deleted` bus event |

`Assistant` = `{ id, name, persona, ownerAccountId, createdAt, updatedAt }`.
Names are case-insensitively unique (`conflict` otherwise); at most 32
assistants. There is no "active" assistant: the assistant in a chat is implied
by which bot is in it (a transport connection) or which one a web thread was
opened with.

## Transports

The dashboard-facing side of the transport contract: the registered transports
and each assistant's connection on them. `{id}` is a source id — any slug of
the right shape (`^[a-z][a-z0-9-]{0,31}$`); a malformed one is `bad_request`,
a well-formed one that never registered `not_found`.
The transport itself registers and reconciles over the
[internal transport API](#internal-transport-api).

| Method | Path | Access | Body/Query | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/transports` | account | — | `{ transports: TransportView[] }` |
| `PUT` | `/api/transports/{id}/config` | admin | `{ config: object }` | `{ configPreview }`. Replaces the transport-level blob and announces the change |
| `GET` | `/api/transports/{id}/connections` | account | `?assistantId=` (optional for admins, **required** for a user-role account, naming its own assistant) | `{ connections: TransportConnectionView[] }` |
| `POST` | `/api/transports/{id}/connections` | account | `{ assistantId, config: object }` | `{ connection: TransportConnectionView \| null }` — **201**. Enabled on creation. `conflict` when the assistant already has a connection on this transport |
| `PATCH` | `/api/transports/{id}/connections/{connectionId}` | account | `{ config?: object (shallow merge), enabled?: boolean }`, ≥1 | `{ connection: { id, enabled } }` |
| `DELETE` | `/api/transports/{id}/connections/{connectionId}` | account | — | `{ deleted: true }` |

`TransportView` = `{ id, name, enabled, registered, contractMajor, compatible,
refusedReason, lastSeenAt, connectionConfigSchema, transportConfigSchema,
configPreview, updatedAt }`; `registered` is false until the transport has
announced itself, `compatible` is false (and `refusedReason` names both
majors) when it announced a contract major this core does not speak. The two
schemas are lists of `TransportConfigField` =
`{ key, label, kind: "text" \| "secret" \| "boolean", help?, required? }` -
the dashboard renders its forms from them, and the `config` blobs a caller
sends are keyed by them. The core never interprets a blob; secrets are never
read back — every `configPreview` reduces a `secret` field to `…last4`.

`TransportConnectionView` = `{ id, assistantId, enabled, configPreview,
createdAt, updatedAt, status }` where `status` is the live poller state the
transport reports on its own `/health` (`{ state: "running" \| "error" \|
"stopped", username, since, error }`) or `null` when it reports none.

Every write here announces `transport.config.changed` on the bus; the transport
refetches its desired state and reconciles.

## Backends

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/backends` | admin | — | `Backend[]` (masked — the key appears only as `apiKeyConfigured`) |
| `POST` | `/api/backends` | admin | `{ name, baseUrl, apiKey?, type }` | The created `Backend` (200) |
| `PATCH` | `/api/backends/{id}` | admin | Partial update, ≥1 field | `{ backend, clearedModels: string[] }` |
| `DELETE` | `/api/backends/{id}` | admin | — | `{ deleted: true }` (409 while a settings role uses it) |
| `GET` | `/api/backends/{id}/models` | admin | — | `{ models: string[] }` |
| `POST` | `/api/backends/test` | admin | `{ backendId? \| baseUrl?, apiKey?, type? }` | `{ models: string[] }` |
| `POST` | `/api/backends/detect` | admin | `{ baseUrl }` | `{ backend: type \| null, detail }` |

`type` is one of `ollama`, `llamacpp`, `vllm`, `anthropic`, `google`, `zai`,
`openai-compatible`. Omitting `apiKey` when testing a stored backend reuses the
stored key, so a URL can be re-tested without resending the secret; `type`
carries the form's current selection, since the listing call differs per
server.

## Settings

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/settings` | admin | — | `Settings` (masked — secrets appear only as `…Configured`) |
| `PATCH` | `/api/settings` | admin | Partial `Settings` update, ≥1 field | The updated `Settings` |
| `POST` | `/api/settings/test-chat` | admin | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-embeddings` | admin | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-images` | admin | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-speech` | admin | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-audio` | admin | `{ backendId?, model?, transcriptionMode? }` | `ProbeReport` |
| `POST` | `/api/settings/test-vision` | admin | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-browser` | admin | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-classifier` | admin | `{ backendId?, model? }` | `ProbeReport` |
| `POST` | `/api/settings/test-background` | admin | `{ backendId?, model? }` | `ProbeReport` |

`Settings` carries, per role (chat, embedding, image, speech, audio, vision,
browser, classifier, background), a `…BackendId` (null = the chat backend) and
a `…Model`; plus `speechVoice`, `audioTranscriptionMode`
(`transcriptions` | `chat`), `webSearchConfigured`, `maintenanceModeEnabled`,
`assistantLoopGuardTurns` (0–10), `timezone`, `dailyJobsRunTime` (`HH:MM`),
`browserDownloadLimitGb` (1–100), `updatedAt`. The write-only secret is
`tavilyApiKey`. Bot tokens are not here: they live on each assistant's
transport connection.

Every role probe performs the role's real work and returns the same
**`ProbeReport`**: `{ model, latencyMs, input[], output[] }`, where each part is
one of `{ kind: "text", label, text }`, `{ kind: "image", label, dataUrl }`,
`{ kind: "audio", label, dataUrl }`, or
`{ kind: "vector", label, dimensions, preview[] }`. Image and audio parts carry
the actual bytes as `data:` URLs, so a caller can render what the endpoint
produced. A probe of a role with no model (and no chat model to fall back to)
is `bad_request`.

Probes merge the input over the stored configuration (omitted fields fall
back; `backendId: null` means "use the chat backend") and resolve exactly as
the runtime does — including the chat-model fallback, so the audio, vision,
browser, classifier and background probes work with no model of their own set. Every field's meaning is in
[Configuration](../configuration.md#db-backed-settings).

## Tools

| Method | Path | Access | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/tools` | admin | `{ tools: ToolView[] }` |

Read-only: the catalog of everything either half of the toolset offers. In-process
feature tools are `{ name, description, feature }`; a tool hosted by a tool
connection carries its slug-prefixed name (`<slug>__<tool>`), `feature:
"connections"`, and `connection: { id, slug, name, managed, enabled, scope: {
appScope, allAssistants, assistantCount } }`. Every registered tool is offered
to the model within its scope; there is no per-tool switch.

## Tool connections

Remote MCP servers the operator adds. What the model is offered changes only on
an explicit **apply** of a reviewed discovery — editing a connection can only
take tools away (disable, re-scope).

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/tool-connections` | account | — | `{ connections: ToolConnection[] }` (a user-role account: its own) |
| `POST` | `/api/tool-connections` | account | `{ slug, name, transport?="http", endpointUrl, authHeaders?={}, enabled?=true, appScope?=null, allAssistants?=true, assistantIds?=[] }` | The created `ToolConnection` — **201**. No tools are offered until a discovery is applied |
| `PATCH` | `/api/tool-connections/{id}` | account | Any subset of `slug, name, endpointUrl, authHeaders, enabled, appScope, allAssistants, assistantIds`, ≥1 | The updated `ToolConnection` |
| `DELETE` | `/api/tool-connections/{id}` | account | — | `{ deleted: true }`; the snapshot and assistant selection cascade |
| `POST` | `/api/tool-connections/{id}/discover` | account | — | `DiscoveryReport` — a server that cannot be reached is `ok: false`, not a 5xx |
| `POST` | `/api/tool-connections/{id}/apply` | account | — | The `ToolConnection` with the discovery applied. `bad_request` before any discovery |

`ToolConnection` = `{ id, slug, name, transport, endpointUrl, authHeaderNames,
enabled, appScope, allAssistants, assistantIds, managed, ownerAccountId,
lastDiscoveredAt, lastError, discoveredTools, drift, tools, createdAt,
updatedAt }` — header **values** never leave the server. `tools` is the applied
snapshot (`{ name, description, inputSchema, appliedAt }`), `discoveredTools`
what the last discovery saw, `drift` that discovery against the snapshot
(`{ added, changed, removed, unchanged }`). `DiscoveryReport` = `{ connectionId,
ok, error, connection, diff }`.

Rules: slug is `^[a-z][a-z0-9-]*$` (≤24) and unique (`conflict`); at most 32
connections; only `http` executes (`stdio` is modelled but refused); at most 8
auth headers; `assistantIds` must exist. A **managed** connection (a
transport's own MCP server) accepts only `enabled` and scope edits and cannot
be deleted (`conflict`). A **user-owned** connection (the owner's current role
is `user`) must select specific assistants of the owner's own, may not scope
to an app, and must target a public address — checked on write and again on
every call.

---

## Users

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/users` | admin | — | `{ entries: DirectoryUser[], unavailable: UnavailableSource[] }`, newest activity first |
| `PATCH` | `/api/users/{id}` | admin | `{ aliases: string[] }` **or** `{ language: string }` | The updated `KnownUser` |

The directory is aggregated across every source (`tg`, `chat`): each entry is
the source's `{ id, username, firstName, lastName, label, aliases, language,
firstSeenAt, updatedAt }` plus its origin `{ source, sourceLabel, ref }`. A
source that could not be read comes back under `unavailable` as `{ source,
sourceLabel, reason }` rather than as an empty list. `{id}` is the person's
scoped ref (`tg:user:123`). Aliases are trimmed, blank-stripped and
case-insensitively deduplicated, then bounded (≤20, ≤60 chars each). An empty
`language` clears to null (→ default).

## Groups

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/groups` | admin | — | `{ entries: DirectoryChat[], unavailable: UnavailableSource[] }`, newest message first |
| `PATCH` | `/api/groups/{id}` | admin | `{ notes: string }` **or** `{ language: string }` | The updated `KnownGroup` |

Each entry is the source's `{ id, kind: "direct" \| "group", title, type, notes,
language, messageCount, memberCount, lastMessageAt }` plus its origin. `{id}` is
the chat's scoped ref (`tg:chat:-100…`). Notes are trimmed (≤2000 chars); empty
clears to null.

## Person links

The operator's declaration that several identities are the same human, so
memory and owner rights follow them across sources.

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/person-links` | admin | — | `{ links: PersonLink[] }`, oldest first |
| `POST` | `/api/person-links` | admin | `{ members: scopedRef[] (2–20), note? (≤500) }` | The created `PersonLink` — **201** |
| `PATCH` | `/api/person-links/{id}` | admin | `{ note }` **or** `{ members }` | The updated `PersonLink` |
| `DELETE` | `/api/person-links/{id}` | admin | — | `{ deleted: true }` |

`PersonLink` = `{ id, note, members: [{ userRef, source, sourceLabel, label,
addedAt }], createdAt, updatedAt }`, each member labelled from the directory
(`label` null when no source currently knows the ref). Members are deduplicated;
an identity belongs to at most one link (`conflict` names the one already
claimed). There is no "remove the last identity": a link with one member says
nothing, so breaking a person apart is a delete.

---

## Web chat

The browser chat: threads an account holds with its assistants. Every thread is
the acting account's own; a thread that is not answers `not_found`.

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/chat/threads` | account | — | `{ threads: ChatThread[] }`, most recent first |
| `POST` | `/api/chat/threads` | account | `{ assistantId, name? (≤120) }` | `{ thread: ChatThread }` (200). A nameless thread is named by the core from the first exchange. A user-role account: its own assistant only |
| `GET` | `/api/chat/threads/{id}` | account | — | `{ thread, messages: ChatThreadMessage[], turn: ChatThreadTurn \| null }` |
| `PATCH` | `/api/chat/threads/{id}` | account | `{ name }` | `{ thread }`. The assistant is fixed at creation |
| `DELETE` | `/api/chat/threads/{id}` | account | — | `{ deleted: true }` |
| `POST` | `/api/chat/threads/{id}/messages` | account | `{ text?="" (≤10 000), image?: { dataBase64, mimeType? }, audio?: { dataBase64, mimeType? } }` — at least one of the three | `{ message: ChatThreadMessage, correlationId }` |
| `GET` | `/api/chat/media/{id}` | account | — | The image bytes; `Cache-Control: private, max-age=31536000, immutable`. Plain-text `404` when unknown |

`ChatThread` = `{ id, assistantId, name, titleProvisional, userId, messageCount,
lastMessageAt, createdAt, updatedAt }`. `ChatThreadMessage` = `{ id, role,
content, sentAt, replyToId, media }` with `media` = `{ id, kind, status:
"pending" \| "described" \| "unavailable", description }` or null — the bytes are
fetched by id from `/api/chat/media/{id}`. `ChatThreadTurn` = `{ sourceMessageId,
activity, since }` while the assistant is answering.

Posting stores the message first and enqueues the turn; the reply arrives
through the pipeline like every other source's, and the `threads` SSE topic
fires when it lands. Base64 payloads are capped at 16 MiB; an image is
normalized to a bounded JPEG and stored `pending` for the vision pass, a voice
note is stored raw and transcribed. Media that cannot be stored does not lose
the message — the turn runs on the text. The media route authenticates the
session only; the media id is the capability.

---

## History

| Method | Path | Access | Body/Query | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/history/summaries` | admin | — | `SummaryJobInfo` |
| `POST` | `/api/history/summaries/run` | admin | — | `SummaryJobInfo` immediately (fire-and-forget) |
| `GET` | `/api/history/search-index` | admin | — | `SearchIndexStatus` |
| `POST` | `/api/history/search-index` | admin | — | `SearchIndexStatus` immediately (fire-and-forget) |
| `DELETE` | `/api/history/search-index` | admin | — | `SearchIndexStatus` + `{ cleared }` |
| `GET` | `/api/history/export` | admin | `?chatRef=` (optional; a scoped chat ref such as `tg:chat:-100…`) | A CSV attachment: `history-<scope>.csv` |
| `POST` | `/api/history/import` | admin | `{ csv, mapping, delimiter? }` | `ImportResult` |

`SummaryJobInfo` = `DailyJobInfoBase` + `{ pendingDays, embeddingsConfigured }`.

`SearchIndexStatus` = `{ status: IdleJobStatus, pending }`. `DELETE` empties the
index and re-arms a rebuild — the recovery path after configuring an embedding
model, since rows indexed without one keep their null vector otherwise.

`ImportResult` = `{ totalRows, imported, skippedDuplicates, errors: [{ line, message }], chatRefs }`.
Import is idempotent — rows whose `(chatRef, sourceMessageId)` already exists are
skipped, not overwritten — so a partially-applied file can be safely re-run. The
column mapping keys are the canonical CSV fields (`chat_ref`,
`source_message_id`, `role`, `content`, `sent_at`, `user_id`,
`reply_to_message_id`, `edited_at`, `deleted_at`), each sourced from a column
(`{ kind: "column", header }`) or a fixed value (`{ kind: "constant", value }`);
see [History](../features/history.md#csv-transfer). At most 5000 rows per file.

## Memory

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/memory` | admin | — | `MemoryView` + `{ job: MemoryJobInfo }` |
| `POST` | `/api/memory/run` | admin | — | `MemoryJobInfo` immediately (fire-and-forget) |
| `DELETE` | `/api/memory/entries/{id}` | admin | — | `{ deleted: true }` — discards a pending note |
| `PATCH` | `/api/memory/users/{userId}` | admin | `{ content }` | The rewritten `UserMemory` (re-embedded) |
| `DELETE` | `/api/memory/users/{userId}` | admin | — | `{ deleted: true }` — forgets the person **and**, by cascade, their pending notes |
| `PATCH` | `/api/memory/general` | admin | `{ content }` | The `GeneralMemory` document (upsert — the first edit creates it) |
| `DELETE` | `/api/memory/general` | admin | — | `{ deleted: true }` |

`{userId}` is the person's scoped ref (`tg:user:123`, `chat:user:<accountId>`) -
the memory keyspace speaks refs, and reads resolve through the person-link
graph so one person's document follows them across identities.
`MemoryView` = `{ entries, users, general, generalPendingNotes }`.
`MemoryJobInfo` = `DailyJobInfoBase` + `{ pendingNotes, pendingExtractionDays, embeddingsConfigured }`.

General knowledge has no id in its path and no `POST`: it is **one** document, so
writing it is an upsert and there is nothing to address individually. An
account deletes its *own* documents through `DELETE /api/profile/memory`.

## Vision

| Method | Path | Access | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/vision/backfill` | admin | `{ status: IdleJobStatus, pending: number }` |
| `POST` | `/api/vision/backfill` | admin | The same, immediately after arming a run (fire-and-forget) |

## Tasks

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/tasks` | account | — | `Task[]` (a user-role account: its own assistants' tasks) |
| `POST` | `/api/tasks` | account | `{ assistantId, chatRef (a scoped chat ref; null = global), threadId?, instruction, triggerKind, context?, targetUserIds?, everyMinutes?, delayMinutes?, scheduleKind?, timeOfDay?, weekdays?, runDate?, enabled? }` | The created task — **201** |
| `PATCH` | `/api/tasks/{id}` | account | Any subset of the editable fields, ≥1 | The updated task |
| `DELETE` | `/api/tasks/{id}` | account | — | `{ deleted: true }` |
| `POST` | `/api/tasks/{id}/fire` | account | — | `{ ok, sent: string[] }` — fires one **timed** task now, off the schedule's books |
| `GET` | `/api/tasks/run` | admin | — | `TaskSchedulerJobInfo` |
| `POST` | `/api/tasks/run` | admin | — | The same, after one immediate tick |

`Task` = `{ id, assistantId, chatId, chatRef, chatSource, threadId, createdByUserId, source,
createdByOwner, instruction, context, triggerKind, targetUserIds, everyMinutes,
delayMinutes, timeOfDay, weekdays, runDate, enabled, attempts,
recentDeliveries, lastRunAt, nextRunAt, createdAt, updatedAt }`. Every task
belongs to one assistant and is gated through it: a user-role account creates,
edits, deletes and fires tasks of its own assistants only (`not_found`
otherwise).

`TaskSchedulerJobInfo` = `{ status, paused, overdue, nextRunAt, asOf }`. `paused` is
`true` while maintenance mode is on — due tasks stay due and fire once it ends.

`triggerKind` selects the family and which fields apply: `message`/`on-reply`
(standing rules — may be global, may carry `targetUserIds` in a group),
`interval` (`everyMinutes`), `timeout` (`delayMinutes`), `schedule`
(`timeOfDay` + `weekdays`/`runDate`). Trigger coherence and `nextRunAt` (in the
operator timezone) are computed by the service. A dashboard-created task has
`createdByUserId: null`, so the chat tools cannot mutate a timed one — except
for the owner, who is exempt and may cancel or edit any task in a chat they are
in. A manual fire leaves `nextRunAt`, `lastRunAt`, `attempts` and
`recentDeliveries` untouched and does not consume a one-shot; it is
`bad_request` for a `message`/`on-reply` task and `service_unavailable` with no
LLM configured. It is traced as `tasks`/`manual-fire`.

## Self-improvement

| Method | Path | Access | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/self-improvement` | admin | `SelfImprovementView` + `{ job: DailyJobInfoBase }` |
| `POST` | `/api/self-improvement/run` | admin | The job info immediately (fire-and-forget) |
| `DELETE` | `/api/self-improvement/exclusions/{id}` | admin | `{ deleted: true, exclusion }` — `not_found` for an unknown id |

`SelfImprovementView` = `{ feedbacks, preferences, correction, exclusions,
feedbacksError }`, each row resolved with a `userLabel`. The feedback rows live
with the owning source; `feedbacksError` names why they are missing when they
are (an unreachable source is an outage on the page, never "no feedback yet").

## Browser agent

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/browser` | admin | — | `{ runs: BrowserAgentRun[] }` |
| `POST` | `/api/browser` | admin | `{ goal }` (4–4000 chars) | The queued `BrowserAgentRun` — **201** |
| `GET` | `/api/browser/{id}` | admin | — | `BrowserAgentRunDetail` |
| `GET` | `/api/browser/{id}/screenshot/{seq}` | admin | — | `image/jpeg`, `Cache-Control: private, max-age=3600` |
| `POST` | `/api/browser/ytdlp/run` | admin | — | The yt-dlp updater's job info immediately (fire-and-forget) |

A dashboard-started run has `chatRef: null` and delivers nothing — its report is read
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
| `chatRef` | Optional — restrict to one chat (scoped ref) |
| `userRef` | Optional — restrict to one user's own messages |

| Method | Path | Access | Extra params | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/analytics/metrics` | admin | — | `TotalsPayload` — the traffic tiles |
| `GET` | `/api/analytics/series` | admin | `section` = `volume` \| `tokens` \| `users` \| `mood` | `SeriesPayload` — `{ buckets, series, bucketUnit, yMax? }` |
| `GET` | `/api/analytics/models` | admin | — | `ModelsPayload` — per model, per call kind |
| `GET` | `/api/analytics/top-users` | admin | — | `TopUsersPayload` |
| `GET` | `/api/analytics/insights` | admin | `chatRef` **required** | `PeriodInsight` or `null` when the period is not rolled up yet |
| `GET` | `/api/analytics/availability` | admin | `source` = `messages` \| `traces` \| `insights`; `from`, `to` **required** | `string[]` — the anchors in range that hold data |
| `GET` | `/api/analytics/insights/run` | admin | — | `AnalyticsJobInfo` |
| `POST` | `/api/analytics/insights/run` | admin | — | The same, after one run |
| `POST` | `/api/analytics/insights/regenerate` | admin | Body `{ granularity, bucket }` | `AnalyticsJobInfo`. **Destructive and billable** |

Every section answers with the same `{ buckets, series }` shape, so one client card
component drives them all. `mood` requires a `chatRef`.

## Traces / Debug

| Method | Path | Access | Query/Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/traces` | account | `feature?`, `assistantId?`, `status?`, `triggerKind?`, `actor?`, `correlationId?`, `relatedId?`, `flow?`, `limit?` (1–200), `offset?` | `{ traces, total, features }` — headers only, newest first |
| `GET` | `/api/traces/{id}` | account | — | The full `Trace` with ordered events; `not_found` for an unknown id |
| `GET` | `/api/traces/bundle` | account | Same filters | JSON attachment `traces-<facets>-<local time>.json` (newest 500 at most) |
| `GET` | `/api/traces/{id}/bundle` | account | — | JSON attachment `trace-<feature>-<action>-<local start>-<id8>.json` |
| `POST` | `/api/traces/prune` | admin | `{ beforeMonth: "YYYY-MM" }` | `{ months: string[], traces: number }`. **Destructive** |

`status` is one of `pending`, `running`, `success`, `error`, `skipped`;
`triggerKind` one of `telegram`, `chat`, `dashboard`, `cron`, `system`, `api`,
`test`. `correlationId` is exact (every trace of one process); `flow` walks the
links transitively (the turn that created a task, its tool calls, every fire,
what each fire sent). A trace carries `assistantId` when the action was one
assistant's; a user-role account sees only its own assistants' traces, and a
trace without an `assistantId` is admin-only (`not_found` otherwise). Bundles
carry `{ schema: "assistant-hub/trace-bundle@1", exportedAt, traces }` and
include full event payloads — which is to say complete conversation content.
Handle accordingly.

---

## Internal transport API

Token-authenticated (`x-internal-token: <INTERNAL_API_TOKEN>`), no session,
bare JSON bodies, errors as `{ "error": { "message" } }`. These are the core's
half of the transport contract; the transport's half (its `/internal/*` HTTP
surface, its MCP server, the queue and bus events) is in
[Adding a transport](../development/adding-a-transport.md). `{id}` is a source
id (`tg`, `chat`).

| Method | Path | Access | Body/Query | Returns |
| --- | --- | --- | --- | --- |
| `POST` | `/api/internal/transports/register` | internal | `{ id, name, baseUrl, mcpPath, connectionConfigSchema, transportConfigSchema }` | `TransportDesiredState`. Upserts the registration (the admin's `enabled` and config blobs survive) and kicks the managed tool-connection reconcile |
| `GET` | `/api/internal/transports/{id}/desired` | internal | — | `TransportDesiredState`. `404` for a transport that never registered |
| `PATCH` | `/api/internal/transports/{id}/config` | internal | A partial config blob (any object) | `{ config }` — the transport-level blob after a shallow merge |
| `GET` | `/api/internal/transports/messages` | internal | `?source=&chatId=&sourceMessageId=` (required), `&assistantId=`, `&direct=true` | `{ found, role: "user" \| "assistant" \| null, assistantId }` — the reaction tool's pre-check against the mirror |
| `POST` | `/api/internal/transports/callback` | internal | `{ source, assistantId, chat: { id, kind, title?, type? }, user: { userId, username, firstName, lastName }, menuSourceMessageId, data }` | `{ toast: string \| null }` — the answer to a feedback-menu button press. Never a 5xx: a failed flow answers `toast: null` |

`TransportDesiredState` = `{ transport: { enabled, config }, connections: [{
id, assistantId, config, enabled }] }`; a connection's `enabled` already folds
in the transport switch and the owning account's deactivation. A `400` is a
body or `{id}` that does not parse (`{ "error": { "message": "unknown transport" } }`
and the like).

---

## Quick reference: all routes

```
POST   /api/auth/setup                                        public
POST   /api/auth/login                                        public
POST   /api/auth/logout                                       public
POST   /api/auth/change-password                              account
GET    /api/health                                            public
GET    /api/events                                            account (SSE)

GET    /api/accounts                                          admin
POST   /api/accounts                                          admin
PATCH  /api/accounts/{id}                                     admin
DELETE /api/accounts/{id}                                     admin

GET    /api/profile                                           account
PATCH  /api/profile                                           account
POST   /api/profile/link-code                                 account
DELETE /api/profile/memory                                    account

GET    /api/assistants                                        account
POST   /api/assistants                                        account
PATCH  /api/assistants/{id}                                   account
DELETE /api/assistants/{id}                                   account

GET    /api/transports                                        account
PUT    /api/transports/{id}/config                            admin
GET    /api/transports/{id}/connections                       account
POST   /api/transports/{id}/connections                       account
PATCH  /api/transports/{id}/connections/{connectionId}        account
DELETE /api/transports/{id}/connections/{connectionId}        account

GET    /api/backends                                          admin
POST   /api/backends                                          admin
PATCH  /api/backends/{id}                                     admin
DELETE /api/backends/{id}                                     admin
GET    /api/backends/{id}/models                              admin
POST   /api/backends/test                                     admin
POST   /api/backends/detect                                   admin

GET    /api/settings                                          admin
PATCH  /api/settings                                          admin
POST   /api/settings/test-chat                                admin
POST   /api/settings/test-embeddings                          admin
POST   /api/settings/test-images                              admin
POST   /api/settings/test-speech                              admin
POST   /api/settings/test-audio                               admin
POST   /api/settings/test-vision                              admin
POST   /api/settings/test-browser                             admin
POST   /api/settings/test-classifier                          admin
POST   /api/settings/test-background                          admin

GET    /api/tools                                             admin

GET    /api/tool-connections                                  account
POST   /api/tool-connections                                  account
PATCH  /api/tool-connections/{id}                             account
DELETE /api/tool-connections/{id}                             account
POST   /api/tool-connections/{id}/discover                    account
POST   /api/tool-connections/{id}/apply                       account

GET    /api/users                                             admin
PATCH  /api/users/{id}                                        admin
GET    /api/groups                                            admin
PATCH  /api/groups/{id}                                       admin

GET    /api/person-links                                      admin
POST   /api/person-links                                      admin
PATCH  /api/person-links/{id}                                 admin
DELETE /api/person-links/{id}                                 admin

GET    /api/chat/threads                                      account
POST   /api/chat/threads                                      account
GET    /api/chat/threads/{id}                                 account
PATCH  /api/chat/threads/{id}                                 account
DELETE /api/chat/threads/{id}                                 account
POST   /api/chat/threads/{id}/messages                        account
GET    /api/chat/media/{id}                                   account

GET    /api/history/summaries                                 admin
POST   /api/history/summaries/run                             admin
GET    /api/history/search-index                              admin
POST   /api/history/search-index                              admin
DELETE /api/history/search-index                              admin
GET    /api/history/export                                    admin
POST   /api/history/import                                    admin

GET    /api/memory                                            admin
POST   /api/memory/run                                        admin
DELETE /api/memory/entries/{id}                               admin
PATCH  /api/memory/users/{userId}                             admin
DELETE /api/memory/users/{userId}                             admin
PATCH  /api/memory/general                                    admin
DELETE /api/memory/general                                    admin

GET    /api/vision/backfill                                   admin
POST   /api/vision/backfill                                   admin

GET    /api/tasks                                             account
POST   /api/tasks                                             account
PATCH  /api/tasks/{id}                                        account
DELETE /api/tasks/{id}                                        account
POST   /api/tasks/{id}/fire                                   account
GET    /api/tasks/run                                         admin
POST   /api/tasks/run                                         admin

GET    /api/self-improvement                                  admin
POST   /api/self-improvement/run                              admin
DELETE /api/self-improvement/exclusions/{id}                  admin

GET    /api/browser                                           admin
POST   /api/browser                                           admin
GET    /api/browser/{id}                                      admin
GET    /api/browser/{id}/screenshot/{seq}                     admin
POST   /api/browser/ytdlp/run                                 admin

GET    /api/analytics/metrics                                 admin
GET    /api/analytics/series                                  admin
GET    /api/analytics/models                                  admin
GET    /api/analytics/top-users                               admin
GET    /api/analytics/insights                                admin
GET    /api/analytics/availability                            admin
GET    /api/analytics/insights/run                            admin
POST   /api/analytics/insights/run                            admin
POST   /api/analytics/insights/regenerate                     admin

GET    /api/traces                                            account
GET    /api/traces/{id}                                       account
GET    /api/traces/bundle                                     account
GET    /api/traces/{id}/bundle                                account
POST   /api/traces/prune                                      admin

POST   /api/internal/transports/register                      internal
GET    /api/internal/transports/{id}/desired                  internal
PATCH  /api/internal/transports/{id}/config                   internal
GET    /api/internal/transports/messages                      internal
POST   /api/internal/transports/callback                      internal
```

87 route files, 114 operations.
