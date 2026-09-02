# Assistants

**Feature id:** `assistants` · **Dashboard:** `/assistants` · **SSE topic:**
`assistants` · **Related ids:** `assistants`

The bot's identities. An assistant is a name, a persona, and — per transport —
a bot connection of its own. Many assistants share one brain (settings, memory,
tools, the pipeline); what is per assistant is the persona, the connections,
the standing tasks and the tool selection. The first-class successor of
personalities (v2 redesign, Phase 3): there is **no "active" assistant** — the
assistant in a chat is implied by which bot is in it.

## Model

The base system prompt is a fixed, code-owned constant
(`features/bot-messaging/server/prompt.ts`, `BASE_SYSTEM_PROMPT`). The persona
is the assistant's behavioural layer over it, appended as "Additional
instructions":

```
BASE_SYSTEM_PROMPT
---
Additional instructions:
You are <name>.

<persona>
```

The identity line is asserted by the system even when the persona is empty or
written in the third person (user decision, 2026-08-24): an assistant always
knows who it is. Since the Mood feature was dropped (user decision,
2026-07-16), the persona is the only behavioural layer over the base prompt,
alongside the self-correction guidelines the feedback job distils and the
chat's standing tasks.

The **name** is also the spoken-summons identity: the core's half of the
addressing check matches it, and the LLM analyzer is asked about it, never
about the bot account's profile name (user decision, 2026-08-24). Rename the
assistant and people summon it by the new name from the next message.

Where the persona is read:

| Turn | Read |
| --- | --- |
| A reply turn | `getAssistantPromptIdentity(event.assistantId)` — one read serving the name check, the analyzer and the persona. An id the store does not know composes no persona, and says so loudly on the server log |
| A timed task fire | `getAssistantPersona(task.assistantId)` — the fire runs as the task's assistant |
| A chat with several assistants | `getAssistantNames()` — another assistant's lines are attributed by its name, never as "You" |
| The self-improvement reflection and its daily job | `getSingleAssistantPersona()`, transitional: the persona when exactly one assistant exists, else none — those flows have no event to name an assistant |

## Owner account

`assistants.owner_account_id` is the account that created the assistant
(`ON DELETE SET NULL`). It decides **owner rights** in every turn the assistant
takes: a sender holds them when their account — resolved through person links —
is this one; admins hold them on every assistant; a null owner (a row created
while auth was unconfigured) is admin-owned in effect
(`server/owner-rights.ts`, [Accounts](accounts.md#owner-rights)). The ingest
stamps the verdict on each turn's event as `sender.isOwner`, per receiving
assistant, and the web chat resolves it the same way for the thread's account.

Ownership also scopes the dashboard (`server/ownership.ts`): an admin sees and
edits every assistant (cards carry an `owner: <name>` badge, or
`admin-owned`); a user-role account sees only its own, with full parity —
create, edit, delete, connect bots, pick tools, write tasks, chat. Foreign ids
answer not-found rather than forbidden, so a scoped API leaks nothing.

## Data

| Table | Notes |
| --- | --- |
| `assistants` | `id`, `name`, `persona`, `owner_account_id`, timestamps |
| `assistant_transports` | One connection per assistant per transport (unique index): the opaque `config` blob the transport's schema describes (Telegram's holds the bot token), and `enabled` |
| `assistant_tool_connections` | Which assistants may call a tool connection whose `all_assistants` is false |
| `tasks.assistant_id` | NOT NULL, cascades — a task is one assistant's standing order ([Tasks](tasks.md)) |

Bounds, enforced by the zod contract (`server/schema.ts`):

| Bound | Value |
| --- | --- |
| Max assistants | 32 |
| Max name length | 64 |
| Max persona length | 32 000 |

Name uniqueness is **case-insensitive** and enforced in the service, not by a
database constraint. The max-count guard is likewise a service concern.

## Transport connections

A bot token is not a setting: it is the assistant's connection on one
transport. The assistant editor renders one section per **registered**
transport (`components/transports/TransportSections.tsx`), built from the
config field schema the transport announced at registration
(`transports.connection_config_schema`: `text`, `secret` and `boolean` fields)
— no build-time UI package, so a new transport gets its editor section for
free. Telegram's schema is one required secret, the bot token.

| Action | Effect |
| --- | --- |
| Connect | `POST /api/transports/{id}/connections` — the row is desired state; the transport refetches it on the bus's `transport.config.changed` and starts the poller |
| Save changes | `PATCH …/connections/{connectionId}` with a config — secrets are write-only (previewed as `…last4`); a changed token restarts the poller |
| Stop / Start | `PATCH` with `enabled` — the desired state the transport receives folds this with the transport's own switch and the owner account's activity, so `false` there means "do not run this" whatever the row says |
| Disconnect | `DELETE …/connections/{connectionId}` — the row and its stored config go; the assistant is untouched |

The section shows the connection's live state as the transport reports it on
`/health` — **Running** (with the bot's username), **Error**, **Stopped**, or
**Not tracked** (enabled, but the transport service is not answering) — and
re-reads on every `status` event the transport publishes. The Overview's bot
status card (`features/bot-messaging/ui/BotControl.tsx`) offers the same
Start/Stop per connection.

Connection edits are traced with the actions `connection-create`,
`connection-update` and `connection-delete` under the `tool-connections`
feature id, which `server/transports/service.ts` shares. The wire contract is
in [Adding a transport](../development/adding-a-transport.md#step-2--register-receive-desired-state-reconcile).

## Tool selection

Every assistant is offered the full stable in-process toolset (no toolset
routing, user decision 2026-08-19). Tool **connections** — remote MCP servers,
including each transport's own — are scoped per assistant on the Tools page: a
connection is either open to every assistant or lists the ones that may call
it (`assistant_tool_connections`); a user-role account's connections must list
its own assistants explicitly. See [Tool connections](tool-connections.md).

## Deletion

`DELETE /api/assistants/{id}` removes the row; its tasks, transport connections
and tool selections cascade in the store. Whatever a source app keeps keyed on
the id — the running poller — is dropped by the app reacting to the
`assistant.deleted` bus event the service publishes on `assistant-hub:events`
(the Telegram transport refetches its desired state and stops the connection).
With no bus configured the trace carries a loud `warn` event saying the sources
were not told, never a silent divergence. Web-chat threads bound to the
assistant keep their `assistant_id` (a plain column, not a foreign key); an
unknown assistant on a later turn replies with the base prompt only and logs
the id. The dashboard's confirm names all of it: the assistant, its tasks and
its bot connections go, and any bot it ran stops polling.

An account's offboarding deletes its assistants through this same service, so
the lifecycle event fires for each ([Accounts](accounts.md#offboarding)).

## Several assistants in one chat

Every assistant present in a group gets its own turn for each message
(`receivers ∩ presence`, [Bot messaging](bot-messaging.md#how-a-turn-arrives)),
its own correlation id and its own reply trace. Assistants hear each other
through the cross-feed, and the **loop guard**
(`settings.assistantLoopGuardTurns`, default 3 — user decision 2026-08-24) is
what stops two of them from answering each other forever: once the chat holds
that many assistant messages in a row, every assistant there stays silent until
a person speaks. `0` stops assistants from answering each other at all.
Deterministic, never an LLM judgement.

## Dashboard

`/assistants` is a Server Component listing assistants oldest-first (scoped to
the account's own for a user role); `AssistantsManager` (Client) owns create,
edit and delete, with the name and persona in a modal (one form for both,
2026-08-14) and the transport sections mounted below the persona for an
existing assistant. Live-updates on the `assistants` topic; the connection
sections re-read on `status`. A "Limit of 32 reached" note disables the
create button at the cap.

## API

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/assistants` | account | The assistants the account may see (all for admins) |
| `POST /api/assistants` | account | Create (201); the creator owns it |
| `PATCH /api/assistants/{id}` | account, owner | Update name and/or persona |
| `DELETE /api/assistants/{id}` | account, owner | Delete, with the cascade and the lifecycle event |
| `GET /api/transports` | account | The registered transports and their field schemas |
| `GET|POST /api/transports/{id}/connections` | account, owner | This transport's connection of one assistant (`?assistantId=`) / connect |
| `PATCH|DELETE /api/transports/{id}/connections/{connectionId}` | account, owner | Re-config, start/stop, disconnect |

## Tracing

Every mutation is traced under `assistants` — `create`, `update`, `delete` —
with the assistant's id on the trace itself, so the assistant's own Debug view
(`?assistantId=`) starts with its creation. Reads are cheap and untraced.

Because the composed system prompt is recorded on every reply trace (with
`personalityApplied: boolean`) and every reply trace carries the assistant id,
the answer to "which assistant, with which persona, produced this reply" is in
the trace itself.

## Tests

`server/assistants.integration.test.ts` (CRUD, the identity line on an empty
persona, case-insensitive uniqueness, deletion with the source-notification
outcome, the trace record of every mutation),
`server/owner-rights.integration.test.ts` (owner rights through links, admins
everywhere, the null-owner rule, the ownership helpers),
`features/accounts/server/accounts.integration.test.ts` (offboarding:
deactivation silences an account's assistants, hard delete cascades them),
`server/turn/turn-consumer.integration.test.ts` (a cross-fed turn answered in
the other assistant's voice; the loop guard at the limit and at zero), and
`features/tool-connections/server/tool-connections.integration.test.ts` (an
explicit assistant selection honoured).
