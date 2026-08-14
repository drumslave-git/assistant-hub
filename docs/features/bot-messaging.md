# Bot messaging

**Feature id:** `bot-messaging` · **Trace action:** `reply` · **Dashboard:**
Overview (bot control card) · **Priority 1**

The core: receive a Telegram message, decide whether to answer, compose the
context, run the model with tools, deliver the reply. Every other feature either
feeds this one or observes it.

The end-to-end flow is documented in
[the Telegram pipeline](../architecture/telegram-pipeline.md). This page covers the
feature's own modules, configuration and failure modes.

## Modules

| Module | Purity | Role |
| --- | --- | --- |
| `addressing.ts` | Pure | The deterministic addressing rules |
| `server/address-analyzer.ts` | Prompt/parse pure, caller owns the call | The LLM half of the addressing check |
| `exclusions.ts` | Pure | The row shape plus the one normalization rule the feature agrees on |
| `server/exclusions-repository.ts` | Data access | Reads consumed by the analyzer; writes owned by self-improvement |
| `policy.ts` | Pure | Owner and maintenance-mode decisions |
| `server/prompt.ts` | Pure | System-prompt composition, time context, group addressing hint |
| `server/reply.ts` | Pure | Telegram's 4096-char split at natural boundaries |
| `telegram-html.ts` | Pure | Model Markdown → Telegram HTML |
| `addressing-trace.ts` | Pure | The addressing event's name and payload, shared by writer and reader |
| `server/service.ts` | The boundary | Addressing, policy, generation, delivery, tracing |
| `ui/BotControl.tsx` | Client | Start/Stop the poller |

Collaborators (reply generation, delivery, history load, vision load, analyzer) are
**injected** into the service, so the whole policy is unit-testable without a live
LLM or Telegram — and so the same service runs behind the simulation harness.

## Addressing

| Chat type | Addressed when |
| --- | --- |
| Private | Always |
| Group / supergroup | @mention (by username or a `text_mention` entity), a reply to one of the bot's messages, `/command@botusername` targeting the bot, or the bot's display name spoken literally |

Anything else in a group is either plainly not for the bot or **undecided**.
Undecided messages go to the LLM analyzer, which:

1. classifies *how* the name appears using a bounded enum (not yes/no), so code
   derives the decision and a chatty model cannot talk its way into a reply;
2. must cite the word it took for the name, and the citation must really occur in
   the message;
3. survives a second, focused verifier call — identify the word's base form and
   what it refers to, then say whether it is the display name;
4. is overruled mechanically when the cited word is a known **exclusion**, and
   both prompts list the exclusions so the model can also recognize declined or
   transliterated forms of them.

Both calls fail closed. A provider failure resolves to "not addressed".

Design constraints worth preserving:

- **No lexical pre-filter** in front of the analyzer. One was built and reverted
  (user decision, 2026-07-20): any lexical gate is weaker than the LLM at spotting
  a name in an unfamiliar spelling, and a missed summons costs more than the calls
  saved.
- **No linguistic heuristics anywhere** — no transliteration tables, no
  romanization folds, no phonetic matching. Code checks only mechanical facts.

## Maintenance mode

`settings.maintenance_mode_enabled`. Pure decision in `policy.ts`:

| Who | Behavior |
| --- | --- |
| Owner | Bot stays functional, but only via deterministic addressing (the analyzer is off for everyone) |
| Everyone else | A static maintenance notice, no LLM reply. Traced, so the operator sees who was turned away |
| Scheduled tasks | Paused — due tasks stay due and deliver once maintenance ends |

## Configuration

| Setting | Effect |
| --- | --- |
| Chat backend + `model` | Without a chat backend and model there are no replies |
| `telegramBotToken` | Without it the poller cannot start |
| `ownerUserId` | Owner-gated behavior |
| `maintenanceModeEnabled` | Above |
| `timezone` | The time context injected into every reply |
| Active personality | Appended as "Additional instructions" |

## Delivery

- Markdown → Telegram HTML at the transport boundary only. History, traces and the
  simulation harness keep the model's raw text. Telegram's HTML mode accepts a
  small tag set and rejects the entire send otherwise, so conversion is
  by-construction (code spans lifted out, everything else entity-escaped, tags only
  from paired replacements) and the transport falls back to a plain-text send if
  Telegram still refuses.
- Long replies are split at natural boundaries, never truncated.
- **Message citations become links.** A reply that says "the first photo was in
  #13488, the other two in #15114 and #15115" has every reference rendered as a
  `t.me/c/<chat>/<id>` anchor, so each one taps through to that message. The ids
  are checked against the chat's mirror first — a whitelist, not a pattern, so an
  invented or mistyped id stays plain text rather than linking nowhere. Only
  supergroups and channels have a per-message URL; in a basic group or a DM
  nothing is linked. Word hashtags (`#weekend`), URL fragments and citations
  inside code spans are left alone.
- The reply normally lands under the message it answers. The `reply_to_message`
  tool moves that target to an earlier message when the answer is *about* that
  message ("here it is", under the photo somebody asked the bot to find). It
  changes delivery only — the turn still sends exactly one message — and the id is
  validated against this chat's mirror before it is accepted. Sends pass
  `allow_sending_without_reply`, so a target that has since been deleted costs the
  quote, not the answer, and the mirror records where the reply actually landed.
- **The bot can react to a message** instead of, or alongside, saying something.
  The `set_message_reaction` tool puts one of Telegram's fixed reaction emoji on
  a message of this chat (an empty emoji takes it back off; a bot gets one
  reaction per message, so reacting again replaces it). Available in every turn
  — a reply turn and a task fire alike — because a reaction is not a message and
  cannot double-deliver. The target id is validated against the chat's mirror,
  and a Telegram refusal (an emoji this chat does not allow, a message too old,
  the poller down) is relayed to the model rather than swallowed, so it never
  tells the chat it reacted when it did not. A reaction the bot sets cannot feed
  itself: the `message_reaction` handler behind the 👍/👎 feedback loop
  ([Self-improvement](self-improvement.md)) ignores updates whose author is a
  bot. See
  [LLM and MCP](../architecture/llm-and-mcp.md#bot-messaging--mcp-tools-bot-messaging).
- A voice reply is synthesized when a speech endpoint is configured
  ([Voice](voice.md)).
- Generated images are delivered after the text ([Image generation](image-generation.md)).

## Tracing

One trace per handled message, plus one per message the LLM was asked about and
then not answered. Chatter rejected by the cheap checks leaves nothing behind.

Event flow: `addressing check` → `system prompt composed` → `chat context loaded`
→ `long-term memory loaded` → `communication preferences loaded` →
`current turn composed` → `history window loaded` → `vision media attached` →
`time context` → `language directive` → `llm_request` → `tool: <name>`… →
`llm_response` → output.

The `addressing check` event carries `matchedText`, `source`, `reason` and
`botDisplayName`. `matchedText` is the field the "wasn't talking to you" feedback
loop reads back — see [Self-improvement](self-improvement.md).

Two kinds of trouble the turn recovered from are recorded as `warn` steps rather
than swallowed, so a turn that took two goes cannot pass for a clean one:
`context overflow — retrying with history shrunk to N messages` (the injected
history outgrew the model's window), and `LLM call failed — retrying (attempt 1
of 2)` (a transient endpoint failure the completion path retried on its own —
see [Configuration](../configuration.md)).

## Outcomes

`ignored` (`from_bot`, `no_content`, `not_addressed`, `maintenance_mode`),
`replied`, or `error`.

`error` covers a failed reply — and one deliberate refusal to send: a turn a
standing chat rule opened, where the model produced no tool call in two
attempts. Its answer claims an action that provably did not happen, so it is
withheld and the chat is told the rule did not run. See
[Tasks](tasks.md#message-triggers--the-matcher).

## Tests

| File | Covers |
| --- | --- |
| `addressing.test.ts` | Every deterministic rule and the undecided cases |
| `server/address-analyzer.test.ts` | Prompt building, enum parsing, citation verification |
| `exclusions.test.ts` | Normalization and matching |
| `server/policy.test.ts` | Owner and maintenance decisions |
| `server/prompt.test.ts` | Prompt composition, time context, addressing hint |
| `server/reply.test.ts` | Splitting |
| `server/service.test.ts` | The whole policy with injected collaborators |
| `telegram-html.test.ts` | Conversion, including that output cannot contain an unbalanced tag |
| `addressing-trace.test.ts` | The shared event shape |
| `server/telegram/process-update.*.integration.test.ts`, `live-flow.integration.test.ts` | The real pipeline against a real database |
