# API conventions

Every HTTP route lives under `app/api/**/route.ts`. All but a handful go through
the shared wrapper `defineRoute` in `server/http.ts`, which is what makes these
conventions hold uniformly. The handful that do not are named here, so nothing
is hidden:

| Route | Why it is hand-rolled | What differs |
| --- | --- | --- |
| `GET /api/events` | Streams a `ReadableStream` | Nothing visible: the same session check, the same error envelope on failure |
| `GET /api/chat/media/{id}` | Streams image bytes | A failure is a plain-text body with the right status, not JSON |
| `/api/internal/transports/*` (five routes) | Called by transport services, never by the dashboard | Token-authenticated (no session), bare JSON bodies (no `data` wrapper), a reduced error shape - see [Internal transport routes](#internal-transport-routes) |

- [Endpoint reference](endpoints.md) - every route, grouped by feature.
- [`openapi.yaml`](openapi.yaml) - OpenAPI 3.1 description of the whole surface.

## Base URL

Relative to the app origin, e.g. `http://localhost:3200/api/...`. There is no
version prefix: the dashboard and the API ship together, so the API is versioned by
the release (`version` in `GET /api/health` is the root `package.json` version).

## Success envelope

Every JSON success response is wrapped:

```json
{ "data": { "…": "…" } }
```

Status is `200` unless noted. The create routes that answer `201`:
`POST /api/accounts`, `POST /api/assistants`, `POST /api/browser`,
`POST /api/person-links`, `POST /api/tasks`, `POST /api/tool-connections`,
`POST /api/transports/{id}/connections`. (`POST /api/backends` and
`POST /api/chat/threads` answer `200`.) The exceptions, which are not wrapped
because the body *is* the artifact:

| Route | Body |
| --- | --- |
| `GET /api/health` | A bare status object (orchestrators read it) |
| `GET /api/traces/bundle`, `GET /api/traces/{id}/bundle` | A pretty-printed JSON attachment |
| `GET /api/history/export` | A CSV attachment |
| `GET /api/browser/{id}/screenshot/{seq}` | `image/jpeg` bytes |
| `GET /api/chat/media/{id}` | The stored image bytes, in the stored mime type (`image/jpeg` when none was recorded) |
| `GET /api/events` | `text/event-stream` |
| `/api/internal/transports/*` | Bare JSON objects |

## Error envelope

```json
{ "error": { "code": "validation_error", "message": "Request validation failed", "details": { } } }
```

`details` is optional, machine-readable, and never contains secrets. For a
validation failure it is the flattened Zod error.

| Code | Status | Typical cause |
| --- | --- | --- |
| `bad_request` | 400 | Malformed JSON body, an invalid path parameter, or a rule the schema cannot see: a self-lockout on accounts (deactivating yourself, demoting the last admin), deleting an account that is still active, a manual fire of a `message`/`on-reply` task, a user-owned tool connection pointing at a private address, an unknown transport id |
| `unauthorized` | 401 | No session cookie, an invalid/expired one, a deactivated account - or, on the auth routes, wrong credentials |
| `forbidden` | 403 | A user-role account on an admin route; any route but the password change while the account still holds an admin-issued temporary password; deleting a memory document that is not about you |
| `not_found` | 404 | Unknown id - or, on an ownership-scoped route, an id that is not yours (scoped routes answer not-found rather than forbidden, so ids do not leak) |
| `conflict` | 409 | A duplicate name (assistant, backend, account username, tool-connection slug); a cap reached (32 assistants, 32 tool connections); an identity already in another person link; a second connection for one assistant on one transport; deleting a backend a settings role still uses; editing or deleting a managed tool connection; `setup` once an account exists |
| `validation_error` | 422 | Schema validation failed |
| `rate_limited` | 429 | - |
| `not_implemented` | 501 | - |
| `service_unavailable` | 503 | A required capability is unconfigured or unreachable (no LLM for a manual task fire, a backend that does not answer, a source service that cannot be read) |
| `internal_error` | 500 | An unexpected failure. The body says nothing more; the real cause is in the server log |

The union is closed (`lib/api-error.ts`). Features throw `ApiError` from service
code; they do not invent their own error shapes.

## Authentication

Accounts, stored in the database. `POST /api/auth/setup` creates the first admin
and refuses with `conflict` once any account exists; admins create the rest with
`POST /api/accounts`, handing over a temporary password the holder must replace.
`POST /api/auth/login` takes `{ username, password }` and answers with a signed
session cookie (`op_session`; `HttpOnly`, `SameSite=Lax`, valid 30 days). The
cookie is stateless - `<accountId>.<expiresMs>.<nonce>.<sig>`, signed with that
account's own session secret - so `POST /api/auth/change-password`, which rotates
the secret, signs out the account's other sessions and returns a fresh cookie for
the caller.

Three access levels, declared per route on `defineRoute`:

| Level | Who passes | Where |
| --- | --- | --- |
| `public` | Nobody is checked | `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/health` |
| `account` | Any signed-in, active account | The web chat, the profile, assistants, tasks, tool connections, transport connections, the trace explorer, the SSE stream, the password change |
| `admin` (the default) | A signed-in admin | Everything else |

Two rules sit on top:

- An account still holding its temporary password (`mustChangePassword`) is
  refused with `forbidden` everywhere except `POST /api/auth/change-password`.
- While no account exists yet (a fresh install before `/setup`) the non-public
  routes are open and the acting account is null; the dashboard forces `/setup`
  on first contact.

Auth is enforced in `defineRoute` as well as at the proxy, so the API stays
covered when the proxy is bypassed.

```bash
curl -c jar.txt -X POST http://localhost:3200/api/auth/login -H 'content-type: application/json' -d '{"username":"…","password":"…"}'
```

```bash
curl -b jar.txt http://localhost:3200/api/settings
```

### What a user-role account sees

`account`-level routes are ownership-scoped through `server/ownership.ts`: an
admin sees everything, a user-role account sees and acts on what its account
owns.

| Surface | Scope for a user-role account |
| --- | --- |
| Assistants | Its own (the ones it created) |
| Tasks, transport connections, manual fires | Those of its own assistants |
| Tool connections | Its own. A user-owned connection must select specific own assistants (never all, never a whole app) and must target a public address |
| Web chat threads | Its own; a new thread must be with one of its own assistants |
| Traces (list, detail, bundles) | Its own assistants' traces; traces carrying no `assistantId` (operator actions, background jobs) are admin-only |
| Transports | `GET /api/transports` is the read-only roster; `GET /api/transports/{id}/connections` requires `?assistantId=` naming one of its own assistants |
| Profile | Its own account, linked identities and memory documents |

A scoped route answers `not_found`, not `forbidden`, for an id outside the scope.

### Internal transport routes

The five `/api/internal/transports/*` routes are how a transport service (the
Telegram app today, a Signal one tomorrow) talks back to the core: register at
boot, refetch desired state, write back into its own config, ask the mirror
about a message, and answer a feedback-menu button press. They ignore the
session cookie and require the shared secret instead:

```
x-internal-token: <INTERNAL_API_TOKEN>
```

A missing or wrong header - or an unset `INTERNAL_API_TOKEN` on the core - is
`401 {"error":{"message":"unauthorized"}}`. Their error bodies carry only a
`message` (no `code`): `400` for a body or transport id that does not parse,
`404` for a transport that never registered. Success bodies are bare objects.
The whole contract - registration, desired state, the queue and bus events
around it, and the transport-side `/internal/*` surface - is in
[Adding a transport](../development/adding-a-transport.md).

## Input validation

| Source | Helper |
| --- | --- |
| JSON body | `parseJson(request, schema)` — invalid JSON is `bad_request`, schema failure is `validation_error` |
| Query string | `parseQuery(request, schema)` — search params coerced by the schema |
| Raw body (dispatch on shape) | `readJsonBody(request)`, then the matching schema |

Path parameters are already awaited by the wrapper and arrive as
`Record<string, string>`.

Several `PATCH` routes take one field per call rather than a combined object,
because the dashboard saves each field on its own:

| Route | Body carries one of |
| --- | --- |
| `PATCH /api/users/{id}` | `{ language }` **or** `{ aliases }` |
| `PATCH /api/groups/{id}` | `{ language }` **or** `{ notes }` |
| `PATCH /api/accounts/{id}` | `{ active }` **or** `{ role }` **or** `{ temporaryPassword }` |
| `PATCH /api/person-links/{id}` | `{ note }` **or** `{ members }` |

Each is dispatched to its own traced action. `PATCH
/api/transports/{id}/connections/{connectionId}` takes `config` and/or
`enabled` and refuses an empty body; `POST /api/chat/threads/{id}/messages`
needs `text`, `image`, `audio`, or some of each.

## Partial updates

`PATCH` bodies are partial and require **at least one** field
(`"Provide at least one field to update"`). For secret fields: omitting leaves the
stored value, `null` clears it, a string replaces it. Secrets are never returned:
reads expose only `…Configured: boolean` (settings, backends), the names of the
configured auth headers (tool connections), or a `…last4` preview (transport
config blobs). The one exception to "partial": a tool connection's `authHeaders`
replaces the whole set when sent, since a merge could never remove a header.

## Identifiers

Rows the core owns carry app-generated UUIDs. Anything that points across apps
is a **scoped ref** - `source:kind:id` with sources `tg` and `chat`, kinds
`user`, `chat`, `thread`, `message` - never a foreign key. Refs appear as the
`{id}` of `/api/users/{id}` and `/api/groups/{id}` (`tg:user:123`,
`tg:chat:-100…`), as the `{userId}` of `/api/memory/users/{userId}` and the
`userId` query of `DELETE /api/profile/memory`, and as person-link `members`.
The `{id}` of `/api/transports/{id}` and `/api/internal/transports/{id}/*` is a
bare source id (`tg`, `chat`).

## Pagination

Only the trace list paginates, with `limit` (1–200) and `offset`; the response
carries `total`. Everything else returns its full collection, which is bounded in
practice by the domain (assistants and tool connections are capped at 32, a
person link at 20 identities, a chat's summaries at a few per day, and so on).

## "Run now" endpoints

Each background job exposes one. Two flavours:

| Behavior | Endpoints |
| --- | --- |
| Awaited — triggers, waits, and returns refreshed job info | `POST /api/analytics/insights/run`, `POST /api/analytics/insights/regenerate`, `POST /api/tasks/run` |
| Fire-and-forget — returns the snapshot immediately, progress arrives over SSE | `POST /api/history/summaries/run`, `POST`/`DELETE /api/history/search-index`, `POST /api/memory/run`, `POST /api/self-improvement/run`, `POST /api/browser/ytdlp/run`, `POST /api/vision/backfill` |

A `GET` on the same path (where one exists) returns the job info without triggering
anything. `POST /api/tasks/{id}/fire` is not a job run: it fires one timed task
on the spot, awaited, off the schedule's books.

## Realtime

`GET /api/events` is a Server-Sent Events stream carrying **every** topic; clients
filter on the payload. Any signed-in account may open it. One connection per
browser tab — see
[Observability](../architecture/observability.md#live-updates) for why that matters.

```
: connected

data: {"topic":"traces","feature":"bot-messaging","at":"2026-07-26T09:12:03.114Z"}

: ping
```

Topics (`REALTIME_TOPICS` in `packages/contracts/src/realtime.ts`): `traces`,
`bot`, `status`, `history`, `users`, `groups`, `vision`, `tasks`, `feedback`,
`memory`, `analytics`, `browser`, `assistants`, `threads`, `tools`, `accounts`.
A heartbeat comment is sent every 25s. The route sets
`Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` so
nginx-style proxies flush live. `EventSource` sends cookies on same-origin
requests automatically.

## Destructive routes

These destroy data and are worth naming explicitly:

| Route | Destroys |
| --- | --- |
| `POST /api/traces/prune` | Every stored trace month file strictly older than `beforeMonth`. The only copy of the full request/response bodies. Manual-only; there is no automatic retention |
| `POST /api/analytics/insights/regenerate` | Every day score covering the period, plus the roll-ups built from them. Also **billable** — each dropped day costs one LLM pass to re-score |
| `DELETE /api/memory/users/{userId}` | The person's memory document and, by cascade, their pending notes |
| `DELETE /api/accounts/{id}` | A (deactivated) account and everything that was only theirs: their assistants (with tasks and transport connections), the memory under their linked identities, their link membership, their web threads, link codes and tool connections |
| `DELETE /api/assistants/{id}` | The assistant, its tasks (store cascade) and, through the `assistant.deleted` bus event, its transport connections |
| `DELETE /api/chat/threads/{id}` | The thread and its whole transcript, media included |
| `DELETE /api/history/search-index` | The search index rows - re-derived by the rebuild it arms, so nothing is lost |

## Timestamps

Every timestamp in a request or response is an ISO-8601 instant (UTC). Rendering in
the operator timezone is a UI concern (`<Timestamp>`), never a wire concern. The
exceptions are deliberate wall-clock strings: `timeOfDay` (`HH:MM`), `runDate`
(`YYYY-MM-DD`), `summaryDate` (`YYYY-MM-DD`), and analytics bucket keys
(`2026-07-16 14`, `2026-07-16`, `2026-07`, `2026`, `all`).

## Content types

Requests send `application/json` unless they send nothing. Responses are
`application/json; charset=utf-8`, except the attachment, image and SSE routes above.
A CSV download is prefixed with a UTF-8 BOM so Excel opens non-ASCII content
correctly; the shared CSV parser strips it again on import, so an export round-trips.
