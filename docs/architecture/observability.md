# Observability: traces, Debug, live updates

Every meaningful action the app takes is recorded as a **trace** with ordered
events. Traces are the primary debugging surface, the source Analytics reads for
token and model metrics, and the reason a bad reply can be explained rather than
guessed at.

## The trace contract

`lib/trace.ts` is the single schema — pure types and zod schemas, importable by
both the server recorder and the client Debug UI. Feature code must **not** invent
its own trace shape; add an event type here instead.

### `Trace`

| Field | Notes |
| --- | --- |
| `id` | |
| `feature` | Must be a registered id from `lib/features.ts` |
| `action` | e.g. `reply`, `summarize`, `test-connection`, or the tool name |
| `status` | `pending` \| `running` \| `success` \| `error` \| `skipped` |
| `trigger` | `{ kind, actor?, correlationId? }` — `kind` is `telegram` \| `dashboard` \| `cron` \| `system` \| `api` \| `test` |
| `startedAt`, `finishedAt` | |
| `inputSummary`, `outputSummary` | Short human summaries |
| `error` | `{ code?, message }` when `status = 'error'` |
| `relatedIds` | Related database row ids by table, for operator drill-down |
| `events` | Ordered `TraceEvent[]` |

### `TraceEvent`

| Field | Notes |
| --- | --- |
| `seq` | Monotonic within the trace, from 0 |
| `ts` | |
| `type` | `step` \| `input` \| `output` \| `external_call` \| `llm_request` \| `llm_response` \| `db` \| `error` |
| `level` | `debug` \| `info` \| `success` \| `warn` \| `error` |
| `message` | A **clean human title** — "system prompt composed", not a raw type string |
| `data` | The structured payload |
| `usage` | For LLM events: `model`, `servedModel`, `callKind`, `promptTokens`, `completionTokens`, `totalTokens`, `latencyMs` |

The `message`/`type` split is a UI contract: the Debug timeline renders the
message as the title and groups the raw event kind into a stage category badge
(`llm_request` and `llm_response` both read as `llm`), so the badge names a phase
rather than an implementation type.

### The feature registry

`lib/features.ts` ties each feature to the identifiers that must stay in lockstep
across the codebase:

| Field | Used for |
| --- | --- |
| `id` | The `feature` string on every trace, and the Debug filter (`/debug?feature=<id>`) |
| `label` | The human name in the Debug filter |
| `group` | Product area (Conversation, People, Knowledge, Automation, Tools, Insights, System) — the Debug filter's optgroups |
| `realtimeTopic` | The SSE topic this feature's pages live-update on |
| `relatedIdsKey` | The key under `trace.relatedIds` for this feature's rows |
| `path` | The feature's dashboard route |

These were previously bare string literals duplicated between each service (the
trace *writer*) and its Debug page (the *reader*), with nothing enforcing that
they matched — so a rename silently produced an empty Debug list. Referencing the
registry from both ends turns a mismatch into a compile error.

## Recording

`server/trace/recorder.ts` is the single entry point. Two shapes:

```ts
// Explicit: open, append, settle.
const trace = await startTrace({ feature, action, trigger, inputSummary });
await trace.event({ type: "step", message: "…", data });
await trace.succeed({ outputSummary });   // or .fail(err) / .skip(reason)
```

```ts
// Wrapped: the common case for a traced mutation.
return withTrace({ feature, action, trigger, inputSummary }, async (trace) => {
  await trace.event({ … });
  return result;                           // settled as success automatically
});
```

`with-trace.ts` owns the try/fail/rethrow contract every traced mutation used to
repeat by hand: a thrown error settles the trace as failed and is rethrown, a body
that returns without settling is settled as a plain success. The body may still
settle explicitly to control the summary — the wrapper only fills in whichever
settle did not happen, so double-settles are impossible by construction.

Full error messages, **including the `cause` chain**, are recorded: traces are
operator-facing debug data, never returned to end users, and the cause chain is
where wrapped failures keep the part that actually explains them.

### What gets traced, and what does not

| Traced | Not traced |
| --- | --- |
| Every handled message, and every message the LLM was asked about and then not answered | Group chatter rejected by the cheap deterministic checks |
| Every operator mutation (settings, aliases, notes, personalities, tasks, memory edits, prune) | Passive capture: `known_users` upserts, the `chat_messages` mirror, vision ingest |
| Every MCP tool call (twice — inline and its own scope) | Cheap reads |
| Every background job run | |
| Every auth attempt (setup/login) | |
| Every Settings probe | |

Passive capture is high-volume and its own record — tracing it would bury
everything else.

### Payload policy

Trace bodies hold the **complete** raw request and response: the whole system
prompt, the whole message list, the whole tool result. Nothing is trimmed or
hand-picked. There is exactly one scoped exception: binary blobs.
`sanitizeMessagesForTrace` replaces an inline `data:image/…;base64,<~1MB>` URL (or
an `input_audio` payload) with a compact `data:<mime>;base64,<N bytes>` marker —
the bytes are not lost, the real image is on the Vision page, and everything the
operator reads (roles, text, structure) is kept verbatim. Browser screenshots
follow the same convention: bytes in Postgres, never in trace JSON.

## The trace store

`server/trace/store.ts`. Traces are **not** in Postgres. A settled trace is
immutable, so each month is a plain append-only NDJSON log — one JSON `Trace`
(header plus embedded events) per line — with no rewrite, fold or compaction.

A trace lives in exactly one of three places, unioned on read:

| Place | State | Durability |
| --- | --- | --- |
| `open` | Running, RAM only | A crash drops it |
| `pending` | Settled, not yet flushed | Lost on hard crash; ≤ one flush interval (60s), and graceful shutdown flushes first |
| months | `traces-YYYY-MM.ndjson` on disk, cached in memory | Durable |

The month cache is **two-tier**, so months of history do not pin their full event
bodies (complete LLM payloads) in the heap forever:

- **Headers** (events dropped) stay cached for every loaded month — the Debug list
  and correlation lookups need only those.
- **Full** months (with events) are kept for at most 3 at a time, evicted back to
  headers least-recently-used.

Range reads load only the months their range intersects.

The store is a `globalThis` singleton so the writers (feature, route and poller
bundles) and the boot-owned flush timer share one instance across Next bundles and
dev hot-reload.

### The header index

Full-history reads (`listTraces`, `listFeatures`, `getTrace`) need every month's
headers. Each request used to walk the directory and load them itself, which made
the Debug page cost grow with the installation's whole history and made N
concurrent requests do the work N times.

`startTraceStore` now kicks off that scan **in the background at boot** (user
decision, 2026-08-14: startup must not wait for it, and the first Debug visit
should not pay for it either). The build is a single promise on the store, so a
read arriving mid-scan awaits it rather than racing a second one; a failure clears
it so the next read retries. The directory listing is cached alongside it — only
this process writes there, and both the flush (which creates a month) and the
prune (which deletes them) update the cache.

The Debug list is **paged** on top of that (50 rows), with `total` still counting
the whole match. The uncapped read remains for `/api/traces` and the bundle export.

### Trace storage health

`getTraceStorageHealth()` probes the **real** write path — opening the current
month's file for append, exactly the operation the flusher performs — and combines
it with the standing flush state (`pendingCount`, `lastFlushError`). A bind mount
the container user cannot write to passes every "is it configured" check and still
loses data.

A flush failure surfaces as a **global system alert** rendered by the dashboard
layout above every page (`components/layout/SystemAlerts.tsx`), because it
silently destroys data if nobody acts: settled traces pile up in RAM and vanish on
the next restart. That surface is reserved for exactly this class of failure —
per-feature degradations (LLM down, bot stopped) stay on their own pages, so the
global banner stays rare enough to stay loud.

Deliberately, trace-storage health is **not** a readiness gate on `/api/health`:
restart-looping the container on an unwritable volume would drop the very traces
still buffered in RAM.

### The other write path

The browser agent's downloads directory is probed the same way — a real create/unlink
rather than an `access(W_OK)` guess — and reported on Overview, on `/browser`, in the
health body, and once in the boot log. It is a **warning**, not an error, and gets no
global banner: an unwritable downloads directory destroys nothing silently, because the
download throws and the failure lands on the run row. See
[the browser agent](../features/browser-agent.md#download-storage-health).

The two probes are the app's only filesystem write paths, and both follow the same rule:
exercise the real operation, never infer from configuration.

### Retention

There is **no automatic retention** (user decision, 2026-07-20). Nothing is ever
deleted except through the manual prune: the Debug page's Prune card, or
`POST /api/traces/prune { beforeMonth: "YYYY-MM" }`, which deletes every stored
month file strictly older than the given key.

This is destructive and irreversible — the month files are the only copy of the
full request/response bodies — so the card is a two-step confirm that names
exactly what it is about to delete, and the prune itself is traced under the
`traces` feature.

## The Debug UI

`/debug` is the single Debug surface for every feature. Features do **not** build
their own debug pages; they compose the shared components in
`components/debug/`:

| Component | Role |
| --- | --- |
| `TraceExplorer` | Filters + one page of the list + pagination + bundle-export link |
| `DebugFilters` | Feature and status filters. The feature select is grouped by product area (`groupedFeatureOptions`), and lists every *registered* feature, not only those with traces, so an empty list reads as "no traces yet" rather than "this feature does not exist". Ids that appear only in old trace data — a retired feature — land under "Other" so their traces stay reachable |
| `TraceList` | Dense, scannable table of headers linking to the detail view |
| `TraceDetail` | Metadata panel plus the timeline |
| `TraceTimeline` | The ordered events, with stage-category badges |
| `JsonBlock` | Payload viewer. Collapses behind a toggle above a size threshold — size-driven, not type-driven, so a full system prompt folds away while short payloads stay inline. Nothing is hidden permanently |
| `TraceStatusBadge` | Status → tone, identical everywhere |
| `DownloadButton` | A plain `<a download>` pointing at a bundle route |
| `PruneCard` | The manual month prune |

Each feature page links into `/debug?feature=<id>` via `featureDebugHref()`.

### Bundles

Two download routes produce the same format
(`traceBundleSchema`, `schema: "llm-tg-bot/trace-bundle@1"`):

| Route | Contents |
| --- | --- |
| `GET /api/traces/{id}/bundle` | One trace with its events |
| `GET /api/traces/bundle` | The filtered set, newest first, capped, each with events |

Both are pretty-printed JSON attachments. They are the artifact to attach to a bug
report — and, because they contain complete conversation payloads, the artifact to
handle carefully.

## Live updates

Every data-display page live-updates. No page requires a manual refresh.

```
service ──publishEvent(topic)──► server/realtime/hub.ts (globalThis singleton)
                                          │ subscribe()
                                          ▼
                              GET /api/events  (SSE, force-dynamic)
                                          │
                    components/realtime/event-stream.ts  (one EventSource per tab)
                                    ├── useLiveRefresh() → router.refresh()
                                    └── useLiveEvent()   → re-fetch
```

### The contract

`lib/realtime.ts`: an event is `{ topic, feature?, at }` — deliberately tiny, a
notification rather than a payload. Topics: `traces`, `bot`, `status`, `history`,
`users`, `groups`, `vision`, `tasks`, `feedback`, `memory`, `analytics`,
`browser`.

### One connection per tab

`/api/events` carries **every** topic and clients filter on the payload. That is
not just tidiness: browsers allow only ~6 concurrent connections per origin over
HTTP/1.1, so a page whose components each opened their own `EventSource` would
spend its whole connection budget on streams that never close — and then hang,
because there is nothing left to fetch with. A dashboard with eight self-fetching
cards reaches that limit on its own.

So the stream is a module-level singleton, reference-counted: it opens when the
first subscriber arrives and closes when the last leaves. Components never touch it
directly.

The route sends a `: connected` comment on open, a `: ping` heartbeat every 25s
(to survive proxy idle timeouts), and sets `X-Accel-Buffering: no` so
nginx-style proxies flush events live. It carries its own session check rather than
using `defineRoute`, because it streams.

### The two hooks

| Hook | For | Mechanism |
| --- | --- | --- |
| `useLiveRefresh(topic)` | A Server Component view | `router.refresh()` re-runs the server read; fresh data streams in with no client-side duplication |
| `useLiveEvent(topic, onEvent)` | A card that fetched its own data on the client | Calls your re-fetch. `router.refresh()` cannot reach state a `fetch` put in a `useState` |

Both accept several topics at once (the Jobs board watches all six job topics) and
return `{ connected }` for the shared `LiveIndicator` pill — which can be clicked
to pause refreshes while reading.

`components/layout/SystemAlertsRefresher.tsx` is an invisible always-mounted
subscriber on the `status` topic, so a system alert appears and clears live on
whatever page the operator happens to be looking at.

### Analytics card liveness

`features/analytics/ui/useCardData.ts` is the one place three things are handled,
because they are the same three for every self-fetching card:

- **Staleness** — the in-flight request is aborted when filters move, and the
  stored result is stamped with the URL that produced it, so a slow early response
  can never be shown against later filters.
- **Liveness** — insight-job completions on the `analytics` topic trigger a
  re-fetch, not a page reload.
- **Continuity** — `loading` is *derived* from the stored result not matching the
  current URL, so the previous period's data stays on screen while the next
  request is in flight instead of the card blanking on every click.
