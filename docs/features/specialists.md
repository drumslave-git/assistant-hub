# Specialists

**Feature ids:** `specialists`, `mcp-tools-specialists` · **Dashboard:** `/specialists` · **Priority 15**

Operator-authored bot roles that store, operate on, and analyze their own data,
and keep themselves proactive through the scheduled-tasks engine. The user's
motivating examples: a daily psycho journal with analysis, grocery management,
and a planning advisor — all three ship as editable seed rows. Every design
point below is a user decision from 2026-07-27.

## Model

A specialist is **a prompt plus one shared toolkit** — no per-specialist tables,
schemas, or code (the skills model: instructions over shared tools). Authoring
is operator-only, on the dashboard; Telegram users activate specialists but
never author them.

Prompt composition **always stacks** — a specialist adds to the persona, it
never replaces or suppresses it:

```
BASE_SYSTEM_PROMPT
---
Additional instructions:            ← active personality (global)
---
Active specialist role for this chat: ← active specialist (per chat)
---
Self-correction guidelines:          ← self-improvement (global)
```

Both the live reply path (`server/telegram/process-update.ts`) and the
scheduled-task fire path (`features/scheduled-tasks/server/fire.ts`) compose
this identically, and both bind the chat as the MCP tool context — the
load-bearing integration: a specialist's self-scheduled check-in wakes up *as
the specialist*, with its toolkit scoped to the firing chat, not as the generic
bot. To make that real, scheduled-task fires now run with the full registered
toolset (`chatCompletionWithTools`), so a fired digest can query its own
entries mid-fire; executed tool calls are recorded on the fire trace.

## Activation

Per chat, default none (`chat_specialists`, one specialist per chat). The
active personality stays a single global setting — deliberately different.

Switching surfaces:

- **Dashboard** — the `/specialists` assignment tab (operator, no gate).
- **Chat** — the `specialist_switch` MCP tool. Permission is enforced *inside*
  the tool (the browser-downloads owner-gate precedent; no lexical pre-filter):
  in a private chat the user may switch their own chat's specialist; in groups
  only the owner (settings owner identity). A denied caller gets a refusal
  result the model relays.

Deactivating (dashboard clear, or switching with an empty name) returns the
chat to the no-specialist default.

## Data

All specialists share one unified store, `specialist_entries`: specialist id,
chat id, author user id (provenance, always recorded), a free-text `collection`
label the model picks, and a JSONB `payload` whose shape the model decides.

**Data scope** is a per-specialist flag:

- `per-chat` (default) — reads filter on (specialist, chat); each chat is its
  own silo (right for the journal).
- `shared` — reads filter on the specialist alone; one pool across every chat
  where it is active (right for a grocery list reachable from the family group
  and the owner's DM).

Guardrails (service-enforced): 16 384-byte payload cap per entry, 50-result cap
per query, **no retention/expiry in v1**. Deleting a specialist cascades its
activations and entries away.

## Toolkit

Six always-registered MCP tools (`features/specialists/server/mcp-tools.ts`),
traced under `mcp-tools-specialists`. The four data tools resolve the current
chat's active specialist from the tool context and return a clear "no
specialist is active in this chat" result when there is none:

| Tool | Purpose |
| --- | --- |
| `specialist_save_entry` | Store one entry (collection label + JSON payload) |
| `specialist_query_entries` | Read entries (collection / contains filters, capped, full payloads) |
| `specialist_update_entry` | Replace one entry's payload by id (scope-checked) |
| `specialist_delete_entry` | Delete one entry by id (scope-checked) |
| `specialist_list` | List specialists + which is active in this chat |
| `specialist_switch` | Activate/deactivate for this chat (gated as above) |

## Proactivity

No engine of its own: a specialist keeps itself proactive by scheduling tasks
through the existing scheduled-tasks tools ("keep a daily 21:00 check-in
scheduled"), and fires deliver through the existing poller + `sendChatMessage`.
Analysis is not a separate engine either — "how was my week" is the model
querying its own entries, and digests are self-scheduled tasks.

## Seeds

Migration `0042` inserts three **ordinary editable rows** (not fixtures): Daily
psycho journal (per-chat), Grocery management (shared), Planning advisor
(per-chat). The operator tunes instructions/tone/language afterward; deleting
them is fine — the migration runs once and never re-creates them.

## Dashboard

`/specialists` (Server Component + `SpecialistsManager` Client Component,
shared Tabs):

- **Specialists** — CRUD cards (name, description, instructions, data scope).
- **Chat assignments** — every known chat (groups + DMs) with its active
  specialist, assign/clear via a select.
- **Entries** — browser over the latest entries with specialist/chat/collection
  filters and full raw JSON payloads.

Live via the shared SSE layer (`specialists` topic): every mutation publishes,
the page refreshes.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/specialists` | `{ specialists, assignments }` |
| `POST /api/specialists` | Create (201) |
| `PATCH /api/specialists/{id}` | Update any subset of fields |
| `DELETE /api/specialists/{id}` | Delete (cascades activations + entries) |
| `PUT /api/specialists/assignments` | Set/clear one chat's specialist |
| `GET /api/specialists/entries` | Entries browser (filters, latest 200) |

## Tracing

Every mutation is traced under `specialists` — create, update, delete, assign
(dashboard), switch (chat, including denials), entry-save, entry-update,
entry-delete — with full raw payloads in the events. Tool calls additionally
trace under `mcp-tools-specialists` (the registry convention). Reply and fire
traces record the composed system prompt with `specialistApplied: boolean`.

## Memory overlap

Deliberately orthogonal in v1 (user: "leave for now"): specialist-driven
chatter stays visible to the nightly memory extraction. Revisit only if the
memory documents actually get polluted.

## Tests

`server/specialists.integration.test.ts` (seeds, CRUD, assignment, switch
gating DM vs group, scope-flag queries, caps, entries browser, trace
recording), `server/mcp-tools.test.ts` (the no-active-specialist result, save
normalization, switch relaying), `features/bot-messaging/server/prompt.test.ts`
(stacking order), `features/scheduled-tasks/server/fire.test.ts` (fire-path
composition + tool-context binding).
