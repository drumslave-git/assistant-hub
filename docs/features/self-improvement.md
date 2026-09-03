# Self-improvement

**Feature ids:** `user-feedback`, `self-improvement` ·
**Dashboard:** `/self-improvement` · **SSE topic:** `feedback`

The bot learns from what people think of its replies. A 👍/👎 reaction opens a short
menu; the answer, plus the bot's own reflection on *why* that exchange went the way it
did, is distilled nightly into two artifacts that go straight back into the prompt.

## The collection flow

```
👍/👎 on a bot reply         (transport.reaction event, forwarded by the transport)
        ↓
feedback row opened + options menu posted     (core → the transport's menu API)
        ↓
button press ──► POST /api/internal/transports/callback ──► option recorded, toast answered
        │                                                        ↓
        └── "Other" ──► status=awaiting_text ──► the reactor's reply to the menu is captured by the ingest
                                                                 ↓
                               feedback.recorded (bus) → model stamp + reflection (detached)
                                                                 ↓
                                              nightly incorporation
```

The flow is split along the transport contract: the transport owns everything
platform-shaped, the core owns the rows and the state machine
(`features/self-improvement/server/collect-flows.ts`, `collect-menu.ts`,
`collect-transport.ts`).

| Step | Where | What |
| --- | --- | --- |
| Someone adds 👍/👎 to a message | The transport (`ahw-transport-telegram`) | Maps its platform's reactions to `up` / `down` — a freshly **added** 👍/👎; removals and other emoji are ignored — and forwards `transport.reaction` once per group |
| Open the row, post the menu | Core: the ingest (`server/ingest/consumer.ts`) → `processReactionUpdate` | Checks the mirror for a bot reply, upserts `source_feedbacks`, builds the keyboard and posts it through `POST /internal/chats/:chatId/menu?assistantId=` on the receiving connection's bot; the menu's id lands in `menu_message_id`. Traced as `self-improvement` / `collect-feedback`, on the reacted reply's correlation |
| A button press | The transport → `POST /api/internal/transports/callback` → `processCallbackPress` | The one transport update that is a synchronous request/response (internal token): the platform's spinner wants a toast only the flow's outcome can word. The core records the option, rewrites or removes the menu through the transport's `PATCH` / `DELETE …/menu/:messageId`, and answers `{ toast }` |
| "Other" | Core | The row goes `awaiting_text`; the next message from the reactor that **replies to the menu** is captured by the ingest (`captureFeedbackReply`) as the free-text answer — mirrored, but it never opens a turn |
| Completion | Core | Publishes `feedback.recorded` on the bus; the core's own events consumer (`recorded-consumer.ts`) stamps the reacted reply's clean model from its trace, then reflects (`quality`) or files an exclusion (`addressing`) |

The transport's menu operations sit behind the `CollectTransport` interface,
so the flows run unchanged against a fake — no platform needed.

**Telegram constraint:** `message_reaction` updates arrive out of the box in private
chats, but in groups **only when the bot is an administrator**. Listing them in the
poller's `allowed_updates` is the transport's job. The web chat has no reactions:
`collectTransport("chat")` is null and nothing here runs for it — a platform
without the affordance simply never publishes `transport.reaction`.

The menu is group-visible but answerable by **one** user only: the person who
reacted. Anyone else gets a toast (user decision — a Telegram group message cannot be
shown to a single member). Every outcome is answered with a toast rather than a
message, because an answered menu deletes itself, so the popup is all the
acknowledgement the chat gets.

### The options

Five predefined options per reaction plus a free-text "Other" (user decision,
2026-07-14):

| 👍 | 👎 |
| --- | --- |
| Helpful & accurate | Inaccurate or wrong |
| Right tone/personality | Wrong tone |
| Good length & format | Too long or rambling |
| Funny/entertaining | Missed the point/context |
| Understood the context | Generic or boring |
| | **Wasn't talking to you** |

Options are only ever **appended**, never reordered: the menu's `callback_data`
carries the option's *index*, so reordering would make an in-flight menu resolve to a
different answer than the one its button showed. The stored feedback is the option's
**text**, so renaming an option later does not corrupt stored rows. The keyboard is a
plain grid the transport converts to its platform's inline-keyboard shape.

## Self-reflection

As soon as a user answers the menu, the bot reads back **how it produced the reply
they reacted to** — the prompt it was given, the tools it ran, the text it sent —
together with what they said about it, and writes down what went right or wrong and
why. The result is stored on the same feedback row (`reflection`,
`reflection_model`).

This is the reasoned half of a feedback. "Too long" is a symptom; the reflection is
where the cause lives, and it is what both nightly folds read.

It runs **detached** from the collection flow, off the `feedback.recorded` bus
event: the answer is already stored and acknowledged, so waiting on an inference
would stall nothing but still has no reason to hold the flow. Best-effort by
consequence — a reflection that never lands leaves the column null, and the daily
job writes the missing ones before folding.

`server/exchange.ts` renders both shapes the flows need — the compact exchange (what
was asked, what was answered, what the user thought) that the folds read, and how that
answer was produced (prompt, tools, reply) that the reflection reads. Kept out of both
callers so reflection and folds cannot drift on what "the exchange" means.

## The nightly incorporation job

Daily at `settings.daily_jobs_run_time`, under an advisory lock. It distils
completed-but-unincorporated feedbacks into:

| Artifact | Table | Injected as |
| --- | --- | --- |
| Per-user communication preferences | `communication_preferences` (versioned per `user_ref`, `likes`/`dislikes`) | A system message for that specific sender |
| Global self-corrections | `self_corrections` (versioned) | Appended to the system prompt on every reply |

**Context discipline (a user requirement):** each feedback is folded in its **own**
LLM call, so a large backlog can never overflow the context, and shared data (the bot
persona) is stated once per call rather than repeated per exchange. Every fold starts
from the running draft with the previous version seeded, so the result is an iterative
refinement rather than a rewrite from scratch.

A feedback answered while the LLM was unavailable has no reflection yet, so the run
writes the missing ones before folding — every fold sees the reasoned form.

Idempotent: an empty backlog is a no-op, and incorporated rows record the version that
consumed them (`prefs_version`, `corrections_version`).

## "Wasn't talking to you" → an addressing exclusion

The one 👎 option that does something structural rather than stylistic.

The bot only ever answers an unaddressed message one way: the addressing analyzer read
a word in it as the assistant's name in another alphabet or an inflected form, and
was wrong — two names the model believes are one name. **The word it cited is already
on the reply's trace** (`matchedText` on the `addressing check` event), so the report
needs no guesswork and no second LLM call: read the decision back, and file the cited
word as an exclusion (`server/addressing-report.ts`, run by the `recorded`
consumer for a row whose `topic` is `addressing`).

Exclusions then enter the addressing decision twice: both analyzer prompts list them
(so the model can also recognize a declined or transliterated form of an excluded
word), and a citation that *is* an excluded word is dropped mechanically before the
verifier call. Neither path skips the LLM classification — the analyzer still runs on
every undecided message; the list only overrules an answer the chat already told us was
wrong.

Everything that is *not* that case resolves with a **reason** instead of an exclusion.
The complaint is still recorded either way — it just has no word to act on, and the
trace says which of the honest reasons applied rather than silently doing nothing.
Nothing reflects on an addressing answer and no fold reads it (user decision,
2026-07-26).

The operator can undo one: `DELETE /api/self-improvement/exclusions/{id}`. After that
the analyzer may match the word again.

## Data

| Table | Notes |
| --- | --- |
| `source_feedbacks` | One row per reaction, for every transport: `source`, `chat_id`, `source_message_id` (the reacted reply), `user_id` (who reacted), `reaction` (`up` \| `down`), `feedback`, `status` (`pending` \| `awaiting_text` \| `completed`), `topic` (`quality` \| `addressing`), `menu_message_id`, `model` (the reacted reply's), `reflection`, `reflection_model`, and the two incorporation versions. Unique on `(source, chat_id, source_message_id, user_id)` |
| `communication_preferences` | Versioned per person, keyed by scoped `user_ref` |
| `self_corrections` | Versioned globally |
| `addressing_exclusions` | Unique on `normalized`; the report's provenance (`chat_ref`, `source_message_id`, `user_ref`, `feedback_id`) travels as refs and ids, with no foreign keys |

The `model` columns are informational only, but must always hold a **clean** model
name (`gemma3:12b`), never a situational registry/path prefix like
`docker.io/ai/gemma3:12b` (user decision, 2026-07-14) — `model-name.ts` normalizes it.

## Dashboard

`/self-improvement` shows the collected feedback (with each row's reflection shown
under the words the user actually said — absent until the reflection lands), the
learned per-user preferences, the latest global self-correction, the addressing
exclusions with a remove action, and the daily job card.

## API

`GET /api/self-improvement` (aggregate view + job info),
`POST /api/self-improvement/run` (fire-and-forget),
`DELETE /api/self-improvement/exclusions/{id}`.

## Tracing

| Feature id | Covers |
| --- | --- |
| `user-feedback` | The `recorded` consumer: the model stamp, the reflection dispatch, and the addressing report |
| `self-improvement` | `collect-feedback` (reaction → menu, on the ingest, stamped with the receiving connection's assistant), the reflection pass and the nightly incorporation |

## Tests

Unit: `format.test.ts`, `model-name.test.ts`, `server/analyze.test.ts`,
`server/scheduler.test.ts`.
Integration: `server/self-improvement.integration.test.ts` — the reflection pass,
the daily incorporation, the `feedback.recorded` consumer, and the addressing
report. The reaction → menu → press state machine itself (`collect-flows.ts`)
has no suite of its own today.
