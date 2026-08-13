# Chat rules

Standing instructions the bot follows in a chat: *"from now on, whenever someone
posts a link to a social-network video, download it and send the file here."*
Rules are written in the author's own words, stored per chat, and composed into
every reply's system prompt. Nothing about a rule is code — the text is the
contract, and it is carried out with the tools the bot already has.

Feature ids: `chat-rules` (CRUD and the match decision), `mcp-tools-chat-rules`
(the toolkit's calls). Dashboard: `/rules`. Debug: `/debug?feature=chat-rules`.

## Two ways in

| | Dashboard `/rules` | The chat itself (`rules_*` tools) |
| --- | --- | --- |
| Who | The operator (the dashboard is operator-only) | Gated — see below |
| Scope | Any chat, **and** the global set | Only the current chat |
| Audience | Everyone, or people ticked off the group's roster | Everyone, or the user ids named in the call |
| Global rules | Create, edit, delete | Visible, never editable |

The chat-side gate mirrors `specialist_switch` exactly (user decision,
2026-07-29): in a **private chat** the user manages their own chat's rules; in a
**group** only the configured owner may, and anyone else gets a refusal the bot
relays. It is enforced in the service, inside the boundary the tool calls — there
is no lexical pre-filter, and a denial is *returned*, never thrown, so the turn
carries on and the model explains the refusal.

A rule of another chat is invisible rather than forbidden (`not_found`): a chat
has no business learning that it exists.

## Scope

A rule belongs to one chat, or is **global** (`chat_id is null`) and applies
everywhere on top of that chat's own rules. A chat's effective set is *its own
rules plus the global ones*, oldest first — the order they were agreed in is the
order the model reads them in.

Each scope is capped independently at **32 rules**, and a rule is at most **1 000
characters**: every enabled rule is in every prompt, so the budget is the real
constraint. Duplicate text within a scope is rejected for the dashboard
(409) and treated as already-satisfied from chat (see the Tools section) — the
same instruction stored twice is noise in every request.

## Who a rule applies to

The second axis (user decision, 2026-08-13). A rule applies to **everyone in its
chat** by default; a rule scoped to a **group** may instead name up to **16**
people, and then applies to their messages and to nobody else's.

It is a filter on the sender, not a hint to the model. `getActiveRulesForChat`
takes the id of whoever sent the message and drops every rule that names someone
else *before* anything is composed — so a rule about one member never reaches
another member's prompt, never reaches the `always` matcher, and the model is
never asked to work out that a rule about somebody else does not apply. Nothing
in the prompt says a rule is targeted, because by the time the prompt exists,
only rules that apply are in it.

Consequences of that shape:

- A **scheduled-task fire** has no sender, so only rules naming nobody apply
  there — as with `always` rules, a fire is nobody's message.
- A targeted `always` rule can only ever open a turn on its own people's
  messages; for everyone else the extra classification call is not even offered
  that rule.
- Elevation is unchanged: a matched targeted rule lends its *author's* rights,
  not its subject's (see *Whose rights a rule-driven action carries*).

Only groups can narrow: a DM is one person already, and a global rule spans chats
whose rosters have nothing to do with each other. A rule can only name people the
bot has **seen speak in that group** (the `group_members` roster), checked in the
service against a real row — a lurker cannot be named until they say something,
and an invented id is refused rather than stored as a rule that silently never
fires. Names are never resolved to ids in code; the group roster injected into
every group prompt carries each participant's exact id, and the model copies one.

Who a rule applies to **is** editable (unlike its scope): adding or dropping a
person is an ordinary amendment within the chat that agreed to the rule.

## Trigger modes

This is what makes a rule more than extra prompt text.

**`on-reply`** (default) — the rule shapes replies the bot was already going to
make: every private message, and group messages that address it. Free: the rules
block is part of a prompt that was being composed anyway.

**`always`** — the rule may additionally act on a group message that never
addressed the bot. Nothing else in the app does this; the addressing check
normally ends such a message's life. So it is deliberately expensive and
deliberately hard to trigger:

1. The addressing check runs first and says "not addressed", as always.
2. *Only if the chat has at least one enabled `always` rule*, one classification
   call asks which rules this message triggers
   (`features/chat-rules/server/matcher.ts`). A chat with no `always` rule never
   makes this call.
3. The model must name a rule by its offered number **and** quote the part of the
   message that triggers it. The quote is checked mechanically against the
   message — same citation guard as the addressing analyzer. An unknown number, a
   missing quote, an invented quote, an unreadable answer, or a failed call all
   mean **no match**, and the message stays ignored.
4. On a match by an `always` rule the ordinary reply pipeline runs, with a
   directive injected last naming the matched rules and telling the model to do
   what they require and nothing else.

Maintenance mode turns the matcher off, exactly as it turns the addressing
analyzer off: maintenance means no LLM work beyond what the cheap checks already
addressed.

**Limit:** the matcher reads the message's *words*. A rule triggered by something
with nothing to quote — a bare photo, a sticker — cannot match this way.

## Whose rights a rule-driven action carries

**A rule is its author's standing order** (user decision, 2026-07-29 — *"rule
creator beats message source"*). When the bot acts because a rule told it to, the
action runs with the rights of whoever set that rule, not those of the person
whose message triggered it.

This is what makes the owner's *"download any media link posted here"* rule
work. The download tools inside a browsing run are owner-only, resolved once at
`browse_web` enqueue time; without this the rule would deliver a file for the
owner's own links and be refused for everybody else's — the opposite of what the
rule says.

Rule-driven downloads are narrower than the owner's direct ones (user decisions,
2026-08-01): a run a rule drove in a group chat — the owner's own message
included — or one whose rights were lent to a non-owner is marked `restricted`.
Its download tools accept only the triggering message's own links (extracted in
code, matched by site — see `docs/features/browser-agent.md`), and a downloaded
file the chat cannot take is discarded and reported as a failed delivery rather
than kept on the server. This bounds what a crafted message — or an over-eager
rule match — can actually make the browser do with the owner's rights.

How it is resolved:

- `resolveRuleAuthority` (`format.ts`) reads the **matched** rules. Only the
  owner is a privileged identity, so elevation is exactly: a matched rule the
  owner wrote from chat, or one written in the operator-only dashboard. A rule an
  ordinary user wrote in their own DM lends nothing — they had no rights to lend.
- The runtime binds the result as `authorityUserId` on the per-turn MCP tool
  context. `browse_web` reads it for the owner check.
- **Permissions only.** `userId` on the tool context is untouched, so provenance
  — who authored a memory, who created a task, who the run was started by — stays
  the real sender. Elevating identity as well would file one person's data under
  another's name.

Because the answer must be the same whether or not the person happened to name
the bot, the matcher **also runs on addressed turns** — its result there is used
only to bind the authority, never to inject a directive (the person asked; the
rules are already in the system prompt). That call is skipped unless it could
change something: it costs nothing when the chat has no rule an elevated author
wrote, or when the sender is the owner already.

An `on-reply` rule can lend rights this way even though it can never open a turn.

*What is not possible:* a user cannot request an elevated action. They can only
say something a rule matches, and the model is then told to do what that rule
requires and nothing else. A rule that lends nothing (its author has no rights)
leaves the sender's own permissions exactly as they were.

## Where a rule lands in the prompt

The rules block is appended **last** in the system prompt, after the personality,
the specialist role and the self-correction guidelines
(`features/chat-rules/format.ts` composes it; `buildSystemPrompt` appends it).
Last because, unlike the layers above it, these are explicit instructions the
people in this chat gave the bot about its own behavior, and they are what the
reply will be judged against.

The block's closing paragraph is load-bearing for a small model. It says a rule
is an instruction and not a topic to discuss, restates the base prompt's honesty
rule where it is about to be tested (*a rule calling for an action is done by
calling the tool that does it, this turn*), and — because a rule can ask for
something the person who triggered it is not allowed to do — tells the model to
say plainly what happened rather than claim the rule was applied.

Scheduled-task fires get the same block (reply-shaping rules only): a rule about
how the bot speaks here governs what it sends unprompted just as much as what it
answers. An `always` rule is not consulted there — it reacts to somebody's
message, and a fire is nobody's message.

The block also tells the model to report plainly when a rule cannot be carried
out: a tool can still refuse — for instance when the matched rule lent no rights
(see *Whose rights a rule-driven action carries*) and the sender has none of
their own.

## A rule turn that called no tool

All of the prompt text above can be read, agreed with, and then not acted on. A
turn nobody addressed exists *only* because a rule demanded an action, and an
action happens only through a tool call — so an answer with zero tool calls
cannot be true, whatever it says.

Live incident (2026-08-03, trace `ec543b22…`): a social-media link matched this
chat's download rule, the reply model's reasoning worked out that it should call
`browse_web`, and the generation then emitted *"downloaded the video from x.com"*
— with an invented author handle, `finish_reason: "stop"`, and no tool call at
all. No browser run existed. Measured over the retained rule-driven downloads,
8 of 9 turns called the tool and this one did not; it is intermittent, not a
broken path. It is the same gemma4:12b tool-avoidance family tracked in
`docs/TODO.md`, and the Honesty block, this feature's rules block, and the
trigger directive had all already told it not to do exactly this.

So the reply pipeline checks the fact rather than the prose
(`features/bot-messaging/server/service.ts`, step 4d). The check is mechanical —
a rule directive was injected, and `onToolCall` never fired — and it can only
be reached on a rule-opened turn, so an ordinary reply that legitimately needs
no tool is untouched.

1. **One retry.** The turn is re-sent with the empty-handed answer appended and
   `RULE_ENFORCEMENT_DIRECTIVE` after it: the answer called no tool, so nothing
   happened, that message will not be sent, and there are exactly two ways
   forward — call the tool now, or say in one sentence that it could not be
   done. The honest way out is offered deliberately: a model cornered into
   calling *something* picks the wrong tool. This is not standing prompt text;
   it is shown only after the failure, with the failure in front of it, which is
   the one form of the instruction the model has not already ignored this turn.
2. **Then the answer is suppressed.** If the retry also runs no tool, the model's
   text is never delivered. The chat gets a labeled system notice instead, saying
   the rule matched but the action was not carried out (user decision,
   2026-08-03 — the people here are owed the truth, not a plausible lie and not
   silence). The notice is not mirrored into history: the bot's own failure
   notice is not conversation, and a claim in the transcript poisons later turns.
3. **The trace fails.** A rule the bot did not carry out is exactly the turn an
   operator has to be able to find on `/debug`, and a green trace is how the
   first one went unnoticed for a day. Both steps are recorded — the retry as a
   `warn`, the suppression as an `error` carrying the text that was withheld.

## Tools

| Tool | Input | Purpose |
| --- | --- | --- |
| `rules_list` | — | This chat's rules with their ids and whose messages each applies to, plus the global ones (marked, and not editable here) |
| `rules_create` | `text`, `trigger`, `user_ids` | Save a standing rule for this chat, for everyone or for named people |
| `rules_update` | `id`, `text?`, `trigger?`, `enabled?`, `user_ids?`, `applies_to_everyone?` | Reword a rule, change its trigger or audience, or pause/resume it |
| `rules_delete` | `id` | Remove a rule for good |

Changing the audience from chat is deliberately two fields rather than one list.
An empty array is what a model sends when it means *leave this alone*, so
`user_ids: []` keeps the current audience (the same convention as `text: ""`) and
widening a rule back to everyone takes the explicit `applies_to_everyone` flag —
otherwise a rule written about one person could be silently widened by a model
filling in a blank. Creating the *same rule text* again with a different set of
people is not "already in force": it amends the audience and says so.

`rules_create`'s description is long by design and pinned in
`mcp-tools.test.ts`: almost nobody says the word "rule" ("from now on…", "always
…", "never … again", "whenever someone sends X…"), and it has to be told apart
from the two tools it is otherwise confused with — a fact about a person is
`memory_save`, and something that happens at a *time* is `tasks_create`.

It also has to undo two beliefs that stopped a model from calling it at all
(trace `f33e1ede…`, 2026-07-29). Having identified `rules_create` as the right
tool, it reasoned that its own earlier *"Got it, from now on…"* meant the rule was
already stored, and that calling again "might result in duplicate rules" — then
answered with a fourth assurance and stored nothing. Two things changed:

- **Creating from chat is idempotent.** The same rule again returns
  `{ status: "exists" }` and the tool reports plain success ("already in force …
  unchanged"), leaving the stored rule untouched. The dashboard still gets a 409,
  because an operator must see a no-op for what it is. A tool that punishes a
  repeat teaches exactly the hesitation above.
- **The description says so**, and says that a message of the bot's agreeing to a
  rule is not the rule being saved, that a repeated instruction means the person
  does not believe it took effect, and that `rules_list` is the only way to know
  what is stored.

The general form of the same failure went into the base prompt's Honesty rules —
its own past confirmation is not evidence it acted, and a repeated request is a
request — so it also covers the tools that have no idempotent repeat.

## Storage

One table, `chat_rules` (migrations `0044`, `0053`):

| Column | Notes |
| --- | --- |
| `chat_id` | Telegram chat id, or **null** for a global rule |
| `text` | The rule, in the author's words |
| `trigger` | `on-reply` \| `always` (checked in the DB) |
| `enabled` | A paused rule stays authored but is never composed into a prompt |
| `target_user_ids` | Senders the rule is limited to; empty = everyone. A DB check keeps it empty for a global rule; group-only is enforced in the service |
| `created_by_user_id`, `source` | Provenance: who wrote it, and whether from `chat` or the `dashboard` |

Scope is **not** editable: moving a rule between chats is a delete plus a create,
so a rule's chat can never change under the people who agreed to it.

## Traces

Every mutation is traced under `chat-rules` (`create` / `update` / `delete`),
with the rule id in `relatedIds.chat_rules`. Tool calls are traced under
`mcp-tools-chat-rules` like every other toolkit.

The match decision is recorded on the **reply trace** of the message it judged —
request, response (`usage.callKind: "chat-rule-match"`), and a `chat rule match`
step carrying the rules offered, what matched, why, and the `authorityUserId` the
turn ended up carrying (null when the sender's own rights apply). When a rule opens a
turn, the trace also holds an `opened by a standing chat rule` step with the
injected directive, and the system-prompt step reports `chatRulesApplied`.

## Tests

| File | Covers |
| --- | --- |
| `features/chat-rules/format.test.ts` | Prompt block and rule-trigger directive; enabled/`always`/sender selection; `resolveRuleAuthority` |
| `features/chat-rules/server/matcher.test.ts` | Match prompt, and every fail-closed path of the citation check |
| `features/chat-rules/server/mcp-tools.test.ts` | Tool contract: bound chat, relayed refusals, partial updates; the `rules_create` description |
| `features/browser-agent/server/mcp-tools.test.ts` | The download gate reads the turn's authority, and provenance stays the sender |
| `features/chat-rules/server/chat-rules.integration.test.ts` | Scope resolution, caps, duplicates, the permission gate, traces; sender targeting end to end (roster check, group-only, editing the audience) |
| `features/known-groups/format.test.ts` | The roster carries each participant's exact user id |
| `features/bot-messaging/server/service.test.ts` | The rule-opened turn: directive placement, silence on no match/failure, maintenance; the addressed-turn pass that binds authority |
