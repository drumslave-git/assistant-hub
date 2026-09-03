# Adding a transport

How to connect a new messaging platform (Signal, Matrix, Discord, Slack, …) to
a running assistant-hub core.

**You do not need this repository.** A transport is developed in its own
repository, in any language, and ships as its own Docker image; the core's
operator adds one service to their compose file and you appear on their
dashboard. Everything a transport must do is published:

| What you need | Where it is |
| --- | --- |
| The contract, as code | [`@assistant-hub-swarm/transport-sdk`](../../packages/transport-sdk/README.md) on GitHub Packages — zod schemas, the Redis helpers, the token guard, an MCP server over Hono, the trace client, image normalization |
| The contract, language-neutral | [`docs/api/transport/events.schema.json`](../api/transport/events.schema.json) (JSON Schema for every event) and [`docs/api/transport/openapi.yaml`](../api/transport/openapi.yaml) (the HTTP in both directions) — generated from the same schemas and checked against them in CI |
| A working version of every step | [`assistant-hub-swarm/ahw-transport-telegram`](https://github.com/assistant-hub-swarm/ahw-transport-telegram) — the Telegram transport, referenced file by file below. It is a separate repository built on the SDK, exactly like yours will be |

This document walks the contract in the order a new transport meets it. Read
[Architecture overview](../architecture/overview.md) first for where a
transport sits, and [The message pipeline](../architecture/telegram-pipeline.md)
for what the core does with what you send it.

## What a transport is

A transport is a **stateless** service that owns exactly one platform. It has
no database and no files. Everything it knows at runtime it learns from the
core at boot (registration answers with the desired state) and from the bus
(config changes). Its whole job is translation:

| Direction | The transport… | The core… |
| --- | --- | --- |
| Platform → core | forwards **every** update it sees (messages addressed or not, edits, reactions, its own sends) as normalized events, media bytes attached | persists them in the conversation store, decides who gets a turn, composes the prompt, runs the pipeline |
| Core → platform | consumes reply-delivery events and performs the send; renders turn lifecycle as the platform's "typing" | publishes one reply-delivery per finished reply and lifecycle events for every turn |
| Model → platform | hosts an MCP server with the platform's own actions (react, reply, send) | offers those tools on that platform's turns only, bound to the turn out of band |
| Operator → transport | announces its config fields at registration | renders them in the assistant editor, stores the values opaquely, hands them back as desired state |

The transport never decides whether to answer. It computes only what the wire
format alone can say (a reply target, an @mention entity) and reports it; the
name check and the LLM analyzer are the core's.

## The shape at a glance

```
 platform API ◄──► your transport service      ◄── Redis pub/sub `assistant-hub:events`
                    ├─ pollers / webhook           reply.delivery, turn.lifecycle,
                    ├─ HTTP :PORT                  transport.config.changed, assistant.deleted
                    │   /health                 ──► Redis queue `transport-updates`
                    │   /internal/*  (token)       transport.message, transport.edited,
                    │   /mcp         (token)       transport.reaction, transport.bot-reaction,
                    └─ bus publisher               message.delivered, transport.presence
                                                ──► bus: trace.recorded, dashboard.refresh
                                                ──► HTTP core /api/internal/transports/* (token)
                                                     register, desired, callback, messages, config
                                                ◄── HTTP from core /internal/* (token)
                                                     voice, photos, files, delete, menus, title
```

Three things cross the boundary, and only three: the Redis bus/queue, the
transport's own HTTP surface, and the core's internal transport API. All HTTP
in both directions is authenticated by one shared secret,
`INTERNAL_API_TOKEN`, sent as the `x-internal-token` header.

## Before you start: what the core knows about you

Nothing, until you register. There is no list of transports anywhere in the
core (user decision, 2026-09-02): the source id you announce is accepted as
long as it has the right shape, and every runtime lookup over "the sources"
— the ingest's source check, the managed tool connections, the Users and
Groups roster, the media backfill and gallery, the app-scope select on the
Tools page — reads the registration table. A transport connects to a running
core with **zero core edits**; if you find yourself editing a core file to
make your transport appear, that is a core bug — file it.

Two things are checked when you register:

| Check | Rule | On failure |
| --- | --- | --- |
| **Source id** | `^[a-z][a-z0-9-]{0,31}$` — short, lowercase, stable. It becomes the prefix of every scoped ref (`signal:user:123`), the slug of your MCP tools (`signal__send_message`), the `source` on every event and the `transports.id` row. It cannot change later without rewriting stored refs | 400 `a transport registration is required` |
| **Contract major** | `contractMajor` must equal the core's `CONTRACT_MAJOR` (exported by the SDK; `2` today). It is bumped when an event, an internal route or the registration shape changes incompatibly | 409 naming both majors. The row is still upserted so the assistant editor shows the refusal next to your name; you get no desired state and your events are dropped until either side updates |

The two versions are different numbers and mean different things: the SDK's
own semver covers its TypeScript API, and `CONTRACT_MAJOR` covers the wire.
When a core refuses your major, bump the SDK and rebuild.

Every dashboard surface is source-generic — see
[What the dashboard shows for your transport](#what-the-dashboard-shows-for-your-transport)
at the end for the exact list, and for the one convention it relies on.

## Step 1 — Scaffold the service

Start an ordinary Node project in your own repository. The `@assistant-hub-swarm`
scope lives on GitHub Packages, so point npm at it first:

```
# .npmrc
@assistant-hub-swarm:registry=https://npm.pkg.github.com
```

That registry wants a **token on every request**: a package published there is
readable by any account once it is public, but not anonymously. Put one with
`read:packages` in your user-level `~/.npmrc`, where it stays out of every
repository you write:

```
//npm.pkg.github.com/:_authToken=<token>
```

In CI it is the workflow's own `GITHUB_TOKEN`; in an image build, pass it as a
BuildKit secret rather than a build arg, so it never lands in a layer.

```bash
npm install @assistant-hub-swarm/transport-sdk \
            hono @hono/node-server @modelcontextprotocol/sdk zod
```

| Dependency | Gives you |
| --- | --- |
| `@assistant-hub-swarm/transport-sdk` | Every schema and helper named below: `CONTRACT_MAJOR`, the queue/channel constants, `turnCorrelationId`, `messageDedupeKey`, `readTurnMeta`, `toolDeliveryResult`, `openQueue`/`openPublisher`/`openSubscriber`, `requireEnv`, `internalTokenGuard`, `serveMcp`, `busTraceClient`, `dashboardRefresh`, `normalizeImageForChat` |
| `hono` + `@hono/node-server` | The HTTP surface. Any framework works, but `serveMcp` is written for Hono's node adapter |
| `@modelcontextprotocol/sdk` | `McpServer` for the platform tools |
| `zod` | The schemas' runtime, and your MCP tools' input shapes |
| Your platform SDK | grammy, for Telegram |

Those last four are the SDK's **peer** dependencies: you construct Hono apps,
`McpServer`s and zod schemas and hand them across, so one copy of each must be
shared. Everything else the SDK needs (BullMQ, ioredis, sharp) it brings.

Not using Node? Nothing above is required. Read the events from
[`events.schema.json`](../api/transport/events.schema.json) and the HTTP from
[`openapi.yaml`](../api/transport/openapi.yaml), and speak Redis and HTTP
directly — the SDK is a convenience, not the contract.

Environment (bootstrap only — runtime config comes from the core):

| Variable | Required | Purpose |
| --- | --- | --- |
| `REDIS_URL` | yes | Bus + queue |
| `INTERNAL_API_TOKEN` | yes | Must equal the core's |
| `PORT` | no | Your HTTP port (tg: 3210) |
| `CORE_API_URL` | no | The core's base URL (default `http://localhost:3200`) |
| `SELF_URL` | no | The base URL you **announce** — what the core will call. Default `http://localhost:<PORT>`; under compose `http://<service>:<PORT>` |

Boot order matters (worked example: [src/index.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/index.ts)):

1. Open the update publisher (queue) and the platform manager.
2. Start the HTTP server **first** so `/health` answers from the first
   moment — the core probes it for the dashboard.
3. Register with the core, retrying until it answers (the core may boot after
   you). The response is your desired state; reconcile from it.
4. Subscribe to the bus for config changes.
5. Start the delivery consumer.
6. On `SIGINT`/`SIGTERM`: close the server, the subscriptions, the platform
   connections, and the queue, then exit.

## Step 2 — Register, receive desired state, reconcile

Reference: [src/desired-state.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/desired-state.ts),
[src/bot-manager.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/bot-manager.ts) (`applyDesiredState`).

### Registration

`POST {CORE_API_URL}/api/internal/transports/register` with
`transportRegistrationRequestSchema`:

```jsonc
{
  "id": "tg",                       // your source id — any slug of the right shape
  "name": "Telegram",               // what the dashboard calls you
  "contractMajor": 2,               // CONTRACT_MAJOR of the contracts package you built against
  "baseUrl": "http://tg:3210",      // SELF_URL — the core calls you here
  "mcpPath": "/mcp",                // or null if you host no tools
  "connectionConfigSchema": [       // one section per assistant, in the editor
    { "key": "botToken", "label": "Bot token", "kind": "secret", "required": true,
      "help": "From @BotFather. Stored by the core; never shown again." }
  ],
  "transportConfigSchema": []       // transport-wide settings (tg has none)
}
```

Field kinds are `text`, `secret` (rendered as a password input, previewed as
`…last4`) and `boolean`. The core upserts the `transports` row: your announced
identity always follows the code, while the admin's `enabled` flag and the
stored config blobs survive every re-registration. A `contractMajor` the core
does not speak is answered 409 (the row is kept, marked refused); retry on
the same interval as a connection failure — the operator will update one
side or the other. Registering also triggers
the managed tool-connection reconcile (Step 6), and the response **is** your
desired state, so registration doubles as the boot-time fetch.

### Desired state

`transportDesiredStateSchema`:

```jsonc
{
  "transport": { "enabled": true, "config": {} },
  "connections": [
    { "id": "<uuid>", "assistantId": "<uuid>", "config": { "botToken": "…" }, "enabled": true }
  ]
}
```

One connection per assistant per transport (unique index). The `config` blob
is exactly what the operator typed into your schema — the core never
interprets it. `enabled` already folds in the transport switch and account
deactivation: a `false` here means "do not run this", whatever the row says.

Refetch with `GET /api/internal/transports/<id>/desired` whenever the bus
carries `transport.config.changed` with `transport === <your id>` or
`assistant.deleted` (its cascade removes connection rows without a per-row
event). Serialize refetches so a burst collapses into one reconcile.

### Reconcile semantics

`applyDesiredState` must be idempotent:

- stop and forget every running connection whose id is absent or `enabled: false`;
- leave an unchanged running connection alone (tg compares the token it was
  started with — secrets are not readable off a live client);
- start or restart the rest; start always replaces a running instance.

Per-connection state you report on `/health` is `running | error | stopped`,
with the platform identity (`username`), `since`, and the last `error`.
Publish `dashboardRefresh(<id>, ["status"])` on every state change so the
assistant editor's badge flips without a reload.

Supervision is your problem: Telegram's poller caps its own fetch retries at
30 s, then reconnects every 15 s on a flat interval for transient network
errors only, and logs edge-triggered (one line down, one line back). A
platform that answered and refused (revoked token) settles as `error` without
retrying.

## Step 3 — Forward every update

Reference: [src/inbound.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/inbound.ts),
[src/updates.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/updates.ts),
[src/addressing.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/addressing.ts),
[src/media/ingest.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/media/ingest.ts).

Everything leaves as one job per event on the BullMQ queue
`TRANSPORT_UPDATES_QUEUE` (`transport-updates`), payload validated by
`transportUpdateEventSchema`. The core's ingest consumes it per-chat
sequentially, cross-chat concurrently — so two messages in one conversation
are never processed out of order, however busy the rest is.

Every event shares the envelope:

| Field | Value |
| --- | --- |
| `v` | `1` |
| `eventId` | a fresh UUID |
| `occurredAt` | ISO instant |
| `correlationId` | `<chatRef>:<sourceMessageId>` for message-shaped events (`turnCorrelationId`, which the core extends with the receiving assistant); it ties your event to the turn's traces |

### `transport.message` — a new inbound message

| Field | Meaning |
| --- | --- |
| `source` | your id |
| `receivedBy` | the assistant whose connection received this update |
| `chat` | `{ id, kind: "direct" \| "group", title?, type? }` — `type` is your platform's own subtype string |
| `sender` | `{ userId, username (lowercase, no @) \| null, firstName, lastName }` |
| `message.sourceMessageId` | your platform's message id, as a string |
| `message.content` | text or caption, `""` for a bare media message |
| `message.sentAt` | ISO instant |
| `message.threadId` | sub-thread (forum topic) or null |
| `message.replyTo` | `{ sourceMessageId, hasMedia, text, quote?, author, authorAssistantId }` or null. `authorAssistantId` is set when the quoted message was written by one of **your running bots** — you recognize your own bot ids; the core does not |
| `media` | see below, or null |
| `receivers` | one entry per running connection that may get a turn, each with its `identity` and its **structural addressing verdict** |
| `dedupeKey` | from `messageDedupeKey(...)` — see stream rules |

**Stream rules.** A group is one shared stream: pass `assistantId: null` to
`messageDedupeKey`, forward the message **once** even if several of your bots
received it (tg keeps an in-process seen-cache with a 10-minute TTL), and list
every running connection in `receivers`. A direct chat is one stream per bot:
pass the receiving assistant's id, and list only the receiving connection.
The core enforces uniqueness on `(source, dedupeKey)`, so a re-forwarded
update is harmless.

**Suppressed duplicates still prove presence.** When your dedupe drops a
second receipt of a group update, publish `transport.presence`
(`{ chatId, assistantId }`) for that connection instead. The core stamps
presence in `source_chat_assistants` from what the platform actually
delivered to each connection, and the group fan-out is
`receivers ∩ presence`; without the stamp a bot that joined a chat second
never gets its turns.

**Structural addressing** (`addressingSchema`): decide only what the wire
shape proves, against **each** receiver's own bot account:

| Verdict | When |
| --- | --- |
| `{ addressed: true, source: "private" }` | direct chat — always |
| `{ addressed: true, source: "reply" }` | the message replies to one of this bot's messages |
| `{ addressed: true, source: "command" }` | a `/command@thisbot` |
| `{ addressed: true, source: "mention" }` | an @mention entity or literal `@username` of this bot |
| `{ addressed: false, needsAnalyzer: true }` | group text that names nothing structurally — the core runs the assistant-name check and, behind it, the LLM analyzer |
| `{ addressed: false, needsAnalyzer: false }` | no text at all |

Always fill `reason` with a sentence naming the evidence: a structurally
addressed message never reaches the analyzer, so that sentence is the whole
account of why the bot answered, and Debug shows it. Never match the
assistant's display name here — the name lives in the core and can be renamed
there (user decision, 2026-08-24). `source: "name"` is reserved for the core.

**Who not to forward.** Bot-authored messages are never forwarded: your own
sends are reported through `message.delivered`, and the core cross-feeds them
to the other assistants in the chat. A message with neither text nor media is
skipped. The transport does **not** filter on addressing — unaddressed group
chatter is forwarded too, because it is the conversation the next reply reads.

**Media** (`transportMediaSchema`): download the bytes yourself — only you can
talk to your platform's file API — and attach them:

| Field | Value |
| --- | --- |
| `kind` | `photo` \| `sticker` \| `image_document` \| `animation` \| `video` \| `voice` |
| `fileId`, `fileUniqueId` | your platform's handles, kept for provenance |
| `mimeType` | of the payload (`image/jpeg` after normalization, `audio/ogg` for voice) |
| `visionHint` | a hint for the describer: a sticker's emoji and pack, the frame-sequence note for video |
| `frames` | base64 payloads, ordered: one normalized JPEG for a still, several sampled frames for a video/GIF, one raw audio blob for voice |
| `unavailable` | `true` with empty `frames` when the bytes could not be loaded — recorded once, never re-attempted |

Run every image through `normalizeImageForChat` (longest edge 768 px, under
900 KB). Video and GIF frames are sampled with ffmpeg in tg
(`src/media/frames.ts`); the thumbnail is the fallback. The core
stores the row as pending media, describes or transcribes it, drops the bytes,
and from then on the transcript line reads ` [photo: …]`. A failed download
still opens the turn — the pipeline answers from the text.

### `transport.edited`

`{ source, chat, assistantId, sourceMessageId, content, editedAt }` — a
content edit. Skip edits with no textual content. Forward a group edit once
(dedupe on `chatId:messageId:editedAt`).

### `transport.reaction`

`{ source, chat, assistantId, sourceMessageId, reaction: "up" | "down", user }`
— a human put a feedback-worthy reaction on a message. You map your platform's
emoji to the two values (tg: a freshly **added** 👍/👎; removals and other
emoji are ignored) and forward once per group. The core checks whether the
target is one of its replies and runs the feedback collection flow, which
posts an options menu through your `/internal/chats/:chatId/menu` endpoint
(Step 5). A platform with no reactions simply never publishes this.

### `transport.bot-reaction`

`{ source, chat, assistantId, sourceMessageId, emoji | null }` — **your**
reaction tool changed the assistant's own badge. The core records it on the
mirror row so the transcript renders `[you reacted: 👍]` and the next turn
remembers reacting (without this record the model denied its own reaction the
very next turn).

### `message.delivered`

Published for **every** send you perform, on every path — reply-delivery
events, the internal send API, your MCP tools — from one function
([src/send.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/send.ts), `publishDelivered`):

| Field | Meaning |
| --- | --- |
| `assistantId` | the authoring assistant, or null when the caller could not say |
| `sourceMessageId`, `dedupeKey` | the delivered message, same stream rules as inbound |
| `content` | the delivered text — a voice reply's spoken words, a file's caption |
| `replyToSourceMessageId` | what the platform **actually** attached, read back from the sent message (Telegram silently drops a reply target it will not attach) |
| `silent` | a transient acknowledgement: mirrored, never cross-fed |
| `image` | `{ fileId, fileUniqueId, base64 }` for a generated picture you delivered — the core stores it as pending media so the describer recognizes what the bot drew |
| `running` | every connection running right now: `{ assistantId, botId, identity }` — the cross-feed roster |

The core writes the mirror row from this event and, in a group, hands the
message to the other present assistants as a cross-fed turn. Publish it
best-effort: a report failure must not turn a message the user can see into a
failed send.

## Step 4 — Consume deliveries and render the turn lifecycle

Reference: [src/delivery.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/delivery.ts).

Subscribe to `BUS_EVENTS_CHANNEL` (`assistant-hub:events`), parse by `type`,
and ignore anything whose `source` is not yours. Failures are logged, never
thrown into the subscriber: one bad delivery must not kill the consumer for
every chat.

### `reply.delivery` — send this

| Field | Meaning |
| --- | --- |
| `assistantId` | whose bot sends |
| `chatRef` | `<source>:chat:<chatId>` — parse with `parseScopedRef` |
| `threadId` | sub-thread to deliver into, or null |
| `replyToSourceMessageId` | the message being answered, or null (unprompted) |
| `text` | the model's **raw Markdown** |
| `silent` | deliver without a notification ping |
| `linkableSourceMessageIds` | the mirror-checked whitelist of `#<id>` citations you may render as tappable message links; anything else stays plain text |

Render the text for your platform at this boundary and nowhere earlier: the
mirror, the traces and the pipeline all keep the raw text. Telegram converts
Markdown to its small HTML tag set by construction
([src/telegram-html.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/telegram-html.ts)) and
falls back to a plain-text send when the platform still rejects the markup —
that fallback triggers only on a parse error, because any other retry could
double-deliver. **You split.** The core publishes the whole answer as one
`reply.delivery` and knows no platform's cap (user decision, 2026-09-02):
cut a long text at natural boundaries under yours (Telegram:
[src/split.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/split.ts), paragraph → line →
sentence → word), send the parts in order with the same reply target, and
report every part as `message.delivered` so the mirror holds the whole
answer.

After the send: publish `message.delivered`, and record the delivery as a
trace (`feature: "bot-messaging"`, `action: "deliver"`) on the event's
`correlationId`, so in Debug it lines up right after the core's reply trace.

Plain text is the only payload this event carries. Voice, images and files
cross your internal API instead (Step 5), because they carry bytes and need a
delivered id back.

### `turn.lifecycle` — show that something is happening

`{ assistantId?, chatRef, sourceMessageId, threadId?, phase, activity? }` with
`phase` in `accepted | progress | settled`. Typing is lifecycle rendering,
never an MCP tool: start your platform's typing indicator on `accepted` (and
keep it on `progress`, whose `activity` names the tool running), stop it on
`settled`. Key the loop per `chatId:sourceMessageId` so concurrent chats never
share one; Telegram refreshes every 4.5 s because its chat action expires
after about 5 s. `settled` is published on every terminal path, ignored turns
included, so a loop always ends.

You do nothing else on `settled` — the core releases its own mirror hold.

## Step 5 — The HTTP surface

Reference: [src/api.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/api.ts),
[src/outbound.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/outbound.ts).

Guard everything under `/internal` and `/mcp` with
`internalTokenGuard(INTERNAL_API_TOKEN)`. `/health` stays open: it carries no
secrets, and the core probes it unauthenticated.

| Method and path | Request | Response | Who calls it |
| --- | --- | --- | --- |
| `GET /health` | — | `{ ok: true, connections: [{ connectionId, assistantId, state, username, since, error }] }` | The core, on every assistant-editor read (5 s timeout) and the Overview status card |
| `POST /internal/chats/:chatId/messages?assistantId=` | `internalSendMessageRequestSchema`: `{ text, replyToSourceMessageId?, threadId?, silent, linkableSourceMessageIds? }` | `{ sourceMessageId }` | Silent browsing acknowledgements (their id is registered for later deletion) and self-link confirmations — sends that need the delivered id back |
| `POST /internal/chats/:chatId/voice` | `{ audioBase64 (OGG/Opus), text, replyToSourceMessageId?, threadId? }` | `{ sourceMessageId, asVoice }` | Voice replies: TTS runs in the core, the bytes cross here. Fall back to a text send of `text` when the platform refuses the voice bubble, and report `asVoice: false` |
| `POST /internal/chats/:chatId/photos` | `{ images: [base64…], threadId? }` | `{ delivered: [{ sourceMessageId, stored }] }` | Generated images, delivered after the reply. Report each with `message.delivered` carrying `image` |
| `POST /internal/chats/:chatId/files` | `{ dataBase64, filename, mime?, caption?, threadId? }` | `{ sourceMessageId }` | Browser-agent downloads. Pick the playable send kind by mime, retry as a plain document when the platform refuses the container. The core allows 500 s for this call |
| `DELETE /internal/chats/:chatId/messages/:messageId` | — | `{ deleted }` | Removing a stale acknowledgement or menu. A refusal is `deleted: false`, never an error — cosmetic for every caller |
| `POST /internal/chats/:chatId/menu?assistantId=` | `internalSendMenuRequestSchema`: `{ text, keyboard: [[{ text, callbackData }]], replyToSourceMessageId }` | `{ sourceMessageId }` | The feedback flow's options menu |
| `PATCH /internal/chats/:chatId/menu/:messageId?assistantId=` | `{ text, keyboard \| null }` | `{ ok: true }` | Rewriting the menu (`null` removes the buttons) |
| `DELETE /internal/chats/:chatId/menu/:messageId?assistantId=` | — | `{ deleted }` | Removing the menu |
| `PUT /internal/chats/:chatId/title` | `{ title }` | `{ title }` | Only for sources whose conversations have provisional names (`chatInfo.titleProvisional`) — Telegram does not serve it |
| `ALL /mcp` | MCP Streamable HTTP | — | The core's MCP client, on this platform's turns |

`assistantId` in the query says whose bot performs the send; absent, use
whichever connection runs. Resolve the client per call so a poller restart
never leaves a stale handle behind. Every send here reports
`message.delivered` too — `content` is the spoken text for voice and the
caption for a file.

Every body's schema is exported from the SDK as `internal*RequestSchema` /
`internal*ResponseSchema`, and described in
[`openapi.yaml`](../api/transport/openapi.yaml). Parse with `safeParse` and
answer 400 with `{ error: { message } }` on a bad body, 502 with the
platform's own words on a refused send. The core keeps your verdict (a 409
reaches the dashboard as a conflict) and turns anything else into
`service_unavailable`.

A platform that lacks an action does **not** implement the endpoint with an
"unsupported" answer. A menu-less platform never receives menu calls because
it never publishes `transport.reaction`; a reaction-less platform simply hosts
no reaction tool. The contract carries no capability flags.

## Step 6 — The MCP server

Reference: [src/mcp.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/mcp.ts),
[src/reactions.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/reactions.ts).

Serve an `McpServer` at the `mcpPath` you announced, with `serveMcp` from the
SDK: one server instance per request, no session ids — every call carries its
whole context, so nothing is worth keeping alive between calls and nothing
needs reconciling after a restart.

The core provisions a **managed tool connection** for you: slug = your source
id, endpoint = `baseUrl + mcpPath`, auth header = the shared token, app scope
= your source, every assistant. Its snapshot follows the code: the reconcile
runs at core boot and again on every registration, discovers your tools and
applies them without an operator pressing Apply. Your tools reach the model as
`<source>__<tool>` (`tg__reply_to_message`) and only on your platform's turns.
The operator can still disable the connection or restrict its assistants on
the Tools page; identity and endpoint are refused as edits.

### The turn binding

A hosted tool has no ambient turn, and the model must not be handed one as an
argument — otherwise it could aim an action at a chat nobody invited it into.
The core attaches the binding to every call as request `_meta` under the key
`assistant-hub/turn` (`TURN_META_KEY`); read it with `readTurnMeta(extra._meta)`
and **refuse** when it is absent or names another source:

| Field | Meaning |
| --- | --- |
| `source`, `chatId`, `assistantId` | where and as whom the tool acts |
| `threadId` | sub-thread, when the chat has them |
| `replyToSourceMessageId` | the message this turn is answering |
| `correlationId` | the turn's trace correlation, so your work joins it |
| `userId`, `senderIsOwner` | the speaker and their owner rights |
| `deliveryKind` | `reply` (a task triggered by a message answers it), `send` (a timed fire speaks unprompted), or null (an ordinary reply turn delivers its own text and is offered neither) |

The core withholds the delivery tool that does not match `deliveryKind`;
check it on your side as well, so a call that arrives anyway cannot smuggle a
send into the wrong turn. Telegram's three tools:

| Tool | Does | Refuses when |
| --- | --- | --- |
| `reply_to_message` | sends `text` attached to `replyToSourceMessageId` | `deliveryKind !== "reply"` |
| `send_message` | sends `text` standalone | `deliveryKind !== "send"` |
| `set_message_reaction` | sets or clears the bot's reaction badge on `message_id` | the id is not in the mirror, the message is the bot's own, or the platform refuses |

Every delivery tool reports its outcome in `structuredContent` with
`toolDeliveryResult({ ok, sourceMessageId, text })` under the key `delivery` — the
core learns that a send happened from the **result shape**, never from the
tool's name, so a task can stamp its wording and a fire can count what
actually reached the chat. A refused send is reported as a delivery that did
**not** happen (`ok: false`, `isError: true`) with the platform's reason in
words the model can act on, so it never claims its words reached anyone.

Tool descriptions self-describe and name no other tool; the system prompt
lists no tools at all. Keep refusal texts actionable ("look the message up
again and use an id from the result").

### Asking the core before acting

Your tools may need the core's mirror: `set_message_reaction` asks
`GET /api/internal/transports/messages?source=&chatId=&sourceMessageId=&assistantId=&direct=`
→ `{ found, role, assistantId }` before touching the platform, so a guessed
id or the bot's own message is refused without a call
([src/core-client.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/core-client.ts)).

## Step 7 — Synchronous calls back into the core

Most traffic is asynchronous (queue and bus). Two things need an answer:

| Call | When | Answer |
| --- | --- | --- |
| `POST /api/internal/transports/callback` with `transportCallbackRequestSchema` `{ source, assistantId, chat, user, menuSourceMessageId, data }` | a feedback-menu button was pressed — the platform's spinner wants a toast only the flow's outcome can word | `{ toast \| null }` — answer the platform's callback query with it |
| `PATCH /api/internal/transports/<id>/config` with a partial blob | you resolved something worth persisting in your transport-level config (shallow merge; the keys are yours) | `{ config }` |

## Step 8 — Traces and live refresh

Tracing is unified and core-owned; a transport never writes trace rows.
`busTraceClient(<id>, publisher)` gives you a recorder: `startTrace({ feature,
action, assistantId, trigger: { kind, actor, correlationId }, inputSummary })`,
then `event(...)`, then one of `succeed`/`skip`/`fail`. The whole trace is
published on settle as one `trace.recorded` event, and the core persists it
into the single trace store the Debug explorer reads. A recorder you never
settle publishes nothing — that is how plain mirrored chatter leaves no trace.

Two conventions make your traces line up with the core's rather than sitting
apart from them:

- **`feature`** is one of the core's registered feature ids so the Debug
  filter groups you. `bot-messaging` is the one a delivery belongs to; an id
  the core does not know lands under "Other", which is where an operator will
  not look for it.
- **`trigger`** is `{ kind: "transport", actor: <a scoped ref>, correlationId:
  <the turn's> }`. The actor is a ref (`signal:user:123`, or the chat's when
  there is no sender) because the Debug facet and the analytics user filter
  match it exactly, and two platforms can hand out the same number. Take
  `correlationId` from the event you are acting on — never invent one — and
  your trace lands next to the core's for the same turn.

Event `message` is a clean human title; `type` and `level` come from the
shared enums. Bodies are complete and raw — the only exception is binary
blobs.

Live dashboard updates: publish `dashboardRefresh(<id>, [topics])` on the bus
whenever you change what a page shows. The core bridges it onto its SSE
layer; unknown topic names ping nothing. The transport's own topic is
`status`; the ingest publishes `history`, `users`, `groups` for the rows it
writes, so you do not.

## Step 9 — Ship an image

A transport is delivered as a container image. Nothing about it is special:
one process, one HTTP port, no database, no migrations, no volumes.

**Dockerfile.** Install dependencies, copy your source, install whatever
system packages your platform needs (Telegram's needs `ffmpeg` for video frame
sampling; `sharp`, which the SDK brings for image normalization, ships its own
libvips), run as a non-root user, and start your entrypoint. Commit the
`.npmrc` line for the scope and mount the registry token as a **BuildKit
secret**, appended and deleted inside the same layer so nothing about it
survives in the image:

```dockerfile
COPY package.json .npmrc ./
RUN --mount=type=secret,id=npm_token     set -eu;     printf '//npm.pkg.github.com/:_authToken=%s
' "$(cat /run/secrets/npm_token)" >> .npmrc;     npm install --no-audit --no-fund;     rm -f .npmrc
```

**Publish it** wherever the operator can pull from — a container registry of
your own, or your repository's (`ghcr.io/<you>/<repo>`). Tag a real version
rather than only `latest`, so an operator can pin one. The Telegram and
Discord transports are released by their own repositories' workflows, on the
same shape as this repo's [release workflow](../../.github/workflows/release.yml):
a version field that changed on `main` is a release.

**What the operator adds.** One service in their `docker-compose.yml`, and
nothing else:

```yaml
  signal:
    image: ghcr.io/you/ahw-transport-signal:1.0.0
    depends_on:
      redis: { condition: service_healthy }
    environment:
      NODE_ENV: production
      PORT: 3220
      # The core will call you here — it is what you announce as baseUrl.
      SELF_URL: http://signal:3220
      REDIS_URL: redis://redis:6379
      CORE_API_URL: http://app:3200
      INTERNAL_API_TOKEN: ${INTERNAL_API_TOKEN:-change-me}
      TZ: ${TZ:-UTC}
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3220/health >/dev/null 2>&1 || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s
    restart: unless-stopped
```

Two things not to ask of them: **do not publish your port** (the internal API
is the core's alone), and **do not add yourself to the core's `depends_on`**.
The core's service depends on no transport at all — it boots without any and
picks each one up when it registers — so a dependency edge would only make
their startup order your problem. The operator-side version of this recipe,
with the mistakes worth avoiding, is
[Adding a transport](../operations/deployment.md#adding-a-transport).

**Local development.** Run a core with its Redis and Postgres (this repo's
compose does), point `REDIS_URL`, `CORE_API_URL` and `INTERNAL_API_TOKEN` at
it, and start your service on the host. Registration, the reconcile and the
bus subscriptions all run at boot, so restart your service after a code change
before judging a live check — a file watcher will not re-run them.

## Step 10 — Verify

Against a running core, in this order — each step proves the one before it
reached the right place:

1. Core log: `transport '<id>' registered from http://…`; yours: registered,
   with the number of connections desired.
2. Assistants page → edit an assistant: a "<Name> connection" section renders
   your announced fields. Connect; the section shows **Running** with the
   platform identity, fed by your `/health`.
3. Tools page: a managed connection `<id>` listing your tools, discovered at
   registration without anyone pressing Apply.
4. Send a direct message to the bot. Debug → filter Bot messaging: an
   `inbound` trace (the ingest), a `reply` trace (the turn), and your
   `deliver` trace, all on one correlation id.
5. History page shows the mirrored exchange, and the transcript's `#<id>`
   citations resolve.
6. Stop the connection in the editor: yours stops within one reconcile; start
   it again; change the secret: it restarts with the new one.
7. Kill your service: the editor shows **Not tracked** ("is the transport
   service running?"); start it: registration retries until the core answers.

Before any of that, prove your shapes offline: every event and body is in
[`events.schema.json`](../api/transport/events.schema.json), so a schema
validator over your own fixtures catches a malformed event in a unit test
rather than in a queue that drops the job. The seams worth pinning are the
ones the Telegram transport pins: one event per platform update (with dedupe
and per-assistant streams), the structural addressing verdicts and their
reasons, and the split-and-send path
([src/inbound.test.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/inbound.test.ts),
[addressing.test.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/addressing.test.ts),
[send.test.ts](https://github.com/assistant-hub-swarm/ahw-transport-telegram/blob/main/src/send.test.ts)).

## Reference: the worked example, duty by duty

[The Telegram transport](https://github.com/assistant-hub-swarm/ahw-transport-telegram),
as the files that carry each duty. It is a separate repository on the published
SDK — the same position yours will be in — so it is worth reading as a whole
once, not only per step.

| Duty | File |
| --- | --- |
| Boot order, shutdown | `src/index.ts` |
| Registration, desired-state fetch, retry | `src/desired-state.ts` |
| Poller lifecycle, reconcile, supervision, update handlers | `src/bot-manager.ts` |
| Normalizing a message into `transport.message`, media, receivers | `src/inbound.ts`, `src/media/*` |
| Structural addressing verdicts | `src/addressing.ts` |
| Queue publisher, envelope, seen-cache | `src/updates.ts` |
| The one send: split under the cap, each part sent and reported as `message.delivered` | `src/send.ts`, `src/split.ts` |
| Bus consumer: reply delivery, typing loops, deliver trace | `src/delivery.ts` |
| Platform sends (HTML render, link whitelist, files by mime, menus, reactions) | `src/outbound.ts`, `src/telegram-html.ts`, `src/telegram.ts` |
| HTTP surface: health, `/internal/*`, `/mcp` | `src/api.ts` |
| MCP tools and the turn binding | `src/mcp.ts`, `src/reactions.ts` |
| Calls into the core (callback toast, mirror lookup) | `src/core-client.ts` |
| Running-connection roster | `src/connections.ts` |

## What the dashboard shows for your transport

Nothing in the core is keyed by a platform literal: every surface that names
a source walks the registration table, and every surface that names a chat
or a person speaks a scoped ref (`<source>:chat:<id>`, `<source>:user:<id>`)
or a `(source, local id)` pair. Once your transport has registered and its
events land, an operator sees it everywhere a Telegram deployment does:

| Surface | What it reads |
| --- | --- |
| Overview and the shell's Bot status | Every registered transport's roster (`/health` per transport); one start/stop block per transport, titled with the name you announced |
| History, search, summaries, memory extraction, analytics | The conversation store across every transport on this core's contract major; chats are addressed by ref (`/history/<ref>`, `?chatRef=`, `?userRef=`) |
| Users and Groups, and their curated edits (aliases, notes, languages) | Each transport's own `source_users` / `source_chats` rows, by ref |
| Vision gallery and backfill | Every transport's `source_media`, tagged with your announced name |
| Tasks | Chats are picked by ref across every transport; a timed fire binds its tool context to the task's chat's transport, so `send_message` is yours |
| Memory, preferences, feedback, addressing exclusions | Keyed by refs in your namespace |
| Browser-agent runs | Deliver through the transport the run's chat ref names |

Two conventions your transport must follow for those surfaces to work:

- **A group is a chat you report as not direct.** The ingest stores a
  `source_chats` row for groups only, and that row is the core's whole notion
  of "this is a group" — no id shape is inspected. A direct chat's
  participants are the people who have messaged in it.
- **Message ids are text.** The core never converts them to numbers (a
  64-bit snowflake would not survive it), and it anchors transcripts and
  citations by them (`#<id>`). Turn correlation ids are
  `<chatRef>:<sourceMessageId>` — the chat's ref, so your turns can never be
  confused with another platform's chat that happens to share an id.

If you find a surface that shows Telegram and not you, that is a core bug —
file it against the "Transport SDK" entry in `docs/TODO.md`.
