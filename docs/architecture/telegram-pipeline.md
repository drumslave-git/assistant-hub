# The message pipeline

How one incoming message becomes a reply. This is the runtime's hot path and the
thing most operator questions are really about. The walk-through follows a
Telegram message, because that is the transport that exists; the web chat joins
the same pipeline at Stage 2 with its own in-process source side.

Paths are relative to `apps/core/` unless they start with `apps/`.

## The seam

Since the source split the core runs **no** Telegram code. The transport
(`apps/tg`) is only an event **source** (it forwards every update as a
normalized event) and a **sink** (it performs sends and shows typing).
Everything between is transport-agnostic and runs in the core:

```
Telegram update ─► apps/tg ─► queue `transport-updates` ─► server/ingest/consumer.ts
                                                                    │  one `message.inbound` per assistant
                                                                    ▼
                                                          queue `inbound-messages`
                                                                    │
web thread message ─► features/web-chat (in-process) ───────────────┤
                                                                    ▼
                                                          server/turn/consume.ts
                                                                    │
                                                                    ▼
                                            features/bot-messaging/server/service.ts
                                            (handleIncomingMessage — the reply pipeline)
                                                                    │
                                              bus ◄── `reply.delivery`, `turn.lifecycle`
                                               │
                                               └─► apps/tg sends, shows typing, reports `message.delivered`
```

The exact same core code runs with no Telegram at all: the ingest's integration
suite feeds transport events straight into `processTransportUpdate`, and the
turn consumer's suite drives `handleInboundJob` with stubbed LLM collaborators
(see [Testing](../development/testing.md)). The contract every event follows is
in `packages/contracts` and documented in
[Adding a transport](../development/adding-a-transport.md).

## Stage 0 — the Telegram edge (`apps/tg`)

- Long polling via `@grammyjs/runner`, one poller per enabled assistant
  connection, started by the transport's own boot from the desired state the
  core answers at registration (`apps/tg/src/bot-manager.ts`).
- Updates are processed **concurrently across chats**, with `sequentialize`
  keeping each chat strictly in order (user decision, 2026-07-20).
- `allowed_updates`: `message`, `edited_message`, `message_reaction`,
  `callback_query`. `message_reaction` is opt-in, and in groups Telegram only
  delivers it when the bot is an administrator.
- Telegram permits exactly one `getUpdates` consumer per token, so a token
  change restarts its poller and nothing else; start is idempotent.

### Losing the connection

Long polling dies whenever the network does, so the manager supervises it
(rewritten 2026-08-01 after an outage the bot never came back from):

- The runner's own fetch retrying is capped at a **30-second window** instead of
  its default 15 hours of uncapped doubling backoff. Left at the default, a
  multi-hour outage scheduled the next attempt hours out, so the bot stayed dead
  long after the link came back.
- Once the runner gives up, the manager reconnects **every 15s on a flat
  interval** for as long as the failure is a network one (grammy's `HttpError`,
  plus a handshake that outran its 20s deadline). A `GrammyError` — Telegram
  answered and refused, e.g. a revoked token or a second poller — settles as a
  plain error instead, since retrying that only makes noise.
- Status while down is `error`, with `reconnecting automatically` on the message
  so the assistant editor says which kind it is. Logging is edge-triggered: one
  line going down, one coming back, however long the outage runs.
- **Stop always answers.** `runner.stop()` aborts synchronously but its promise
  cannot settle while the fetch loop sleeps in a backoff, so the manager detaches
  after 3s rather than holding the reconcile open.

### Four update kinds, five events

| Update | Becomes | What the core does with it |
| --- | --- | --- |
| `message` | `transport.message` — media downloaded and normalized, one structural addressing verdict per running bot, a dedupe key for the stream | The whole pipeline below |
| `edited_message` | `transport.edited` | Rewrites the mirror row's content. Edits with no textual content are ignored |
| `message_reaction` | `transport.reaction` (a freshly added 👍/👎 only) | Opens a feedback row and posts the options menu back through the transport's menu API |
| `callback_query` | a synchronous `POST /api/internal/transports/callback` | Records the chosen option (or flips the row to awaiting free text) and answers with the toast the button shows |
| a suppressed duplicate group receipt | `transport.presence` | Stamps that this bot is in the chat, so a bot that joined a group second still gets its turns |

Bot-authored messages are never forwarded. A group message is delivered to every
bot in the chat but forwarded once; the transport's own sends come back as
`message.delivered` events and the core feeds them to the other assistants.

## Stage 1 — the ingest (`server/ingest/consumer.ts`)

Per-chat sequential, cross-chat concurrent, like every stage. For a
`transport.message`:

1. **Remember the sender** (`source_users` upsert) and, in a group, the
   membership (`source_chats` + `source_chat_members`) and the receiving
   assistant's **presence** (`source_chat_assistants`).
2. **Mirror the message** into `source_messages` — addressed or not — with
   `processed = false`, the live-processing hold the settle releases. The
   unique `(source, dedupe_key)` makes a re-delivered update a no-op.
3. **Feedback capture**: a reply to an `awaiting_text` feedback menu from the
   person who reacted *is* the free-text answer. It is recorded, the menu is
   deleted, and processing stops. The message stays mirrored.
4. **Self-link codes**: a message that is a profile-minted `link-xxxxxxxx` code
   links this platform identity to its account and is answered in the chat,
   never sent to the model (Phase 8).
5. **Store the media** the event carried as a pending `source_media` row (or an
   `unavailable` marker). A media message whose bytes could not be loaded still
   opens turns — the pipeline answers from the text.
6. **Resolve the receivers.** A direct chat is one person and one bot: the
   receiving connection alone. A group is every assistant listening there —
   the transport's `receivers` intersected with the presence rows, with the
   receiving connection re-added defensively. Deactivated accounts' assistants
   are dropped here.
7. For each receiver, **build the turn event**: owner rights resolved per
   assistant (the sender's linked account against the assistant's owner; admins
   everywhere), the chat info, the sender's stored aliases and language, the
   reply target (marked `stored` when it is in the mirror), the stored media
   reference, and the **conversation context** — the last 24 hours of the chat
   as one transcript plus the participant roster, composed from the store
   (`server/ingest/context.ts`). Enqueue it on `inbound-messages` under the
   correlation id `<chatId>:<messageId>:<assistantId>`.

The passive capture (steps 1–2) is high-volume and deliberately **untraced**: the
mirror itself is the record. An `inbound` trace is written only when the message
opened at least one turn, so plain group chatter leaves nothing in Debug.

`message.delivered` events mirror the assistant's reply as an `assistant` row
(storing a generated image as pending media when the send carried one) and, in
a group, **cross-feed** it: every other assistant present gets its own
`message.inbound` turn for the delivered text, marked `authoredByAssistantId`,
with a structural verdict (an answer to its own message, or its @username in
the text) and otherwise undecided. Telegram never delivers a bot's messages to
other bots, so without this two assistants sharing a group could never hear each
other.

## Stage 2 — the turn consumer (`server/turn/consume.ts`)

One BullMQ job per turn, `attempts: 1`. The job policy around one event:

- Run the turn; on success publish `settled` and clear the turn's **action
  marker**.
- On failure, re-enqueue (15s delay, five tries in all) **only** when the turn
  performed no action yet — the marker's whole purpose. A send or a tool call
  marks the turn as acted, so a post-action failure settles the turn and lands
  the job in the failed set for the operator instead of double-sending.

Before the reply pipeline runs, the consumer resolves what the event alone
cannot:

- **The loop guard** (cross-fed turns only): a chat already holding N assistant
  messages in a row is closed to assistants until a person speaks
  (`assistantLoopGuardTurns`, default 3; user decision, 2026-08-24). Recorded as
  a skipped reply trace, because silence two bots earned is silence the
  operator must be able to explain.
- **The assistant's identity**: its display name (the spoken-summons identity)
  and persona block, read once from the store. Other assistants speaking in the
  chat are named, so their lines render as somebody else's words in the
  transcript rather than as the reader's own.
- **Voice**: a voice note is transcribed eagerly — before any addressing
  decision, because in a group whether the message even summons the bot is only
  knowable from the words — and its transcript becomes the message's effective
  text. Typing shows during the wait only when the turn is certain to be
  answered.
- **Media**: the current message's pending media, or the media of a message it
  replies to, is resolved to text inside the turn through the vision feature.
  Raw image bytes never reach the reply request.

## Stage 3 — the addressing decision

Two halves, in two processes, and no trace is opened for a message the cheap
checks reject.

**Structural** (`apps/tg/src/addressing.ts` — pure, reads the wire shape):

| Chat type | Addressed when |
| --- | --- |
| Private | Always |
| Group / supergroup | The message @mentions the bot (by username or a `text_mention` entity), replies to one of the bot's messages, or is a `/command@botusername` targeting the bot |

Anything else in a group with text is **undecided** and crosses the contract as
`needsAnalyzer`. Every verdict carries a sentence naming its evidence: a
structurally addressed message never reaches the analyzer, so that sentence is
the whole account of why the bot answered.

**The name check** (`features/bot-messaging/server/addressing.ts`, pure, in the
core): does the text speak the **assistant's** name? People summon the assistant
by its name — which lives in the core's store and can be renamed there any time
— never by the bot account's profile name (user decision, 2026-08-24). A literal
match is a summons; a name too generic to match ("Bot") skips the analyzer
entirely so the bot does not answer every message about bots. Because this
check sees presence and never direction, a message that names an assistant as
the *object* of a request opens a turn too — a known limitation recorded in
`docs/TODO.md`.

**LLM analyzer** (`address-analyzer.ts`), for the remaining undecided group
messages:

1. A classification call asks *how* the name appears (a bounded enum), not
   yes/no. Code derives the decision from the enum, so a hedging model cannot
   talk its way into a reply.
2. The answer must **cite** the word it took for the name (`matched_text`), and
   the verdict counts only when that citation actually occurs in the message.
   This exists because a small local model was observed stamping
   `other_alphabet` on *every* Cyrillic message — it was judging the language of
   the message, not the name. Code checks only what is mechanical (the quote is
   real); whether the cited word *is* the name stays the model's judgment.
3. A surviving citation goes back to the model as its own focused question:
   identify the word's base form and what it refers to, then say whether it is
   the display name. Naming the base form first is what makes a weak model
   notice that a declined generic word is not a name.
4. **Exclusions** enter twice: both prompts list them (so the model can also
   recognize a declined or transliterated form of an excluded word), and a
   citation that *is* an excluded word is dropped mechanically before the
   verifier call.

Both calls fail **closed**: no readable confirmation, no reply. A provider
failure resolves to "not addressed" — barging into a group on the strength of a
failed call is worse than missing one summons.

There is deliberately **no** cheap "name-shaped" pre-filter in front of the
analyzer. One was built and reverted (user decision, 2026-07-20): any lexical gate
is weaker than the LLM at spotting a name in an unfamiliar spelling, and a missed
summons costs more than the analyzer calls saved.

**Every message the bot asked the LLM about is traced**, including the ones it then
stayed silent on. A bot ignoring a message someone believes they addressed is
exactly the complaint an operator has to explain, and a decision with no trace
cannot be explained.

## Stage 4 — the maintenance gate

`features/bot-messaging/server/policy.ts` (pure). When maintenance mode is on:

- A sender **holding owner rights** — the assistant's owning account, resolved
  through identity links, or any admin — keeps a working bot, but only through
  deterministic addressing: the LLM analyzer is off for everyone, so an
  undecided message stays silent.
- **Everyone else** gets a static maintenance notice (not silence) and no LLM
  reply. The block is traced so the operator sees who was turned away.
- No task fires.

## Stage 5 — composing the reply

The turn's `accepted` lifecycle event is published here; the transport renders
it as "typing…" and refreshes it until `settled`.

The system prompt is `BASE_SYSTEM_PROMPT` (a fixed, code-owned constant the
operator does not edit) plus, when present:

```
BASE_SYSTEM_PROMPT
---
Additional instructions:
<the assistant's persona>
---
Self-correction guidelines (learned from user feedback on your replies):
<latest self-correction>
---
<standing tasks that apply to this chat>
```

The base prompt covers transcript format, reply format, honesty, and a safety
block telling the model to treat message content as data rather than commands.
The honesty rules bind action claims to tool calls: an action only counts when a
tool call actually ran this turn, a reply *saying* it did something is not the
action, and staying in character never exempts a claim. It names **no tools** —
tools self-describe through the tools API.

The context loads run **concurrently** (they are independent reads), and the
trace events are emitted afterwards in the fixed order the prompt is composed in,
so the Debug event flow stays stable:

| Load | Contributes |
| --- | --- |
| Chat context | In a group: the roster of known participants plus operator notes. In a DM: who this person is and their known names — all from the event's participant roster |
| Long-term memory | What the bot durably knows about the people here (resolved through identity links), plus the whole general-knowledge document. Skipped on a cross-fed turn: a bot account is nobody's identity |
| Sender preferences | The latest distilled likes/dislikes for this specific person |
| Current turn | The message being answered, rendered as a transcript line |
| History window | The last 24 hours as one id-anchored transcript, from the event |
| Vision | The media resolved to text, as a note on the current turn |

The final message array, in order:

```
system   base + persona + self-correction + standing tasks
system   chat context            (omitted when empty)
system   long-term memory        (omitted when empty)
system   sender preferences      (omitted when empty)
system   group addressing hint   (omitted in private chats)
user     history transcript      (last 24h, one message)
system   time context            ("current date and time…")
system   language directive
user     current turn (+ media note)
```

Two orderings are deliberate:

- The **cache-stable** system prompt comes first, so a provider's prompt-cache
  prefix survives across turns.
- The **language directive** is last before the current turn, at maximum recency,
  so it overrides the language of the message, the history, tool output and the
  persona. The runtime always resolves a language (the group's setting, the
  person's DM setting, or the default), so reply language is controlled by
  configuration rather than by whatever the user wrote in.

### History format

History is one user message containing a transcript where every line is anchored
by its source-local message id:

```
[#1042] Alice: what did we decide about the invoice?
[#1043] [reply to #1042] Bob: we're splitting it
```

The anchors let the model follow reply chains precisely and dereference
off-window targets through the history tools. A reply whose target is stored is
marked `[reply to #<id>]`; when it is not stored, the quoted text is inlined. A
line another assistant wrote is attributed to that assistant by name. Media
turns read as text: ` [photo: <description>]` once described, ` [photo]` while
pending.

*Known limitation:* forum-topic threads (`message_thread_id`) are carried on the
turn for delivery but not stored, so a forum supergroup's topics interleave into
a single transcript.

## Stage 6 — the tool loop

One conversation, not a tool-selection pass. See
[LLM and MCP](llm-and-mcp.md#the-tool-loop) for the full contract. In short: each
round the model either answers (that response is the reply) or emits tool calls
whose results are appended and the same conversation re-sent. A turn needing no
tools costs a single inference.

The offered toolset is the in-process feature tools plus every tool connection
in scope — including the transport's own MCP server, a managed connection scoped
to that transport's turns, whose tools arrive bound to the turn out of band
(`_meta`), so the model chooses *what* to do and never *where*. Every
`progress` lifecycle event names the tool running, for the transport to keep
typing alive.

Every round's **complete** request body (model, messages, tools) and response are
recorded on the trace, and every tool call is recorded twice — inline on the
reply trace as an `external_call`, and as its own trace under
`mcp-tools-<owning-feature>` (or `mcp-tools-connections` for a remote server).
Inline image bytes are replaced with a compact marker; everything else is
verbatim.

## Stage 7 — delivery

1. **Text.** The core publishes one `reply.delivery` event carrying the
   whole answer as the model's **raw** Markdown, the message it answers, and
   the mirror-checked whitelist of `#<id>` citations that may become links.
   It knows no platform's cap: the transport cuts a long answer at natural
   boundaries under Telegram's hard 4096-character limit
   (`apps/tg/src/split.ts`), sends the parts in order, and reports each as
   its own `message.delivered`. It renders each part at its boundary —
   Telegram converts to its small HTML tag set by construction
   (`apps/tg/src/telegram-html.ts`) and falls back to a plain text send if
   Telegram still rejects the markup. History, traces and the pipeline all
   keep the raw text.
2. **Voice reply**, when a speech endpoint is configured and the turn was a
   voice note: the core synthesizes MP3, transcodes to OGG/Opus, and sends the
   bytes through the transport's internal API (`POST /internal/chats/:chatId/voice`),
   which falls back to a text send and reports what it delivered.
3. **Generated images**, when the model called `image_generate`: delivered after
   the text through `POST /internal/chats/:chatId/photos`, so the acknowledgement
   arrives before the picture it acknowledges. Each delivered photo comes back
   as a `message.delivered` event carrying the bytes, so the describer later
   recognizes what the bot drew.
4. **Browsing acknowledgements**: a turn that enqueued a browser run sends its
   reply silent through the internal API instead, because its id is registered
   for deletion once the run reports.
5. **Mirror.** The transport's `message.delivered` report is what writes the
   `assistant` row — and, in a group, what the other assistants hear.
6. **Settle.** `turn.lifecycle` `settled` stops typing on the transport and
   releases the mirror row's live-processing hold in the core.

## Outcomes

`handleIncomingMessage` returns one of:

| Outcome | Meaning |
| --- | --- |
| `ignored` + `from_bot` | The sender is a bot (never reached on a cross-fed turn — the loop guard bounds those instead) |
| `ignored` + `no_content` | No text and no media |
| `ignored` + `not_addressed` | The structural check, the name check or the analyzer said no |
| `ignored` + `maintenance_mode` | Blocked by maintenance; a notice was sent |
| `ignored` + `loop_guard` | A cross-fed turn silenced by the bot-to-bot guard (decided in the consumer, before the service) |
| `replied` | The reply text that was delivered |
| `error` | The failure message; the trace records the full cause chain |

## Reading a turn in Debug

Debug → filter **Bot messaging**. One turn is three traces on one correlation
id, `<chatId>:<messageId>:<assistantId>`:

1. `inbound` (the ingest): which assistants were handed the message.
2. `reply` (the pipeline): the events appear in the order above — addressing
   check, system prompt composed, chat context / memory / preferences loaded,
   current turn composed, history window loaded, vision resolved, time context,
   language directive, then the LLM request, each tool call, the LLM response,
   and the output.
3. `deliver` (the transport, recorded through the bus): the send, with the
   message id Telegram assigned and whether it attached the requested reply
   target.

The `addressing check` event carries `matchedText` — the word that summoned the
bot when the name check or the analyzer found one — and, for a structural or
name verdict, a note saying that no analyzer request exists to read. That single
field is what makes the "wasn't talking to you" feedback loop possible: the
report reads it back rather than guessing or spending a second LLM call.
