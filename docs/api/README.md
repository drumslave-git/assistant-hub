# API conventions

Every HTTP route lives under `app/api/**/route.ts` and goes through the shared
wrapper in `server/http.ts`. That wrapper is what makes these conventions hold
uniformly — there are no per-feature exceptions.

- [Endpoint reference](endpoints.md) — every route, grouped by feature.
- [`openapi.yaml`](openapi.yaml) — OpenAPI 3.1 description of the whole surface.

## Base URL

Relative to the app origin, e.g. `http://localhost:3200/api/...`. There is no
version prefix: the dashboard and the API ship together, so the API is versioned by
the release.

## Success envelope

Every JSON success response is wrapped:

```json
{ "data": { "…": "…" } }
```

Status is `200` unless noted (`201` for the two create routes). The exceptions,
which are not wrapped because the body *is* the artifact:

| Route | Body |
| --- | --- |
| `GET /api/health` | A bare status object (orchestrators read it) |
| `GET /api/traces/bundle`, `GET /api/traces/{id}/bundle` | A pretty-printed JSON attachment |
| `GET /api/history/export` | A CSV attachment |
| `GET /api/browser/{id}/screenshot/{seq}` | `image/jpeg` bytes |
| `GET /api/events` | `text/event-stream` |

## Error envelope

```json
{ "error": { "code": "validation_error", "message": "Request validation failed", "details": { } } }
```

`details` is optional, machine-readable, and never contains secrets. For a
validation failure it is the flattened Zod error.

| Code | Status | Typical cause |
| --- | --- | --- |
| `bad_request` | 400 | Malformed JSON body, or an invalid path parameter |
| `unauthorized` | 401 | No session cookie, or an invalid/expired one |
| `forbidden` | 403 | — |
| `not_found` | 404 | Unknown id |
| `conflict` | 409 | e.g. a duplicate personality name |
| `validation_error` | 422 | Schema validation failed |
| `rate_limited` | 429 | — |
| `not_implemented` | 501 | — |
| `service_unavailable` | 503 | A required capability is unconfigured (e.g. `DATABASE_URL` unset) |
| `internal_error` | 500 | An unexpected failure. The body says nothing more; the real cause is in the server log |

The union is closed (`lib/api-error.ts`). Features throw `ApiError` from service
code; they do not invent their own error shapes.

## Authentication

A signed session cookie, `HttpOnly`, valid 30 days. Obtain it from
`POST /api/auth/login` (or `POST /api/auth/setup` on a fresh install) — the response
sets it via `Set-Cookie`.

Public routes, and only these:

| Route | Why |
| --- | --- |
| `POST /api/auth/setup` | It exists exactly when no credential exists yet |
| `POST /api/auth/login` | By necessity |
| `POST /api/auth/logout` | Clearing your own cookie needs no session, and logout must work with an expired one |
| `GET /api/health` | The Docker healthcheck and orchestrators probe it without a session |

Everything else returns `401` with the standard error envelope. Auth is enforced in
`defineRoute` as well as at the proxy, so the API stays covered when the proxy is
bypassed.

```bash
curl -c jar.txt -X POST http://localhost:3200/api/auth/login -H 'content-type: application/json' -d '{"password":"…"}'
```

```bash
curl -b jar.txt http://localhost:3200/api/settings
```

## Input validation

| Source | Helper |
| --- | --- |
| JSON body | `parseJson(request, schema)` — invalid JSON is `bad_request`, schema failure is `validation_error` |
| Query string | `parseQuery(request, schema)` — search params coerced by the schema |
| Raw body (dispatch on shape) | `readJsonBody(request)`, then the matching schema |

Path parameters are already awaited by the wrapper and arrive as
`Record<string, string>`.

Two `PATCH` routes dispatch on the body's shape rather than taking a combined
object, because the dashboard saves each field on its own:

| Route | Body carries one of |
| --- | --- |
| `PATCH /api/users/{id}` | `{ language }` **or** `{ aliases }` |
| `PATCH /api/groups/{id}` | `{ language }` **or** `{ notes }` |

Each is dispatched to its own traced action.

## Partial updates

`PATCH` bodies are partial and require **at least one** field
(`"Provide at least one field to update"`). For secret fields: omitting leaves the
stored value, `null` clears it, a string replaces it. Secrets are never returned —
reads expose only `…Configured: boolean`.

## Pagination

Only the trace list paginates, with `limit` (1–200) and `offset`; the response
carries `total`. Everything else returns its full collection, which is bounded in
practice by the domain (personalities are capped at 32, a chat's summaries at a few
per day, and so on).

## "Run now" endpoints

Each background job exposes one. Two flavours:

| Behavior | Endpoints |
| --- | --- |
| Awaited — triggers and returns refreshed job info | `POST /api/analytics/insights/run`, `POST /api/tasks/run`, `POST /api/vision/backfill` |
| Fire-and-forget — returns the snapshot immediately, progress arrives over SSE | `POST /api/history/summaries/run`, `POST /api/memory/run`, `POST /api/self-improvement/run`, `POST /api/browser/ytdlp/run` |

A `GET` on the same path (where one exists) returns the job info without triggering
anything.

## Realtime

`GET /api/events` is a Server-Sent Events stream carrying **every** topic; clients
filter on the payload. One connection per browser tab — see
[Observability](../architecture/observability.md#live-updates) for why that matters.

```
: connected

data: {"topic":"traces","feature":"bot-messaging","at":"2026-07-26T09:12:03.114Z"}

: ping
```

Topics: `traces`, `bot`, `status`, `history`, `users`, `groups`, `vision`, `tasks`,
`feedback`, `memory`, `analytics`, `browser`. A heartbeat comment is sent every 25s.
The route sets `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no` so nginx-style proxies flush live. `EventSource` sends
cookies on same-origin requests automatically.

## Destructive routes

Three routes destroy data and are worth naming explicitly:

| Route | Destroys |
| --- | --- |
| `POST /api/traces/prune` | Every stored trace month file strictly older than `beforeMonth`. The only copy of the full request/response bodies. Manual-only; there is no automatic retention |
| `POST /api/analytics/insights/regenerate` | Every day score covering the period, plus the roll-ups built from them. Also **billable** — each dropped day costs one LLM pass to re-score |
| `DELETE /api/memory/users/{userId}` | The person's memory document and, by cascade, their pending notes |

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
