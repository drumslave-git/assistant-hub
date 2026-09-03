# LLM integration and MCP tools

Everything the app asks a model to do goes through one of five OpenAI-compatible
clients in `server/llm/`. Everything the model can ask the app to do goes through
the MCP layer in `server/mcp/`: an in-process registry of the feature tools, plus
remote MCP servers reached over HTTP — the operator's tool connections and each
transport's own tool server.

Paths are relative to `apps/core/` unless they start with `apps/` or `packages/`.

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

Two backend types do not speak these OpenAI routes at all, and each rides the AI
SDK's native provider (`server/llm/provider.ts` picks the provider per
connection) plus its own model listing in `client.ts`:

- **`anthropic`** — native Messages API, `x-api-key` listing. The non-chat
  clients refuse it with a named error, since Anthropic serves no embeddings,
  image, or audio routes.
- **`google`** — the Generative Language API at `/v1beta`, `x-goog-api-key`
  listing (`pageToken` paging, ids namespaced `models/…` and stripped here).
  Chat, embeddings and images all resolve natively; speech and
  transcriptions-mode audio refuse with a named error, since neither sits on an
  OpenAI audio route. Gemini is reachable through an OpenAI-compatibility layer
  too, but the native provider carries thought signatures as a first-class field
  and resolves the thinking knob per model, which that layer does neither.

A third type speaks the OpenAI routes but not from the same base:

- **`zai`** — Z.ai (GLM). Chat, tools and `reasoning_content` are the ordinary
  OpenAI shape off the configured base (`…/api/paas/v4`), so the shared provider
  serves it. Two things are not ordinary. Thinking stops **only** on
  `thinking: {type: "disabled"}` — `reasoning_effort` and
  `chat_template_kwargs` are accepted and ignored, so a generic-typed row keeps
  paying reasoning tokens on every classifier call. And the model catalog lives
  on `/v1/models` while chat lives on the base: the base's own `/models`
  answers with a strict subset (8 ids against 14, missing the vision, flash and
  `:free` variants that chat completes with), so the listing is taken from
  `modelListingBaseUrl` — the one adapter hook for a catalog that is not beside
  the chat routes.

`classifier.ts` is not a sixth client but a call *shape* over `client.ts`: the
reasoning mode and token budget every per-message classification uses (addressing
analyzer and verifier, chat-rule match, honesty gate). It lives on its own so the
reply path and the Settings probe cannot drift apart on what a classification
costs — and so the numbers, all of which were measured, are written down once.
Which model answers them is the **classifier role** (see
[Configuration](../configuration.md#llm-roles-models-tab)); the shape is the same wherever
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
- **A tool call may carry vendor extras that must be echoed back.** Gemini signs
  every function call it emits, and replaying that call in the next round without
  its signature is a flat 400 (`Function call is missing a thought_signature in
  functionCall parts`) — so on a tool-using bot, every reply that touched a tool
  failed. The signature travels on the call itself, as `extra_content` in the
  conversation's OpenAI shape (`LoopToolCall` in `transport.ts`), and is handed
  back to the provider as `providerOptions.google.thoughtSignature` — which is
  what both the native Google provider and the OpenAI-compatibility layer read.
  On the compatibility layer the two halves of the SDK key it differently (the
  response files it under the provider's own name, the request reads only
  `google`), so the transport bridges them rather than naming one key.
- **A knob can be per model, not per backend.** "Do not think" is
  `thinkingBudget: 0` on Gemini 2.5, `thinkingLevel: "minimal"` on Gemini 3, and
  impossible on 2.5 Pro — so no fixed body field is right for more than one
  model. `LlmBackendAdapter.reasoningSetting` is the seam: the adapter states the
  intent in the SDK's normalized vocabulary and the provider resolves it against
  the model id it was handed, instead of this layer copying a mapping that goes
  stale with every model release.
- **Which roles a turn may use is the server's rule, not the caller's.**
  Anthropic takes instructions in a top-level `system` field, filled from the
  system turns at the head of the conversation; a `system` turn *inside*
  `messages` is a model-gated capability (`role 'system' is not supported on this
  model` — a 400 on 4.5 and older), while the reply prompt interleaves system
  turns for prompt-cache reuse and recency. `LlmBackendAdapter.normalizeMessages`
  is the seam: the Anthropic adapter passes the leading run through for the
  provider to hoist and hands every later run over as a `user` turn in the same
  position. Content and order are preserved; only that role changes, and it
  changes to the one this API accepts on every model. Every other backend leaves
  it unset and is sent the conversation exactly as assembled.

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

**What is asked depends on whether the turn has already run tools.** With nothing
run yet, the notice above is true and the tools stay offered — the missing thing
may well be a call. Once a call has run, the loop appends
`EMPTY_ROUND_AFTER_WORK_NOTICE` (the work above is done, what is missing is the
answer) and asks the round **with the tools withheld**, the same request the
stall guard makes, but not flagged `loopDetected` — the model is not stuck, it
just went quiet.

That split is what stops a *replayed side effect* (trace `796852a6…`,
2026-08-14): the model answered and called `tasks_create` in one round, the next
round came back empty (two output tokens), and the old notice told it "Nothing
was run and nobody received anything". Acting sensibly on a false premise, it
made the identical call again — two identical reminders three seconds apart. A
retry is safe for a round that did nothing and unsafe for one that did
something, so the two cannot share a notice; and withholding the tool is a
stronger guarantee than telling a model not to repeat itself.

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

Tools are exposed through the Model Context Protocol in two ways. The feature
tools are **in-process** — no sockets, no HTTP. Everything else is a remote MCP
server over Streamable HTTP: the tool connections an operator adds on the Tools
page, and the managed connection the core provisions for every registered
transport's own server (the Telegram one serves its reply, send and reaction tools at
`/mcp`).

```
BotMcpRegistry ── in-memory transport pair ── McpServer
      │                                          │
      │ callTool()                               │ registered tools
      ▼                                          ▼
 tool-trace.ts wrapper                    features/*/server/mcp-tools.ts
      │
      └─► one trace per call, feature `mcp-tools-<owner>`

resolveConnectionToolset(scope) ── http-client.ts ── remote McpServer (tool connection / a transport's /mcp)
      │  applied snapshot, `<slug>__<tool>` names, turn binding as `_meta`
      └─► one trace per call, feature `mcp-tools-connections`
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
| `server/mcp/http-client.ts` | The MCP client for remote servers: discovery (`listRemoteTools`) and calls (`callRemoteTool`) over Streamable HTTP with the connection's auth headers |
| `features/tool-connections/server/toolset.ts` | Turns the stored connections into the tools one turn may call: enabled, in the turn's source-app scope, open to this assistant. Offers the **applied snapshot**, never a live listing |
| `features/tool-connections/server/managed.ts` | Provisions and reconciles the transports' own servers as managed connections at boot and on every registration |

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

The storage itself is a `globalThis` singleton, like the registry. Next
evaluates the same server module in several bundles (instrumentation, where the
queue consumers and the schedulers run, and the app/Route Handler bundle behind
the dashboard), and dev hot reload adds another copy each time — but the
registry that holds the tool handlers outlives all of them. A storage owned by a
module instance is therefore bound in one copy and read from another, and every
tool fails with "no chat is bound" however correctly the pipeline bound the
turn. Keying the storage by name instead of by module identity is what keeps
the binding a fact about the process rather than about load order.

A **remote** tool has no access to that storage, so the same binding travels
with every call as request `_meta` under the key `assistant-hub/turn`
(`packages/contracts/src/tool-meta.ts`): source, chat, assistant, thread, the
message being answered, the speaker and their owner rights, and which delivery
the turn may perform. It is attached out of band — invisible in the tool
schema — so the model still chooses *what* to do and never *where*; a hosted
tool refuses a call that carries no binding. See
[Adding a transport](../development/adding-a-transport.md#the-turn-binding).

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

- **Every in-process feature tool is always offered** during a reply — there is
  no per-tool on/off switch and no embedding or keyword routing (user decision,
  2026-08-19). The only exception is the delivery tools, offered by turn kind
  (below). Tool *connections* are the operator's: each is enabled or not, scoped
  to every source app or one, and to every assistant or a selection, on the
  Tools page — and what it offers is the snapshot the operator applied, never a
  live listing that could change mid-conversation.
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

18 in-process tools across 8 owning features, plus the transports' own tools
(Telegram's three, on Telegram turns) and whatever tool connections the
operator has applied.

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

`history_search` reads `source_message_search` — a projection of each message
holding its own text **plus its media annotation**, embedded for semantic search
(see [data-model](./data-model.md) and
[background jobs](./background-jobs.md#message-search-index)). That is what makes
"find the photo of the front door" answerable: an uncaptioned photo's message row
holds `''`, and only the projection carries what the picture shows. Hits name
their author, so the `author` filter has something to be checked against; the
bot-vs-participant distinction and the self-authored-only warning are unchanged.

### Telegram — the transport's own server, `mcp-tools-connections`

Platform actions are not core tools: they are the transport's, served by its
own MCP server and reached as a managed connection scoped to that transport's
turns (the transport's own `src/mcp.ts`, offered to the model as `tg__<tool>`). Their calls
trace under `mcp-tools-connections` with the connection slug on the trace.

| Tool | Input | Purpose |
| --- | --- | --- |
| `reply_to_message` | `text` | **`message`-triggered task turns only** — reply to the message that triggered the task. The target is the turn's, carried in the binding, so there is no id for the model to get wrong |
| `send_message` | `text` | **Timed fires only** — send a standalone message to the task's chat |
| `set_message_reaction` | `message_id`, `emoji`, `big` | Put one of Telegram's reaction emoji on a message of this chat (empty `emoji` takes it back off) |

All three act on **the bound chat** only. `set_message_reaction` asks the
core's mirror before touching Telegram (`GET /api/internal/transports/messages`),
so the model can aim neither at another conversation nor at an id it invented,
and it refuses one target Telegram would happily accept — **the bot's own
messages** (an `assistant` row in the mirror), because a badge the bot puts on
its own message tells nobody anything. Another bot's message arrives as an
ordinary `user` row and stays fair game. The allowed emoji are Telegram's fixed
set, single-sourced in the transport's `src/reactions.ts` from the Bot API type and
carried in the tool's own description. Validity is checked in the **handler**,
not by a `z.enum`: the local backends this bot usually runs on template tool
JSON without enforcing schemas, so an off-list emoji has to come back as a
refusal written for the model rather than a raw schema error — and the
normalizer accepts the variation-selector spellings (`U+2764 U+FE0F`) that
Telegram itself rejects. A refusal from Telegram (a chat that allows only some
emoji, a message too old, the poller down) is relayed verbatim with "do not
claim you reacted", and the badge is recorded on the mirror row through a
`transport.bot-reaction` event so the next turn remembers reacting.

`set_message_reaction` is offered in **every** Telegram turn, unlike the two
delivery tools: a reaction is not a message, so there is nothing to
double-deliver, and the bot can react to the very message it is answering.

When an answer names several messages, citing their `#<id>`s in an ordinary
sentence is the better shape — the transport turns each cited id the core has
verified against the mirror into a link to that message (see
[Bot messaging](../features/bot-messaging.md#delivery)), so one reply can carry
three working references. Deliveries pass `allow_sending_without_reply`, so a
reply target that has since been deleted costs the pointer, not the answer.

The delivery tools report what they sent in the result's `structuredContent`
(`delivery: { ok, messageId, text }`), which is how the core counts a fire's
deliveries and stamps a task's wording without recognizing any tool by name.

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
name in code. **Paused** tasks are not in this toolkit's world at all: every
read goes through the service's chat-visible functions, so one cannot be listed,
read or mutated here, and no tool can pause anything — from a chat, cancelling a
task deletes it (user decision, 2026-08-14).

| Tool | Input | Purpose |
| --- | --- | --- |
| `tasks_list` | — | This chat's tasks with ids, triggers, and audience, plus the global ones |
| `tasks_get` | `id` | One task, including its saved context |
| `tasks_create` | `instruction`, `trigger`, `context`, `user_ids`, `every_minutes`, `delay_minutes`, `time`, `weekdays`, `date` | Save a standing rule or a timed job for **this** chat |
| `tasks_update` | `id` + any changed field, `applies_to_everyone` | Reword, retime, re-target |
| `tasks_delete` | `id` | Remove a task for good — how a chat cancels one |

A task-driven turn's completion text is never sent; a **delivery tool** is the
only path to the chat, and the delivery tools belong to the source the turn runs
on: Telegram's `reply_to_message` / `send_message` on its own server (above),
the web chat's `chat_reply_to_message` / `chat_send_message` in-process (below).
A turn is offered **at most one** of the pair: the reply tool for a
`message`-triggered turn (it is acting on a message, so the answer belongs under
it) and the send tool for a timed fire (nothing triggered it, so there is
nothing to reply to). An ordinary reply turn gets neither — its own text already
delivers itself.

The turn's `deliveryKind` (`reply` | `send` | none) decides which; the core
withholds the other, and the tool's handler checks the binding's kind as well,
so a stale toolset cannot let a fire claim it replied to a message that never
existed (user decision, 2026-08-14).

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

### Randomness — `mcp-tools-randomness`

| Tool | Input | Purpose |
| --- | --- | --- |
| `roll_chance` | `percent` (0–100) | Roll once against a percentage and report `hit`, `percent` and the `roll`. How a standing task worded "sometimes" or "in 30% of cases" gets an honest coin flip instead of a model's guess |

Read-only and side-effect free, but deliberately **not** idempotent: two
identical calls are supposed to disagree. See [Randomness](../features/randomness.md).

### Web chat — `mcp-tools-web-chat`

The web chat's delivery tools, in-process since the chat dissolve (Phase 6),
offered only on `chat` turns and only by the turn's `deliveryKind`
(`webChatToolOffered`):

| Tool | Input | Purpose |
| --- | --- | --- |
| `chat_reply_to_message` | `text` (≤8000) | **`message`-triggered task turns only** — reply into the thread, attached to the triggering message |
| `chat_send_message` | `text` (≤8000) | **Timed fires only** — post a standalone message into the thread |

Both store the message in the thread and ping the live view; they report the
delivery in `structuredContent` exactly like the Telegram pair, so the core's
bookkeeping is the same whichever source a task fires on.

### Browser agent — `mcp-tools-browser-agent`

| Tool | Input | Purpose |
| --- | --- | --- |
| `browse_web` | `goal` | Enqueue a background run: a sub-agent drives a full browser, then reports back to this chat |

**This is the only web-facing tool.** `search_web` (Tavily) and `read_web_page`
(one-shot Chromium read) were removed on 2026-07-26 (user decision) — searching
and page reading both happen inside a run now, on a real browser, where the
agent can follow up on what it finds. Two weaker alternatives alongside it only
split the model's choice. See [Browser agent](../features/browser-agent.md);
every URL the model supplies is SSRF-checked before the browser touches it
([Security](security.md#ssrf-defense)).

The chat model calls this and moves on — it does not drive the browser itself
(recorded decision: background run, not inline). The generic browser primitives
(`browser_navigate`, `browser_back`, `browser_click`, `browser_type`,
`browser_scroll`, `browser_read`, `browser_source`, `browser_get_network`,
`browser_screenshot`, `browser_wait`, `browser_download_file`,
`browser_download_stream`, `browser_download_media`) are plain OpenAI tool
definitions for the *agent's own* loop. They are **not** MCP tools and are never offered to the main chat model.

## Adding a tool

A tool that performs a **platform action** (send, react, pin, anything that
touches Telegram or another transport's API) belongs in that transport's own
MCP server, not here — see
[Adding a transport](../development/adding-a-transport.md#step-6--the-mcp-server).
A tool over the core's own data is an in-process feature tool:

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
