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
| `client.ts` | `/v1/chat/completions`, `/v1/models` | Replies, addressing analyzer, every LLM background job, the browser agent |
| `embeddings.ts` | `/v1/embeddings` | History summary embeddings, user-memory embeddings |
| `images.ts` | `/v1/images/generations` | The `image_generate` tool |
| `speech.ts` | `/v1/audio/speech` | Voice replies |
| `transcription.ts` | `/v1/audio/transcriptions` | Voice-message transcription |

Each of the four non-chat clients falls back to the core LLM connection when its
own base URL is unset — an embedding model usually comes from a different model
and sometimes a different host, but often enough the same one serves both.

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

## Call kinds

`features/analytics/llm-call-kind.ts` is the taxonomy of LLM calls the app makes,
recorded on the trace event as `usage.callKind` and rendered as a label by the UI.

It exists as its own dimension because the trace's `feature`/`action` describe the
*action being traced*, not the call. One handled Telegram message is a single
`bot-messaging`/`reply` trace that can contain an addressing check, several tool
rounds and a final answer — three kinds of work with completely different cost
profiles, previously averaged into one number that moved with the mix rather than
with any actual request.

The kinds: `addressing-check`, `reply-tool-turn`, `reply-final`,
`vision-describe`, `voice-transcribe`, `history-summarize`, `memory-extract`,
`memory-consolidate`, `insight-hour`, `insight-rollup`, `browser-agent-turn`,
`browser-agent-report`, `scheduled-task-fire`, `self-improve-analyze`,
`self-improve-reflect`.

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
| `server/mcp/runtime.ts` | Process-wide registry singleton. Registers every feature's tools once and connects the client/server pair once. **New tool-owning features add their registrar here** |
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
  tasks, but a participant may only edit or cancel tasks they created.

### Tool tracing

Every MCP tool call is recorded **twice**, on purpose:

1. Inline on the reply trace as an `external_call` event, so the reply reads as one
   story.
2. As its own trace under feature `mcp-tools-<owning-feature>` with the tool name
   as the action, so each tool group has an independent Debug scope
   (`/debug?feature=mcp-tools-history`).

Wrapping the single `BotMcpRegistry.callTool` choke point means every current and
future tool gets its own scope with no per-tool wiring.

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

17 tools across 8 owning features.

### History — `mcp-tools-history`

Deeper-than-the-window lookups. Two kinds, because they fail in opposite ways:
the literal ones are exact but blind (they only find what was worded the way the
query words it), while recall searches by meaning.

| Tool | Input | Purpose |
| --- | --- | --- |
| `history_search` | `query` (string or array), `limit` | Case-insensitive substring search over this chat's full stored history |
| `history_get_in_range` | `from`, `to` (ISO-8601) | This chat's messages in a range, oldest first |
| `history_get_by_message_ids` | `ids` (array) | Read messages referenced as `#<id>` in the transcript. Missing ids are omitted |
| `history_recall_topics` | `query` (string or array), `limit` | Search past daily topic summaries by meaning; returns date, summary and the message ids to read the originals |

### Memory — `mcp-tools-memory`

| Tool | Input | Purpose |
| --- | --- | --- |
| `memory_save` | `scope`, `person?`, `content` | Record **one** durable fact. The only way anything is remembered across conversations |
| `memory_get` | `person?` | Read every durable fact about one person |
| `memory_search` | `query` (string or array), `limit` | Semantic search across durable facts about people, including people not in this chat |

`memory_save`'s description is long by design: it states that saying "I'll
remember that" without calling the tool is a false promise, when to save
proactively, what never belongs in `general` scope, and that facts must be
self-contained and one per call.

### Scheduled tasks — `mcp-tools-scheduled-tasks`

| Tool | Input | Purpose |
| --- | --- | --- |
| `tasks_create` | `instruction`, `schedule_kind`, `time`, `weekdays`, `date` | Schedule a reminder for **this** chat |
| `tasks_update` | `id` + any changed field | Author-scoped edit |
| `tasks_delete` | `id` | Author-scoped cancel |
| `tasks_list` | — | This chat's tasks with ids, schedules and next run times |
| `tasks_get` | `id` | One task |

Not owner-gated (a recorded decision, unlike the MVP): any participant may create
tasks. Authorship is what limits mutation.

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
`browser_download_stream`) are plain OpenAI tool definitions for the *agent's own*
loop. They are **not** MCP tools and are never offered to the main chat model.

## Adding a tool

1. Write the handler in `features/<name>/server/mcp-tools.ts`, exporting a
   registrar and a `*_TOOL_NAMES` array.
2. Read the chat and speaker from the tool context — never from model input.
3. Make the boundary resolve rather than throw, and format the result text with a
   pure, unit-tested `format.ts`.
4. Register it in `server/mcp/runtime.ts` with its owning feature string.
5. Add `mcp-tools-<owner>` to `lib/features.ts` — the id must equal
   `mcp-tools-${owner}` exactly, or the tool's Debug scope will be empty.
6. Add a `tool-selection.integration.test.ts` verifying a real model actually
   picks the tool for the phrasings it should (see
   [Testing](../development/testing.md)).
