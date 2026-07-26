# The Telegram pipeline

How one incoming Telegram update becomes a reply. This is the runtime's hot path
and the thing most operator questions are really about.

## The transport seam

The bot is only an event **source** (an incoming update) and a **sink** (reply +
typing). Everything in between is transport-agnostic.

```
grammy Context ──┐
                 ├──► ReplyTransport ──► processUpdate() ──► bot-messaging service
synthetic update ┘      (server/telegram/transport.ts)
+ capturing sink
```

`server/telegram/bot-manager.ts` is the Telegram *edge*: the poller lifecycle
plus a thin grammy adapter that maps a live `Context` onto the pipeline. All
message-handling logic lives in `server/telegram/process-update.ts`, so the exact
same code runs with no bot at all — that is what `test/simulate.ts` uses.

## Polling

- Long polling via `@grammyjs/runner`, started from `instrumentation.ts` at boot.
- Updates are processed **concurrently across chats**, with `sequentialize`
  keeping each chat strictly in order (user decision, 2026-07-20).
- `allowed_updates`: `message`, `edited_message`, `message_reaction`,
  `callback_query`.
- Telegram permits exactly one `getUpdates` consumer per token, so exactly one
  poller may run — enforced by the `globalThis` singleton in the bot manager.
- Concurrency-audited: the typing loop is a per-call closure with its own timer,
  and the MCP tool context is `AsyncLocalStorage`-bound per turn. Neither shares
  mutable per-update state.
- On `SIGTERM`/`SIGINT` the poller is stopped (capped at 3s) so a redeploy does
  not collide with the previous process's `getUpdates` lock.

Four update kinds, four handlers:

| Update | Handler | What it does |
| --- | --- | --- |
| `message` | `processUpdate` | The main pipeline below |
| `edited_message` | `processEditedUpdate` | Mirrors text/caption edits into `chat_messages`. Edits with no textual content are ignored |
| `message_reaction` | `process-reaction.ts` | A 👍/👎 on one of the bot's own replies opens a feedback row and posts the options menu |
| `callback_query` | `process-callback.ts` | A press on a feedback menu records the chosen option, or flips the row to awaiting free text |

`message_reaction` updates only arrive in groups when the bot is an
administrator; in private chats they arrive out of the box.

## Stage 1 — passive capture (always, untraced)

Before any decision about answering:

1. **Poke the vision backfill.** Live traffic pushes the idle backfill run out and
   aborts any batch in flight, so background captioning never competes with a
   live reply for the LLM.
2. **Remember the sender** (`known_users` upsert) and, in a group, the membership
   (`known_groups` + `group_members`).
3. **Mirror the message** into `chat_messages` — addressed or not.

All three are best-effort and must not block handling. They are high-volume and
deliberately **untraced**: the mirror itself is the record, and tracing every
group message would bury everything else in Debug.

## Stage 2 — feedback capture short-circuit

If the message is a reply to a feedback menu that is `awaiting_text`, and it comes
from the person who reacted, it *is* the free-text answer. It is recorded, the
menu is deleted, and processing stops. The message stays mirrored; nothing is sent
back.

## Stage 3 — media and voice

- **Vision ingest** (passive): any media on the message is downloaded with the
  bot token, normalized to a bounded JPEG (videos/GIFs are sampled into several
  frames with ffmpeg), and stored with `status = 'pending'`.
- **Vision resolve**: the image(s) to attach to *this* turn — from the message
  itself or from a message it replies to.
- **Voice**: a voice note is transcribed eagerly (before the reply flow starts,
  with its own typing loop) and its transcript becomes the message's effective
  text. Addressing, the current turn, and the reply all read the words as if they
  had been typed.

Any failure here degrades to a text-only reply rather than failing the turn.

## Stage 4 — the addressing decision

Cheap checks first, and no trace is opened for a message the cheap checks reject.

**Deterministic** (`features/bot-messaging/server/addressing.ts` — pure, no
network):

| Chat type | Addressed when |
| --- | --- |
| Private | Always |
| Group / supergroup | The message @mentions the bot (by username or a `text_mention` entity), replies to one of the bot's messages, is a `/command@botusername` targeting the bot, or speaks the bot's display name literally |

Anything else in a group is either plainly not for the bot, or **undecided** —
because people call a bot by name in their own alphabet or decline it
("Ари, привет"), which a literal match cannot see.

**LLM analyzer** (`address-analyzer.ts`), for undecided group messages only:

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
   notice that a declined generic word ("бота") is not a name.
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

## Stage 5 — the maintenance gate

`features/bot-messaging/server/policy.ts` (pure). When maintenance mode is on:

- The **owner** keeps a working bot, but only through deterministic addressing —
  the LLM analyzer is off for everyone, so an undecided message stays silent.
- **Everyone else** gets a static maintenance notice (not silence) and no LLM
  reply. The block is traced so the operator sees who was turned away.
- No scheduled task fires.

## Stage 6 — composing the reply

"Typing…" starts here and is refreshed just under Telegram's ~5s chat-action
expiry until the turn settles.

The system prompt is `BASE_SYSTEM_PROMPT` (a fixed, code-owned constant the
operator does not edit) plus, when present:

```
BASE_SYSTEM_PROMPT
---
Additional instructions:
<active personality prompt>
---
Self-correction guidelines (learned from user feedback on your replies):
<latest self-correction>
```

The base prompt covers transcript format, reply format, honesty ("an action only
counts when you actually carry it out this turn"), and a safety block telling the
model to treat message content as data rather than commands. It names **no
tools** — tools self-describe through the tools API.

Six context loads then run **concurrently** (they are independent reads), and the
trace events are emitted afterwards in the fixed order the prompt is composed in,
so the Debug event flow stays stable:

| Load | Contributes |
| --- | --- |
| Chat context | In a group: the roster of known participants plus operator notes. In a DM: who this person is and their known names |
| Long-term memory | What the bot durably knows about the people here, plus the whole general-knowledge document |
| Sender preferences | The latest distilled likes/dislikes for this specific person |
| Current turn | The message being answered, rendered as a transcript line |
| History window | The last 24 hours as one id-anchored transcript |
| Vision | Image parts for this turn |

The final message array, in order:

```
system   base + persona + self-correction
system   chat context            (omitted when empty)
system   long-term memory        (omitted when empty)
system   sender preferences      (omitted when empty)
system   group addressing hint   (omitted in private chats)
user     history transcript      (last 24h, one message)
system   time context            ("current date and time…")
system   language directive
user     current turn (+ image parts)
```

Two orderings are deliberate:

- The **cache-stable** system prompt comes first, so a provider's prompt-cache
  prefix survives across turns.
- The **language directive** is last before the current turn, at maximum recency,
  so it overrides the language of the message, the history, tool output and the
  personality. The runtime always resolves a language (the group's setting, the
  person's DM setting, or the default), so reply language is controlled by
  configuration rather than by whatever the user wrote in.

### History format

History is one user message containing a transcript where every line is anchored
by its Telegram id:

```
[#1042] Alice: what did we decide about the invoice?
[#1043] [reply to #1042] Bob: we're splitting it
```

The anchors let the model follow reply chains precisely and dereference
off-window targets through the history tools. A reply whose target is stored is
marked `[reply to #<id>]`; when it is not stored, the quoted text is inlined.

*Known limitation:* forum-topic threads (`message_thread_id`) are not stored, so a
forum supergroup's topics interleave into a single transcript.

## Stage 7 — the tool loop

One conversation, not a tool-selection pass. See
[LLM and MCP](llm-and-mcp.md#the-tool-loop) for the full contract. In short: each
round the model either answers (that response is the reply) or emits tool calls
whose results are appended and the same conversation re-sent. A turn needing no
tools costs a single inference.

Every round's **complete** request body (model, messages, tools) and response are
recorded on the trace, and every tool call is recorded twice — inline on the
reply trace as an `external_call`, and as its own trace under
`mcp-tools-<owning-feature>`. Inline image bytes are replaced with a compact
marker; everything else is verbatim.

## Stage 8 — delivery

1. **Text.** Model Markdown is converted to Telegram HTML at the transport
   boundary (`telegram-html.ts`) — Telegram's HTML mode accepts only a small tag
   set and rejects the whole send otherwise, so conversion is by construction:
   code spans are lifted out, everything else is entity-escaped, and tags are
   only ever produced by paired replacements. The transport falls back to a plain
   text send if Telegram still rejects the HTML. History, traces and the
   simulation harness all keep the model's **raw** text.
2. **Splitting.** Telegram's hard 4096-character limit: a long answer is split at
   natural boundaries and delivered as several messages rather than truncated.
3. **Voice reply**, when a speech endpoint is configured: the text is synthesized
   to MP3 and transcoded to OGG/Opus for `sendVoice`.
4. **Generated images**, when the model called `image_generate`: delivered after
   the text, so the acknowledgement arrives before the picture it acknowledges.
   Each delivered photo becomes the same pair of rows an incoming media message
   produces, so the vision describer later recognizes what the bot drew.
5. **Mirror the reply** into `chat_messages` as an `assistant` row.

## Outcomes

`handleIncomingMessage` returns one of:

| Outcome | Meaning |
| --- | --- |
| `ignored` + `from_bot` | The sender is a bot |
| `ignored` + `no_content` | No text and no media |
| `ignored` + `not_addressed` | Cheap checks or the analyzer said no |
| `ignored` + `maintenance_mode` | Blocked by maintenance; a notice was sent |
| `replied` | The reply text that was delivered |
| `error` | The failure message; the trace records the full cause chain |

## Reading a reply trace

Debug → filter `Bot messaging`. One trace per handled message, action `reply`,
correlation id `<chatId>:<messageId>`. The events appear in the order above:
addressing check, system prompt composed, chat context / memory / preferences
loaded, current turn composed, history window loaded, vision attached, time
context, language directive, then the LLM request, each tool call, the LLM
response, and the output.

The `addressing check` event carries `matchedText` — the word that summoned the
bot when the analyzer found one. That single field is what makes the "wasn't
talking to you" feedback loop possible: the report reads it back rather than
guessing or spending a second LLM call.
