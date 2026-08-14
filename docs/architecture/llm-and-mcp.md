# LLM integration and MCP tools

Everything the app asks a model to do goes through one of five OpenAI-compatible
clients in `server/llm/`. Everything the model can ask the app to do goes through
the in-process MCP registry in `server/mcp/`.

## The five provider clients

All five are server-only, and all five take their connection **explicitly** as an
argument. The connection comes from DB-backed Settings, not env vars, which is why
the same client serves both the Settings probe and the production path.

| Client | Endpoint | Used by |
| --- | --- | --- |
| `client.ts` | `/v1/chat/completions`, `/v1/models` | Replies, the per-message classifications, every LLM background job, the browser agent |
| `embeddings.ts` | `/v1/embeddings` | History summary embeddings, user-memory embeddings |
| `images.ts` | `/v1/images/generations` | The `image_generate` tool |
| `speech.ts` | `/v1/audio/speech` | Voice replies |
| `transcription.ts` | `/v1/audio/transcriptions` | Voice-message transcription |

Each of the four non-chat clients falls back to the chat role's backend when the
role has none of its own — an embedding model usually comes from a different
model and sometimes a different host, but often enough the same one serves both.

`classifier.ts` is not a sixth client but a call *shape* over `client.ts`: the
reasoning mode and token budget every per-message classification uses (addressing
analyzer and verifier, chat-rule match, honesty gate). It lives on its own so the
reply path and the Settings probe cannot drift apart on what a classification
costs — and so the numbers, all of which were measured, are written down once.
Which model answers them is the **classifier role** (see
[Configuration](../configuration.md#llm-roles)); the shape is the same wherever
it runs.

Notable constraints, each learned the hard way:

- **Embedding width is a code constant** (`lib/embeddings.ts`,
  `EMBEDDING_DIMENSIONS = 1024`), not a setting: pgvector cannot index a vector of
  unspecified width, so the column type itself commits to a size. A model emitting
  a different width is a configuration error surfaced loudly at the client rather
  than an opaque Postgres rejection deep inside a nightly job.
- **Images are always requested as `b64_json`.** Ollama's image endpoint and the
  GPT image models return no URLs, so there is nothing else to ask for.
- **Audio must be transcoded both ways.** Telegram delivers voice as OGG/Opus,
  which OpenAI-compatible `input_audio` parts do not accept (the spec allows only
  `wav`/`mp3`), so transcription converts to 16 kHz mono WAV. Speech endpoints
  answer with MP3, while Telegram's `sendVoice` needs OGG/Opus, so synthesis
  converts the other way. Both go through the shared system-ffmpeg runner
  (`server/media/ffmpeg.ts`).
- **The OpenAI SDK discards error bodies** that are not its own
  `{error:{}}` shape, which turns a real provider message into
  "500 status code (no body)". `server/llm/error-detail.ts` exists to recover the
  detail; probe with raw `fetch` before blaming a provider.
- **The same server words the same failure differently per path** — llama.cpp
  returns a context overflow as a 400 on one route and a 500 on another — so
  errors are classified by *concept* keywords, with live phrasings pinned in
  tests.

## Deadlines and retries

The SDK client is built with `maxRetries: 0` — retrying is decided here, where the
difference between *the endpoint had a bad moment* and *this request is wrong* is
known.

| | Classification | Reply round | Background |
| --- | --- | --- | --- |
| Wire timeout | 90 s (`CHAT_COMPLETION_TIMEOUT_MS`) | 150 s (`REPLY_CHAT_COMPLETION_TIMEOUT_MS`) | 300 s (`BACKGROUND_CHAT_COMPLETION_TIMEOUT_MS`) |
| Attempts | 2 (`INTERACTIVE_RETRY_ATTEMPTS`), 3 s apart | 2, 3 s apart | 1 |
| Slowest observed | 57.7 s | 95.8 s | — |

Every deadline is sized from measured traces, not from a round number, and they
differ because the call shapes do. A classification judges one message against a
~500-token prompt under a 3,000-token thinking cap; a reply round carries ~20 k
tokens of history and tools. Measured over 118 successful reply rounds on the
live bot (2026-08-03): median 18.9 s, p95 68.3 s, max 95.8 s — against a 57.7 s
worst case for classifications.

Two incidents on 2026-08-03 set these numbers, and they pull in opposite
directions:

- **A hung request** (trace `82a8976c…`). A reply died at exactly 120.005 s while
  the endpoint served the next call 0.2 s later. Nothing retried, so the group
  got "the bot could not generate a reply". This wants a *tight* deadline, so the
  retry comes quickly.
- **A slow-but-working round** (trace `93a963ec…`). Both attempts were cut at
  exactly 90.0 s on a round that was progressing. This wants a *generous* one —
  the retry cannot help, because a round that needs 95 s needs 95 s on the second
  attempt too, and restarts prefill and decode from nothing.

The retry covers the first case, so each deadline is sized for the second:
roughly 1.5× the slowest honest call of that kind. Collapsing the reply and
classification deadlines back into one number reintroduces `93a963ec…`, and a
test pins the ordering.

`isRetryableLlmError` judges the **raw** SDK error, before `toLlmError` flattens
a 400 and a dropped connection alike into `service_unavailable`. Retried: a
connection error or timeout, and a 5xx (or status-less) response. Not retried: a
4xx, a context overflow (the fix is sending less — see the shrink-and-retry
ladder in the reply pipeline), and an empty or truncated completion, which is
what this prompt produces on this model and produces again on a second ask. Empty
answers are judged *after* the retry wrapper for exactly that reason.

Background calls are not retried at all: they already wait for a quiet endpoint,
carry a longer deadline, and run again on their own schedule. Replies get no
second schedule.

The retry is for a request that never got going, never for one that is merely
slow — that is what the deadline is for, and confusing the two is what
`93a963ec…` was.

In the tool loop the retry sits around a single **round**, so everything the loop
has gathered — including the results of tools that already ran — is what gets
re-sent. A retry around the whole call would re-execute side effects; this one
cannot re-download a video.

Recovery is never silent: `onRetry` reaches the caller, and the reply pipeline
records it as a `warn` step on the trace.

## The tool loop

`server/llm/tool-loop.ts`. Chat completion with tools as **one** conversation:

```
round 1  system + context + user  → model answers        → that response is the reply
                                  ↘ model emits tool calls
round 2  … + assistant(tool_calls) + tool results        → re-sent, same system prompt
…
```

There is deliberately **no separate tool-selection pass**. Every request carries
the same system prompt, so a turn that needs no tools costs a single inference and
the provider's prompt-cache prefix survives.

Termination is **progress-driven** (ported from the MVP):

- A round with no tool calls ends the loop.
- A streak of 3 rounds (`MAX_STALL_ROUNDS`) that each introduce no new call — a
  stuck or looping model — takes the tools away for one final forced answer, and
  the result is flagged `loopDetected`.

There is no round cap or wall-clock cap. For the browser agent that is an explicit
recorded decision: only the stall guard ends a run that stops progressing, and the
forced tools-free final round then salvages a report from what was gathered.

### A failed call is restated as an instruction

When a round's tool call fails — an `isError` result or a thrown error — the loop
appends a **system turn** naming the tool and its error, stating that nothing was
done, and giving the model its two exits: fix the call and try again, or tell the
user plainly that it failed.

This is not redundant with the honesty rules in the reply system prompt. A small
local model read a failed `tasks_delete`, could not explain it, and answered "done"
anyway (2026-08-05) — by the final round those rules are thousands of tokens back
and the failure is one unremarkable `tool` message. Restating it where the model is
deciding what to do next is what makes it land. Generic in the loop, so every
feature's tools get it.

### A round that produced nothing is asked again

A round can come back with **no message text and no tool call**: nothing the chat
can receive, and no work started. The loop appends a system turn saying exactly
that and asks once more (`MAX_EMPTY_ROUND_RETRIES = 1`); a second empty round is a
model with nothing to say, and the caller's empty-answer failure stands. The retry
is recorded as a warn step on the trace, so a turn that needed it cannot pass for
a clean one.

The failure it exists for (trace `ef8634e5…`, 2026-08-08): asked to find a photo,
gemma4:12b reasoned its way to the *correct* call and then emitted it inside its
reasoning as literal text — `<|tool_call>call:history_search{author:…}`, with the
chat template's quote tokens leaking into the argument values. `tool_calls` was
absent, content empty, `finish_reason: "stop"`. 600 tokens spent, nothing run, and
the group got a failure notice. This is a **tool-call dialect** failure, the one
class the backend normalization layer had recorded as *not* a problem.

Deliberately nothing is parsed out of the reasoning text. A call reconstructed
from garbled pseudo-syntax is a call the model never actually made, and tool
selection stays the model's. What the loop acts on is the mechanical fact that the
round produced nothing at all.

## Call kinds

`features/analytics/llm-call-kind.ts` is the taxonomy of LLM calls the app makes,
recorded on the trace event as `usage.callKind` and rendered as a label by the UI.

It exists as its own dimension because the trace's `feature`/`action` describe the
*action being traced*, not the call. One handled Telegram message is a single
`bot-messaging`/`reply` trace that can contain an addressing check, several tool
rounds and a final answer — three kinds of work with completely different cost
profiles, previously averaged into one number that moved with the mix rather than
with any actual request.

The kinds: `addressing-check`, `task-match`, `reply-tool-turn`, `reply-final`,
`vision-describe`, `voice-transcribe`, `history-summarize`, `memory-extract`,
`memory-consolidate`, `insight-hour`, `insight-rollup`, `browser-agent-turn`,
`browser-agent-report`, `task-fire`, `self-improve-analyze`,
`self-improve-reflect` (plus the retired `chat-rule-match` and
`scheduled-task-fire`, kept so pre-merge traces still label).

Model performance on the Analytics page groups trace rounds by model **and** by
call kind, which is only possible because this id is on the event.

## Parsing what a model returns

`lib/json.ts` parses JSON an LLM was asked to emit **leniently**: models routinely
wrap a requested object in fences or a sentence of prose, which `JSON.parse`
rejects outright. The helper takes the outermost `{ … }` span. Failing a whole
nightly run over punctuation is not an acceptable trade.

Every LLM-derived job fails **closed**: an unusable response leaves stored state
untouched and the unit stays owed for the next run. In particular an empty memory
merge is treated as a *failed* pass, never as "this is now empty", so a garbage
response can never erase a document that took months to build.

## MCP: how tools work here

Tools are exposed through the Model Context Protocol, but entirely **in-process**
— no sockets, no HTTP.

```
BotMcpRegistry ── in-memory transport pair ── McpServer
      │                                          │
      │ callTool()                               │ registered tools
      ▼                                          ▼
 tool-trace.ts wrapper                    features/*/server/mcp-tools.ts
      │
      └─► one trace per call, feature `mcp-tools-<owner>`
```

| Module | Role |
| --- | --- |
| `server/mcp/runtime.ts` | Process-wide registry singleton, built from the `REGISTRARS` table. Registers every feature's tools once and connects the client/server pair once. **New tool-owning features add their registrar to that table** |
| `server/mcp/registry.ts` | The registrar contract: a feature contributes its tools to the shared server |
| `server/mcp/in-process-transport.ts` | A linked pair wiring an MCP `Client` to a local `McpServer` in the same process. Messages are delivered on a microtask so `send` never re-enters the caller synchronously |
| `server/mcp/openai-tools.ts` | Pure conversions between MCP wire shapes and OpenAI tool shapes |
| `server/mcp/context.ts` | Per-turn context (see below) |
| `server/mcp/tool-trace.ts` | Wraps the single `callTool` choke point so every tool gets its own trace scope automatically |
| `server/mcp/tool-result.ts` | The normalized result type the tool loop consumes |

### Per-turn context — the security boundary

Tools are registered once at startup, but their execution is scoped to a single
chat turn. Rather than force the model to pass (and be trusted with) a chat id,
the runtime **binds** the current chat and speaker in an `AsyncLocalStorage`
context, and handlers read it from there.

The consequences are structural, not advisory:

- A tool can only ever touch the current conversation's data. It cannot be talked
  into writing memory into another chat or reading another chat's history.
- The person a fact is *about* defaults to the bound speaker, and is otherwise
  named by a name the model already sees — never a numeric id, which the model is
  never given. That reference is resolved against the actual participants of the
  current chat.
- Scheduled-task mutations are author-scoped: listing shows all of the chat's
  tasks, but a participant may only edit or cancel tasks they created. The owner
  is exempt and may edit or cancel any task in a chat they are in, including the
  authorless dashboard-created ones (user decision, 2026-08-07). Chat scoping is
  not part of the exemption. Owner status is resolved from the turn's authority,
  the same way the browser agent's download rights are.

### Tool tracing

Every MCP tool call is recorded **twice**, on purpose:

1. Inline on the reply trace as an `external_call` event, so the reply reads as one
   story.
2. As its own trace under feature `mcp-tools-<owning-feature>` with the tool name
   as the action, so each tool group has an independent Debug scope
   (`/debug?feature=mcp-tools-history`).

Wrapping the single `BotMcpRegistry.callTool` choke point means every current and
future tool gets its own scope with no per-tool wiring.

A tool that returns an **error result** (`isError`) settles its trace as `error`,
the same as a tool that threw: the tool ran, but the action the model asked for
did not happen, and an operator scanning Debug is looking for exactly that. (It
used to settle `success` on the reasoning that "it ran" — which left a failed
`tasks_delete` sitting in the list as a green row while the reply told the user
the task was cancelled.) The result itself still reaches the model unchanged.

### Tool authoring rules

- **All registered tools are always available** to the model during a reply.
  There is no per-tool on/off switch; the Tools page is read-only visibility.
- **Every tool self-describes**, and a tool description never references another
  tool by name. The system prompt lists no tools at all. The model chooses between
  tools from their descriptions alone.
- **Boundaries never throw.** A failed search, a blocked URL, a missing image
  model — each resolves to a result carrying a model-readable explanation, so the
  model can say "I couldn't do that" and carry on rather than aborting the whole
  reply.
- **Result text is the model's only evidence.** Where bytes travel out-of-band
  (generated images), the result text must be unambiguous in both directions: on
  success that the image is already in the chat and must not be described, on
  failure that nothing was sent.

## The tool catalog

26 tools across 9 owning features.

### History — `mcp-tools-history`

Deeper-than-the-window lookups. Two kinds, because they fail in opposite ways:
the literal ones are exact but blind (they only find what was worded the way the
query words it), while recall searches by meaning.

| Tool | Input | Purpose |
| --- | --- | --- |
| `history_search` | `query?` (string or array), `author?`, `media_kinds?`, `limit` | Hybrid search over this chat's full stored history — semantic, full-text and substring, fused by reciprocal rank. Finds media by **what it shows**, not just its caption. Returns anchored snippets, not full messages |
| `history_get_in_range` | `from`, `to` (ISO-8601) | This chat's messages in a range, oldest first |
| `history_get_by_message_ids` | `ids` (array) | Read messages referenced as `#<id>` in the transcript. Missing ids are omitted |
| `history_recall_topics` | `query` (string or array), `limit` | Search past daily topic summaries by meaning; returns date, summary and the message ids to read the originals |

`history_search` reads `chat_message_search` — a projection of each message
holding its own text **plus its media annotation**, embedded for semantic search
(see [data-model](./data-model.md) and
[background jobs](./background-jobs.md#message-search-index)). That is what makes
"find the photo of the front door" answerable: an uncaptioned photo's message row
holds `''`, and only the projection carries what the picture shows. Hits name
their author, so the `author` filter has something to be checked against; the
bot-vs-participant distinction and the self-authored-only warning are unchanged.

### Bot messaging — `mcp-tools-bot-messaging`

| Tool | Input | Purpose |
| --- | --- | --- |
| `reply_to_message` | `message_id`, `text` | Attach what is said to an earlier message: in a reply turn it retargets the turn's own reply (`text` empty); in a task fire it delivers `text` as a reply to that message |

Pointing at *one* message. When the answer names several, citing their `#<id>`s in
an ordinary sentence is the better shape — the delivery layer turns each cited id
into a link to that message (see
[Bot messaging](../features/bot-messaging.md#delivery)), so one reply can carry
three working references. The two compose: attach the reply to the main one, cite
the rest.

The one tool that changes **delivery** rather than doing work. Answering "where's
that photo of the door?" under the question leaves the asker to go looking; a
reply aimed at the found message quotes it and taps through to it. It sends
nothing itself — the turn still produces exactly one message — and it validates
the id against this chat's mirror first, because Telegram refuses a send whose
reply target it cannot find. Deliveries pass `allow_sending_without_reply`, so a
target that has since been deleted costs the pointer, not the answer.

### Memory — `mcp-tools-memory`

| Tool | Input | Purpose |
| --- | --- | --- |
| `memory_save` | `scope`, `person?`, `content` | Record **one** durable fact. The only way anything is remembered across conversations |
| `memory_get` | `person?` | Read every durable fact about one person |
| `memory_search` | `query` (string or array), `limit` | Semantic search across durable facts about people, including people not in this chat |

`memory_save`'s description is long by design: it states that saying "I'll
remember that" without calling the tool is a false promise, when to save
proactively, which scope a fact about a person belongs in (`user` for someone this
chat knows, `general` for anyone else), and that facts must be self-contained and
one per call.

### Tasks — `mcp-tools-tasks`

Standing rules and timed jobs for the current chat, one toolkit — see
[tasks.md](../features/tasks.md). Gates live in the service, per family:
standing (`message`/`on-reply`) kinds are self-serve in a DM and owner-only in
a group; timed kinds are open to create and creator-or-owner to mutate. Global
tasks are read-only here. A group standing task may name the people it applies
to, by ids copied from the roster in the group context — never resolved from a
name in code.

| Tool | Input | Purpose |
| --- | --- | --- |
| `tasks_list` | — | This chat's tasks with ids, triggers, and audience, plus the global ones |
| `tasks_get` | `id` | One task, including its saved context |
| `tasks_create` | `instruction`, `trigger`, `context`, `user_ids`, `every_minutes`, `delay_minutes`, `time`, `weekdays`, `date` | Save a standing rule or a timed job for **this** chat |
| `tasks_update` | `id` + any changed field, `applies_to_everyone` | Reword, retime, re-target, or pause/resume |
| `tasks_delete` | `id` | Remove a task for good |

The toolkit's second registrar owns the **outbound** delivery tool:

| Tool | Input | Purpose |
| --- | --- | --- |
| `send_message` | `text` | **Task fires only** — deliver a standalone message to the task's chat |

A timed fire's completion text is never sent; only `send_message` (and
`reply_to_message`, below) deliver. `getToolset({ outbound: true })` — asked
only by the task scheduler — is what offers `send_message` at all; a reply turn
never sees it, and its handler refuses without the fire's `deliver` context
binding.

### Web — `mcp-tools-browser-agent`

| Tool | Input | Purpose |
| --- | --- | --- |
| `browse_web` | `goal` | Enqueue a background browsing run: search, read, interact, download |

**This is the only web-facing tool.** `search_web` (Tavily) and `read_web_page`
(one-shot Chromium read) were removed on 2026-07-26 (user decision) — searching and
page reading both happen inside a run now, on a real browser, where the agent can
follow up on what it finds. Two weaker alternatives alongside it only split the
model's choice. See [Browser agent](../features/browser-agent.md); every URL the
model supplies is SSRF-checked before the browser touches it
([Security](security.md#ssrf-defense)).

### Images — `mcp-tools-image-gen`

| Tool | Input | Purpose |
| --- | --- | --- |
| `image_generate` | `prompt`, `size?` | Draw an image and send it to the chat |

The generated bytes deliberately do **not** travel in the tool result: they go to
the turn's `collectImage` sink and the pipeline delivers them after the reply. The
model never sees the image it asked for, which is exactly why the result text
forbids describing its contents.

### Users — `mcp-tools-known-users`

| Tool | Input | Purpose |
| --- | --- | --- |
| `update_user_aliases` | `name`, `aliases` | Record a nickname observed for a participant, so the bot recognizes that name later |

### Browser agent — `mcp-tools-browser-agent`

| Tool | Input | Purpose |
| --- | --- | --- |
| `browse_web` | `goal` | Enqueue a background run: a sub-agent drives a full browser, then reports back to this chat |

The chat model calls this and moves on — it does not drive the browser itself
(recorded decision: background run, not inline). The generic browser primitives
(`browser_navigate`, `browser_back`, `browser_click`, `browser_type`,
`browser_scroll`, `browser_read`, `browser_source`, `browser_get_network`,
`browser_screenshot`, `browser_wait`, `browser_download_file`,
`browser_download_stream`, `browser_download_media`) are plain OpenAI tool
definitions for the *agent's own* loop. They are **not** MCP tools and are never offered to the main chat model.

## Adding a tool

1. Write the handler in `features/<name>/server/mcp-tools.ts`, exporting a
   registrar and a `*_TOOL_NAMES` array.
2. Read the chat and speaker from the tool context — never from model input.
3. Make the boundary resolve rather than throw, and format the result text with a
   pure, unit-tested `format.ts`.
4. Add it to the `REGISTRARS` table in `server/mcp/runtime.ts` with its owning
   feature string and its `*_TOOL_NAMES`.
5. Add `mcp-tools-<owner>` to `lib/features.ts` — the id must equal
   `mcp-tools-${owner}` exactly, or the tool's Debug scope will be empty.
6. Add a `tool-selection.integration.test.ts` verifying a real model actually
   picks the tool for the phrasings it should (see
   [Testing](../development/testing.md)).

The declared `*_TOOL_NAMES` are load-bearing beyond grouping: the registry is a
`globalThis` singleton that **survives dev hot reload by design**, so a server
started before your registrar existed would otherwise keep serving the old tool
list forever. `loadMcpRegistry` compares the cached registry's registered names
against the table and rebuilds on any difference, so a new tool appears without a
restart. The names must therefore match what the registrar actually registers —
if they drift, the registry rebuilds on every single call. That is pinned in
`server/mcp/runtime.test.ts`.

The stale-registry symptom is worth recognising, because it does not look like a
registry problem from either end: the model is never offered the tool, so it
answers in prose and *promises* to do the thing (the base prompt's honesty rules
cannot save it — there was no tool to call), and `/tools` shows the same stale
list, which reads as a dashboard page nobody updated. Both are one object built
too early.
