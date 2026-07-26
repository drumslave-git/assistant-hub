# Personalities

**Feature id:** `personalities` · **Dashboard:** `/personalities` · **Priority 2**

Named personas the operator writes. Exactly one can be active, and the active one's
prompt is appended to the base system prompt on every reply.

## Model

The base system prompt is a **fixed, code-owned constant**
(`features/bot-messaging/server/prompt.ts`, `BASE_SYSTEM_PROMPT`) that the operator
does not edit. Personality is the operator's behavioral layer over it:

```
BASE_SYSTEM_PROMPT
---
Additional instructions:
<active personality prompt>
```

Since the Mood feature was dropped (user decision, 2026-07-16), the persona is the
**only** behavioral layer over the base prompt, alongside the self-correction
guidelines the feedback job distils.

This is a full CRUD feature with an active selection, not a single settings field
(user decision) — an operator wants to keep several personas and switch between
them without retyping.

## Data

`personalities` — `id`, `name`, `prompt`, `created_at`, `updated_at`. The active
selection lives on the settings row (`settings.active_personality_id`, FK
`ON DELETE SET NULL`), so deleting the active persona clears the selection rather
than leaving a dangling id.

Bounds, enforced by the zod contract:

| Bound | Value |
| --- | --- |
| Max personalities | 32 |
| Max name length | 64 |
| Max prompt length | 32 000 |

Name uniqueness is **case-insensitive** and enforced in the service, not by a
database constraint. The max-count guard is likewise a service concern.

## Dashboard

`/personalities` is a Server Component listing personas oldest-first with the
active one marked; `PersonalitiesManager` (Client) owns create, edit, delete and
set-active. Each mutation calls the API and then `router.refresh()` re-reads the
server-rendered list and selection. Built from the shared UI-kit
`Card`/`Field` primitives — no bespoke chrome.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/personalities` | `{ personalities, activeId }` |
| `POST /api/personalities` | Create (201) |
| `PATCH /api/personalities/{id}` | Update name and/or prompt |
| `DELETE /api/personalities/{id}` | Delete |
| `PUT /api/personalities/active` | Set the active id, or `null` to clear |

## Tracing

Every mutation is traced under `personalities` — create, update, delete and
set-active. Reads are cheap and untraced.

Because the composed system prompt is recorded on every reply trace (with
`personalityApplied: boolean`), the answer to "which persona produced this reply"
is in the trace itself rather than inferred from the current selection.

## Tests

`server/schema.test.ts` (bounds and shapes),
`server/personalities.integration.test.ts` (CRUD, uniqueness, the count guard and
active-selection behavior against a real database).
