# Tool connections

**Feature ids:** `tool-connections` (the connections: CRUD, discovery, apply,
the managed reconcile), `mcp-tools-connections` (every remote tool call) ·
**Dashboard:** `/tools` · **SSE topic:** `tools` · **Related ids:**
`tool_connections`

The DB-backed half of the toolset. The in-process feature tools are code and
always offered; a tool connection is a remote MCP server whose tools the model
may call — added by an operator, or provisioned by the core for each
transport's own MCP server. Config lives in the database, not in env.

## Two halves of one toolset

`features/mcp-tools/server/service.ts` composes what a turn is offered: every
registered in-process tool (under its bare name — renaming those would
invalidate stored traces, task rows and prompt text that name them), plus the
connection tools **in scope** for the turn under their connection's slug prefix
(`<slug>__<tool>`, so two connections can both have a `search`). The Tools page
lists both halves as one catalog, each connection tool tagged with where its
scope offers it.

## Scope — three dimensions

Whether a connection's tools reach a turn (user decision, 2026-08-28), resolved
once per turn in `server/toolset.ts`:

| Dimension | Column | Rule |
| --- | --- | --- |
| Enabled | `enabled` | A disabled connection keeps its snapshot but is offered to nobody |
| App | `app_scope` | Null = every source; else only turns of that source app (`tg`, `chat`) — how each transport's own MCP server stays out of the other's prompt |
| Assistant | `all_assistants` + `assistant_tool_connections` | Every assistant, or the explicit selection; absent rows then mean "no assistant", not "everyone" |

Per-chat and per-user scoping are not part of v2. The store is read on every
turn rather than cached: two small queries cost nothing next to an inference,
and a cache would mean an applied snapshot the running process keeps ignoring.

## Discover, then apply

What the model is offered is always the **applied snapshot**
(`tool_connection_tools`), never a live answer from the remote server: a
server that renamed a tool mid-conversation would break the prompt's prefix
cache and, on a strict provider, 400 the whole request.

| Step | Route | Effect |
| --- | --- | --- |
| Create | `POST /api/tool-connections` | The row, with **no tools offered** until a discovery is applied |
| Discover | `POST /api/tool-connections/{id}/discover` | Asks the server what it offers, stores the answer (`last_discovered_tools`, `last_discovered_at`, `last_error`) and reports the **drift** against the applied snapshot — added, changed (description or schema, compared with keys sorted so a reordered schema is not a change), removed, unchanged. A server that cannot be reached is a report with `ok: false`, not a 5xx: the operator asked a question and got an answer, and the applied toolset is untouched |
| Apply | `POST /api/tool-connections/{id}/apply` | Makes the reviewed discovery the offered set — from the stored discovery, deliberately not a fresh fetch, so what is applied is what was on screen when the button was pressed. The **only** write that changes what the model can call, from the next turn |
| Edit | `PATCH /api/tool-connections/{id}` | Can only take tools away (disable, re-scope); sending `authHeaders` replaces the whole set. A managed connection's identity and endpoint are refused as edits; its scope and enabled flag are the operator's |
| Delete | `DELETE /api/tool-connections/{id}` | Snapshot and assistant selection cascade; managed rows cannot be deleted |

Drift is computed on read from the two stored columns rather than stored
itself — a stored copy could disagree with both. The dashboard shows the drift
as a warning badge and makes Apply the primary action while it exists.

## Calling a remote tool

A call carries the turn's binding as MCP request `_meta` under
`assistant-hub/turn` — source, chat, assistant, thread, correlation id, the
speaker and their owner rights, `deliveryKind` and the message being answered —
never as arguments, so a hosted tool can choose *what* to do and never *where*.
A hosted tool that delivered a message says so in its `structuredContent`
(`toolDeliveryResult`), and the turn's bookkeeping runs off that shape, not
the tool's name — which is how a task stamps its wording and a fire counts
what reached the chat, whatever a source calls its send tool. A dead endpoint
is a failed tool call, not a failed turn: the model gets the reason and can
answer without it, and the toolset never shrinks because a server blinked
(user decision, 2026-08-28). Every call is traced under
`mcp-tools-connections`, one scope for every connection — the connections are
operator data, not features, so their trace ids cannot be a static table; the
connection slug rides on each trace.

## Managed connections — the transports' own servers

Each transport hosts an MCP server for its platform's actions (Telegram:
`reply_to_message`, `send_message`, `set_message_reaction`), and the core
registers it as a **managed** connection (`server/managed.ts`): slug = the
source id, name "<Transport> tools", endpoint = the registered `baseUrl` +
`mcpPath`, auth header = the shared internal token, app scope = the source,
every assistant, `managed = true`, owned by nobody. The reconcile runs at core
boot and again on every transport registration, discovers the tools and
applies them **without an operator pressing Apply** — the one place the
discover-then-apply rule does not hold, deliberately: these tools ship with the
release and change when it is deployed, and asking for an Apply after every
upgrade would mean an assistant that silently lost the ability to react. A
transport that does not answer keeps its last snapshot (dropping it because
the app is still starting would make the first turns after a restart quietly
less capable); a source this deployment does not run has its row disabled.
The operator still owns the judgment calls — enabling, and which assistants
may call it. `TRANSPORT_SOURCE_IDS` (`["tg"]`) is the list a new transport
adds itself to
([Adding a transport](../development/adding-a-transport.md#step-6--the-mcp-server)).
The web chat's delivery tools left this list with the dissolve: they are
in-process registry tools now ([Web chat](web-chat.md)).

## Ownership and user-owned connections

Every connection an account creates is that account's (`owner_account_id`;
null for managed rows). Admins see and manage everything, a user-role account
only its own — an unowned id answers not-found. A connection whose owner's
**current** role is `user` is restricted, judged live so a demotion takes
effect without a data migration (Phase 9):

- it may target **public addresses only** — the core makes the calls, so a
  private-range or localhost endpoint would be an SSRF hole (`isSafePublicUrl`,
  checked at create, update, discovery, and again at call time);
- it cannot be scoped to an app, cannot be open to all assistants, and may
  list only its owner's own assistants — even an admin editing it cannot walk
  it out of the rules.

A connection dies with its account (offboarding cascade, [Accounts](accounts.md)).

## Data

| Table | Notes |
| --- | --- |
| `tool_connections` | `slug` (unique; lowercase letters, digits and dashes, ≤24 — it must be a valid tool-name prefix and cannot contain the `__` separator), `name` (≤64), `transport` (`http` is the only one that executes; `stdio` is modelled and refused), `endpoint_url` (http(s)), `auth_headers` (≤8, values ≤2000 chars — secret, never returned; clients see the header **names**), `enabled`, `app_scope`, `all_assistants`, `managed`, `owner_account_id`, `last_discovered_at`, `last_error`, `last_discovered_tools` |
| `tool_connection_tools` | The applied snapshot: `(connection_id, name)`, `description`, `input_schema`, `applied_at` |
| `assistant_tool_connections` | The explicit assistant selection |

At most 32 connections. Header values are withheld from trace bodies too — a
bearer token pasted into Debug is a leaked credential.

## Dashboard

`/tools` (`features/mcp-tools/ui/ToolsManager.tsx`,
`features/tool-connections/ui/ConnectionsManager.tsx`): the built-in catalog,
then each connection with its applied tools, drift, last check, **Discover**
and **Apply** buttons, and an editor whose "Where it applies" picker offers
every source / Telegram turns only / web chat turns only plus the assistant
selection. A managed connection is badged "provided by the hub" and its
identity fields are read-only. Live on the `tools` topic. A user-role account
sees the catalog, its own connections, and its own assistants in the pickers.

## API

`GET|POST /api/tool-connections`, `PATCH|DELETE /api/tool-connections/{id}`,
`POST /api/tool-connections/{id}/discover`, `POST /api/tool-connections/{id}/apply`
— all `account`-level, ownership-gated; `GET /api/tools` (the catalog, admin).

## Tracing

`tool-connections` (`relatedIdsKey`: `tool_connections`): `create`, `update`,
`delete`, `discover` (a failed discovery settles the trace as failed while the
API answers with the report), `apply`, `reconcile-managed` (one trace per boot
or registration pass, naming each source's outcome); the transports service
also records assistant connection edits under this id
([Assistants](assistants.md#transport-connections)). Every remote call under
`mcp-tools-connections`.

## Tests

Unit: `server/diff.test.ts` (added/changed/removed/unchanged; a reordered
schema is unchanged), `server/schema.test.ts` (prefixed names round-trip and
a bare built-in name is rejected; create defaults; slug, endpoint and header
validation).
Integration: `server/tool-connections.integration.test.ts` — the service
(secrets withheld from clients and traces, duplicate slugs, the refused
transport, scoping, header replacement, delete), discovery (discover without
offering, then apply; auth headers sent; drift reported without changing the
offer; an unreachable server keeps the applied set; apply refused before a
discovery), the connection toolset (slug prefix, nothing before apply or
while disabled, app and assistant scoping, the `_meta` binding, tool errors
for an unreachable server and an unknown name), the managed source
connections, and ownership with the public-address guard.
