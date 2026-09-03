# Bot messaging

**Feature id:** `bot-messaging` · **Trace actions:** `inbound` (the ingest),
`reply` (the turn), `deliver` (the send), `name-conversation` · **Dashboard:**
Overview (bot status card, per-connection Start/Stop)

The core: receive a message from a transport, decide whether to answer, compose
the context, run the model with tools, deliver the reply. Every other feature
either feeds this one or observes it.

The transport contract — what a source app forwards, what it consumes, and
which tools it hosts — is documented in
[Adding a transport](../development/adding-a-transport.md) and is not repeated
here. The stage-by-stage composition of a reply is in
[the message pipeline](../architecture/telegram-pipeline.md). This page covers
the feature's own modules, the two queue hops a turn crosses, configuration and
failure modes.

## Modules

| Module | Purity | Role |
| --- | --- | --- |
| `server/addressing.ts` | Pure | The name half of the deterministic addressing rules (`matchBotName`, `displayNameMatchable`) and the verdict shape |
| `server/address-analyzer.ts` | Prompt/parse pure, caller owns the call | The LLM half of the addressing check |
| `exclusions.ts` | Pure | The row shape plus the one normalization rule the feature agrees on |
| `server/exclusions-repository.ts` | Data access | Reads consumed by the analyzer; writes owned by self-improvement |
| `server/policy.ts` | Pure | The maintenance-mode decision over the event's `sender.isOwner` |
| `server/prompt.ts` | Pure | System-prompt composition, time context, group addressing hint |
| `server/reply-integrity.ts` | Pure | Is the answer a reply at all — the mechanical checks and the correction |
| `server/action-claim.ts` | Prompt/parse pure, caller owns the call | The honesty gate over a drafted reply |
| `addressing-trace.ts` | Pure | The addressing event's name and payload, shared by writer and reader |
| `server/service.ts` | The boundary | Addressing, policy, generation, delivery, tracing |
| `server/turn-bindings.ts` | Collaborators | The tool loop with the bound turn context, the standing-task match, the lent authority |
| `server/turn/consume.ts` | Core | The turn consumer: one inbound event in, deliveries and lifecycle out |
| `server/turn/loop-guard.ts` | Pure | The bot-to-bot loop guard |
| `server/turn/render.ts` | Pure | History window, chat context and current turn rendered from the event |
| `server/ingest/consumer.ts` | Core | The ingest stage: mirror, presence, fan-out |
| `ahw-transport-telegram/src/addressing.ts` | Transport, pure | The structural half of addressing (entities, replies, commands) |
| `ahw-transport-telegram/src/telegram-html.ts` | Transport, pure | Model Markdown → Telegram HTML |
| `ahw-transport-telegram/src/mcp.ts` | Transport | The reply, send and reaction tools |
| `ui/BotControl.tsx` | Client | Per-connection Start/Stop of the transport's pollers, live on the `status` topic |

Collaborators (reply generation, delivery, history load, vision load, analyzer)
are **injected** into the service, so the whole policy is unit-testable without
a live LLM or a transport — the turn consumer builds them from the inbound
event and the brain's services.

## How a turn arrives

A message crosses two queues before a model sees it:

1. The transport forwards **every** update it sees — addressed or not — as an
   event on the BullMQ queue `transport-updates` (`transport.message`,
   `transport.edited`, `transport.reaction`, `transport.bot-reaction`,
   `message.delivered`, `transport.presence`), media bytes attached.
2. The ingest (`server/ingest/consumer.ts`) consumes it **per chat
   sequentially, cross-chat concurrently**: it upserts the sender and the chat
   (`source_users`, `source_chats`, `source_chat_members`), stamps which
   assistant the platform delivered the chat's traffic to
   (`source_chat_assistants`), mirrors the message into `source_messages`
   with the live-processing hold (`processed = false`), stores the media as
   pending `source_media`, and then decides **who gets a turn**: the receiving
   connection alone in a direct chat; in a group, every running connection
   whose assistant is present there. A message that is a feedback-menu answer
   or a self-link code is consumed here and never opens a turn. Each turn is
   one `message.inbound` event on the inbound queue, correlated
   `<chatId>:<messageId>:<assistantId>`, carrying the conversation context
   (history window, roster, chat and sender info with `sender.isOwner`
   stamped) the source composed. When at least one turn opened, an `inbound`
   trace records it; plain mirrored chatter leaves nothing behind.
3. The turn consumer (`server/turn/consume.ts`) runs the turn: loop guard,
   the assistant's identity read once from the store (name and persona), the
   name half of addressing, eager voice transcription, the collaborators, then
   `handleIncomingMessage`. Deliveries leave as `reply.delivery` events and
   the turn's `accepted` / `progress` / `settled` lifecycle as
   `turn.lifecycle` events on the Redis channel `assistant-hub:events`; the
   owning source performs the send (or, for the web chat, stores the line
   in-process) and renders the lifecycle as typing.

Ordering is preserved within a chat by an in-process promise chain per chat
ref; eight chats run concurrently. A turn that fails **before performing any
action** is re-enqueued after 15 s, up to 5 tries; a turn that has already
acted — sent something, run a tool — is never re-run (`turn_actions` markers,
user decision 2026-08-22), so nothing double-sends or double-executes. The
service catches its own turn errors and delivers the error notice, which is an
action, so those turns are handled, not retried.

## Addressing

The deterministic check is split along the contract:

| Half | Where | Verdicts |
| --- | --- | --- |
| Structural — what the wire shape alone proves | The transport (`ahw-transport-telegram/src/addressing.ts`), per receiving bot | `private` (always), `reply` to one of this bot's messages, `/command@thisbot`, an @mention entity or literal `@username` |
| Name — does the text speak the **assistant's** name | The core (`server/turn/consume.ts` → `matchBotName`) | `name` on a literal match; a name too generic to match skips the analyzer entirely (a bot named "Bot" must not answer every message about bots) |

The transport never matches the assistant's display name: the name lives in
the core's store and can be renamed there any time, and people summon the
**assistant**, never the bot account's profile name (user decision,
2026-08-24). A group message the structural check cannot decide comes back
`needsAnalyzer`, and only then, after the name check, does the LLM analyzer
run. It:

1. classifies *how* the name appears using a bounded enum (not yes/no), so code
   derives the decision and a chatty model cannot talk its way into a reply;
2. must cite the word it took for the name, and the citation must really occur in
   the message;
3. survives a second, focused verifier call — identify the word's base form and
   what it refers to, then say whether it is the display name;
4. is overruled mechanically when the cited word is a known **exclusion**, and
   both prompts list the exclusions so the model can also recognize declined or
   transliterated forms of them.

Both calls fail closed. A provider failure resolves to "not addressed". A
voice message is transcribed first and the name check re-runs on the words: a
spoken name is as much a summons as a typed one.

**Most turns never reach the analyzer**, and the trace says so. A verdict from
a cheap check (`private`, `reply`, `mention`, `command`, `name`, `task`) is the
whole decision — there is no request or response in the trace because no model
was asked — so the Debug timeline renders a note under the verdict naming what
decided instead (`analyzerNote`, derived from the verdict so old traces explain
themselves too). Only an `analyzer` verdict has an exchange above it, and then
the note is absent. Without that line the missing exchange reads as missing
data rather than as "nothing was asked", which is a question the debug page
should answer rather than provoke.

Design constraints worth preserving:

- **No lexical pre-filter** in front of the analyzer. One was built and reverted
  (user decision, 2026-07-20): any lexical gate is weaker than the LLM at spotting
  a name in an unfamiliar spelling, and a missed summons costs more than the calls
  saved.
- **No linguistic heuristics anywhere** — no transliteration tables, no
  romanization folds, no phonetic matching. Code checks only mechanical facts.

## Shared chats: cross-fed turns and the loop guard

Several assistants can sit in one group. Every send a transport performs is
reported as `message.delivered`, and the ingest hands a delivered message to
the **other** assistants present in that chat as a cross-fed turn: the sender
is the authoring bot account, `authoredByAssistantId` names whose words they
are, and the structural verdict is recomputed from what remains (a reply to
one of the target's own messages, or its `@username` spelled in the text;
anything else goes to the name check and the analyzer). Silent sends and
direct chats are never cross-fed. In the prompt, another assistant's lines are
attributed by that assistant's **name** — never as "You", never as the bot
account's profile name (user decision, 2026-08-24) — and a cross-fed turn
reads no memory and no preferences: a bot account is nobody's identity.

Nothing on the platform stops two assistants from answering each other
forever, so the core does: once a chat holds `assistantLoopGuardTurns`
assistant-authored messages **in a row** (default 3, user decision
2026-08-24; `0` stops assistants from answering each other at all), every
assistant there stays silent until a person speaks again. Deterministic —
`server/turn/loop-guard.ts` counts the trailing run off the conversation
window the source composed, plus the incoming message — and only ever
reachable on a cross-fed turn. A silenced turn is recorded as a skipped reply
trace with the streak and the limit, because silence two bots earned is
silence an operator must be able to explain.

## Maintenance mode

`settings.maintenance_mode_enabled`. Pure decision in `server/policy.ts` over
the event's `sender.isOwner` — whether the sender holds owner rights over the
receiving assistant (its owning account, resolved through person links, or an
admin; see [Accounts](accounts.md)). The core compares no user ids of its own.

| Who | Behavior |
| --- | --- |
| A sender with owner rights | Bot stays functional, but only via deterministic addressing (the analyzer is off for everyone) |
| Everyone else | A static maintenance notice, no LLM reply. Traced, so the operator sees who was turned away |
| Timed tasks | Paused — due tasks stay due and deliver once maintenance ends |

## Configuration

| Setting | Effect |
| --- | --- |
| Chat backend + `model` | Without a chat backend and model there are no replies |
| A transport connection per assistant (the bot token, in the assistant editor) | Without a running connection nothing is received or sent — see [Assistants](assistants.md) |
| Owner rights (the assistant's owning account + admins) | Owner-gated behaviour |
| `maintenanceModeEnabled` | Above |
| `assistantLoopGuardTurns` | The loop guard's limit (0–10, default 3) |
| `timezone` | The time context injected into every reply |
| The assistant's persona | `You are <name>.` plus the persona text, appended as "Additional instructions" |

## Reply integrity — deliberation is not an answer

A thinking model is supposed to keep its working-out in its own channel and send
only the answer. Models stop doing that: measured on the operator's llama.cpp
endpoint (`gemma-4-26B-A4B-it-abliterated`, 2026-08-24), **10 of 10** replies to
one real turn were the model's raw deliberation — the transcript echoed back,
options weighed, "I'll say X" repeated to the token cap — with the thought
channel never opened, so there was nothing for the server to strip. One went out
as three Telegram messages.

Nothing downstream can tell such an answer from a real one, so the turn checks
the **shape** of what came back, before anything else judges what it says. Two
rules:

1. It ran into the token cap — cut off mid-sentence whatever else it is. That is
   reason enough on its own, and it is what 7 of those 10 did.
2. It contains text a reply may never contain: the `[#<id>]` transcript anchor
   (the input-only line format the prompt forbids) or a raw chat-template
   channel marker (a serving artifact). All 10 leaks carried the anchor —
   including the 3 that ended inside the cap, which rule 1 alone would have
   sent. The plain `#<id>` citation form stays legal: that is how the bot links
   to a message.

No lexical rules, and nothing is stripped or rewritten: a reply either stands as
the model wrote it or is regenerated. A violation is retried once, with a
correction that shows the model its own working-out and names it as the part
nobody may see (10/10 recovered in the same measurement). A second violation is
suppressed — the chat is told plainly, as with the other two enforcement paths,
rather than being sent the notes or left in silence.

## Delivery

- The core keeps the model's **raw text**: history, traces and the pipeline all
  see it unrendered. A long answer leaves whole as one `reply.delivery`; the
  core knows no platform's cap, so the transport splits it under its own
  (Telegram: `ahw-transport-telegram/src/split.ts`, never truncated) and reports every part.
- Markdown → Telegram HTML at the transport boundary only
  (`ahw-transport-telegram/src/telegram-html.ts`). Telegram's HTML mode accepts a small tag
  set and rejects the entire send otherwise, so conversion is by-construction
  (code spans lifted out, everything else entity-escaped, tags only from paired
  replacements) and the transport falls back to a plain-text send if Telegram
  still refuses — on a parse error only, because any other retry could
  double-deliver.
- **Message citations become links.** A reply that says "the first photo was in
  #13488, the other two in #15114 and #15115" has every reference rendered as a
  `t.me/c/<chat>/<id>` anchor, so each one taps through to that message. The
  whitelist is resolved core-side against the chat's mirror
  (`linkableSourceMessageIds` on the event — a whitelist, not a pattern, so an
  invented or mistyped id stays plain text) and rendered transport-side. Only
  supergroups and channels have a per-message URL; in a basic group or a DM
  nothing is linked. Word hashtags (`#weekend`), URL fragments and citations
  inside code spans are left alone. The web chat renders no message links.
- **The reply always lands under the message it answers.** The model cannot
  move it: the delivery tools take text and nothing else. They are the
  transport's own, served from its MCP server and reached as the managed
  connection `tg` (`ahw-transport-telegram/src/mcp.ts`, offered as `tg__reply_to_message`,
  `tg__send_message`, `tg__set_message_reaction` on Telegram turns only); the
  web chat has its in-process twins `chat_reply_to_message` /
  `chat_send_message` and no reaction tool. Which delivery tool a turn is
  offered is a fact about the turn — `reply` for a turn a `message` task
  opened, `send` for a timed fire, neither for an ordinary reply — bound out
  of band as the call's `_meta` and re-checked by the tool. Letting the model
  pick a target is what produced the outage described in
  [tasks.md](tasks.md#how-a-task-delivers--no-hardcoded-sending).
- **The bot can react to a message** instead of, or alongside, saying
  something. `set_message_reaction` puts one of Telegram's fixed reaction
  emoji on a message of this chat (an empty emoji takes it back off; a bot
  gets one reaction per message, so reacting again replaces it). Available in
  every Telegram turn — a reply turn and a task fire alike — because a
  reaction is not a message and cannot double-deliver. The transport asks the
  core's mirror first (`GET /api/internal/transports/messages`) so a guessed
  id is refused without a platform call, and the bot's **own** messages are
  refused there — Telegram would allow the reaction, but a badge on its own
  message says nothing to anyone (another bot's message is an ordinary
  participant message and can be reacted to). A Telegram refusal (an emoji
  this chat does not allow, a message too old, the poller down) is relayed to
  the model rather than swallowed, so it never tells the chat it reacted when
  it did not. The badge is reported back as `transport.bot-reaction` and
  recorded on the mirror row ([History](history.md#the-bots-own-reactions)),
  so the next turn remembers it. A reaction the bot sets cannot feed itself:
  the transport forwards only humans' 👍/👎 as `transport.reaction`
  ([Self-improvement](self-improvement.md)). See
  [LLM and MCP](../architecture/llm-and-mcp.md#telegram--the-transports-own-server-mcp-tools-connections)
  for the tools and
  [Adding a transport](../development/adding-a-transport.md#step-6--the-mcp-server)
  for the contract.
- A voice reply is synthesized when a speech endpoint is configured
  ([Voice](voice.md)); the audio crosses the transport's internal API.
- Generated images are delivered after the text ([Image generation](image-generation.md)).
- A conversation whose source has no name for it (a web thread) is named from
  its first exchange after the reply is delivered
  (`server/turn/name-conversation.ts`, [Web chat](web-chat.md)).

## Tracing

Every trace of an action that belonged to an assistant carries its id, so
`/debug` shows an **Assistant** column and filters to one of them
(`?assistantId=`): reply turns and their source-side halves (inbound, delivery,
feedback collection — the receiving connection's assistant), timed task fires
(the task's own assistant), and edits to an assistant itself. Anything nobody
owns in particular — background jobs, settings, auth — is blank and stays out
of every assistant's view. A user-role account sees only its own assistants'
traces.

One `reply` trace per handled message per assistant, plus one per message the
LLM was asked about and then not answered. Chatter rejected by the cheap checks
leaves nothing behind. On one correlation id Debug lines up the ingest's
`inbound` trace, the core's `reply` trace and the transport's `deliver` trace.

Event flow: `addressing check` → `system prompt composed` → `chat context loaded`
→ `long-term memory loaded` → `communication preferences loaded` →
`current turn composed` → `history window loaded` → `vision context composed`
→ `time context` → `language directive` → (`opened by a standing task`) →
`request` → `tool: <name>`… → `response` → output. The LLM
request/response/tool/retry events are recorded by the shared LLM tracing layer
(`LlmCallTrace`), not by this feature. A voice turn opens the trace before
transcription, so the transcribe exchange lands at the top of the same flow.

The `addressing check` event carries `matchedText`, `source`, `reason` and
`botDisplayName` (the assistant's name). `matchedText` is the field the
"wasn't talking to you" feedback loop reads back — see
[Self-improvement](self-improvement.md).

Two kinds of trouble the turn recovered from are recorded as `warn` steps rather
than swallowed, so a turn that took two goes cannot pass for a clean one:
`context overflow — retrying with history shrunk to N messages` (the injected
history outgrew the model's window), and `LLM call failed — retrying (attempt 1
of 2)` (a transient endpoint failure the completion path retried on its own —
see [Configuration](../configuration.md)).

## Outcomes

`ignored` (`not_addressed`, `maintenance_mode`, or `loop_guard` from the turn
consumer — bot-authored and contentless updates never reach the core, the
transport drops them), `replied`, or `error`.

`error` covers a failed reply — and the deliberate refusals to send: a turn a
standing chat rule opened where the model produced no tool call in two attempts
(its answer claims an action that provably did not happen, so it is withheld and
the chat is told the rule did not run — see
[Tasks](tasks.md#message-triggers--the-matcher)); a reply that claimed an action
no tool performed, twice (the honesty gate); and a reply that was the model's own
deliberation, twice (reply integrity, above). Each tells the chat what happened
instead of sending something untrue or nothing at all.

## Tests

| File | Covers |
| --- | --- |
| `server/addressing.test.ts` | The name half and the undecided cases |
| `ahw-transport-telegram/src/addressing.test.ts` | Every structural verdict, with its reason |
| `ahw-transport-telegram/src/inbound.test.ts` | One event per update, dedupe and DM streams, reply-author recognition, what is dropped |
| `server/address-analyzer.test.ts` | Prompt building, enum parsing, citation verification |
| `exclusions.test.ts` | Normalization and matching |
| `server/policy.test.ts` | Maintenance decisions |
| `server/prompt.test.ts` | Prompt composition, time context, addressing hint |
| `server/reply.test.ts` | Splitting |
| `server/reply-integrity.test.ts` | The shape checks, over real leaked answers as fixtures |
| `server/action-claim.test.ts` | The honesty gate's prompt and verdict parsing |
| `server/service.test.ts` | The whole policy with injected collaborators |
| `addressing-trace.test.ts` | The shared event shape |
| `ahw-transport-telegram/src/telegram-html.test.ts` | Conversion, including that output cannot contain an unbalanced tag |
| `server/turn/loop-guard.test.ts`, `server/turn/render.test.ts` | The streak arithmetic; transcript rendering with several assistants' voices |
| `server/ingest/ingest.integration.test.ts` | The ingest over the whole event contract against a real database: persistence, presence fan-out, dedupe, media, cross-feed, edits, reactions, the self-link short-circuit |
| `server/turn/turn-consumer.integration.test.ts` | The turn end to end: composed context in, delivery + lifecycle out; web threads; conversation naming; cross-fed turns and the loop guard; retry and settle semantics; media and voice turns |
| `server/source-store/source-store.integration.test.ts` | The mirror's dedupe key and per-assistant DM streams |
