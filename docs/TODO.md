# TODO

The working tracker for pending work. It replaced `NEXTJS_REWRITE_PLAN.md` and
`NEXTJS_REWRITE_PROGRESS.md` (retired 2026-07-27): the v1 rewrite is complete,
so the phase plan, per-feature progress tables, session logs and the historical
Decision Notes are archive material — recoverable from git history — and only
the still-actionable information was carried forward here.

How to use this file:

- Update it before and after substantial work; statuses are `todo`,
  `in-progress`, `blocked`, `done`, `deferred`.
- A `done` entry records proof (files changed, tests run, build/typecheck/lint
  status, remaining risks) — and is then **pruned** once the work is shipped and
  documented under `docs/`. Git history is the archive; this file holds only
  open work.
- A `blocked` entry records the blocker, the attempted approach, and the next
  decision needed.
- Decisions are made by asking the user and recording the outcome against the
  entry it belongs to, here (no `docs/decisions/*.md` files).
- At handoff, leave short notes here: current state, next best task, known
  pitfalls, commands that passed or failed.

## Current state

v1 (priorities 1–14 in `AGENTS.md`) is complete and deployed: the app
independently runs the bot, dashboard, persistence, background jobs and Docker
deployment. Priorities 5–6 (search / read-link MCP tools) were later
superseded — `browse_web` is the only web tool (user decision, 2026-07-26).

## Voice: why transcription is failing in production (`blocked`, 2026-08-14)

Reported by the operator, 2026-08-14: voice messages come back with no
transcript. Two distinct symptoms on prod (`/api/health` reports **1.40.0**):

1. Media cards reading "Transcribed" with `(no speech)` and no content
   (~12:29–12:30 GMT+3).
2. `voice`/`transcribe` traces ending in `error` at **0 ms / 2 ms / 14 ms**, on
   three consecutive message ids in the same second (13:06:03 GMT+3) — the
   vision backfill working a batch.

Symptom 1 is **fixed** (next section): an empty answer was being stored as a
terminal `(no speech)`. Symptom 2 is the underlying failure and is still
**unknown** — sub-15 ms means the transcribe threw *before the wire*, so it is
configuration or a local process, not the endpoint. Candidates, in order:

- `toWavForTranscription` (`features/vision/server/service.ts`) — an ffmpeg
  spawn/transcode failure. ENOENT fails in single-digit ms, which fits best.
- `createOpenAiClient` (`server/llm/client.ts`) refusing an `anthropic` audio
  role in `transcriptions` mode — an instant, named `ApiError`.

**Blocker:** no authenticated access to `/debug`. The Browser pane blocks every
`/_next/static/*` asset with `net::ERR_BLOCKED_BY_CLIENT` (the `/login`
document itself is 200), so the page never hydrates and the sign-in form is
inert; the Claude-in-Chrome extension is not connected either. `/api/health` is
public and was the only reachable signal.

**Next decision needed:** the operator pastes the error message and event list
from one 13:06 `transcribe` trace (or its JSON bundle). That one string
separates ffmpeg-missing from a backend refusal — they read nothing alike.
Note that symptom 1's fix converts these into *more* such traces rather than
fewer: failures that were previously laundered into `(no speech)` now surface
as errors, which is the point.

## Voice: a failed transcription was stored as a finished one (`done`, 2026-08-14)

`parseTranscript` collapsed two opposite outcomes into the same empty string —
the transcriber explicitly reporting `[no speech]` (a terminal fact about the
audio) and the transcriber returning nothing at all (a failed call). The caller
then mapped that single empty string to `(no speech)` and stored it, marking the
row `described` and dropping the audio bytes. A failure became permanent and
invisible: a "Transcribed" card with no content that no pass would ever retry.
The image path one branch above already did the honest thing
(`skip("empty description")`), so the two disagreed.

- **Files changed:** `features/voice/format.ts` (`parseTranscript` →
  `readTranscript`, returning a `TranscriptOutcome` discriminated union),
  `features/vision/server/service.ts` (an `empty` outcome throws
  `ApiError.serviceUnavailable`, naming endpoint vs model),
  `server/llm/transcription.ts` (`chat` mode no longer pre-collapses the marker,
  so `TranscriptionResult.text` means the same thing in both modes),
  `features/voice/format.test.ts`, `features/voice/server/voice.integration.test.ts`,
  `docs/features/voice.md`.
- **Tests:** `format.test.ts` 6/6; `voice.integration.test.ts` 9/9 including two
  new cases (chat model returns whitespace; dedicated STT answers with no text).
  Both new tests were confirmed to **fail** against the old behavior with
  `expected 'described' to be 'pending'` — the operator's exact symptom.
- **Lint/typecheck:** both clean. Full `npm run test`: 1083 passed, 21 failed —
  all 21 in `browser-agent` yt-dlp tests, failing identically on a clean tree
  (yt-dlp is not installed on this machine), unrelated to this change.
- **Remaining risk:** none to the stored data shape, but the live reply path now
  takes the "transcription failed" branch (`VOICE_UNAVAILABLE_NOTE`) in cases
  that previously produced a `(no speech)` transcript — the bot says it could
  not listen instead of answering a blank. That is the intended behavior. Rows
  already stored as `(no speech)` by the old code are **not** repaired by this
  change; they are terminal and their audio bytes are gone.

## Google (Gemini) as a native backend type (`done` pending key-in-hand verification, 2026-08-14)

User decision, 2026-08-14, immediately after the thought-signature fix below:
use `@ai-sdk/google` rather than keep reaching Gemini through its
OpenAI-compatibility layer. Same shape as the Anthropic backend that shipped
earlier the same day.

### What shipped

- **New backend id `google`** (`lib/llm-backend.ts`, labeled "Google (Gemini)"):
  plain-text column, no migration. Zod enums, the Backends UI and the OpenAPI
  enum pick it up from `LLM_BACKEND_IDS`.
- **Native provider** (`@ai-sdk/google` 4.0.44, new dependency): `createProvider`
  branches on the backend and returns `languageModel` / `embeddingModel` /
  `imageModel` — Gemini serves all three, so unlike Anthropic none of them
  refuse. `providerOptionsName` returns `google`. `toGoogleBaseUrl` (new, beside
  `toOpenAiBaseUrl`) appends `/v1beta` rather than `/v1` and leaves an
  explicitly versioned URL alone.
- **`LlmBackendAdapter.reasoningSetting`** (new optional member, implemented only
  by `google`): expresses the reasoning intent through the SDK's normalized
  setting instead of a body field, because Gemini's off-switch is
  `thinkingBudget: 0` on 2.5, `thinkingLevel: "minimal"` on Gemini 3 and
  impossible on 2.5 Pro — a fixed field would be a 400 on whichever family it was
  not written for. The provider already resolves it against the model id; this
  layer would otherwise have to copy that mapping and keep it current.
  `chatBodyExtras` for `google` therefore returns `{}`.
- **Adapter**: `readReasoning` reads native `candidates[].content.parts[]` with
  `thought: true` (Gemini interleaves thinking as flagged text parts — no
  separate field); overflow pattern `/input token count/i` (Google's phrasing
  carries no "context" word), behavior `error`; `normalizeServedModelId` strips
  the listing's `models/` namespace so one model is not counted as two.
- **Native listing** (`listGoogleModels`): `GET /v1beta/models?pageSize=1000`
  with `x-goog-api-key`, following `nextPageToken`, ids de-namespaced, errors
  mapped to the shared `LLM endpoint error (status): detail` wording — including
  Google's **array-wrapped** `[{error:{message}}]` body, which every
  `{error:{message}}` reader misses.
- **Detect** recognizes `generativelanguage.googleapis.com` by hostname with
  zero probes, like Anthropic.
- **Speech and transcriptions-mode audio refuse with a named error**
  (`createOpenAiClient`): Gemini has both capabilities but neither sits on an
  OpenAI audio route, and those two roles are the only ones that reach that
  client.
- Docs: `configuration.md`, `features/backends.md`,
  `architecture/llm-and-mcp.md`, `api/openapi.yaml`.

### Proof

Lint clean; typecheck clean; `next build` clean. Unit: `server/llm` 155/155,
full suite 1082 passed / the same 21 pre-existing yt-dlp + media-download
Windows failures. Integration: backends + settings + status 59/59 against real
Postgres. New tests, all against the real provider with a stubbed fetch rather
than a mock of it:

- The **same call** produces `thinkingConfig: {thinkingBudget: 0}` on
  `gemini-2.5-flash` and `{thinkingLevel: "minimal"}` on `gemini-3-pro-preview`
  — the per-model resolution reaching the wire, which is the entire reason
  `reasoningSetting` exists.
- A two-round `chatCompletionWithTools` on the native provider: round 1's
  `functionCall` carries `thoughtSignature`, and round 2's `contents` replays it.
- Listing: `/v1beta/models`, `x-goog-api-key` with no `Authorization`,
  `pageToken` paging, `models/` stripped, and the array-wrapped 400 read.
- Adapter: native thought parts, overflow phrasing, namespace folding, and that
  no other backend claims `reasoningSetting`.

### Remaining risks / operator steps

- **Not yet exercised with a real key** — the assistant handles none. Create the
  backend with the key: Test connection should list `gemini-*` ids; then point
  the chat role at it and run the Settings chat probe and a tool-using message.
- **The dropdown was not seen in a browser**: no dev server was running, and a
  restart drops the preview's login, which the assistant cannot restore. The
  option is data-driven from `LLM_BACKENDS` and the build is clean, but the
  visual check is the operator's.
- The overflow phrasing is Google's documented wording, **not** observed live;
  if a real overflow reads differently, the pattern is the place to fix.
- Vision, browser agent and the two aux roles inherit the chat backend as usual,
  so pointing chat at Gemini moves them too unless they are set explicitly.

## Tool calls and system turns broke on hosted backends (`done` pending live verification, 2026-08-14)

Two operator reports the same day, both 400s that killed the whole reply, both
from the same root cause: the conversation was assembled for the local
OpenAI-shaped servers this app grew up on, and a hosted provider's own rules
about it were never carried.

1. **Gemini** — `[{"error":{"code":400,"message":"Function call is missing a
   thought_signature in functionCall parts … function call
   `default_api:memory_save`, position 3","status":"INVALID_ARGUMENT"}}]`. Gemini
   signs every function call it emits and rejects any request whose history
   replays one unsigned. Round 1 (the call) succeeded; the round that re-sent it
   with the tool result never could — so **every reply that touched any MCP tool
   failed**, and only those.
2. **Anthropic** — `messages.1: role 'system' must precede an 'assistant'
   message or end the array`. The reply prompt interleaves system turns on
   purpose (per-chat blocks above the history window for prompt-cache reuse;
   per-turn directives directly below it, the language directive last for
   recency), and each cluster is followed by a `user` turn. On Anthropic **every**
   reply failed, tools or not.

### What shipped

- **Vendor extras ride the tool call** (`server/llm/transport.ts`): new
  `LoopToolCall` = the OpenAI-shaped call plus `extra_content`, which is exactly
  where Google's OpenAI-compatibility layer carries the signature. `completeRound`
  reads it off the SDK's per-call `providerMetadata` and `toModelMessages` hands
  it back as `providerOptions.google.thoughtSignature`. The two halves of
  `@ai-sdk/openai-compatible` disagree on the key — the response files it under
  the provider's own name (`llm` here), the request builder reads only `google` —
  so the transport scans the metadata entries rather than naming one key, which is
  what would regress silently if the provider were ever renamed. The loop already
  appends the call object verbatim, so nothing else changed.
- **`LlmBackendAdapter.normalizeMessages`** (`server/llm/backends/types.ts`,
  optional; only `anthropic` implements it): `toAnthropicSystemPlacement` merges
  each run of consecutive system turns into one block and moves a block that
  would sit in front of user turns to just after them, where it precedes the
  assistant's answer or ends the array. Nothing is dropped and relative order is
  kept; the leading block stays leading (the provider lifts it into the top-level
  `system` field, which is what the KV-cache prefix depends on). Applied once in
  `completeRound`, so both the tool loop and plain completions get it.
  **Decision taken in implementation, not asked**: moving the per-turn directives
  to *after* the message they are about was preferred over folding them into the
  user turn — it is the only legal spot that keeps them a separate turn, and it
  moves the way the placement was already reaching (maximum recency).

### Proof

Lint clean; typecheck clean. `server/llm` 143/143, full unit suite 1070 passed /
the same 21 pre-existing yt-dlp + media-download Windows failures. New tests, all
written so the pre-fix code fails them:

- `transport.test.ts` — a two-round `chatCompletionWithTools` against a stubbed
  Gemini-shaped endpoint asserting the **second** request's assistant turn still
  carries `extra_content.google.thought_signature` (a conversion-only unit test
  would have passed while the bot stayed broken); plus the conversion both ways.
- `transport.test.ts` — `chatCompletion` on an `anthropic` connection with the
  real native provider and a stubbed fetch: the wire body's `system` field holds
  the prefix and its `messages` roles are `user, assistant, user, system` with no
  illegal system placement. This is the half no pure test can see — that the
  provider emits those turns as `system` messages rather than hoisting them.
- `backends.test.ts` — the rewrite asserted against Anthropic's rule directly
  (a predicate over the messages, not a hand-copied array), that every block
  survives in order, that an already-legal arrangement is untouched, and that no
  other backend has a normalizer at all.

### Remaining risks / operator steps

- **Neither fix is yet observed against the live providers** — the assistant
  holds no key for either. Gemini: point the chat role at the endpoint and send a
  message that uses a tool. Anthropic: any message at all.
- If the Gemini endpoint is reached **through OpenRouter** rather than directly,
  the mechanism may differ (OpenRouter relays Google's signatures in its own
  `reasoning_details` shape). The raw array-wrapped error body in the report is
  Google's own, with no OpenRouter envelope, so the direct endpoint is what this
  targets; a trace from the failing turn would settle it.
- The Anthropic rewrite changes prompt composition on that backend only: two to
  five system blocks arrive merged into one, positioned after the user turn.
  Worth a read of the first live trace to confirm the directives still land the
  way they were tuned to.

## Anthropic (Claude) as a native backend type (`done` pending key-in-hand verification, 2026-08-14)

User report, 2026-08-14 (screenshot): pointing a Generic backend at
`https://api.anthropic.com/v1` failed Test connection with
`LLM endpoint error (401): Invalid bearer token`. Diagnosis: the test's
`GET /v1/models` is **not** part of Anthropic's OpenAI-compatibility layer
(which covers chat completions only) — the native route wants `x-api-key` +
`anthropic-version` and rejects any Bearer API key before validating it.
**User decision: full native Anthropic integration** (over an
OpenAI-compat-shim backend type, and over "diagnosis only").

### What shipped

- **New backend id `anthropic`** (`lib/llm-backend.ts`, option labeled
  "Anthropic (Claude)"): plain-text column, no migration. Zod enums and the
  Backends UI pick it up from `LLM_BACKEND_IDS`.
- **Chat rides the AI SDK's native provider** (`@ai-sdk/anthropic` 4.0.38, new
  dependency): `createProvider` (`server/llm/provider.ts`) branches per
  connection and now returns a normalized `LlmProvider`
  (`languageModel`/`embeddingModel`/`imageModel` — the factory names the two
  provider families share); the transport calls `languageModel` and keys
  `providerOptions` per connection (`providerOptionsName`: the shared `llm`
  name, or the SDK-fixed `anthropic`). Tool loop, traces, retry policy
  untouched — the wire dialect lives in the provider.
- **Adapter** (`server/llm/backends/adapters.ts`): reasoning `off` →
  `thinking: {type: "disabled"}` (valid across the meetable model range; only
  `claude-fable-5` rejects it); `low` dropped — Anthropic's briefly-please
  knobs (`effort`, adaptive) are model-gated, and an intent a server cannot
  express is dropped, never approximated. `readReasoning` reads native
  `content[]` thinking blocks (empty by default on Opus 4.7+ — Anthropic's
  default, not a missing channel). Overflow pattern `/prompt is too long/i`
  (their wording carries no "context" word), behavior `error`.
- **Native model listing** (`listAnthropicModels` in `server/llm/client.ts`):
  `GET /v1/models?limit=1000` with `x-api-key` + `anthropic-version:
  2023-06-01`, following `has_more`/`last_id` pagination; errors mapped to the
  same `LLM endpoint error (status): detail` wording as every other backend.
  `listModels` branches on the declared backend.
- **Test connection carries the form's `type`** (`testBackendSchema` +
  `testBackend` + both forms): the listing differs per backend now, so the
  test probes what the operator is about to save, not what a stored row says.
- **Detect** recognizes `api.anthropic.com` by hostname without sending a
  single probe (Anthropic serves no unauthenticated fingerprint route).
- **Non-chat roles refuse with a named error** instead of relaying a 404:
  `createProvider`'s anthropic `embeddingModel`/`imageModel` factories and
  `createOpenAiClient` (speech, transcriptions-mode audio) throw
  "Anthropic backends serve chat models only — pick a different backend…".
  Chat-shaped roles (chat, vision, browser agent, classifiers, background)
  work; vision image parts convert natively in the provider.
- Docs: `configuration.md`, `features/backends.md`,
  `architecture/llm-and-mcp.md`, `api/openapi.yaml` (BackendType enum + test
  body `type`).

### Proof

Lint clean; typecheck clean. Unit: full suite 1064 passed / the same 21
pre-existing yt-dlp + media-download Windows failures (new: adapter body/read
pinning incl. the native thinking-block shape, detect-by-hostname with zero
probes sent, native listing pagination + header assertions + 401 mapping, and
a transport test proving `thinking: {type:"disabled"}` reaches the native
request body under `providerOptions.anthropic` with `x-api-key` auth — same
stub-fetch philosophy as the existing provider tests). Integration: backends
11/11, settings + status 48/48.

Browser-verified against the live dev server: the type dropdown lists
"Anthropic (Claude)"; Detect on `https://api.anthropic.com/v1` answered
"Detected Anthropic API (api.anthropic.com)" and switched the type; Test
connection (no key) now reaches the **native** route — the error became
`LLM endpoint error (401): x-api-key header is required`, Anthropic's own
message, where the generic path died on `Invalid bearer token` regardless of
key.

### Remaining risks / operator steps

- **Key-in-hand verification is the operator's step** (the assistant does not
  handle API keys): create the backend with the real key — Test connection
  should list `claude-*` models — then point the chat (or vision) role at it
  and run the Settings chat probe. Not yet observed with a real key.
- The reply path sends no `max_tokens` by default; the provider fills the
  model's own output cap for known `claude-*` ids. A truncated-looking reply
  on an unknown/new model id would be the 4096-token compatibility default —
  visible in the trace's request body.
- `reasoning: "off"` maps to `thinking: {type: "disabled"}`, which
  `claude-fable-5` rejects (400) — if that model is ever configured for the
  classifier role, the adapter mapping is the place to revisit.
- Anthropic has no audio input on the chat route: chat-mode audio (STT) on an
  Anthropic backend sends the turn's text without the audio part (the
  transport drops `input_audio` for all AI SDK backends) — the audio probe
  reports what actually comes back rather than failing.

## Unified tasks (`done` pending production deploy, 2026-08-13)

User direction, 2026-08-13: a significant rework. Scheduled tasks become just
**tasks**; chat rules are absorbed; hardcoded fire delivery is replaced by
outbound MCP tools the model chooses to call.

User decisions (2026-08-13):

1. **One feature.** A task = instruction + trigger. Trigger kinds:
   - `message` — fires when an incoming message matches the instruction (the
     chat-rules `always` matcher machinery, incl. per-user targeting, sender
     labels, and the citation guard);
   - `on-reply` — no fire of its own; the instruction is composed into every
     reply prompt (the old shaping rules, folded in — user picked "fold into
     tasks" over a separate slim rules feature);
   - `interval` — every N minutes/hours/days ("every 10m");
   - `timeout` — one-shot, relative to creation ("in 1h");
   - `schedule` — calendar-based (the current once/daily/weekly shape).
2. **No hardcoded sending.** A fire runs a full tool loop (same toolset as a
   reply) plus new outbound tools — `send_message`, `reply_to_message` — bound
   to the task's own chat (user decision: no cross-chat sends). The completion's
   final text is traced, never delivered; only tool calls deliver.
3. **Silence is allowed** for timed fires (enables "check X, message only if Y";
   the trace records a quiet fire). Message-triggered fires keep the chat-rules
   enforcement: a matched message demanded an action, so a no-tool turn is
   retried once with the enforcement directive, then suppressed with an honest
   notice.
4. **Clean cut.** `chat_rules` and `scheduled_tasks` (tables, features, pages,
   toolkits) are removed in the same release; the new `tasks` table starts
   empty and the operator re-creates the handful of live entries. One `/tasks`
   page replaces `/scheduled-tasks` and `/rules`.

Decisions made in implementation (defaults, not asked):

- Scope: `chat_id` stays nullable, but **null (global) is valid only for
  `message` / `on-reply` kinds** — a timed task acts in a chat, so it needs one.
  Per-user targeting stays valid for `message`/`on-reply` in groups only.
- Permission gates carry over per kind, unchanged in spirit: `message`/`on-reply`
  keep the rules gate (self-serve in a DM, owner-only in a group);
  `interval`/`timeout`/`schedule` keep the scheduled-tasks gate (create freely
  in chat, mutate own or as owner).
- Interval floor: 1 minute (tick is 30s); `timeout` is a one-shot — fires once,
  then the row is deleted like a spent one-shot today, with the same
  failed-attempt retry/disable behavior.
- Outbound tools are registered like any toolkit but refuse outside a fire
  context (a reply turn already delivers its text; `send_message` there would
  double-send). Exact mechanism decided at the registry.
- A **message-triggered** task turn keeps the reply-pipeline execution it has
  today (context assembly, vision, browse ack flow, the no-tool enforcement
  retry + suppression notice, auto-delivered reply to the triggering message).
  "No hardcoded sending" targets the *timed* fire path, which today generates
  text and blindly sends it — that is what the outbound tools replace. The
  message path never had a hardcoded send: the model's reply IS the delivery,
  and real actions were already enforced as tool calls.
- Outbound tools (`send_message`, `reply_to_message`) are therefore offered
  **only to timed fires**: `getToolset` gains a filter (reply turns never see
  them — a reply that calls `send_message` would double-deliver), and the tools
  read a `deliver` sink on the MCP tool context that only the fire binds.
- The matcher's system prompt text is ported **verbatim** (it was live-tuned on
  2026-08-13, both directions pinned) — only module/type names change.
- `tasks` table: one row shape with per-kind nullable columns (`every_minutes`,
  `delay_minutes`, `time_of_day`/`weekdays`/`run_date`), `target_user_ids`,
  `source` provenance, and the existing attempts/recent-deliveries lifecycle.
  The 32-per-scope cap applies to prompt-composed kinds (`message`/`on-reply`)
  only — it is a prompt-budget fact, not a scheduling one.

### What shipped (`done` pending production deploy)

Everything above, as specified. The per-user targeting and the live-tuned
two-step matcher prompt (both shipped earlier on 2026-08-13 under chat rules —
see git history for that entry) carried over intact into `message`/`on-reply`
tasks.

- New `features/tasks/` (types, trigger math, format, matcher, schema,
  repository, service, fire, scheduler, CRUD + outbound MCP tools, UI), the
  `/tasks` page, `/api/tasks` (+`[id]`, `/run`). `getToolset({ outbound })`
  carve-out in `features/mcp-tools`; `deliver` binding on the MCP tool context;
  `sendChatMessage` gained `replyToMessageId`. `reply_to_message`
  (bot-messaging) is now dual-mode: retargets in a reply turn, delivers in a
  fire.
- Removed: `features/chat-rules/`, `features/scheduled-tasks/`, `/rules` +
  `/scheduled-tasks` pages and APIs, their feature ids and tools. Migrations
  `0054` (drop both tables, clean cut) + `0055` (create `tasks`), **applied to
  the dev DB**. Trace `callKind`s: `task-match` / `task-fire` (retired ids kept
  for old traces).
- Docs: `docs/features/tasks.md` replaces `chat-rules.md` +
  `scheduled-tasks.md`; data-model, llm-and-mcp, endpoints + openapi, operator
  guide, troubleshooting, background-jobs, testing, specialists, security,
  README, `AGENTS.md` note.

### Proof

Lint clean; typecheck clean; `next build` clean (route table shows `/tasks`,
old routes gone). Unit suite: the only failures are the pre-existing
Windows-only `ytdlp-binary`/`media-download` ones. Integration:
`tasks.integration.test.ts` (scopes, caps, targeting, per-kind gates, timing)
and `scheduler.integration.test.ts` (settle per kind, quiet fires, one-shot
retry/disable) green against real Postgres; `live-matcher.integration.test.ts`
ported (opt-in, `LLM_LIVE=1`).

### Remaining risks / follow-ups

- **Not yet observed live**: a real timed fire delivering via `send_message`
  (the whole delivery inversion), and the model picking the right `trigger` in
  `tasks_create` from chat phrasings. The old live-flow + tool-selection
  LLM_LIVE tests were deleted with chat-rules and not yet rewritten for tasks —
  `todo`: port `live-flow.integration.test.ts` (group message-task download +
  DM chat-side create) and the tool-selection cases to the unified toolkit.
- The matcher prompt remains tuned against the locally configured classifier;
  re-run `live-matcher` after changing the classifier model.
- A person-only `message` task opens a turn on **every** message that person
  sends; worth watching on the first real one.
- The operator re-creates the handful of live rules/tasks after deploying (the
  clean cut dropped both tables).

## Audio transcription modes + vision probe + relayed error detail (`done` pending production deploy, 2026-08-12)

User decisions, 2026-08-12: the audio (STT) role must **support both**
transcription styles — the OpenAI `/v1/audio/transcriptions` endpoint
(whisper-class servers) *and* an `input_audio` chat completion (OpenRouter and
other chat-only providers) — chosen explicitly via a new **Transcription mode**
select on the Audio tab; and the Vision tab gets a real **Test vision** probe
(a model listing cannot reveal a missing image-input modality — discovered when
OpenRouter's gemma-4 turned out to accept no audio at all).

### What shipped

- `settings.audio_transcription_mode` (`transcriptions` | `chat`, default
  `transcriptions`; migration `0051_salty_ezekiel`, **applied to the dev DB**).
  Flows through schema/service/UI; "Test audio" takes the form's current mode.
- `TranscriptionRuntime` carries `mode`; `transcribeAudio`/`probeTranscription`
  dispatch on it (chat mode = `buildTranscribeMessages` + `chatCompletion`).
  The live voice path routes chat-mode STT through `resolveDescribeDeps`'
  existing `input_audio` branch (usage recorded on the trace) on the audio
  role's own connection; the status probe follows the mode automatically.
- `testVision` service + `POST /api/settings/test-vision`: describes a tiny
  sharp-generated PNG (`server/media/image.ts`, twin of `tinySilenceWav`)
  through the resolved vision runtime, including the chat-model fallback.
- Relayed provider errors surfaced: OpenRouter's `error.metadata.raw` /
  `provider_name` (the actual upstream failure behind a generic "Provider
  returned error") now appear in `ApiError` messages and hence traces —
  `relayedProviderDetail` in `server/llm/client.ts`, wired into both
  `apiErrorDetail` (OpenAI SDK path) and `sdkErrorDetail` (AI SDK path).

### Proof

Files: `db/schema.ts` + `db/migrations/0051`, `server/llm/transcription.ts`,
`server/llm/client.ts`, `server/media/image.ts` (new),
`features/settings/server/{repository,schema,service}.ts`,
`features/settings/ui/SettingsForm.tsx`, `features/vision/server/service.ts`,
`app/api/settings/test-{audio,vision}/route.ts`.

Lint clean; typecheck clean except the same three stale `.next/types` lines;
settings integration suite 25/25 (new: mode round-trip, chat-mode `testAudio`
asserting the `input_audio` request shape, `testVision` incl. fallback and
clean rejection); `error-detail` unit suite 8/8 (new OpenRouter
`metadata.raw` case). Browser-verified against the live dev server and real
OpenRouter: chat-mode "Test audio" with `nemotron-3-nano-omni-30b-a3b`
(`:free`) returned 200 with empty transcript for the probe silence; "Test
vision" described the red probe square via the chat-model fallback; a 429 on
the first vision attempt displayed the relayed detail ("(Google AI Studio)
…temporarily rate-limited upstream…") proving the error-detail fix live.

### Follow-up shipped the same day: Google-compatible tool schemas

The surfaced detail immediately named the real reply failure on
OpenRouter→Google (gemma-4): three MCP tool declarations violated Google's
strict schema validation — `""` enum members (`tasks_update.schedule_kind`,
`rules_update.trigger`; "optional" is now modeled by omitting the field) and
`image_generate.size`'s `z.tuple` (positional `items: [...]`; now
`z.array(dimension).length(2)`). One bad declaration 400s the whole reply
call, so every tool-bearing reply failed on that provider.
`server/mcp/schema-compat.test.ts` lint-checks every registered tool's
serialized parameters against these rules so no future tool reintroduces
them. Handlers already treated falsy as "unchanged" — no behavior change.
Note: the MCP registry singleton survives dev hot-reload and its staleness
check compares tool *names* only, so a schema-only change needs a dev-server
restart to serve (done).

### Remaining risks

- Production deploy runs 0051 (single additive column with default — low risk).
- OpenRouter serves **no audio input on gemma-4** (`image, text, video` only),
  so the operator's "gemma-4-26b for audio" plan needs an audio-capable model
  there (only `:free` option today: `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`).
- Chat-mode status probes make a real (tiny) LLM call when audio is configured
  — same "real probe" doctrine as before, now potentially against a paid
  provider.

## Separate LLM configuration for auxiliary calls (`done` pending production deploy, 2026-08-13)

User request, 2026-08-13: *"separate configuration for aux calls llm —
adressing, honesty check, summarization, etc etc"*. Every non-reply call
resolved `getLlmRuntime()`, so the whole app rode one model.

Decisions taken with the user before implementing:

- **Two aux roles, not one** — Classifiers (addressing analyzer + verifier,
  chat-rule match, honesty gate) and Background jobs (history summaries, memory
  extract/consolidate, analytics insights, self-improvement reflection). One
  bucket would force a bad trade: the classifiers run on every group message and
  want a small fast model, while the background jobs read long transcripts and
  want a capable one. Splitting them lets both be right.
- **Scheduled tasks stay on the chat role** — a fired task is a real
  user-facing message through the tool loop, so it holds the reply quality bar.

### What shipped

- **Two roles** (migration `0052_brave_menace`, **applied to the dev DB**):
  `classifier_backend_id`/`classifier_model` and
  `background_backend_id`/`background_model`, both "main by default" — each
  unset half falls back to the chat backend/model, so an installation that never
  opens the new tabs behaves exactly as before.
- **`toInheritingRuntime`** replaces what would have been the third and fourth
  copy of the vision/browser resolver; `getClassifierRuntime` and
  `getBackgroundRuntime` join them. Both roles are ordinary listed roles for
  stale-model clearing (`ROLE_FIELDS`).
- **`server/llm/classifier.ts`** — the classification call shape (thinking off,
  `CLASSIFIER_MAX_TOKENS`, the honesty gate's tighter budget) lifted out of
  `process-update.ts`, which held it as file-local constants. It had to move for
  the probe to exercise the same call the bot makes; the win is that the reply
  path's three call sites and the probe now cannot drift.
- **Probes that run the real thing**, per the standing doctrine: `testClassifier`
  runs the **actual addressing check** (real prompt builder, real verdict
  parser) over a synthetic message naming a synthetic bot; `testBackground` runs
  the **actual summarizer** (real system prompt, transcript format, topic
  parser) over a tiny synthetic chat-day at background priority. Both report a
  poor answer rather than throwing — and both catch a failure that is otherwise
  silent in production: an unreadable verdict reads as "not addressed" (the bot
  stops answering when called), and prose instead of topic JSON stores an empty
  day while the job reports success.
- Overview gained two cards, `inherited` ("Chat model") until overridden. The
  status fallback detail is now per role rather than one sentence: the aux roles
  are plain completions with no modality to require.

### Proof

Files: `db/schema.ts` + `db/migrations/0052`, `features/settings/server/{repository,schema,service}.ts`,
`features/settings/ui/SettingsForm.tsx`, `server/llm/classifier.ts` (new),
`server/telegram/process-update.ts`, `server/status.ts`,
`features/{history/server/summary-scheduler,memory/server/scheduler,analytics/server/scheduler}.ts`,
`features/self-improvement/server/{scheduler,reflect}.ts`,
`app/api/settings/test-{classifier,background}/route.ts` (new), tests
(`settings.integration`, `status.integration`, `server/llm/classifier.test.ts`
new), docs (`configuration.md`, `features/settings.md`, `api/endpoints.md`,
`api/openapi.yaml`, `operations/operator-guide.md`,
`architecture/{data-model,llm-and-mcp}.md`).

Lint clean; typecheck clean (the three stale `.next/types` lines are gone — the
dev server rebuilt). Settings integration 69/69 (7 new: both roles inherit then
override independently of chat and each other; classifier probe runs the real
analyzer prompt with thinking off and a 3k cap; unreadable verdict reported not
swallowed; background probe uses its own backend at background priority and
parses topics; prose reported as zero topics; clean rejections). Status
integration: the two new endpoints report `inherited`, not `off`, once a chat
model is set. Integration: `server/` 5 files / 25 tests, `features/` 22 files /
350 tests pass. Unit: `server/` 232/232 (incl. the new
`server/llm/classifier.test.ts` 2/2), `features/` 818 passed / the same 21
pre-existing yt-dlp + media-download Windows failures. `npm run build` **not
run** (a dev server is live).

Browser-verified against the live dev server and the local vLLM `gemma4-26b`:

- **Classifier probe passed in 259 ms** — the real analyzer prompt, raw answer
  `{"name_match": "exact", "matched_text": "Zylbot"}`, parsed as
  `addressed — cited "Zylbot"`. That latency on a 26B model is the thinking-off
  bound demonstrably reaching the wire.
- **Background probe passed in 5.8 s**, distilling the three-line probe
  transcript into two correctly-attributed topics with the right message ids —
  and its raw answer came back inside a ```json fence, so the lenient parser was
  exercised for real rather than in theory.
- Overview shows both new cards as "Chat model" with their own detail, while
  Images still reads "Off" — the `inherited`/`off` distinction survives.
- Full save round-trip through the form: selecting a classifier model persisted
  `classifierModel` and touched nothing else; the clear button then restored
  `null`. The role model list is fed by the effective (inherited) backend.

### Remaining risks

- Production deploy runs 0052 (four additive nullable columns + two FKs).
- **The classifier probe's expected verdict is a judgement, not a gate.** A
  model that returns "not addressed" for the probe message is reported as such
  and the operator decides; there is deliberately no pass/fail on classification
  quality.
### Follow-up: vitest collected every test twice (fixed, 2026-08-13)

Found while verifying the above — a `.claude/worktrees/…` copy of
`status.integration.test.ts` failed against the new endpoint list, in a file the
working tree does not contain. The cause was not that one file: an agent
worktree is a **full checkout inside the repo**, and neither vitest config
excluded it, so *half of every collected file was a duplicate* — 98 of 197 unit
files and 38 of 76 integration files. The integration half ran at Testcontainers
prices, and each duplicate tested whatever revision that worktree happened to
hold, so it could fail (or pass) for reasons unrelated to this checkout.

`**/.claude/worktrees/**` added to `exclude` in `vitest.config.ts` and
`vitest.integration.config.ts`. Collection now lists exactly 99 unit and 38
integration files — the previous totals minus precisely the duplicates, so
nothing real was dropped. Full unit suite 1085 passed / the same 21 pre-existing
yt-dlp + media-download Windows failures; full integration suite **27 passed /
11 skipped, 375 tests, no failures** (it could not pass cleanly before this).

## Every probe exercises the real thing and shows the exchange (`done`, 2026-08-13)

User requirement, 2026-08-13: *"every Test button have to test corresponding
functionality with detailed input and output"* — chat: prompt → message +
reasoning; embedding: phrase → vector; images: prompt → image; speech: prompt →
audio; audio: silent audio → result; vision: red square → result.

### What shipped

- **One shape for every probe**: `ProbeReport` (`{ model, latencyMs, input[],
  output[] }`) whose parts are labelled text, image, audio or vector
  (`features/settings/server/schema.ts`), rendered by one shared
  `ProbeReportView`. This removed the seven bespoke `renderOk` badges and the
  generic from `roleTab` — a probe now describes what it exchanged, and how
  that looks is not its business.
- **Images and speech stopped faking it.** Both only listed models before. The
  image probe generates a 512×512 picture from a fixed prompt and returns it;
  the speech probe synthesizes a phrase in the configured voice and returns
  playable audio. A listing cannot catch a model that fails on the requested
  size, answers with an empty payload, or an endpoint that silently substitutes
  an unknown voice.
- **New chat probe** (`testChat` + `POST /api/settings/test-chat`): a real
  completion reporting the reply **and** the hidden reasoning (via
  `readReasoningFor`). The Chat tab's old "Test connection" listed the
  backend's models, which says nothing about whether the selected model
  answers, or thinks.
- Embeddings now report the vector (width + an 8-component preview) rather than
  just a width; audio reports the silence it sent and the transcript; vision the
  image it sent and the description; browser the tool offered, whether it was
  called, and the answer.
- Image/audio bytes are replaced by their size in **trace** bodies (the vision
  describer's convention); the dashboard renders the real artifact from the API
  response.

### Proof

Files: `features/settings/server/{schema,service}.ts`,
`features/settings/ui/{ProbeReportView.tsx,RoleSection.tsx,SettingsForm.tsx}`,
`server/llm/{embeddings,images,speech}.ts`,
`app/api/settings/test-chat/route.ts` (new),
`features/settings/server/settings.integration.test.ts`, docs
(`features/settings.md`, `api/endpoints.md`, `api/openapi.yaml`,
`operations/operator-guide.md`).

Lint and typecheck clean; settings integration 62/62 and status 7/7 (new: chat
reports reasoning, names an absent reasoning channel, rejects unconfigured;
images/speech/embeddings report their artifact); `openapi.yaml` re-parsed to
confirm the seven probe paths and the new `ProbeReport`/`ProbePart` schemas.

Browser-verified against the live dev server: **chat** on vLLM `gemma4-26b`
returned the answer (95 chars) plus 1036 characters of separate reasoning in
5.1s; **vision** rendered the red probe square inline next to the model's
description of it; **audio** rendered a playable clip of the sent silence with
the transcript beside it. The vector rendering is covered by the integration
test but was **not** seen live — the embedding endpoint currently 404s (below).

### Remaining risks

- **vLLM now returns `reasoning_content`.** The earlier entry recording that
  Gemma thinking is never populated on vLLM (and that the fix was in the vLLM
  launch) is out of date: the chat probe reads a full reasoning channel from
  `gemma4-26b` today. Re-check that entry before acting on it.
- **The embeddings backend 404s.** `POST /v1/embeddings` on the Ollama backend
  returns "404 page not found", so semantic recall is off and the Overview
  shows Embeddings as an error. It worked on 2026-08-12; unrelated to this
  change, but it needs the operator's attention.
- The image and speech probes now cost a real generation. Both are bounded
  (120s / 30s) and only run when the operator presses the button, but on a paid
  provider they are no longer free.

## Unified LLM role tabs + clearable model select + honest fallback status (`done`, 2026-08-13)

User reports, 2026-08-13: a selected model could not be cleared; the Overview
called Browser agent and Audio (STT) "Off" when both actually run on the chat
model; and a request that the LLM role tabs be unified in behaviour and look.

### What shipped

- **Combobox is clearable** (`components/ui/Combobox.tsx`): a clear (X) button
  whenever a value is committed, plus Enter on an erased field committing "".
  Every consumer gives "" its own meaning (use the chat model, feature off), so
  picking an option was a one-way door. The erased-field Enter also fixes a real
  bug: with an empty query the highlight sat on the *unfiltered* list's first
  entry, so Enter silently selected a different model.
- **Overview stops lying about fallback roles** (`server/status.ts`,
  `app/(dashboard)/page.tsx`): new `inherited` endpoint state, rendered
  "Chat model" (neutral) instead of "Off", for audio/vision/browser with no
  dedicated model. `off` now means what it says — including the case where
  there is no chat model to fall back to either.
- **One renderer for all seven role tabs** (`roleTab` + `RoleTabSpec` in
  `SettingsForm.tsx`): probe invalidation, test availability and the stale
  warning are decided once; only wording, probe, free-text, extra fields and
  inheritance are per-role data. Removed ~130 lines of near-duplicate JSX.
- **`testBrowser` + `POST /api/settings/test-browser`**: the Browser agent tab
  was the only LLM role with no Test button. The probe runs one real tool round
  with a single trivial tool — a listing cannot reveal missing tool-call
  support, which is all the browser agent does. A model that answers without
  calling the tool is reported, not failed.

### Proof

Files: `components/ui/Combobox.tsx`, `server/status.ts`,
`app/(dashboard)/page.tsx`, `server/status.integration.test.ts`,
`features/settings/server/service.ts`, `features/settings/ui/SettingsForm.tsx`,
`app/api/settings/test-browser/route.ts` (new),
`features/settings/server/settings.integration.test.ts`, docs
(`features/settings.md`, `api/endpoints.md`, `api/openapi.yaml`,
`operations/operator-guide.md`).

Lint clean; typecheck clean except the same three stale `.next/types` lines.
Settings integration 56/56 (new: browser probe through the chat fallback, the
no-tool-call case, clean rejection); status integration 7/7 (new: fallback
roles report `inherited`, not `off`, once a chat model is set). Full
integration suite 54 files / 714 tests pass; unit suite unchanged (same 21
pre-existing yt-dlp Windows failures).

Browser-verified against the live dev server (the operator signed the preview
in): Overview reads "Chat model" for Audio (STT) / Vision / Browser agent and
still "Off" for Images / Speech; the chat model's clear button emptied the
field and then disappeared, leaving the value restored on reload since nothing
was saved; "Test browser model" ran a real tool round against the local vLLM
backend and returned `{ model: "gemma4-26b", calledTool: true, answer: "ready" }`.
A DOM sweep over all seven role panels confirmed the unified contract: every
one has a backend select, a model select and a Test button; the test is
disabled only where an empty model means "off" (images, speech); the clear
button shows exactly where a value is committed (chat, embeddings).

### Remaining risks

- OpenRouter's `google/gemma-4-26b-a4b-it:free` — the configured chat model —
  returned HTTP 200 and then aborted mid-response for **every** probe on
  2026-08-13 (vision and browser alike), ~10s in, while the same probes pass
  against the local vLLM backend. An upstream availability problem, not a code
  path: it worked on 2026-08-12. Worth re-checking before blaming the app for
  a failed reply.
- The resulting message, `LLM endpoint error (200): The operation was
  aborted`, reads like our own timeout rather than a provider drop. Left as-is
  here; see the follow-up task on `toLlmError`.

## Audio stale-clearing in chat mode + always-testable audio probe (`done`, 2026-08-12)

User report, 2026-08-12: repointing the chat backend cleared the stale vision
model but left a chat-mode audio model (`nemotron-…:free`) selected, and "Test
audio" was disabled with an empty model even though empty means "chat-model
fallback" — a real, testable path (vision's test works exactly that way).

### What shipped

- The audio exemption from stale-model clearing is now **conditional on the
  transcription mode**: only `transcriptions` mode is exempt (whisper-class
  servers list nothing); in `chat` mode the STT model is an ordinary chat model
  and is verified/cleared like every listed role. Server:
  `listedModelRoles(mode)` replaces the `LISTED_MODEL_ROLES` constant, applied
  in both `clearStaleModelSelections` (post-patch mode) and
  `clearRoleModelsNotServed` (stored mode). Client: the audio role's `listed`
  flag follows the form's mode, and the Audio tab shows the stale warning in
  chat mode.
- "Test audio" is no longer gated on a model being set: with no audio model,
  `testAudio` resolves `toChatFallbackTranscriptionRuntime` — the chat model
  carrying the probe silence as `input_audio`, exactly what the voice path
  uses — mirroring `testVision`'s fallback probing.

### Proof

Files: `features/settings/server/service.ts`,
`features/settings/ui/SettingsForm.tsx`,
`features/settings/server/settings.integration.test.ts`, docs
(`configuration.md`, `features/{settings,backends}.md`).

Lint clean; typecheck clean except the same three stale `.next/types` lines;
settings integration suite 53/53 (new: chat-mode audio cleared on repoint,
no-model `testAudio` probing the chat fallback with the `input_audio` shape,
clean rejection when nothing resolves). Unit suite: same 21 pre-existing
yt-dlp Windows failures only. Browser-verified against the live dev server:
"Test audio" enabled with an empty model and returned
"google/gemma-4-26b-a4b-it:free — endpoint responded" through real OpenRouter.

### Remaining risks

- Switching the mode select alone (no backend repoint) does not trigger a
  server-side verify; the form's fetched-list warning + save-time clearing
  covers it once the list is known.

## Backends catalog + per-role LLM configuration (`done` pending production deploy, 2026-08-12)

User request, 2026-08-12: *"lets re-work our LLM backend"* — Backends as a CRUD
entity (`url`, optional `api key`, `type`; test connection + preview available
models), roles selecting from the catalog instead of re-entering endpoints,
search in model selection, and granular role configs: chat (aka main — must
support thinking and tools), embedding, audio (main by default), vision (main
by default), speech, image generation, browser agent (main by default).

### What shipped

- **`backends` table + CRUD feature** (`features/backends`, page `/backends`,
  feature id `backends`, `/api/backends[...]`): name (unique
  case-insensitively), URL, write-only key, server type (the existing
  `LlmBackendId` normalization ids) with the Detect fingerprint moved to
  `POST /api/backends/detect`. Per-backend **Test connection** = one
  `/v1/models` call whose result doubles as the model preview. Delete is
  refused (409) naming the settings roles pointing at the row; the FKs are
  `ON DELETE RESTRICT` as backstop.
- **Settings are role configs** (migrations `0049_slimy_hedge_knight` +
  `0050_faithful_wendell_vaughn`, **applied to the dev DB**): per role a
  `*_backend_id` FK (null = "use the chat backend") + model column. Roles:
  chat (`chat_backend_id` + `model`), embedding, image, speech (+voice),
  audio (renamed from transcription), vision (new), browser (new). 0049
  carries a SQL data migration: legacy `*_base_url`/`*_api_key`/`*_backend`
  columns become deduplicated backend rows and the role FKs are pointed at
  them; 0050 drops the legacy columns. Verified against the live dev DB:
  "Main" (vLLM) + "Embeddings" (Ollama) rows created, chat/embedding roles
  attached, all others inheriting.
  Note: drizzle-kit's rename prompt cannot run non-interactively, hence the
  two-pass generate (adds, then drops) with the data migration hand-inserted.
- **Runtime resolution**: `getLlmRuntime` (chat) keeps its shape;
  embedding/image/speech require their model (off otherwise) and inherit the
  chat backend when their own is null; `getAudioRuntime` (was
  `getTranscriptionRuntime`) keeps the null → chat-model `input_audio`
  fallback; new `getVisionRuntime`/`getBrowserLlmRuntime` fall back to the
  chat backend *and* chat model per unset half. Vision describe runs on the
  vision runtime (`resolveDescribeDeps`), with the voice `input_audio`
  fallback split onto the chat connection when vision points elsewhere; the
  browser-agent runner uses the browser runtime.
- **Stale-model doctrine carried over** to backend-id semantics: a PATCH that
  repoints a role (own backend id change, or chat backend change hitting
  inheritors) lists the newly effective backend once and clears verifiably
  unserved stored models in the same write; editing a backend's URL/key does
  the same for every role riding on it (`clearRoleModelsNotServed`, reported
  back to the Backends form). Failed listing clears nothing; audio exempt;
  same-patch picks trusted.
- **UI**: new shared searchable `Combobox` (components/ui) used for every
  model select (type-to-filter; free-text mode for audio); `RoleSection`
  replaces `ConnectionSection`; Settings tabs are now Chat / Embeddings /
  Images / Speech / Audio / Vision / Browser agent / Telegram / General /
  Integrations / Security; per-backend model lists preloaded server-side and
  fetched on demand (`useBackendModels`). Backends page mirrors the
  personalities CRUD pattern. `readApiError` extracted to `lib/api-error.ts`
  (third copy was imminent).
- Probe routes take `{ backendId?, model? }` (`test-audio` replaces
  `test-transcription`; `test-connection`/`list-models`/`detect-backend`
  removed in favor of the backends routes). Overview endpoint statuses now
  include vision/browser (probed only when overridden — otherwise they'd
  duplicate the LLM card's probe).

### Proof

Files: `db/schema.ts`, `db/migrations/0049+0050`, `features/backends/*` (new),
`features/settings/server/{repository,schema,service}.ts`,
`features/settings/ui/{SettingsForm,RoleSection,connection}.tsx|ts`,
`components/ui/Combobox.tsx`, `server/status.ts`,
`features/vision/server/service.ts`, `features/browser-agent/server/runner.ts`,
`app/api/backends/*`, `app/(dashboard)/backends/page.tsx`, nav + features
registry, docs (`configuration.md`, `features/{settings,backends}.md`,
`api/{endpoints.md,openapi.yaml}`, `architecture/{data-model,security}.md`,
feature docs, `getting-started.md`).

`npm run lint` clean; `npm run typecheck` clean except three stale
`.next/types/validator.ts` lines referencing the deleted routes (regenerates on
next dev-server rebuild/build). Integration: settings (20) + backends (11) +
status (4) suites rewritten/extended — 35/35 pass, exercising the new
migrations in Testcontainers. `npm run test` 1081 passed / the same 21
pre-existing yt-dlp Windows failures. `npm run build` **not run** (would kill
the running dev server). Browser-verified against the live dev server:
Backends page CRUD chrome + Test connection ("Connected — 1 models" from the
live vLLM), Settings role tabs with the migrated selections, chat model
combobox listing the served model, vision tab inherit labels, and a real
"Test embeddings" through the new role resolution ("bge-m3:latest — 1024
dimensions" from the live Ollama).

### Remaining risks

- Production deploy runs 0049+0050 against real data: the data migration is
  exercised in tests and on the dev DB, but production is the first run with
  its exact column contents. `backends` rows are created before any drop, so a
  failed run cannot lose connection data silently.
- Role probes resolve "inherit chat" against the **stored** chat backend, so
  testing an inheriting role right after changing the chat backend in the form
  (without saving) probes the saved one. Save first; the form's stale warnings
  cover the rest.
- The live-fetched model list is now authoritative per backend: a backend that
  serves a model while omitting it from `/v1/models` would flag (and on save
  clear) that selection — same accepted trade as before, now per backend row.

## Stale model selections survive an endpoint switch + Settings tab rework (`done` pending production deploy, 2026-08-09)

User report, 2026-08-09: *"when I change main llm endpoint and for example embedding
was using it also — embedding model stays selected even though new backend does not
even have it."* Plus a requested rework: every model/backend on its own tab, same
for Telegram settings.

### The fix — verified clearing on save

`clearStaleModelSelections` (`features/settings/server/service.ts`, inside
`updateSettings`): when a PATCH repoints an endpoint — the LLM base URL changes
and a section reuses that connection, or a section's own URL changes (including
falling back to the LLM one) — the new endpoint's `/v1/models` is listed once
per distinct endpoint and every stored selection it verifiably does not serve is
cleared **in the same write**, with a warn event per cleared model on the update
trace and `cleared stale …` in the output summary. Covers the chat model too
(same staleness, same mechanism). Deliberate limits, all on the side of not
destroying configuration:

- a model sent in the same PATCH is trusted — the operator just picked it;
- a failed listing clears nothing — absence is only acted on when proven
  (per the "verify real state" rule; the trace records why);
- transcription is exempt — whisper-class servers often expose no listing, so
  absence from one proves nothing (why that field is free-text in the UI).

The form now sends **only changed fields** (previously it always sent
`llmBaseUrl`/`llmBackend`/`model`), which is what lets the server tell "stored
selection" from "explicit choice". An untouched form produces an empty patch and
short-circuits to "Saved" without a request.

Surfaced twice in the UI: after a successful "Test connection", a shared
section's model absent from the fresh list gets a warning on its own tab (and is
no longer re-offered as a select option); after save, whatever was cleared is
named next to the Save button.

The form also owns the case the server check cannot see: a selection stale
against the *unchanged* endpoint (left behind by a switch made before this
existed — the live dev DB's `docker.io/ai/stable-diffusion:Q4` image model is
exactly this). A save sends a probe-flagged selection as null; the probe resets
on any URL edit, so a fresh list always describes the endpoint currently in the
form. Found during browser verification: the warning promised "cleared on save"
while a save with an unchanged URL would have cleared nothing.

### The rework — nine tabs, one per concern

Core split into **LLM** (endpoint, key, backend, test, model), **Telegram** (bot
token, owner, maintenance mode) and **General** (timezone, daily jobs run time,
download cap); Embeddings/Images/Speech/Transcription/Integrations/Security
unchanged. `ConnectionSection` grew an optional `modelWarning` slot.

### Proof

Files: `features/settings/server/service.ts`,
`features/settings/ui/{SettingsForm,ConnectionSection}.tsx`,
`features/settings/server/settings.integration.test.ts` (8 new cases: clears
verified-missing models across shared sections, keeps served ones, keeps all on
a failed listing, trusts same-patch picks, own-endpoint sections untouched by an
LLM URL change, fall-back-to-LLM validated, trace events recorded, no listing
without a URL change; also fixed the pre-existing empty-defaults expectation
missing the five `*Backend` fields), docs
(`configuration.md`, `operations/{operator-guide,troubleshooting}.md`,
`features/settings.md`, `getting-started.md`).

`npm run lint` clean, `npm run typecheck` clean, `npm run test` 1068 passed / the
same 21 pre-existing yt-dlp Windows failures. Settings integration suite 40/40
and status integration 2/2 (the only other `updateSettings` caller; its one call
sets URL + model together — the explicit-choice path, no listing). Also repaired
9 expectations in the settings integration file that predated the backend layer
(`llmBackend` defaults missing from `getSettings`, `backend` missing from the
four runtime getters) — this suite runs separately from `npm run test` and had
not been run since that change landed. `npm run build` clean (run after the
dev server was stopped); version bumped to 1.33.0.

Remaining risks:

- The stale check adds one model listing (≤10s bound) to a save that changes a
  base URL. A dead new endpoint makes such a save take that long once — accepted
  in exchange for never clearing on unproven absence.
- A backend that serves a model while omitting it from `/v1/models` would get its
  selection cleared; not observed on Ollama/llama.cpp/vLLM, and the operator is
  told exactly what was cleared and why.

## Find a photo and reply to it (`done` pending production deploy + live verification, 2026-08-07)

User request, 2026-08-07: *"userA: find the photo of userB's door → bot finds the
original message with the photo and replies to that message 'here it is'."*
Neither half was possible.

`history_search` matched `chat_messages.content` only, so an uncaptioned photo —
which is most of them — was invisible to every lookup the bot had; and the reply
target was hard-wired to the message being answered, so there was no way to point
at anything.

Decisions taken with the user before implementing:

- **Delivery**: retarget *this turn's* reply rather than sending a second message
  or copying the photo back. One message, and it taps through to the original.
- **Retrieval**: embeddings, over **every** message type — text, photos, videos,
  GIFs, voice — not a keyword-only first cut.
- **Tool shape**: extend `history_search`; no second lookup tool.

### What shipped

- `chat_message_search` (migration `0048_dazzling_chamber`, **applied to the dev
  DB**) — each message's searchable text (its own words **plus** its media
  annotation) and that text's `vector(1024)`. A table, not columns on
  `chat_messages`: the reply path reads the 24h window with `select *`, and a 4 KB
  vector on that row would be dragged through the hottest read in the app.
- `features/history/server/index-messages.ts` + `index-scheduler.ts` — idle job,
  90s debounce against the vision backfill's 45s so it runs *after* the describer
  in the same quiet window. Due-scan compares `indexed_at` against the message's
  `edited_at` and its media's `described_at`, which is what makes it self-healing:
  a photo indexed as bare `[photo]` is re-indexed once the description lands.
- `search-repository.ts` — hybrid search, three pools fused by RRF (k=60, same
  scheme as `searchChatSummaries`): vector, full text, and the original substring
  pool over `chat_messages` (kept because it is the only one that sees a message
  sent since the last indexing run).
- `history_search` — hybrid, plus `author` and `media_kinds` filters, and each hit
  now names its author. The bot-vs-participant distinction and
  `SELF_AUTHORED_ONLY_NOTE` are untouched; an unresolvable `author` is an **error
  result**, never a silently widened search.
- `features/bot-messaging/server/mcp-tools.ts` — `reply_to_message`, the first
  bot-messaging tool. Validates the id against this chat's mirror, then moves the
  turn's target through a new `setReplyTarget` context sink (same shape as
  `collectImage`, and for the same reason: it changes *delivery*, which a tool
  result cannot carry). The mirror records where the reply actually landed.
- Telegram sends now pass `allow_sending_without_reply`, so a target deleted since
  it was found costs the quote rather than the whole answer.
- `/api/history/search-index` (GET/POST/DELETE) + a card on the Jobs board.

### Two bugs the integration test caught that typechecking could not

1. **`= any(${ids}::text[])` fails at runtime.** An array in a Drizzle `sql`
   template expands to a comma-separated *parameter list*, not one array-typed
   parameter, so Postgres got `'200'::text[]` and raised "malformed array
   literal". `in (${ids})` is the form that works.
2. **Raw `db.execute` returns timestamps as strings**, not the `Date` the query
   builder hands back — the driver's type parsing is not applied to an untyped
   statement. `row.sent_at.toISOString()` threw on every hit.

### Verification

`npm run lint` clean, `npm run typecheck` clean. `npm run test` 1039 passed / 21
failed — the same 21 pre-existing `ytdlp-binary` + `media-download` Windows
environment failures. New: 10 integration cases in
`features/history/server/search-index.integration.test.ts` (including the exact
scenario: an uncaptioned photo found by "door", nothing before indexing, hits
after), 5 in `features/bot-messaging/server/mcp-tools.test.ts`, 7 unit cases for
the result format and rank-merge. `history.integration.test.ts`'s two
`searchChatMessages` cases were retargeted at the hybrid function, which replaces
it. `npm run build` not run (would kill the running dev server).

### Measured against the live dev database and endpoint

The full dev backlog — **1366 messages** — was indexed in one run from the Jobs
board: 1366 rows written, **1366 embedded** (`bge-m3:latest`), live progress
ticking on the card, ~2 minutes end to end. Nothing was left due.

Then the exact scenario, as a raw cosine query over the built index:

| query | rank | hit |
| --- | --- | --- |
| "a photo of a door" | 3 (0.334) | An uncaptioned photo *"looking through an open door into a bathroom"* |

That message's own text is `Тут душевний чіназес` — nothing about a door, and not
in English. It is unreachable by any search this bot had before: the mirror row
carries the caption, and the caption says nothing. Ranks 1–2 were other indoor
photos, which is the expected shape of a vector-only top-5; the tool additionally
fuses full text and substring and returns more than five.

### Round 2 — first live run, from one trace (2026-08-07)

Trace `eccd1190…`. Asked in the group to find a photo of a door somebody had
posted, the bot did find one — and answered by **pasting a raw result line into
the chat**: `[#13488] [2026-07-29T12:11:15.000Z] <name> (@<handle>): … [photo:
Photo of a weathered, rustic building exterior…]`. Four separate defects, all
visible in the one trace.

1. **`query` was required, so the model's first call was rejected.** It called
   `{author: "…"}` with no query — a perfectly good request — got a zod
   validation error, and retried as `{query: ["door", …]}` **without the author
   filter**. Requiring a query is what made it search the whole chat. Query is
   now optional when `author` or `media_kinds` is given, and a filters-only
   lookup returns the most recent matches.
2. **The author arrived quoted**: the argument was the string `"R.K."`, quotes
   included, so exact-name resolution would have missed a person who was right
   there. `unquote` strips one layer of surrounding quotes — a mechanical fix to
   a stray delimiter, not a guess at what a name means.
3. **One search returned 41 KB / ~11.8k tokens.** 50 hits × full vision
   descriptions, taking the reply prompt to 38.8k. Results are now snippets
   (~220 chars) with a default of 10 hits (max 50). Only the model-facing text is
   cut: `structuredContent` is trace-only (the loop feeds the model
   `result.text`), so Debug still records every body in full.
4. **`reply_to_message` was offered and never called** — the model pasted the
   line instead. Every result now carries `SEARCH_RESULT_USAGE_NOTE`.

### Round 3 — citations as links (user decision, 2026-08-07)

On the next run the bot answered in prose — *"the first photo was in #13488, the
other two under #15114 and #15115"* — and the user's verdict was **"I like this
more, just if they can be anchors to messages or something."** So that shape is
the target, not the single retarget: several messages named in one sentence, each
one tappable.

A cited `#<id>` is now rendered as a `t.me/c/<chat>/<id>` anchor. The ids are
resolved against the chat's mirror before delivery — a **whitelist, not a
pattern**, so an invented or mistyped id stays plain text instead of linking
nowhere. `messageLinkBase` returns null for a basic group or a DM, which have no
per-message URL at all, and then nothing is linked. Anchors are lifted out of the
Markdown pipeline as placeholders so they cannot be nested inside another link
(Telegram rejects nested `<a>`, which would cost the whole send), italicized in
half, or split by a line rule. Word hashtags, URL fragments and citations inside
code spans are untouched.

The two mechanisms compose rather than compete: attach the reply to the main
message, cite the rest inline. `SEARCH_RESULT_USAGE_NOTE` now says so — cite ids
in your own sentence, never paste the line they came from.

Files: `lib/telegram.ts` (`MESSAGE_REF_PATTERN`, `findMessageRefs`,
`messageLinkBase`), `features/bot-messaging/telegram-html.ts`,
`server/telegram/{transport,bot-manager,process-update}.ts`,
`features/history/server/{mcp-tools,search-repository}.ts`. Verification:
`npm run lint` clean, `npm run typecheck` clean, `npm run test` 1062 passed / the
same 21 pre-existing yt-dlp failures; 12 integration cases (2 new, for the
filters-only lookup and the no-criteria refusal), 20 renderer cases (10 new) and
11 `lib/telegram` cases (8 new).

### Round 4 — the tool call went into the reasoning channel (2026-08-08)

Trace `ef8634e5…`, and **not** a search bug: the round-2 description fix worked.
Asked to find a photo somebody had posted, gemma4:12b composed exactly the right
call — author + media_kinds + query together, in one call — and then emitted it
*inside its reasoning* as literal text:

```
<|tool_call>call:history_search{author:"R.K.",media_kinds:[<|"|>photo<|"|>],query:[<|"|>ПМ<|"|>]}<tool_call|>
```

The `<|"|>` around each value is the chat template's own quote tokens leaking
through. The API response carried **no `tool_calls`**, empty content, and
`finish_reason: "stop"` — 600 completion tokens, nothing run — so the reply path
raised "LLM returned an empty response", failed the trace, and the group got an
error notice.

This is a **tool-call dialect** failure: the class the normalization-layer entry
above explicitly records as *not* one of the confirmed breakages. It is now, and
it is not specific to the new tools — any turn that decides on a tool inside its
thinking can hit it.

*User decision, 2026-08-08*, asked with four options (retry / salvage the call out
of the reasoning text / both / measure first): **retry the round once**, and leave
the chat-facing failure text as it is.

So `runToolLoop` now re-asks a round that produced neither an answer nor a tool
call, once, appending `EMPTY_ROUND_NOTICE` — which restates the single thing that
was wrong (a tool call written in the thinking is not a tool call) and leaves both
exits open, the same shape as `toolFailureNotice`. Nothing is parsed out of the
reasoning: a call reconstructed from garbled pseudo-syntax is a call the model
never made, and tool *selection* stays the model's. The retry is a warn step on
the trace (`round produced no answer and no tool call — asking again`), which is
also the signal that will say whether this is rare or routine.

Note this reverses, for the tool loop only, the 2026-08-03 decision that an empty
completion is not retryable. That decision was about the *transport* retry
(`withLlmRetry`), where an empty completion means the provider answered fine and
re-sending changes nothing; here the retry carries a new system turn, so it is a
different request.

Files: `server/llm/tool-loop.ts`, `features/bot-messaging/server/service.ts`,
`server/telegram/process-update.ts`, `docs/architecture/llm-and-mcp.md`.
Verification: `npm run lint` clean, `npm run typecheck` clean, `npm run test` 1068
passed / the same 21 pre-existing yt-dlp failures; 6 new tool-loop cases.

### Remaining risks / live verification checklist

- **The retry is one extra round, not a cure.** If the model re-emits into the
  reasoning channel a second time the turn still fails, exactly as before. Watch
  the new warn step: frequent appearances mean this wants fixing at the backend
  adapter (salvage, or a different tool-call dialect), not in the loop.
- **Not yet exercised through the bot itself since round 2/3.** Next live check:
  ask for a photo by something only its description says, and confirm the reply
  cites ids that are tappable and does not paste a result line.
- **The snippet cut is 220 characters, chosen from one trace.** If the model
  starts picking the wrong message because the descriptions are cut too early,
  that number is the dial — not the hit count.
- **Citations only link in supergroups.** In a DM or a basic group the bot will
  still write `#13488` and it will be plain text. Nothing tells the model that,
  so it may promise a link that is not one.
- **Production backlog is larger than dev's 1366.** It runs only while the bot is
  quiet and yields to live traffic, but watch the first night's `history-index`
  traces for the backlog actually draining.
- **Vision descriptions are English** (the describe prompt is), while chats here
  are not. The measurement above shows the vector half bridging that; the
  full-text half will not. If recall is poor for non-English queries, that is the
  thing to look at first — not more prompt text.
- Rows indexed before an embedding model is configured keep a null vector forever.
  `DELETE /api/history/search-index` is the recovery path; it is not automatic.
- `reply_to_message` is one more tool for a 12B model to choose wrongly. The
  failure mode to watch is it retargeting an ordinary turn at some unrelated
  message — visible as a reply landing in a strange place, and in the
  `mcp-tools-bot-messaging` Debug scope.

## Backend normalization layer (`in-progress`, 2026-08-07)

User decision, 2026-08-07: "bot breaks every time I switch backend… implement an
adaptation/normalization layer per backend instead of layers of fixes every
time." Step zero, ahead of the reply-latency work below.

Decisions taken with the user before implementing:

- **Scope**: all five endpoints get their own backend selector (LLM, embedding,
  image, speech, transcription) — they can genuinely be different servers.
- **Tool loop**: `runToolLoop` stays hand-rolled; the AI SDK is transport only.
  The SDK's agent has no stall guard, no `compact()`, no forced tools-free final
  round, and no per-round usage reporting — and Analytics groups on the round.
- **Backends**: Ollama, llama.cpp, vLLM, and a generic OpenAI-compatible
  fallback (the default, and what every pre-existing settings row resolves to).
- **Detection**: manual dropdown plus a Detect button that fingerprints the
  endpoint. Never automatic — a silent change is the bug class this prevents.
- **Speech/transcription**: keep the `openai` SDK internally.
  `@ai-sdk/openai-compatible` supports chat, completion, embedding and image
  models only — it has no transcription or speech model type.
- **Cutover**: adapter layer first with no behavior change, then the latency
  work as a separate change, so a regression has one candidate cause.

Confirmed breakages the layer must pin (user, 2026-08-07): thinking/reasoning
control, context-overflow error shape, served-model-id normalization. Tool-call
dialect was explicitly *not* one of them — **until 2026-08-08**, when a live turn
emitted its tool call inside the reasoning channel and the round came back empty
(see "the tool call went into the reasoning channel" below). Handled generically
in the tool loop for now; if it recurs it belongs here, in the Ollama adapter.

### Done so far

- `lib/llm-backend.ts` — client-safe ids/labels/coercion.
- `server/llm/backends/` — adapter interface, four adapters, registry, endpoint
  fingerprinting. Pure: no fetch, no SDK, so every quirk is testable without a
  server.
- `db/schema.ts` + `db/migrations/0047_bouncy_ink.sql` — five backend columns,
  `NOT NULL DEFAULT 'openai-compatible'` so existing rows keep current behavior.
- Settings zod schemas, repository, service, and `LlmConnection` carry the
  backend. It follows the **host**, like the API key: an endpoint that falls
  back to the LLM connection inherits its backend too.
- `server/llm/backends/backends.test.ts` — 17 tests.

Proof: `npm run lint` clean, `npm run typecheck` clean, `npm run test`
1002 passed / 21 failed — the same 21 fail on a stashed clean tree
(`ytdlp-binary`, `media-download`; environment-dependent, unrelated).

**Migration not applied locally** — no Postgres reachable at the configured
`DATABASE_URL`. It is generated and committed; apply on deploy with
`npm run db:migrate`.

### How the vendor fields reach the wire

`providerOptions[<provider name>]` is the seam, exactly as the provider's docs
describe. The typed options schema
(`{user, reasoningEffort, textVerbosity, strictJsonSchema}`) is `$strip`, which
reads like it would discard everything else — it does not. The model spreads the
raw `providerOptions` entry into the request body and filters out **only** those
four known keys (`@ai-sdk/openai-compatible/dist/index.js`, the
`Object.fromEntries(...)` spread in `getArgs`). Every other key — `think`,
`chat_template_kwargs`, `reasoning_format` — is passed straight through.

So an adapter's `chatBodyExtras()` maps onto `providerOptions` directly and no
`fetch` shim is needed. Two consequences for the adapters:

- Genuine vendor fields use their **wire spelling** (`think`,
  `chat_template_kwargs`, `reasoning_format`) and pass through untouched.
- `reasoningEffort` is the exception and must use the **camelCase typed name**.
  The model writes `reasoning_effort` into the body *after* the passthrough
  spread, so a snake-case `reasoning_effort` is overwritten by the unset typed
  option and never reaches the endpoint. Found by the end-to-end test, not by
  reading the code.

`server/llm/transport.ts` is the single wire, and `server/llm/transport.test.ts`
pins the passthrough against the real provider with a stub `fetch` — asserting
the behavior rather than the declaration, because reading the declaration got it
wrong once.

The conversation stays in OpenAI's message shape and is converted once at the
transport boundary. `./tool-loop` owns the conversation and appends assistant
turns to it verbatim across rounds, so that shape is a stable internal DTO;
converting at the edge leaves the loop, the browser agent, and the MCP tool
bridge untouched by the transport swap.

`chatCompletion` and the tool loop's round factory both run on the transport.
Migration `0047` is applied to the dev DB and the existing row backfilled to
`openai-compatible`.

Behavior is deliberately unchanged until an operator names a backend: the
classifiers still pass `reasoning: "low"`, which on the generic adapter produces
the identical `reasoning_effort: "low"` body they always sent, and the reply path
passes no reasoning preference at all.

Two things improved for free by moving off the OpenAI SDK:

- **Error bodies survive.** `APICallError` keeps `responseBody`, where the OpenAI
  SDK discarded any JSON error body that was not its own `{error:{}}` shape —
  the "500 status code (no body)" problem `fetchWithErrorDetail` exists to work
  around. `isContextOverflowError` and `toLlmError` now read it.
- **`isContextOverflowError` takes the backend**, so an adapter's phrasings are
  tried after the shared concept matcher.

### Measured against the live Ollama (0.32.6, 12B thinking model)

One classifier prompt, identical verdict every time:

| body                       | completion tokens | latency |
| -------------------------- | ----------------- | ------- |
| (nothing)                  | 135               | 2269 ms |
| `reasoning_effort: "low"`  | 94                | 1784 ms |
| `reasoning_effort: "none"` | **17**            | **802 ms** |

So `"low"` — what the bot has been sending all along — is **not** a weaker
"off". It still thinks. `"none"` is the switch, and it is now what the Ollama
adapter emits for `reasoning: "off"`.

Also measured, and why the adapter does *not* send `think`: Ollama's native flag
works on `/api/chat` (17 tokens, 816 ms, no thinking) but the OpenAI-compatible
`/v1/chat/completions` route this app speaks **ignores it** — 128 completion
tokens with it and without. `chat_template_kwargs: {thinking:false}` and
`options: {think:false}` were also tried on `/v1` and did not disable it.

llama.cpp mappings remain **documented, not measured** — no live instance. Its
tests assert the body produced, not a server's answer. vLLM was measured live on
2026-08-12 — see "vLLM measured live" below: the mapping is right, the
deployment is not.

### Settings UI

`features/settings/ui/BackendField.tsx` — one dropdown + Detect control, used by
the LLM section in `SettingsForm` and by all four optional sections through
`ConnectionSection`. A section reusing the LLM connection shows no control: it
inherits that endpoint's backend at read time, so persisting one would be a
second, silently-ignored source of truth.

`POST /api/settings/detect-backend` fingerprints an endpoint. Ollama's
`/api/version` is tried before vLLM's bare `/version` — both answer `{version}`,
and the reverse order would let a generic body claim an Ollama host.

Verified in the browser against the live endpoint: the control renders in the
Core tab, Detect returned "Detected Ollama 0.32.6" and set the dropdown, and
saving persisted `llm_backend = 'ollama'` while leaving the four inheriting
sections untouched.

### Two bugs the live check caught that nothing mocked could

1. **System turns were rejected outright.** The AI SDK refuses `system` messages
   inside `messages` unless `allowSystemInMessages` is set, steering callers to
   its single `instructions` field. That does not fit this app — the reply prompt
   places system turns *between* other turns deliberately (time context after the
   history window, language directive last, at maximum recency). Left unset,
   **every reply would have failed on deploy** with `AI_InvalidPromptError`. Now
   pinned by a test that asserts the sent role order.
2. **The backend never reached the wire.** Ten call sites built their connection
   as `{ baseUrl, apiKey }`, dropping `backend`, so `adapterFor` fell back to the
   generic adapter and the operator's choice did nothing. Fixed at every site.
   The footgun remains: a bare object literal silently loses the field. Worth
   making the runtime itself an `LlmConnection` that callers spread.

### Measured through the app's own code path, live

Same classifier prompt, identical verdict, only the stored backend differing:

| `llm_backend`        | completion tokens | latency | reasoning |
| -------------------- | ----------------- | ------- | --------- |
| `openai-compatible`  | 149               | 2519 ms | 431 chars |
| `ollama`             | **17**            | **683 ms** | **0**  |

### Embeddings and images

Both run on the AI SDK provider now, through the shared `server/llm/provider.ts`
factory that chat also uses — it exists so the three cannot drift on the two
things easy to get subtly wrong: base URL normalization and the
`providerOptions` key. Chat briefly had its own copy that skipped the URL
normalization, which worked only because the stored setting already ended in
`/v1`; an operator entering `http://host:11434` would have hit the wrong path.

Verified live against `bge-m3:latest`: probe reports 1024 dimensions, and a
3-input batch keeps one vector per input **in order** — vector 1 has similarity
1.0 against the same text embedded alone, versus 0.45 cross. That check exists
because `embedMany` pairs vectors to inputs *positionally*: the provider maps
`response.data` straight across and discards each entry's `index`, which the old
code placed by. An arity check now stands in for that guard — a short or padded
response fails loudly instead of misaligning every vector after the gap.

Images are unverified: `image_model` is `docker.io/ai/stable-diffusion:Q4`, which
the configured endpoint does not serve (a Docker Model Runner leftover), and
Ollama has no `/v1/images/generations` at all. The port typechecks and the code
path is the same one embeddings proved; the endpoint is what is missing.

The `openai` package stays for speech, transcription, and `listModels` — the
first two have no model type in `@ai-sdk/openai-compatible`, and the provider
exposes no model listing.

Also fixed while here: a fired deadline now names the endpoint. The AI SDK paths
bound themselves with `AbortSignal`, which throws a bare `TimeoutError` whose
message ("The operation was aborted due to timeout") names neither the host nor
the attempt — useless in a trace read months later.

### Remaining

- Nothing outstanding on the normalization layer itself.
- Watch the first production reply traces after deploy: `addressing-check` and
  `chat-rule-match` should drop from ~135 completion tokens to ~17, and the
  `reasoning` field on their responses should be gone.

### Reply calls keep thinking (user decision, 2026-08-07 — do not retry)

Turning reasoning off on the **reply** path was measured against the live
endpoint and **rejected**. It is not a latency trade, it is a correctness
regression, and the second failure below is the one this bot already has a gate
for.

Three runs each, gemma4:12b, live:

*"split a 2400 bill between 5, two ate half"* — correct answer $600 / $300:

| reasoning | result |
| --------- | ------ |
| on        | **3/3 correct** |
| off       | **0/3 correct** — $480/$240, a garbled half-answer, $533.33/$266.67 |

*"did she push it yet?"* over history where only Bea can know — the bot should
ask her or say it does not know:

| reasoning | result |
| --------- | ------ |
| on        | 3/3 fine: *"@Bea, have you pushed the changes?"* / *"She hasn't mentioned if she pushed it yet."* |
| off       | 3/3 **fabricated**: *"Not yet, still checking the logs."* / *"Not yet. Checking now."* |

That last one asserts a fact it cannot know *and* an action it is not
performing — exactly what `runActionClaimGate` exists to catch. So it is also
**slower**, not faster: those replies trip the gate, which forces a regeneration
plus a re-check. Two extra calls to save 800 ms.

Tool *selection* alone survives reasoning-off (3/3 correct tool, 772 ms vs
4704 ms), but it cannot be isolated: `runToolLoop` only learns a round was the
final answer when it comes back with no tool calls, and that same call is the
one that wrote the reply.

### gemma4:26b benchmarked and rejected (2026-08-07 — do not retry)

The dashboard's Model performance card shows `gemma4:26b` at **2.3x the
tokens/sec of 12b**, which read as free speed. A controlled benchmark against the
live endpoint says the opposite: **12b is faster on every call shape**, and
neither model made a mistake.

Both models warmed first (a cold VRAM load would otherwise be charged to
whichever case ran first) and grouped per model to avoid swap thrash. Median of
3 runs each:

| case                     | 12b p50 | 26b p50 | tok/s 12b | tok/s 26b | correct |
| ------------------------ | ------- | ------- | --------- | --------- | ------- |
| classifier (reasoning off) | **646 ms**  | 800 ms   | 26.3 | 21.3 | 3/3 both |
| short reply              | **1689 ms** | 2050 ms  | 59.2 | 37.6 | 3/3 both |
| arithmetic               | **6215 ms** | 6674 ms  | 71.8 | 44.2 | 3/3 both |
| tool selection           | **2619 ms** | 4241 ms  | 61.5 | 41.5 | 3/3 both |
| big prompt (~26k tokens) | **6097 ms** | 10134 ms | 53.3 | 43.3 | 3/3 both |

26b is the more *concise* model — 295 tokens to 12b's 446 on the arithmetic, 77
to 100 on the short reply — but its lower throughput more than cancels that.

**Why the dashboard disagreed, and what to do about it.** `tokensPerSec` on the
Model performance card is `completionTokens / latency` summed over calls made at
different times under different load. Latency there includes time queued behind
other work on a serial endpoint, so the number measures *how busy the box was
while that model happened to be in use*, not how fast the model is. 12b carries
3,189 lifetime calls including every busy period; 26b carries 228, mostly from
quiet ones. The card is not wrong about what it reports — it is a poor proxy for
model speed, and it was read as one here. Worth a hint on the card saying so
before it misleads someone again.

### vLLM measured live (`done` pending live reply verification, 2026-08-12)

**Resolved by the operator on 2026-08-12**: the vLLM config was changed and
re-measured with raw curl against the endpoint. The default request (the reply
path's shape) now thinks and comes back parsed — reasoning in the `reasoning`
field (which the vllm adapter reads), `content` holding only the clean
answer. The classifier shape (`chat_template_kwargs: {enable_thinking:false}`
+ `reasoning_effort`) stays properly off: 11 completion tokens, no reasoning.
Two background traces (history-summaries, memory-extraction) errored with 502
during the restart window — transient, they retry on schedule. Remaining
proof wanted: one live bot reply trace showing reasoning in the response body
and no transcript-marker echo. The original findings below are kept for the
record.

The operator switched chat to a live vLLM (0.26.0, `https://vllm.tcloud.monster`,
`gemma4-12b`) on 2026-08-11 and reported two regressions the next day: replies
leaking transcript markers (`[reply to #560]` delivered to Telegram) and no
reasoning anywhere in Debug. Both trace to one fact, measured with raw curl
against the endpoint:

- **Default template never thinks.** A plain chat completion answers directly —
  19 completion tokens on a live reply trace, `reasoning: ''`. The reply path
  sends `reasoning: default` (leave the model alone) by design, so on this
  server every reply runs thinking-off — the exact mode measured on 2026-08-07
  to produce fabricated facts and wrong arithmetic ("Reply calls keep thinking",
  above). The transcript-marker echo is the same degradation showing up as
  format mimicry.
- **`chat_template_kwargs: {enable_thinking: true}` is broken server-side.**
  Non-streaming, the model thinks (192 completion tokens, `finish_reason: stop`)
  but the response arrives with **both `content` and `reasoning` null/empty** —
  the server's parsing swallows the entire answer. Streaming the same request
  shows why: everything lands in `content` as raw text beginning with Gemma's
  literal `thought` marker — no reasoning parser is separating the channels.
  So the app must NOT force the kwarg on this server: replies would come back
  empty. The vllm adapter's `readReasoning` (`reasoning`/`reasoning_content`)
  is correct — the field exists in the schema and is simply never populated.

**Blocker**: app-side nothing can restore thinking here; the fix is in the vLLM
launch (a reasoning parser that understands the Gemma `thought` format +
template defaulting to thinking on), or keeping chat on llama.cpp (which parses
Gemma thinking natively into `reasoning_content` — the 3-way benchmark already
ranked it best for chat replies). Next decision needed: the operator picks
which; nothing to change in this repo either way.

A code-side mitigation (`stripTranscriptEcho`, mechanically removing echoed
transcript markers from reply text before delivery) was shipped and **reverted
the same day (user decision, 2026-08-12): no code solutions to LLM output
problems.** Model misbehavior is fixed at the LLM level — prompt, model choice,
serving configuration — never by post-processing its text in code. Do not
re-add a reply-text sanitizer. What stays is the LLM-level part: an explicit
input-only rule about the transcript format in `BASE_SYSTEM_PROMPT`'s Reply
format block. The real fix for the leakage is restoring thinking (the blocker
above).

## Browser agent: failure verdict + download fallback (`done` pending live verification, 2026-08-12)

User report, 2026-08-12: runs show "Done" despite the task having failed, and a
yt-dlp failure ends the run with nothing else attempted.

Two causes, two fixes:

1. **Status**: the runner settled every report-producing run as `done`; `failed`
   was only for thrown errors — while the agent is *instructed* to end an
   unachievable goal with an honest failure report. New run-outcome verdict
   (`features/browser-agent/server/outcome.ts`, wired in `runner.ts`): a small
   classification call judges whether the report states the goal failed,
   citation-required and verified in code, failing open to `done` (same doctrine
   as the reply path's honesty gate). A confirmed failure settles the run
   `failed` (report kept, error carries the quoted failure) and fails the trace
   so it is findable on Debug.
2. **Fallback**: the agent system prompt ordered "if the download fails, the run
   has FAILED: stop" (the 2026-08-01 anti-substitution guard). Reworded: a
   failed download tool must first exhaust the other routes to the SAME content
   (retry with the verbatim URL, another official page, and outside big media
   platforms a direct file link / network media URL via
   browser_download_file/browser_download_stream); substitution stays forbidden
   no matter how many attempts failed.

Proof: outcome parser unit tests (8) pass; typecheck + lint clean; browser-agent
suite shows only the pre-existing environment-dependent ytdlp-binary /
media-download failures (identical on a stashed clean tree). **Pending live
verification**: a real failed run (e.g. an impossible download) should settle
`failed` with the quoted reason, and a yt-dlp failure on a non-platform site
should show retry/fallback attempts in the run activity before any failure
report.

## Reply latency (`todo`, 2026-08-07)

From the production trace/analytics review, 2026-08-07 (1,939 traces,
2026-07-22 → 2026-08-07):

- Replies run **p50 36.8s, p90 86.8s**.
- **90% of every generated token is hidden `reasoning`** — a measured reply
  averaged 78 characters of answer against 3,895 of reasoning. One sample reply
  that emitted no reasoning returned an 80-character answer in **3.0s** against
  **49.3s** for a same-sized answer with 10,964 characters of reasoning.
- The two pre-reply gates (`addressing-check` 206 min, `chat-rule-match` 123 min)
  are **37% of all LLM wall time**, against 60 min for reply generation itself —
  and both sit on the critical path, costing the median reply ~13.5s before
  generation starts. 1,704 of those turns ended in silence.
- `gemma4:26B` measured **2.3x faster per token** than `gemma4:12b` across every
  call kind — worth checking the 12b's GPU layer split.
- ~~Interactive calls bypass the priority gate with no concurrency limit~~ —
  capped at 4 on 2026-08-07, see below.
- ~~The 24h history window is injected as one message, invalidating the KV
  prefix~~ — **measured and wrong**, see below. The real cache-breaker was the
  per-sender blocks sitting *above* the window; fixed 2026-08-07.

Blocked on the normalization layer above by user decision (2026-08-07): the
thinking fix is exactly a per-backend knob, so it lands after the seam exists.

## Prompt ordering and the KV prefix cache (`done`, 2026-08-07)

Measured against the live endpoint, `gemma4:12b`, ~9.4k-token window.

**The blob→split refactor was rejected.** The claim was that injecting the 24h
window as one message invalidates the cache each turn, because that message's
content changes. It does not: the cache keys on the **token sequence**, not on
message boundaries, and a new line is appended to the *end* of the blob — so the
prefix is preserved either way.

| history shape          | turn 1  | turn 2 | turn 3 |
| ---------------------- | ------- | ------ | ------ |
| one blob (today)       | 4752 ms | 768 ms | 692 ms |
| one message per line   | 5247 ms | 713 ms | 700 ms |

**The real cache-breaker was prompt order**, and it is now fixed. The per-sender
blocks (communication preferences, addressing hint) sat *above* the history
window, so every change of speaker invalidated the prefix and re-read the whole
window. In a group, the speaker changes on most turns.

| per-sender blocks         | t1 Alex | t2 Alex | t3 Bea  | t4 Cai  |
| ------------------------- | ------- | ------- | ------- | ------- |
| above the window (before) | 4209 ms | 532 ms  | 3923 ms | 3918 ms |
| below the window (now)    | 3930 ms | 532 ms  | 658 ms  | 673 ms  |

~3.3s per turn whenever the speaker changes. The rule the ordering now follows:
**per-chat context above the window, per-turn context below it.** Anything added
above it later must be stable for the whole chat, or it silently costs a full
re-prefill per message. `service.test.ts` asserts the role order with that
reason attached.

**No truncation.** Separately checked, since the Ollama adapter records that this
backend truncates rather than raising: a needle placed at the very start of the
window was recalled at 2.4k, 7.7k and 14.5k prompt tokens. The window is intact
at the sizes this bot uses.

## Interactive concurrency cap (`done`, 2026-08-07)

Interactive calls used to skip the gate entirely. The assumption behind that was
that the endpoint is serial, so queueing in-process would only add latency. It is
not serial — it serves in parallel — but it has a cliff, and unbounded sat past
it.

Measured live, 16 requests over four distinct chat histories:

| in flight | wall time | p50      |
| --------- | --------- | -------- |
| 4         | 13996 ms  | 3381 ms  |
| 8         | 11398 ms  | 4823 ms  |
| 16        | 16698 ms  | 12750 ms |

Unbounded is the last row and is the worst of both — **longer** overall than a cap
of 4 and nearly 4x the latency for the person waiting. That is the shape of the
production `addressing-check` spread (p50 4.3s, p95 27.3s), and 16 concurrent
calls is ordinary traffic: eight group messages arriving together produce exactly
that, because each fires an addressing check and a standing-rule match.

Capped at **4**, not 8: someone is waiting on one reply, not on the batch, and 8
buys ~19% wall time for ~43% more latency per turn. Not a serialization — at a
cap of 1 the burst took 10.0s against 6.4s unbounded, so the parallelism is real
and worth using up to the cliff.

Interactive waiters queue separately from background ones so priority stays
structural: a freed slot always wakes an interactive call first, and background
work cannot get in front of a person by having queued earlier.

## The owner can cancel anyone's scheduled task (`done` pending production deploy + live verification, 2026-08-07)

User decision, 2026-08-07: "I as an owner should be able to cancel other users
scheduled tasks." The chat tools were author-scoped with no exception — a
participant could edit or cancel only tasks they created — so the owner could see
every task in `tasks_list` and mutate none of them but their own. Authorless
tasks (created from the dashboard, `createdByUserId: null`) were unreachable from
chat by *anyone*. The dashboard route handlers have always been unrestricted, so
the gap was chat-only.

`checkOwnership` now takes `isOwner` and returns early on it, after the chat
check and never before: `chatId` is bound by the tool context and is the boundary
no rights reach across, so the owner reaches only the current chat's tasks like
everyone else. What they are exempt from is the author rule inside it.

Scope: the exemption covers **both** mutating tools, not delete alone. They share
one guard, and `tasks_update` can set `enabled: false` — the softer form of the
same cancel. Exempting delete only would have let the owner destroy a task but
not pause it. Say so if the intent was narrower.

`guardMutation` resolves owner status from the turn's **authority**
(`authorityUserId ?? userId`) — the same resolution `browse_web` uses, so an
owner's standing chat rule lends the right the same way. Provenance is untouched:
`createdByUserId` still records whoever really created the task. It fails
**closed** — an unreadable policy or no configured owner means the author rule
stands, because widening rights on a failed read is the one outcome a permission
check must never have.

Both tool descriptions now state the real rule and tell the model to just call
the tool rather than refuse on the user's behalf or guess at authorship; the
denial text names the owner as the one who can, so the bot can say why.

Files: `features/scheduled-tasks/server/mcp-tools.ts` (+ test — 11 new, covering
the pure rule and the authority resolution end to end through the registered
`tasks_delete` handler), `docs/api/endpoints.md`, `docs/api/openapi.yaml`,
`docs/architecture/llm-and-mcp.md`, `docs/architecture/security.md`,
`docs/features/scheduled-tasks.md`, `docs/operations/operator-guide.md` — six
docs asserted the old rule, three of them specifically that a dashboard-created
task could not be touched from chat.

Verification: `npm run typecheck` clean, `npm run lint` clean, `npm run test` 985
passed / 21 pre-existing browser-agent failures (unchanged, see below).

Remaining risks:

- Untested against the live bot. The model has to actually call `tasks_delete`
  for someone else's task now instead of talking itself out of it — the failure
  the honesty gate below was built for.
- No audit trail beyond the existing tool trace. An owner cancelling someone
  else's task looks the same in the task's own history as the author doing it;
  the trace's `actor` is the only record of who asked.

## The bot said a task was cancelled without calling any tool at all (`done` pending production deploy + live verification, 2026-08-06)

Trace `3db16957…` (reply, 2026-08-06 12:29 Kyiv), and the turn before it. A user
asked, in reply to the bot, to cancel a scheduled task. The turn made **zero**
tool calls — `tasks_list`, `tasks_delete`, `rules_list` and `rules_delete` were
all offered — and answered, in effect, "removed from the record". The user had
asked for the same thing one turn earlier and got the same lie. The task is
still scheduled.

The model's own reasoning shows why: it listed `rules_list` as step one of its
plan four separate times over ~2,900 reasoning tokens, then dropped it —
*"if I find no rule in `rules_list`, I won't call the tool because there is
nothing to delete"*. It declined to run a **read** because it had already
guessed the read would come back empty, and then reported the guess as a result.

This is the third instance of the same class (2026-08-03 rule turn, 2026-08-05
failed `tasks_delete`, this one). The base prompt's Honesty block already
forbids it in five rules, including the exact case — *"Someone asking you the
same thing again is telling you it did not take effect"*. More standing prompt
text is not the lever.

### Fix — a post-answer honesty gate

`features/bot-messaging/server/action-claim.ts` (new). On a turn that made no
tool call at all, the drafted reply goes to one classifier call: does it assert
the assistant did (`performed`) or will do (`promised`) something, or not
(`none`)? A claim only counts when the model quotes the words carrying it and
that quote really occurs in the reply — code checks the mechanical fact (a tool
ran / the quote is real), the model judges the language. On a confirmed claim,
the answer is shown back with `ACTION_CLAIM_ENFORCEMENT_DIRECTIVE`, whose third
paragraph names the specific mistake above ("read it with the tool that reads
it"; a repeated request is evidence the thing is still there). The retry either
calls a tool (nothing left to check) or is re-gated once; a second confirmed
claim is suppressed and the chat gets `ACTION_NOT_TAKEN_REPLY` with the trace
failed — same shape and same reasoning as the rule-turn enforcement.

Fails **open**, unlike the addressing analyzer: an unreadable verdict, an
unbacked quote, or a provider failure means the reply goes out as written. This
guard removes lies; it must not become a new way for honest turns to break.

User decision, 2026-08-06: of the fixes offered (inject the chat's active
scheduled tasks into the system prompt / this gate / a larger reply model), the
gate alone was chosen.

Files: `features/bot-messaging/server/action-claim.ts` (+ test),
`features/bot-messaging/server/service.ts` (`checkActionClaim` dep,
`runActionClaimGate`, step 4e), `server/telegram/process-update.ts` (shared
`runClassifier` — addressing, its verifier and the gate now cannot drift apart
on model/effort/token cap), `features/analytics/llm-call-kind.ts`
(`action-claim-check`; also adds the missing `addressing-verify`, which was
being mislabeled `reply-final` on the Model-performance page).

Verification: `npm run typecheck` clean, `npm run lint` clean,
`npx vitest run features/bot-messaging/server` 102 passed. Full `npm run test`:
974 passed, 21 failed — all 21 in
`features/browser-agent/server/{ytdlp-binary,media-download}.test.ts` and
**pre-existing** (confirmed failing identically on a stashed clean tree). Those
are unrelated to this change and are open work of their own.

### Round 2 — first day live: the gate cost 40s and returned nothing (2026-08-07)

Trace `ab4fc127…` (reply, 2026-08-07 13:26 Kyiv). A user asked the bot to stop
bringing a topic up. It agreed — "crossing it off the repertoire" — with no tool
call, so the gate ran, spent its whole 3,000-token classifier budget on that
two-sentence reply, and was cut off at `finish_reason: "length"` with no verdict
after **40.4s**. Fail-open worked exactly as designed (warn step traced, reply
delivered unchanged), but the turn took 60.7s end to end and the gate was 2/3 of
it.

Two things, one cause.

The question was genuinely ambiguous and the prompt had no answer for it. A
promise about how the bot will *talk* in later messages — stop mentioning
something, drop a topic, be shorter — needs no tool, because talking is the one
thing it does without one. Left unaddressed, the likelier verdict was
`promised`, which would have forced a retry and then suppressed a perfectly
honest reply behind the system notice. So that case is now its own `none` bullet
in the classifier prompt, phrased to cover the figurative forms ("struck off",
"dropped", "closed") the persona actually reaches for.

And the gate had no budget of its own. It inherited `CLASSIFIER_MAX_TOKENS`
(3,000), which is sized for the addressing check, where truncation means a
missed summons. Truncation *here* just restores the pre-gate behaviour, so its
worst case is pure cost. It now has `HONESTY_GATE_MAX_TOKENS` (800) and
`HONESTY_GATE_TIMEOUT_MS` (20s) — ~5x and ~4x this endpoint's own measured norm
for a classifier call of this shape (120–160 completion tokens, 3–5s, from the
`chat rule match` calls in these same traces), so neither can cut off a verdict
that was going to arrive. `runClassifier` grew an optional budget argument;
model and reasoning effort stay shared.

Files: `features/bot-messaging/server/action-claim.ts` (+ test),
`server/telegram/process-update.ts`. `npm run typecheck` clean, `npm run lint`
clean, `npx vitest run features/bot-messaging server/telegram` 229 passed; full
`npm run test` unchanged at 974 passed / 21 pre-existing browser-agent failures.

Remaining risks:

- Scope. The gate only sees turns with **zero** tool calls. A reply that called
  `tasks_list` and then lied about what came back is a different failure the
  mechanical signal cannot see.
- Cost. One extra classifier call on every tool-less turn, which is most
  ordinary conversation. Bounded now, but a normal verdict is still ~3–5s added
  to every such turn, and that has not been measured across a day's traffic.
- The new caps are sized from two traces, not a sample. If the "honesty gate
  failed — reply left as written" step starts appearing on ordinary turns, the
  cap is biting real verdicts and wants raising.
- False positives. A confirmed claim costs a second reply generation, and no
  live one has been observed yet — the only two gate runs so far were one
  `none` and one truncation. Watch the "reply claimed an action no tool
  performed — retrying" step on Debug.
- The underlying trigger is untouched: the model still cannot see which
  scheduled tasks exist without calling `tasks_list`, while chat rules *are*
  injected as standing state. Whatever fired at that chat is still firing.

## The bot said a task was cancelled after `tasks_delete` failed (`done` pending production deploy + live verification, 2026-08-05)

Traces `1f300347…` (reply), `5d33d8c1…` (`tasks_list`), `c757d10a…`
(`tasks_delete`), all 2026-08-05 12:08 Kyiv. A user asked, in reply to the bot,
to cancel a task. Round 1 called `tasks_list` and got the four tasks back. Round
2 called `tasks_delete` with the right task's id **minus one character** — the
model dropped a `6` out of the last group while copying. The tool answered `No
task <id> in this chat.`, and the final round answered that it was done. The task
is still scheduled.

Two independent failures, fixed separately.

### 1. The error told the model nothing it could act on

`checkOwnership` returned the same sentence for a mistyped id, a deleted task and
another chat's task. The model's own reasoning shows it working the case and
giving up — *"it was there a millisecond ago… maybe a race condition"* — because
nothing in the result said the id was malformed, and it had no list to re-copy
from. The loop had rounds left; it just had nothing to retry with.

- `isTaskId` (ids are `randomUUID()` values) and `unknownTaskText`, both pure and
  pinned by tests, in `features/scheduled-tasks/server/mcp-tools.ts`. The miss
  now says which case it is and lists the chat's actual ids to copy from — ids
  `tasks_list` already showed, so nothing new is exposed.
- One `guardMutation` used by `tasks_update`/`tasks_delete`, and the same text on
  `tasks_get`; the chat's ids are loaded **only** on a miss.
- Matching stays exact. Nothing is resolved by prefix or similarity, least of all
  for a delete — the fix is to let the model retry correctly, not to guess for it.

### 2. The reply claimed success over a failed tool call

The worse half. The `Honesty` block of the reply prompt forbids exactly this, in
five sentences, and the model read the failure, spent ~1 400 reasoning tokens
unable to explain it, and wrote "done" anyway. By the final round those rules are
thousands of tokens back and the failure is one unremarkable `tool` message.

- `toolFailureNotice` + a **system turn** appended after any round with a failed
  call (`server/llm/tool-loop.ts`): names the tool and its error, states that
  nothing was done, and gives the two allowed exits — fix the call and retry, or
  tell the user it failed. Generic in the loop, so every feature's tools get it.
- Same shape as the rule-turn enforcement directive below: standing prompt text
  that was ignored is restated at the moment of the decision, and tool *selection*
  is still the model's.

### 3. A failed tool call was traced green

`tracedToolCall` settled `success` for an `isError` result, on the reasoning that
the tool ran. Wrong unit for an operator: the failed `tasks_delete` sat in Debug
as a green row. It now settles `error` with the tool's own message; the result
still reaches the model unchanged. Scoped to `mcp-tools-*` traces, so the
analytics traffic tiles (which count `bot-messaging` only) are untouched.

*Proof.* Files — `server/llm/tool-loop.ts`, `server/mcp/tool-trace.ts`,
`features/scheduled-tasks/server/mcp-tools.ts` (+ all three test files); docs
`architecture/llm-and-mcp.md`, `features/scheduled-tasks.md`. Tests —
`npm run lint` ✅, `npm run typecheck` ✅, `npm test` 950 passed / 21 failed,
those 21 being the known Windows yt-dlp environment failures (same 2 files, same
count as the 2026-08-03 entry below, and neither file imports anything touched
here). New: 3 tool-loop cases (notice content, no notice on success, several
failures in one notice), 1 tool-trace case reworked to the failed status, 9
scheduled-tasks cases (`isTaskId`, `unknownTaskText`, ids handed back on a miss).
`npm run build` not run (would kill the running dev server).

*Remaining risks / live verification checklist (after deploy).*

- Ask the bot in the group to cancel a task and confirm the task actually
  disappears from `/scheduled-tasks`. The interesting run is a *failed* first
  attempt: watch `/debug?feature=mcp-tools-scheduled-tasks` for a **red**
  `tasks_delete`, then check whether the same reply trace shows a second
  `tasks_delete` with a corrected id (the retry landing) or a reply that admits
  the failure. Either is the fix working; "done" with no successful delete is not.
- The notice is English inside a Ukrainian-language turn, like the other
  enforcement text. If it starts leaking into replies verbatim, reword it.
- The id list rides in a tool error, so a chat with many tasks makes that message
  long. Cap it if a chat ever grows past a few dozen tasks.

## A rule turn that called no tool + no recovery from a hung LLM call (`done` pending production deploy + live verification, 2026-08-03)

Two user reports from the same afternoon on the live bot, unrelated in cause.

### 1. The bot said it downloaded a video and downloaded nothing

Trace `ec543b22…` (2026-08-03 15:47 Kyiv). A bare `x.com` link matched the
group's download rule and everything up to the model worked: the matcher cited
the link verbatim, the addressing check opened the turn on the rule's authority,
the directive went in last, all 25 tools including `browse_web` were in the
request. The model then produced **text only** — `finish_reason: "stop"`, no
`tool_calls` — saying it had downloaded the video, with an invented author
handle. Its reasoning block reads *"Action: Use `browse_web` to get the content
of this URL"*, so the call was decided and then not emitted. No
`browser_agent_runs` row exists; the last run on the box was the previous
evening.

Frequency, from all 94 retained successful `bot-messaging` traces on the live
instance: 9 rule-opened turns, **8 called `browse_web`, 1 did not**. Prompt size
is not the discriminator (a 25 103-token turn succeeded; this 23 058-token one
failed), and neither is the site (an `x.com` link went through on 08-01). Same
gemma4:12b tool-avoidance family as the `tasks_list`/`rules_create` items below,
now landing on the one path that *promises the chat an artifact*.

*Decision (operator, 2026-08-03): retry once, then suppress — "but don't be
silent about it".* Also asked and answered: **do not** pursue the standing
model-replacement question yet; fix the guard and record this as evidence.

Note this does not reopen "we never solve model problems by code". Tool
*selection* is still left to the model — nothing is forced, nothing is gated, and
the enforcement directive offers "say you could not do it" as an equally correct
answer. What code now checks is a mechanical fact it is entitled to check: a
directive was injected and `onToolCall` never fired, so the answer's central
claim is false. Same shape as the matcher's citation check.

- `RULE_ENFORCEMENT_DIRECTIVE` (`features/chat-rules/format.ts`) — shown only
  after the failure, with the empty-handed answer appended to the conversation
  in front of it. Deliberately not standing prompt text: the Honesty block, the
  rules block and the trigger directive already said this three times and were
  ignored in this very turn.
- Enforcement in `features/bot-messaging/server/service.ts` (step 4d): tool calls
  counted; one retry; if the retry is also empty-handed the answer is **never
  sent**, a labeled system notice (`RULE_NOT_APPLIED_REPLY`) goes to the chat
  instead, the notice is not mirrored into history, and the trace **fails** so
  the turn is findable on `/debug` (a green trace is how the first one went
  unnoticed for a day).
- Unreachable on an ordinary turn: only a turn nobody addressed gets a directive.

### 2. A hung LLM call lost the reply, with the endpoint healthy

Trace `82a8976c…` (15:51). The reply request died at exactly **120.005 s** with
`Connection to … timed out`, and the operator confirmed Ollama was up. The live
call timeline backs that: the rule match 8 s earlier was fine, and the next
message's classification answered in 11 s starting **0.2 s after** the timeout.
No self-inflicted load either — the poller processes messages serially, and the
only other traces in the window are `vision-backfill` runs finishing in ~20 ms.
One connection hung; `maxRetries: 0` and nothing above it retried, so the group
got the error notice.

*Decisions (operator, 2026-08-03): 90 s timeout × 2 attempts; retry all
interactive calls, not just replies.*

- `CHAT_COMPLETION_TIMEOUT_MS` 120 s → **90 s** (sized from measured traces:
  replies run 40–70 s, slowest successful rule download 66 s).
- `withLlmRetry` + `isRetryableLlmError` (`server/llm/client.ts`), used by both
  completion paths. Judges the **raw** SDK error — `toLlmError` flattens a 400
  and a dropped connection alike to `service_unavailable`. Retries connection
  errors/timeouts and 5xx; never a 4xx, a context overflow, or an empty
  completion (the empty check moved *outside* the retry wrapper for that reason).
  Background calls keep a single attempt — they wait for a quiet endpoint, have
  a 300 s deadline, and re-run on their own schedule.
- The retry sits per **round** in the tool loop, so a hung connection after a
  download re-asks the model with the tool result in hand rather than
  re-downloading. Pinned by a test.
- Visible, not silent: `onRetry` → a `warn` step on the reply trace, so a turn
  that took two attempts cannot pass for a clean one.

*Proof.* Files — `server/llm/{client,tool-loop}.ts`,
`features/bot-messaging/server/service.ts`, `features/chat-rules/format.ts`,
`server/telegram/process-update.ts`; docs
`features/{chat-rules,bot-messaging}.md`, `architecture/llm-and-mcp.md`. Tests —
`npm run lint` ✅, `npm run typecheck` ✅, `npm test` 936 passed / 21 failed,
those 21 being the known Windows yt-dlp environment failures (verified identical
on a stashed clean tree: same 2 files, same 21). New: 7 service cases (retry
composition, delivery after a successful retry, suppression + notice, failed
trace, no history mirror, and both untouched-ordinary-turn cases), 1 retry-step
case, 4 `isRetryableLlmError` cases, 4 `chatCompletion` retry cases, 1 tool-loop
round-retry case, 1 directive-pinning case. The openai mock in both LLM test
files now has `APIConnectionTimeoutError extends APIConnectionError`, matching
the real SDK hierarchy the predicate relies on. `npm run build` not run (would
kill the running dev server).

*Remaining risks / live verification checklist (after deploy).*

- Post a social-media link in the rule-bearing group and confirm the video
  arrives. The case that needs patience is the failure one: it is ~1 turn in 9,
  so watch `/debug?feature=bot-messaging` for a **red** reply trace carrying
  `rule turn answered without calling any tool — retrying`. A trace with that
  step and a green outcome is the retry working, which is the outcome to hope
  for.
- Confirm the system notice reads acceptably in the group when it does fire —
  it is English by design (same rule as the other two notices).
- Watch for `LLM call failed — retrying` steps. A rash of them means the endpoint
  is unwell rather than the timeout being wrong; none at all over a week of the
  90 s deadline means the deadline could go lower still.
- ~~Unverified assumption: that 90 s never cuts off a legitimately slow turn.~~
  **It did, within the hour — see the round below.**
- The enforcement is prompt-plus-suppression, and the retry half is still the
  same model that ignored three standing instructions. The suppression half is
  not — it holds regardless of what the model does. Feeds the standing
  model-replacement question below.

### Round 2 — 90 s was under the reply tail (same day, deployed)

Two live traces from the first hour after deploy settled the deadline question
the checklist above left open, in both directions.

- **The retry works.** Trace at 14:57: a rule-driven Instagram download whose
  reply round hung and was cut at 90 s, recovered on the retry (~62 s), called
  `browse_web`, hung again on the next round, recovered again, and **delivered
  the video**. Two hung rounds, one delivered file. Under the pre-deploy code
  that turn fails.
- **But the deadline was too tight.** Trace `93a963ec…` (15:03): both attempts
  cut at exactly 90.003 s and 90.008 s on a round that was working, just slowly.
  The retry cannot help here by construction — a round that needs 95 s needs
  95 s on the second attempt too, and retrying restarts prefill and decode from
  nothing.

The 90 s came from the 9 rule-download turns (40–70 s), which was the wrong
sample. Over all 118 successful reply rounds on the box: median 18.9 s, p75
38.2 s, p90 54.7 s, p95 68.3 s, **max 95.8 s**, with 2 rounds past 90 s. The
classifications are a different distribution entirely — ~500-token prompt,
median 15–25 s per hour across the whole retained window, **max 57.7 s** — and
that flatness also rules out "the endpoint is degrading": it spikes per call
(a 17 s classification occasionally taking 57 s), it does not drift.

*Decision (operator, 2026-08-03): 150 s for replies, 90 s for classifications.*
The two shapes get their own deadline rather than sharing the reply's.

- New `REPLY_CHAT_COMPLETION_TIMEOUT_MS` = 150 s in `server/llm/client.ts`
  (beside the other two deadlines — the client already owns this vocabulary),
  passed explicitly by both reply paths in `process-update.ts`. ~1.6× the
  slowest legitimate round on record.
- `CHAT_COMPLETION_TIMEOUT_MS` stays 90 s and is now, in practice, the
  classification deadline — 1.5× their 57.7 s worst case — so a hung
  classification still fails over fast instead of inheriting a reply-sized wait.
- The doc comments now state the division of labour explicitly, because getting
  it wrong is what round 1 did: **the retry is for a request that never got
  going; the deadline is for one that is merely slow.**
- Pinned by a test on the ordering and the observed-maximum headroom, so the
  three deadlines cannot silently collapse back into one.

*Proof.* Files — `server/llm/client.ts`, `server/telegram/process-update.ts`,
`docs/architecture/llm-and-mcp.md`. `npm run lint` ✅, `npm run typecheck` ✅,
`server/llm` 71 passed (2 new deadline cases).

*Still open.* 150 s is headroom over the *observed* max, not a proof. If a reply
fails twice at 150 s, that is a genuinely stuck endpoint rather than a tuning
problem — check `/api/ps` and the `OLLAMA_NUM_PARALLEL`/VRAM note below before
raising it again. Worst case a person now waits ~5 min before the error notice.
Also unaddressed and visible in the same window: `history-summaries` failed
twice at 418 s and 340 s against its 300 s background deadline, which is the
batch-size question already flagged under the priority-gate entry.

## Restricted rule-driven downloads: stranded files + substitute download (`done` pending production deploy + live verification, 2026-08-01)

Two incidents in the group, same afternoon, both children of the owner's
"download social-network media links" rule (traces `1747a84c…`/`f458155f…` and
`dc7df92e…`/`35dc99a4…`):

1. A member asked for a YouTube video; the rule matcher (gemma4:12b) matched the
   YouTube link to the "x.com, tiktok, instagram" rule, lent the owner's rights,
   and the 77 MB result exceeded the 20 MB attach cap — so it was "kept" on the
   server and the chat was told the file is in "your downloads folder", which no
   chat user can reach.
2. A bare x.com link opened a rule turn; the chat model composed the goal with a
   **flipped digit in the 19-digit tweet id** (`…702` → `…102`) *and* appended
   "(або аналогічний відео/медіа файл)" — the exact softener `browse_web`'s
   description forbids. The sub-agent, unable to download the (mangled) tweet,
   searched "popular music videos 2024" and delivered Maroon 5's "Sugar" as a
   "similar" file, kept on disk, reported as success.

*Decisions (operator, 2026-08-01).*

- **Attach or fail** for **restricted** runs: a download the chat cannot take is
  deleted, not kept; the run's report says the delivery failed and is sent
  **silent** (no ping). Restricted (second decision, same day: *"it has to be
  the same for the owner in a group chat"*) = a standing rule drove the run in
  a **group** — the owner's own message included — or lent the sender rights
  they did not hold. The owner's direct requests, their own DM rules, and
  dashboard runs stay unrestricted (kept on disk as before).
- **The attach cap is not a setting.** `browser_download_max_mb` removed from
  settings/dashboard; fixed at Telegram's 50 MB bot upload ceiling
  (`TELEGRAM_MAX_UPLOAD_MB`, `lib/telegram.ts`).
- **Hard data does not pass through an LLM.** Message URLs are extracted in code
  (`features/browser-agent/urls.ts`), bound to the tool context
  (`McpToolContext.messageUrls`), stored on the run (`source_urls`), appended
  verbatim to the agent's goal message, and — for a `restricted` run (new
  column) — the download tools accept **only** those URLs or same-site ones
  (subdomain folding + `youtu.be`↔`youtube.com`, `x.com`↔`twitter.com`
  aliases). Rule-driven-ness is detected as `authorityUserId` being bound on
  the turn: the matcher only binds it when a rule with rights actually
  matched, and it is skipped on the owner's direct (addressed) requests.
  Declined alternatives: deterministic domain-matching for rules, dropping
  elevation entirely.
- **Prompt hardening**: the agent system prompt forbids substitute/"similar"
  downloads — a failed target is a failed run, reported honestly.
- **Local Bot API server** (2 GB uploads) deferred — see Other open items.

*Files.* New — `features/browser-agent/urls.ts` (+ `urls.test.ts`),
`db/migrations/0046_lonely_ben_parker.sql`. Changed — `lib/telegram.ts`,
`db/schema.ts`, `server/mcp/context.ts`, `server/telegram/process-update.ts`,
`features/browser-agent/{types,format}.ts`,
`features/browser-agent/server/{agent,tools,runner,repository,service,mcp-tools}.ts`
(+ `tools.test.ts`, `mcp-tools.test.ts`, `browse-live.integration.test.ts`),
`features/settings/server/{schema,repository,service}.ts` (+ integration test),
`features/settings/ui/SettingsForm.tsx`,
`features/chat-rules/server/live-flow.integration.test.ts`, docs
(`configuration.md`, `architecture/{data-model,security}.md`,
`features/{browser-agent,chat-rules}.md`, `operations/operator-guide.md`,
`api/openapi.yaml`).

*Verification.* `npm run lint` clean, `npm run typecheck` clean, `npm test` 90
files / 930 passed (new: 12 for `urls.ts`, 3 dispatcher cases — URL fence,
alias, discard; enqueue elevation/sourceUrls pins), `npm run test:integration`
25 files / 338 passed / 41 live-LLM skipped. `npm run build` **blocked** by the
known `data/pg` EACCES (fifth recurrence, tracked below; reproduces with the
changes stashed).

*Deployment finding (2026-08-01).* Asked to "kill the running server and
migrate", it turned out **the production bot does not run on this machine**: no
app process or container, no built image, no `data/traces/traces-2026-08.ndjson`
anywhere on disk, and the local Postgres (`llm-tg-bot-nextjs-db-1`) holds zero
messages for the incident group, none of today's runs, and no client
connections — this checkout + DB is the dev environment. Migration 0046 **was
applied to the dev DB** (`npm run db:migrate`, journal at 0046); the production
deployment (wherever it lives) still needs: pull this code, rebuild the image,
run the migration during the restart. The stale memory that production runs
from this working copy has been corrected.

*Remaining risks / next steps.*

- **Production deploy + migration** are the operator's (or need access details):
  migration 0046 drops `settings.browser_download_max_mb`, which older builds
  still select — apply it together with the code, during the restart.
- **Live re-test** (operator): repeat both incidents — a YouTube link from a
  non-owner (expect: download refused as out of rule scope, or delivered if it
  fits 50 MB once the matcher fires; nothing new left in `data/downloads`), and
  a dead x.com link (expect: honest failure report, silent, no substitute file).
  Also the owner's own link in the group via the rule: >50 MB must now be
  discarded + reported silent, not kept.
- The two stranded incident files (`Maroon 5 - Sugar….mp4`,
  `Mission… Impossible….mp4`, ~140 MB) are on the production host's
  `data/downloads` — delete there.
- Accepted limitation: on a restricted run, a direct-file/stream URL on a CDN
  host differing from the message's site is refused too; the rule use-case is
  media pages, where `browser_download_media` takes the page URL itself.
- The host alias table is deliberately tiny (`youtu.be`, `x.com`); a new
  share-domain alias (e.g. a future shortener) needs a one-line addition in
  `urls.ts`.
- The rule matcher still over-matches ("such as" lists judged by gemma4:12b) —
  now bounded in blast radius rather than fixed; folds into the standing
  model-replacement question.

## Keeping yt-dlp up to date (`done` pending live verification, 2026-08-01)

*Why.* The image installed yt-dlp from `apk`, which is frozen per Alpine release: the
copy on this machine was `2026.03.17` against upstream's `2026.07.04`, four months and
many YouTube-side changes behind. The recorded remedy ("rebuild against a newer base
image") was never reliable — a rebuild only moves to whatever Alpine froze next. And
the failure is silent: a stale yt-dlp does not warn, it answers *every* media page with
an extraction error until a user's request fails.

*Decisions (operator, 2026-08-01).* Asked with four options (runtime auto-update job /
pinned binary rebuilt manually / pip in the Dockerfile / host-side rebuild cadence).
Chosen: **runtime auto-update job**, with the downloaded binary **ephemeral** — kept in
`/app/data/bin` inside the container, re-downloaded on boot after a recreate, rather
than bind-mounted. Rationale for ephemeral: no Compose change and no host directory
whose ownership must be kept right for the non-root `app` user; the cost is one ~40 MB
download per redeploy.

*What shipped.* The Dockerfile now installs upstream's self-contained `musllinux`
build, pinned by version + SHA-256 and arch-selected, instead of `apk add yt-dlp` —
which also drops python3 from the image. That build is only the floor: a daily job on
the shared daily-job model checks GitHub's latest release, verifies the asset against
the release's `SHA2-256SUMS`, **runs it from a temp path**, and only then renames it
over `data/bin/yt-dlp`. The media downloader resolves its command per download, so an
update lands without a restart. A container with no managed copy checks once at boot
instead of waiting for the night.

Failure design: every expected dead end (unsupported platform, already current, GitHub
unreachable or rate-limiting, no usable asset) settles as a no-op summary; only a
checksum mismatch or a downloaded binary that will not run raises — and neither can
replace the working binary, because the rename happens last.

*Files.* New — `features/browser-agent/ytdlp-release.ts` (+test),
`features/browser-agent/server/ytdlp-binary.ts` (+test),
`features/browser-agent/server/ytdlp-scheduler.ts`,
`features/browser-agent/ui/YtDlpJobCard.tsx`, `app/api/browser/ytdlp/run/route.ts`.
Changed — `Dockerfile`, `server/paths.ts` (`binDir()`),
`features/browser-agent/server/media-download.ts` (resolver),
`server/telegram/register-node.ts`, `lib/features.ts` (`ytdlp-updater`),
`features/jobs/server/registry.ts` (+test), `app/(dashboard)/browser/page.tsx`,
`features/browser-agent/server/media-download.test.ts`. Docs — `getting-started.md`,
`architecture/{overview,security,background-jobs}.md`,
`operations/{deployment,troubleshooting,operator-guide}.md`,
`features/{README,browser-agent}.md`, `api/{README,endpoints,openapi.yaml}`.

*Verification.* `npm run lint` clean, `npm run typecheck` clean, `npm run test` 89
files / 915 tests passing (38 new: 20 for the release helpers, 15 for the updater, 1
for the managed-binary preference, 2 for the job view). `npm run build` **fails**, but
not because of this change: Turbopack's tree walk hits `data/pg` (owned by the
container's postgres uid, `drwx------`) and dies with `Permission denied`. Confirmed
pre-existing by stashing every change and rebuilding — same error, same directory,
just named against `server/download.ts` instead. Fixed on the operator's side with
`sudo chmod -R g+rX data/pg`.

*Remaining risks / next steps.*
- **Not verified live.** The updater has never run against real GitHub: the tests stub
  `fetch`. First real proof is hitting **Run now** on the yt-dlp updater card and
  seeing the version badge move off the image's pinned build.
- The image change needs a rebuild before the deployment has any of this; until then
  the running container still has the apk `yt-dlp`.
- Integrity, not provenance: `SHA2-256SUMS.sig` is not checked (no GPG keyring in the
  image). Recorded in `docs/architecture/security.md`.
- The boot check re-downloads ~40 MB after every container recreate, by design.

## Poller does not survive an outage; Stop does nothing (`done` pending live verification, 2026-08-01)

User report: after a few hours without an internet connection the bot never came
back, and Stop on the dashboard did nothing at all. Both are one root cause, in
`@grammyjs/runner`'s defaults.

*What happened.* The runner's update fetcher retries a failing `getUpdates` with
**uncapped doubling** backoff (100ms → 200 → … ) for up to **15 hours**. After
three hours down, the next attempt had been scheduled roughly three hours out, so
the connection returning changed nothing. That sleep is a bare `setTimeout` the
abort signal cannot interrupt — and `runner.stop()`'s promise only settles once
the fetch loop unwinds. `stopBotInternal` awaited it, holding `transitioning`
true for the whole sleep, so the dashboard POST hung and every later start/stop
returned the stale status immediately. Hence "nothing happened".

*Fixes* (`server/telegram/bot-manager.ts`):
- `maxRetryTime: 30_000` on the runner, so a drop surfaces in a window instead of
  disappearing into a multi-hour sleep.
- Reconnect supervision owned by the manager: a flat **15s** retry for as long as
  the failure is a network one (`HttpError`, plus a handshake that outran the new
  20s deadline), driven by a `desired` flag that Stop withdraws. A `GrammyError`
  (Telegram answered and refused — revoked token, second poller) settles as a
  plain error rather than spinning. Status carries `reconnecting automatically`;
  logging is edge-triggered, one line down and one back up.
- `stopBotInternal` detaches after a **3s** drain instead of awaiting the sleep.
  Safe because the abort is synchronous — the detached loop throws on its next
  fetch. The task-rejection handler now checks runner identity, so a late
  rejection from a replaced runner cannot clobber a live bot (a pre-existing bug:
  it would have nulled the *new* bot).
- `bot.init()` bounded by `initWithDeadline` (grammy's own client timeout is
  500s — long enough to hold the transition lock and the request behind it).
- `register-node.ts`: the autostart promise has a `catch`, so a boot with the
  database unreachable no longer ends in an unhandled rejection.

Proof: files `server/telegram/{bot-manager,register-node}.ts`, new
`server/telegram/bot-manager.test.ts` (10 — retry window, handshake deadline,
self-reconnect, keeps retrying while the outage lasts, no spin on a refused
token, stale-runner rejection ignored, Stop answers while the loop is asleep,
Stop leaves the manager startable, Stop cancels a pending reconnect), docs
(`docs/architecture/telegram-pipeline.md` new "Losing the connection" section,
`docs/operations/troubleshooting.md`). `npm run lint`, `npm run typecheck`,
`npm test` (87 files / 877) all clean; `npm run build` blocked again by the
`data/pg` EACCES tracked below (fourth recurrence — needs the operator chmod).

Remaining risks / next steps:
- **Live verification:** pull the network for a few minutes with the bot running.
  Expect the status to flip to error + `reconnecting automatically`, one log line,
  and the bot back within ~15s of the link returning — and Stop to answer at any
  point during it. Only the mocked lifecycle has been exercised so far.
- 15s of retries costs nothing while down (each attempt fails at connect), but on
  a *partial* outage where Telegram answers slowly, attempts overlap the 20s
  handshake deadline. Accepted: the transition lock serialises them.
- A drop is still invisible until the runner gives up (up to 30s of its own
  retrying); no "degraded" state is surfaced during that window.

## Scheduled-task context on update + delivery-history pollution (`done` pending live verification, 2026-08-01)

Two user reports against the round-3 `context` work tracked under "Context-free
reminders" below.

1. **Context is not gathered when a task is updated via MCP.** The GATHER CONTEXT
   rule lived only on `tasks_create`, and `tasks_update`'s description said
   nothing beyond "only the fields you pass are changed" — so the very case the
   context column exists for (a user handing over the background a thin existing
   task was missing) went through with nothing gathered. New exported
   `TASKS_UPDATE_DESCRIPTION` carries the create rule reworded for updates,
   naming that case explicitly, warning against leaving stale context behind a
   changed instruction, and exempting a pure schedule/enabled change. The
   `instruction`/`context` field descriptions were tightened to match. Context is
   now also *visible* to the model: `tasks_get` and the create/update
   confirmations print it (new `taskText`), and `tasks_list` flags a task that has
   none — previously the tool text showed only `summarizeTask`, so the model could
   not tell whether a task carried any background at all.
2. **Recent deliveries polluted the fire.** The last five delivered texts are fed
   back for wording variation, but nothing said so: a hallucination in one fire
   read as context for the next and compounded. `buildTaskDirectiveMessage`'s
   block is now labelled `WORDING REFERENCE ONLY`, states they are the bot's own
   past messages, not a source of facts, may be wrong/stale/invented, and that
   anything in them not in the directive or saved context must not be repeated or
   built on. Same source ranking `BASE_SYSTEM_PROMPT`'s Grounding block applies to
   the bot's own transcript lines.

Proof: files `features/scheduled-tasks/server/{mcp-tools,fire}.ts` (+
`mcp-tools.test.ts` 5 new pinning cases, `fire.test.ts` 1 new),
`docs/features/scheduled-tasks.md` (which had never documented `context` at all —
the Saved context section and the `context` key column are new). `npm run lint`,
`npm run typecheck`, `npm test` (87 files / 877), `npm run test:integration
features/scheduled-tasks` (22 passed / 7 live-LLM skipped) all clean.

Remaining risks / next steps: this is prompt text against gemma4:12b, the same
model that ignored rounds 1–3 of the create-side rule — see the tool-avoidance
item below. **Live re-test:** give the bot the background for an existing
context-less task in chat and confirm the `tasks_update` call actually carried a
`context` (not just a claim that it did), then let the task fire.

## Browser-agent chat delivery overhaul (`done` pending live verification, 2026-08-01)

User report (2026-08-01, after the first live rule-driven Instagram download): the
video arrived as a plain document instead of a playable video, and the flow was
three messages where one or two would do (the "Завантажую контент" ack, the file,
then a report repeating the filename). Three changes, all user-requested:

1. **Playable media.** `sendChatDocument` became `sendChatFile`
   (`server/telegram/bot-manager.ts`): the send method is picked from the mime by
   the new pure `telegramFileKind` (`lib/telegram.ts`) — `sendVideo` (with
   `supports_streaming`) for MP4/QuickTime, `sendAudio` for MP3/M4A, `sendDocument`
   otherwise, with a document fallback when Telegram rejects the media kind
   (`GrammyError` only — a network error still throws, a blind retry could
   double-send). Captions render HTML-with-plain-fallback like messages.
2. **File + report in one message.** Attachable downloads are no longer sent as
   they land; `onDownload` stages them (`"staged" | "kept"` — new
   `DownloadOutcome` in `tools.ts`; `CollectedFile` gained `filePath`) and the
   runner delivers at settle: a single staged file with a caption-sized report
   goes out as ONE combined message; otherwise files under their own line + the
   report as text. The recap lists only files that did NOT reach the chat. The
   disk copy now survives until the send succeeds (previously unlinked at
   download time on delivery); a failed run still delivers its staged files
   before the failure notice.
3. **Silent, self-deleting ack.** `browse_web` reports the enqueued run to the
   turn via `McpToolContext.onBrowserRunEnqueued`; the reply pipeline then sends
   the model's "on it" reply with `disable_notification` and registers each
   delivered chunk in the new in-memory ack store
   (`features/browser-agent/server/ack.ts`, `globalThis` like `signal.ts`). The
   runner deletes the ack (new `deleteChatMessage`) after posting the outcome, on
   success and failure, and soft-deletes its history-mirror row (new
   `markMessageDeleted` in history service + `markChatMessageDeleted` repository
   fn — first writer of the existing `deleted_at` column). Race-safe both ways: a
   run that settles first leaves a marker and the late-arriving ack is deleted on
   registration (via the new optional `ReplyTransport.deleteMessage`).

Proof: files — `lib/telegram.ts` (+ new `telegram.test.ts`),
`server/telegram/{bot-manager,transport,process-update}.ts`,
`server/mcp/context.ts`, `features/browser-agent/server/{tools,runner,mcp-tools}.ts`,
new `features/browser-agent/server/ack.ts` (+ `ack.test.ts`),
`features/browser-agent/format.ts` (doc),
`features/history/server/{repository,service}.ts`,
`docs/features/browser-agent.md`. Tests: `npm run lint`, `npm run typecheck`,
`npm test` (86 files / 861), `npm run test:integration` (338 passed / 41
live-LLM skipped) all clean; `tools.test.ts` reworked to the staged contract,
`mcp-tools.test.ts` gained the ack-wiring case. `npm run build` could NOT be
run: the known `data/pg` Turbopack EACCES recurred (third time — tracked below;
needs the operator chmod), and reproduces with these changes stashed.

Remaining risks / next steps:
- Live verification: send a social-media video link through the bot again — the
  ack should arrive without a ping and vanish when the video posts; the video
  should play inline and carry the report as its caption; `downloads/` should not
  keep a copy.
- The report is the caption now, so a >1024-char report degrades to the old
  two-message form by design.
- The ack of a run that outlives a server restart is not deleted (in-memory
  store; accepted — cosmetic).
- An ERROR_REPLY sent after a turn that enqueued a run goes out silent too (the
  send closure cannot tell it apart); it is never registered as an ack, so it is
  not deleted. Accepted.

## Browser-agent context-window exhaustion (`done`, 2026-07-30)

Root cause of trace `622483e0…` (browser-agent run failed with
`service_unavailable: LLM returned an empty response`): the run's prompt grew
monotonically (every stale page snapshot and 20k-char `browser_source` chunk
carried verbatim forever) until it filled the Ollama server's 32,768-token
window; the final round was cut off (`finish_reason: "length"`) before emitting
content or a tool call, and the loop reported that as a plain empty response —
with the download URL already found. Server side, the window was raised the
same day (`OLLAMA_CONTEXT_LENGTH`, verified loaded at 256,000 via `/api/ps`;
the model's native max is 262,144, and Ollama's OpenAI-compatible API has no
per-request way to set context size). App-side fixes:

- **Conversation compaction** — `RunToolLoopParams.compact` rewrites what each
  round *sends* (copy per round; kept history stays complete), wired for the
  browser agent as `compactAgentConversation`: every page-state snapshot but
  the latest, every `browser_source` chunk but the latest two, and every
  screenshot vision turn but the latest become one-line "superseded — re-fetch
  with X" stubs. Search results, network listings and download outcomes stay
  verbatim (small, durable URLs acted on rounds later).
- **Truncation detection** — `finishReasonOf` + `CONTEXT_EXHAUSTED_MESSAGE` in
  `server/llm/client.ts`; both completion paths now throw "LLM context window
  exceeded …" instead of "LLM returned an empty response" when an empty
  completion has `finish_reason: "length"`. The message deliberately matches
  `isContextOverflowError`, so bot-messaging's window-shrink retry and
  history's batch-shrink retry recover from mid-generation exhaustion too.

Proof: files `server/llm/client.ts`, `server/llm/tool-loop.ts`,
`features/browser-agent/server/agent.ts` (+ tests `agent.test.ts` new,
`tool-loop.test.ts`, `client.test.ts`); lint/typecheck/build clean, unit suite
84 files / 849 tests passed (2026-07-30). Remaining risks: compaction is
always-on (a goal needing two page texts side-by-side must re-read — accepted;
the system prompt already declares old refs stale); a *truncated but non-empty*
final report still ships as-is rather than erroring.

## Voice/vision trace + describe-race overhaul (`done`, 2026-07-27)

Root cause of the "transcription succeeded but the bot said it couldn't hear"
incident (trace `11162be5…` / `69761c50…`): `describeAndStore` handed the
transcript back only through `markDescribed`'s row, which returns null when a
concurrent pass described the row first — the caller then read `description:
null` from the stale pre-read row and told the model transcription failed,
while the trace recorded a clean success. All user decisions 2026-07-27:

- **One reply trace per incoming message.** Live transcribe/describe passes
  record into the `bot-messaging`/`reply` trace (`describeAndStore` takes an
  optional parent `TraceRecorder`; the runtime opens the reply trace before
  eager voice transcription via `startReplyTrace` and the service adopts and
  settles it on every path). Standalone `voice`/`transcribe` and
  `vision`/`describe` traces remain only for backfill/probe passes. Side
  effect (accepted): the `/debug` voice/vision feature filters now show only
  those standalone traces; live passes are inside reply traces. Analytics is
  unaffected — usage events carry explicit `callKind`.
- **Honest describe results.** `describeAndStore` returns the text it produced
  or found: a lost `markDescribed` race re-reads and reuses the winner's text
  (warn event), an already-described row is reused without an LLM call, and a
  parent-trace failure becomes a warn event + null, never a fake success.
- **`message_media` → `chat_messages` FK** on `(chat_id, telegram_message_id)`
  (cascade): media never floats free of the mirror. Migration `0041` sweeps
  orphans first (stub mirror rows for `described` orphans, delete the rest).
  Consequences implemented: media from bot-authored messages is no longer
  ingested (was also wasting transcription calls on other bots' voice), and a
  mirror failure now blocks media handling (warn event on the reply trace).
- **Live-processing semaphore** `chat_messages.processed` (user-proposed): the
  live pipeline mirrors with `false` and releases to `true` in `processUpdate`'s
  `finally`; `listPendingMedia` only returns released rows, with a **10-minute
  timeout** fallback so a crashed pipeline can't hide a row forever. This is
  DB-level, so it also fences a backfill in another process sharing the DB.

Proof: files — `db/schema.ts`, `db/migrations/0041_slimy_molten_man.sql`,
`features/vision/server/{service,repository,backfill}.ts`,
`features/history/server/{service,repository}.ts`,
`features/bot-messaging/server/service.ts`, `server/telegram/process-update.ts`,
`server/trace/{recorder,store,with-trace}.ts` (new `setInputSummary`),
`test/db.ts` (`seedMirrorMessage`), docs (`vision.md`, `voice.md`,
`history.md`). Tests: new coverage for the write-race reuse, parent-trace
nesting, re-delivery reuse, semaphore gating + timeout, pre-opened-trace
settlement; `npm run lint`, `typecheck`, `test`, `test:integration`, `build`
all green (see handoff note below if any flipped). Migration applied to the
dev DB. Remaining risk: the production incident's *second* transcriber was
never identified from the two exported traces alone — if it recurs, check the
trace list for the correlation id and whether another process shares the
production DB.

## Priority 15 — Specialists (`done`, 2026-07-27)

Implemented per the user-decided design of 2026-07-27 (now documented in
`docs/features/specialists.md`): operator-only `/specialists` CRUD, one shared
MCP data toolkit over a unified `specialist_entries` store (free-text
collection + JSONB payload), per-chat activation stacking base + personality +
specialist, in-tool switch gating (self-serve in own DM, owner-only in
groups), the per-specialist `per-chat`/`shared` data-scope flag, proactivity
via the existing scheduled-tasks engine, and three editable seed rows.

Implementation choices within the decided guardrails (values were unspecified):
payload cap 16 384 bytes/entry, query cap 50 results, collection label ≤128
chars, max 32 specialists (the personalities bound). Load-bearing integration
delivered by making scheduled-task fires run with the full registered toolset
(`chatCompletionWithTools`) inside the task chat's tool context — so a
specialist's check-in queries its own entries mid-fire; tool calls are
recorded on the fire trace as `external_call` events.

Proof: files — `db/schema.ts` + migration `0042_next_iron_monger.sql` (three
tables + seeds; **applied to the dev DB**), `features/specialists/*`
(schema/repository/service/mcp-tools/UI), `app/api/specialists/**`,
`app/(dashboard)/specialists/page.tsx`, `lib/features.ts`
(`specialists` + `mcp-tools-specialists`), `lib/realtime.ts` (`specialists`
topic), `server/mcp/runtime.ts`, `components/layout/nav-config.ts`,
`features/bot-messaging/server/{prompt,service}.ts`,
`server/telegram/process-update.ts`,
`features/scheduled-tasks/server/{fire,scheduler}.ts`, docs
(`docs/features/specialists.md`, features README, AGENTS.md). Tests: new
`specialists.integration.test.ts` (18: seeds, CRUD, assignment, switch gating
DM vs group, scope silos, caps, browser, traces), `mcp-tools.test.ts`
(no-active-specialist result, save normalization, switch relaying), prompt
stacking + fire-path composition/tool-context tests added to existing suites.
`npm run lint`, `typecheck`, `test` (716), `test:integration` (311 passed / 31
skipped — the live-LLM-gated ones), `build` all green. Remaining risks: the
dashboard page was verified only by build + tests (operator auth blocks an
agent from logging in — check `/specialists` renders after the next dev-server
restart; the "new MCP tools only appear after a restart" caveat recorded here is
no longer true, see the chat-rules entry — the registry now rebuilds itself when
the tool set changes); gemma4:12b tool-selection quality over the new toolkit is
unmeasured — if the model ignores `specialist_*` tools live, tune the seed
instructions/tool descriptions like the tasks tools were.

## Memory scope placement — `general` holds outsiders again (`done`, 2026-07-28)

*What happened.* Trace `833006d7…`: a user told the bot to remember, once and for
all, who a person discussed in the chat is. The model called `memory_save` with
`scope: "general"`, the tool returned `saved: true`, the bot replied "записав",
and the 17:20 consolidation run reported `general knowledge updated`. The fact was
nowhere afterwards. `GENERAL_MERGE_PROMPT` had been told biography "is a line to
drop" (2026-07-17 rule), so the merge correctly excluded it — and
`runMemoryConsolidation` deletes every note in the batch whenever the merge
returns a non-empty document, kept or not. Confirmed promise, silent loss.

*Decision (operator, 2026-07-28), reversing 2026-07-17.* Placement is decided by
**who the fact is about**: someone this chat knows → `user`; anyone else →
`general` is the right home, name written into the fact. The two follow-ups
offered — "don't delete what the merge didn't keep" and "surface the discard" —
were explicitly declined; the gate is the fix.

*Fixes landed.*
1. **Gate, both directions** (`features/memory/server/service.ts`) —
   `resolveMemorySubject` (chat-scoped reference → known-user id; a reference
   matching nobody now points the model at `general` instead of "drop the fact")
   and `checkGeneralNoteSubject` (a `general` note whose declared `person`
   resolves to a chat participant is refused and sent back as `user`). Both are
   service-level, so the `memory_save` tool and passive extraction clear the same
   bar (extraction already writes through `saveMemoryNote`, and its rejections are
   already traced as warnings).
2. **`mcp-tools.ts` thinned** — the old local `resolveSubjectId` is gone;
   `memory_save`/`memory_get` call the service. Tool description rewritten: which
   scope a person-fact belongs in, and that `person` is meaningful for `general`
   too.
3. **Prompts realigned** — `UNIDENTIFIED_PERSON_RULE` now says "save it as general
   with their name in" (shared by the tool and `EXTRACTION_SYSTEM`);
   `GENERAL_MERGE_PROMPT`'s biography ban replaced with "keep every named fact",
   retaining the never-merge-two-people guard that makes the reversal safe;
   extraction's `general` scope line and empty-roster fallback updated to match.

Files changed: `features/memory/prompt.ts` + `prompt.test.ts`,
`features/memory/extract-prompt.ts` + `extract-prompt.test.ts`,
`features/memory/types.ts`, `features/memory/server/service.ts`,
`features/memory/server/mcp-tools.ts`,
`features/memory/server/memory.integration.test.ts` (new `subject placement`
block), `docs/features/memory.md`, `docs/architecture/data-model.md`,
`docs/architecture/llm-and-mcp.md`.

Verified: `npm test` (75 files, 741 passed), `npm run lint`, `npm run typecheck`,
`npm run build` — all clean. **`npm run test:integration` could not be run** on
this machine: testcontainers finds no container runtime (`docker` is not
installed), so the new `subject placement` tests are unexecuted — run them where
a runtime exists.

*Remaining risks.*
- The gate only sees the subject the model **declares**. A `general` save that
  names no `person` is taken at its word, so a person-fact can still slip in
  unfiled. Content-scanning was considered and rejected: the triggering fact
  ("Muradyan is a friend of \<user A\> who pranked \<user B\>") names two known
  people incidentally while being about a third, so a mention-based guard would
  have rejected exactly the fact this change exists to keep.
- The merge can still fail to carry a note forward for its own reasons, and the
  batch is still deleted either way (declined above). A note lost that way is
  still silent.
- The 2026-07-17 failure mode (name-keyed lines merging across people) is now held
  off by prompt text alone in the merge, plus the gate keeping known people out.
  Watch `/memory` → General knowledge for two outsiders collapsing into one.

## Media downloads — yt-dlp (`done` pending live verification, 2026-07-29)

*What happened.* Trace `11d1809d…`: the owner sent a YouTube Music link and the words
"download track". The run ended with a paragraph identifying the track and the advice
to *"use standard desktop tools like `yt-dlp`"* — no file. Two independent defects:

1. **No capability.** The two download tools take a whole-file URL and an HLS/DASH
   manifest URL. A media site's player has neither: it derives ciphered, per-session,
   per-format stream URLs in its own JavaScript. Reading the page source or the
   network requests finds nothing downloadable, so there was no path to the file.
2. **The goal was watered down before the agent ever saw it.** The user's message was
   "«link» download track". The chat model composed the `browse_web` goal as
   *"…identify the track and find a way to download it **or provide direct info about
   what it is**"* — an alternative the user never offered. The sub-agent took it. Also
   observed, from the model's own reasoning at seq 7: it concluded from prior
   knowledge that YouTube "doesn't have a direct button" and stopped, without calling
   `browser_get_network` or any download tool. Whether that inspection would have
   found anything usable is not established — the ciphered-URL claim above is why the
   new tool exists, not something that run tested.

*Decisions (operator, 2026-07-29).* A **new `browser_download_media` tool** taking the
page URL (not a fallback inside the existing tools); an explicit **`mode: audio |
video`**, always best available audio and best available video with **no quality
ceiling**; **`apk add yt-dlp`** in the Dockerfile with no `YTDLP_PATH` escape hatch;
**no cookies** from the run's browser session in v1.

*Landed.* New pure `features/browser-agent/ytdlp.ts` (argv, progress lines, error
text) + `server/media-download.ts` (spawn, scratch dir inside `DOWNLOADS_DIR` so the
final rename never crosses a filesystem, `YtDlpMissingError` mirroring
`FfmpegMissingError`, SSRF on the page URL). `server/tools.ts`: the new tool, its
dispatch case behind the same owner gate, and `formatBytes`-duplication removed in
favour of a shared `formatTransferLine` in `files.ts` (which also gained
`mimeForFilename`, since yt-dlp hands back a file with no `Content-Type`). Prompt
work for defect 2: the agent system prompt now states that a goal asking for a file is
not done until a download tool was called and forbids ending a run by telling the user
to download it themselves, and `browse_web`'s description forbids adding a weaker
alternative to the user's request. Dockerfile, `docs/features/browser-agent.md`,
getting-started, deployment, troubleshooting, security, overview, llm-and-mcp updated.

*Follow-on: the download size cap became a setting (operator, 2026-07-29).* Asked why
`MAX_DISK_BYTES` (2 GB, files) and `MAX_STREAM_BYTES` (4 GB, streams) both existed. The
two *mechanisms* differ legitimately — the file downloader aborts and deletes the
partial, ffmpeg's `-fs` truncates and keeps a playable one — but nothing in the code,
the commits or the docs justified the two different *values*, and the 4 GB one was
never documented. Adding yt-dlp would have made it a third arbitrary number. Both
constants are gone, replaced by **`settings.browser_download_limit_gb`** (1–100,
default 10), read once per run by the runner and passed into all three downloaders as
`maxBytes` — so those modules keep no settings dependency. yt-dlp's `--max-filesize` is
a third enforcement style again: it refuses *before* downloading, from the declared
size. Migration `0043_fat_shiver_man.sql` (`ADD COLUMN … DEFAULT 10 NOT NULL`) —
**applied to the dev DB**; still to apply wherever else the app runs.

*Verified.* `npm run lint`, `npm run typecheck`, `npm test` and
`npm run test:integration` (319 passed / 32 skipped — the live-LLM-gated ones) all
clean. `npm run build` passed until the bundled Postgres was started with the default
`PG_DATA_DIR=./data/pg`; since then it fails with EACCES on that directory, which is
an environment problem (see troubleshooting: give the data dir group access) and
reproduces identically with every change here stashed; the integration suite ran for the first time this session, the container runtime
the 2026-07-28 entry below lacked now being available. New unit tests:
`ytdlp.test.ts` (16), `server/media-download.test.ts` (10, against a **stub** `yt-dlp`
on `PATH` — real spawn, no network), `server/tools.test.ts` (7, owner gate + mode
default + error surfacing), plus `files.test.ts` additions.

The new setting was also exercised on the running dev instance: both Core fields render,
saving 25 patched only `browser_download_limit_gb` (attach-limit untouched) and survived
a reload, `PATCH /api/settings` returned 422 for 500 and for 0, and the value was
restored to 10. No console errors.

*Live verification (2026-07-29, operator installed yt-dlp 2026.03.17).*
- **Real binary:** `BROWSER_LIVE=1 … primitives-live -t browser_download_media` passed
  in 1.9 s — `Big Buck Bunny.m4a`, 28 237 KB, named from the media's own title, mime
  `audio/mp4`, on-disk size matching.
- **Real agent run, defect 1 closed:** a dashboard run given the incident's own words
  (`«the YouTube Music link» download track`) called `browser_download_media` with
  `mode: "audio"` as its **first and only** tool call — no navigate, no source read, no
  network hunt — and produced `VIRUS (Fytch Remix).opus` (2 866 338 B) in ~5 s, one
  step, status `done`, honest one-line report. The original trace took 5 LLM rounds and
  61 s to deliver no file. gemma4:12b, the same model.

*Unrelated fix found while verifying.* `npm run lint` failed with `EACCES` on
`data/pg`: `eslint.config.mjs`'s `globalIgnores` replaces eslint-config-next's
defaults and never listed `/data`, so the moment anyone follows the documented Compose
default (`PG_DATA_DIR=./data/pg`, root-owned 0700) the whole lint run dies. Added
`data/**` and `downloads/**` — both already in `.gitignore`, neither ever source.

- **Defect 2 closed too.** A subsequent Telegram-originated run composed the goal as
  "Download the audio track from this YouTube Music link: «url»" — the user's request
  intact, no "or …" branch. Both halves of the incident are now fixed in practice.
- **Audio is mp3, not the native container** (operator, 2026-07-29, reversing the
  original choice). That first live run returned `VIRUS (Fytch Remix).opus`, which
  Telegram will not play. Avoiding a lossy-to-lossy re-encode was the wrong thing to
  optimize for when the result is unplayable; `--audio-format mp3 --audio-quality 0`
  now, trading some quality for a file every client handles.

- **Downloads are no longer archived on the server** (operator, 2026-07-29): a file is
  kept locally *only* if it did not reach the chat. `onDownload` now resolves whether
  Telegram actually took the document, and `finishDownload` unlinks on success. The
  record's `inline` flag (was the file small enough to attach?) became
  `deliveredToChat` (did the chat get it?) — the old flag also made a dashboard run's
  downloads read as "attached to chat" when there was no chat at all. Old rows lack the
  field and normalize to `false`, correct for them.

*Remaining risks / next steps.*
- The image still needs rebuilding before the deployment has yt-dlp; only this dev
  machine has it.
- The delete-on-delivery path was verified by unit test and by a dashboard run (which
  always keeps the file, having no chat). **The delivered-and-removed branch has not
  been exercised against real Telegram** — send a small track through the bot and check
  the file is in the chat and gone from `downloads/`.
- ~~The distro yt-dlp is frozen per Alpine release while these sites change often~~ —
  addressed by the yt-dlp updater entry below (2026-08-01).
- No cookies means age-gated, sign-in-walled and region-locked pages fail with
  yt-dlp's own error. That was the accepted v1 scope — revisit if it bites.

## On-disk paths are fixed, not configurable (`done`, 2026-07-29)

Operator decision: drop every path env var and put all local state under `./data`.
Removed — `TRACES_DIR` and `DOWNLOADS_DIR` (app), `PG_DATA_DIR`, `TRACES_DATA_DIR`
and `DOWNLOADS_DATA_DIR` (Compose). The layout is now `data/pg`, `data/traces`,
`data/downloads`, resolved from `process.cwd()`, which is the package root locally
and `/app` in the image — the same literals the Dockerfile creates and Compose
mounts. Every deployment already used the defaults; the only thing the variables
bought was a local/container divergence (`./downloads` vs `/app/data/downloads`) and
longer docs.

New `server/paths.ts` owns `tracesDir()` / `downloadsDir()`. The env vars were
load-bearing for **test isolation**, not for operators, so they are replaced by an
explicit `__setDataDirsForTests()` door in the same module — matching the existing
`__resetTraceStoreForTests` convention. `download.test.ts` and
`media-download.test.ts` no longer need `vi.resetModules()`, since the path is read
per call rather than frozen at import.

Files: `server/paths.ts` (new), `server/env.ts` (schema shrinks to `DATABASE_URL`,
`TZ`, `NODE_ENV`), `server/trace/store.ts`,
`features/browser-agent/server/{download,media-download,stream-download}.ts`,
`test/{setup-trace-store,trace-store}.ts`, both download test files,
`docker-compose.yml`, `.env.example`, `Dockerfile`, and eleven docs.

Verified: `npm run lint`, `typecheck`, `test` (780), `build`, `test:integration`
(319 passed / 32 skipped) all clean.

**Migration note for anyone with an existing checkout:** local downloads move from
`./downloads` to `./data/downloads`. Nothing reads the old path any more, so move its
contents across. A deployment that set any of the five variables to a non-default
path must move that data under `./data` before the next `up`.

## Priority 16 — Chat rules (`done` pending live verification, 2026-07-29)

Standing instructions the bot follows in a chat, set from the chat itself or on
`/rules`, composed into every reply's system prompt and carried out with the
existing toolset. Documented in `docs/features/chat-rules.md`.

*Decisions (operator, 2026-07-29), all three taken as recommended.*
- **Opt-in `always` rules.** A rule is `on-reply` (shapes turns the bot already
  answers) or `always` (may act on a group message nobody addressed). An `always`
  rule costs **one classification call per unaddressed message**, and only in a
  chat that has one — the alternatives considered were on-reply-only (cheapest,
  but the operator's own media-download example would never fire in a group) and
  checking every message unconditionally.
- **Per-chat + global scope.** A rule belongs to one chat, or is global
  (`chat_id is null`) and applies everywhere on top of that chat's own. Global
  rules are dashboard-only to author; a chat sees them and cannot change them.
- **Specialists permission precedent.** From chat: self-serve in a private chat,
  owner-only in a group, enforced in the service, denial returned (not thrown) so
  the model relays it.

*Chosen within the guardrails (values were unspecified):* 32 rules per scope,
1 000-char rule text, duplicate text refused per scope, scope not editable
(delete + recreate), rules block appended **last** in the system prompt.

*Files.* `db/schema.ts` + migration `0044_lean_puck.sql` (**applied to the dev
DB**), `features/chat-rules/*` (schema / format / matcher / repository / service /
mcp-tools / ui), `app/api/chat-rules/**`, `app/(dashboard)/rules/page.tsx`,
`lib/features.ts` (`chat-rules` + `mcp-tools-chat-rules`), `lib/realtime.ts`
(`rules` topic), `components/layout/nav-config.ts`, `server/mcp/runtime.ts`,
`features/analytics/llm-call-kind.ts` (`chat-rule-match`),
`features/bot-messaging/server/{prompt,service,addressing}.ts`,
`server/telegram/process-update.ts`, `server/mcp/context.ts`
(`authorityUserId`), `features/browser-agent/server/mcp-tools.ts`,
`features/scheduled-tasks/server/{fire,scheduler}.ts`, docs (feature page,
features README, `llm-and-mcp.md`, `data-model.md`, AGENTS.md).

*Verified.* `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and
`npm run test:integration` all clean — see the proof line in the handoff below.
New tests: `chat-rules/format.test.ts` (16, incl. `resolveRuleAuthority`),
`matcher.test.ts` (11), `chat-rules/.../mcp-tools.test.ts` (11),
`chat-rules.integration.test.ts` (15), a new
`features/browser-agent/server/mcp-tools.test.ts` (5 — the download gate reads
the turn's authority and provenance stays the sender), plus the standing-rules
block in `features/bot-messaging/server/service.test.ts` and the prompt-order
case in `prompt.test.ts`.

The dashboard was also exercised on the running dev instance: creating a global
`always` rule, pausing and resuming it, switching scope to a DM (where it appears
under "Also in force here — 1 global rule"), and deleting it; all three mutations
showed up on `/debug?feature=chat-rules` with their input summaries, and both new
ids appear in the Debug feature filter. No console errors. The test rule was
deleted again, so the dev DB holds no rules.

*Remaining risks / next steps.*
- **Stale MCP registry — fixed, and it was the first live failure** (trace
  `7a3c354e…`, 2026-07-29). The owner said *"new rule - whenever you see a message
  with link to social network media … download it and send to the chat"* and the
  bot replied *"Understood, I'll make sure to…"* without calling anything. The
  request's tool list in that trace holds 21 tools and no `rules_*`: the running
  dev server's registry was built before `registerChatRulesMcpTools` existed, and
  `loadMcpRegistry` cached it on a `globalThis` symbol that survives hot reload by
  design. `/tools` rendered the same 21 and so looked like a page that had never
  been updated — it is fully automatic, and was showing the truth about a stale
  object. Fixed in `server/mcp/runtime.ts`: the registrars are a table whose
  declared `*_TOOL_NAMES` can be read without building, and a cached registry
  whose tool set differs from the loaded code is discarded and rebuilt (also when
  the cached *instance* predates the class — that happened on the very reload that
  added the check). Verified on the running server: `/tools` went from 21 to 25
  tools, all four `rules_*` present, no restart. Pinned in
  `server/mcp/runtime.test.ts` (4), including the reuse case — a registrar whose
  declared names drift from what it registers would rebuild the MCP server on
  every reply turn.

- **The model would not call `rules_create` even once offered — addressed, still
  unverified** (trace `f33e1ede…`, 2026-07-29). With all four `rules_*` tools in
  the request, the third identical *"new rule - whenever you see a message with
  link to social network media …"* still produced only prose. The reasoning block
  is explicit: it worked out that it *should* call `rules_create`, then argued
  itself out of it across 1 761 completion tokens on two beliefs — *"I already
  confirmed twice"* (its own #962/#964 read as evidence the rule was stored) and
  *"calling `rules_create` again for the exact same text might result in duplicate
  rules"*. It also wrote *"I can't see the internal database"* while holding
  `rules_list`. Note the transcript is now self-poisoning: three empty
  confirmations sit in the 24-hour window.

  Fixes (prompt/tool side, per the standing "we never solve model problems by
  code" rule — the one code change makes the tool safe to repeat rather than
  gating anything): chat-side create is **idempotent** (`RuleWriteResult.exists`
  → plain success, stored rule untouched; the dashboard still 409s), the text is
  normalized in the service so an untrimmed repeat cannot slip past the duplicate
  check, `RULES_CREATE_DESCRIPTION` now states that its own agreement is not a
  saved rule, that a repeat is safe, that a repeated instruction means it was not
  believed, and that `rules_list` is the only evidence — and the general form went
  into `BASE_SYSTEM_PROMPT`'s Honesty block (a past confirmation is not evidence of
  having acted; a repeated request is a request; never skip a call for fear of
  doing it twice), which also covers the `tasks_list` fabrication tracked below.

  **Verified against the real model**, unlike the earlier rounds of this
  tool-avoidance family: new
  `features/chat-rules/server/tool-selection.integration.test.ts` drives live
  gemma4:12b through the production prompt + real tool schemas (6 cases — rule
  saved, `always` trigger chosen for "whenever you see a message …", `rules_list`
  on "what rules do you have", list→delete on "forget the rule", and a plain
  "from now on answer in one sentence" going to `rules_create` rather than
  `memory_save`/`tasks_create`). The load-bearing case replays the incident's
  **poisoned transcript** — the bot's own two empty confirmations as `priorTurns`
  — and the model now calls `rules_create` anyway. 3 consecutive full runs, 18/18.
  Canned `rules_*` results added to `test/tool-selection.ts`.

  **The end-to-end path is verified too** (2026-07-29, after the operator fixed the
  `data/pg` permissions): new
  `features/chat-rules/server/live-flow.integration.test.ts` drives synthetic
  updates through the whole real `processUpdate` pipeline against live gemma4:12b,
  in two fresh synthetic chats it cleans up afterwards. Three cases, 3 consecutive
  runs, 9/9:
  - a group holding one dashboard-authored `always` rule, where a **non-owner**
    member posts a TikTok link **without addressing the bot** → the turn opens, and
    the enqueued `browser_agent_runs` row has `is_owner = true` (the rule author's
    rights) with `created_by_user_id` still the poster (provenance untouched) and
    the link in the goal;
  - a synthetic user's DM, where "new rule: from now on always answer me in one
    short sentence" is stored through a real `rules_create` call (`source: chat`),
    traced under `mcp-tools-chat-rules`;
  - ordinary chatter in that same rule-bearing group → still silent
    (`ignored / not_addressed`), so the matcher is not a "reply to everything" switch.

  No owner-sent turn in that test **on purpose**: the owner is a real person in the
  real database and `rememberUser` would overwrite their stored profile with
  synthetic names. The chat-side create is covered in the DM instead, and the
  authority half only needs the matched rule to be dashboard-authored.

  A real Telegram round trip is still the one thing untested by machine — the
  delivered file in a real chat. Everything up to `browse_web` being called with
  owner rights is now proven.

- **The bot side is still not verified live** — the first attempt never reached
  the feature at all, the second never called the tool. The run that matters: in a group, have the owner say *"new rule: when someone posts
  a video link, download it and send it here"*, confirm `rules_create` was called
  (not just claimed — this is exactly the gemma4:12b bluffing pattern tracked in
  the two items below), then have someone post a link **without** addressing the
  bot and check the `chat rule match` step on that message's reply trace.
- **A rule carries its author's rights** (operator decision, 2026-07-29 — *"rule
  creator beats message source"*, reversing the first cut, where the owner-gated
  download made the example rule owner-only in practice). `resolveRuleAuthority`
  elevates a turn to the owner when a **matched** rule was written by the owner or
  in the dashboard; the runtime binds it as `authorityUserId` on the MCP tool
  context and `browse_web` reads it for the download gate. Permissions only —
  `userId` is untouched, so memory/task/run provenance stays the real sender — and
  a rule an ordinary user wrote in their own DM elevates nothing.

  Consequence, and the reason the matcher now runs on **addressed** turns too:
  the answer has to be the same whether or not the person named the bot, so a
  chat with an owner-authored rule pays one classification per addressed message
  from a non-owner as well. It is skipped when it could change nothing (sender is
  the owner, or no rule an elevated author wrote). An `on-reply` rule can lend
  rights even though it can never open a turn.

  Residual risk: a non-owner can put text in front of an elevated turn. They
  cannot *request* an elevated action — only say something a rule matches, with
  the model then told to do what that rule requires and nothing else — but a 12B
  model steered by a crafted message is the exposure the owner accepted here.
  Worth re-reading the `browse_web` goal on the first live rule-driven downloads.
- **The matcher reads text only.** A rule triggered by a bare photo or sticker
  cannot match an unaddressed message; it still works as `on-reply`.
- **Cost on a busy group** is one extra call per unaddressed message once any
  `always` rule exists. Watch Model performance → `chat-rule-match` after the
  first such rule is set; if it is heavy, the lever is making the rule
  `on-reply`.

## Reply latency: LLM priority gate, thinking caps, parallel classifications (`done` pending production deploy + live verification, 2026-08-01)

Measured on the live bot (Debug traces, 2026-08-01): a successful reply took
27–70 s, an ignored group message 5–9 s, and the background jobs were dying —
`history-summaries` and `memory-extraction` failed with "Connection … timed
out" after exactly 120 s because every feature's requests pile into the single
LLM endpoint's queue and the wire timeout burns while queued. Breakdown of a
69 s reply: addressing analyzer 14 s (~1,000 completion tokens — the configured
model thinks, and the thinking dwarfed its 56-char JSON verdict), verifier
4.5 s, final answer 50.7 s (~23k prompt tokens).

*Decisions (operator, 2026-08-01).*

- **Replies have the highest priority** on the shared endpoint; background jobs
  wait. No separate worker/service — an in-process gate on the established
  `globalThis`-singleton pattern.
- **Same model for the classification calls** (no small-model routing);
  **thinking capped** instead (`reasoning_effort: "low"` + a hard
  1,000-token stop).
- **Reply completion capped** (4,096-token hard stop + a stronger brevity rule
  in the base prompt); the ~23k-token reply prompt is **not** shrunk — history
  stays as is, but the summaries job had to be fixed (see priority gate).
- Addressing analyzer and chat-rule matcher **run concurrently** (they judge
  the same message independently). On the rare turn the analyzer opens itself,
  the already-started unaddressed rule match is settled first and the
  addressed-turn pass still has the last word on authority.

*How the gate works* (`server/llm/priority.ts`): interactive calls (replies,
addressing/rule classifications, live vision describes, scheduled-task fires,
browser-agent rounds) dispatch immediately; background calls (history
summaries, memory extraction/consolidation, vision backfill, analytics
insights, self-improvement) wait until no interactive call is in flight and at
most one background call is on the wire. A background call's HTTP timeout now
starts at dispatch, not enqueue — that alone removes the 120 s starvation
deaths — and background calls default to a 300 s wire timeout
(`BACKGROUND_CHAT_COMPLETION_TIMEOUT_MS`) since a summarize batch legitimately
outlives 120 s on a local model. No preemption: an interactive call arriving
mid-background-request queues behind that one request on the provider.

*Files.* New — `server/llm/priority.ts` (+ `priority.test.ts`). Changed —
`server/llm/client.ts` (`priority`/`maxTokens`/`reasoningEffort` inputs, gate
wrap, background timeout), `server/llm/tool-loop.ts` (per-round gate +
`maxTokens`), `server/telegram/process-update.ts` (classifier + reply caps),
`features/bot-messaging/server/service.ts` (concurrent analyzer/rule match; +
2 tests in `service.test.ts`), `features/bot-messaging/server/prompt.ts`
(brevity rules), `features/vision/server/service.ts` +
`backfill-scheduler.ts` (describe priority by caller), and the background
schedulers of history/memory/analytics/self-improvement (priority tag).

*Verification.* `npm run lint` ✅, `npm run typecheck` ✅, unit tests ✅ (158
in the touched files; full suite 920 passed with 21 pre-existing yt-dlp
failures on Windows, also failing on a clean checkout — environment, not
regression), `npm run build` ✅. Integration suite not run (Testcontainers).

*Endpoint probe (2026-08-01, against the configured Ollama 0.32.5, synthetic
classifier-shaped calls on gemma4:12b).* `reasoning_effort: "low"` is accepted
(no error) but only mildly shrinks this model's thinking (~3.6k → ~2.9k chars
in one pair, ~8.2k → ~3.7k in another); `max_tokens` is honored; 4 concurrent
calls really do run concurrently (wall ≈ slowest call, not the sum), so
`OLLAMA_NUM_PARALLEL=4` works. The original 1,000-token classifier cap
truncated 3 of 8 probe calls mid-think (`finish_reason: "length"`, empty
content = a missed summons) — raised to 3,000 the same day, sized above every
observed think-then-answer (max seen: 2,229 tokens).

Probe also showed per-request decode collapsed to ~10–15 tok/s (from ~70 tok/s
in the pre-parallel production traces): with 4 slots' KV cache reserved, only
9.7 GB of the 12.2 GB model stays in VRAM (`/api/ps`), the rest on CPU — see
the operator note below about `OLLAMA_NUM_PARALLEL`/context sizing.

*Remaining risks / live verification checklist (after deploy).*

- Classifier cap 3,000: confirm addressing-check traces parse and completion
  tokens stay well under the cap; if `finish_reason: "length"` shows up on a
  classification, raise further or drop the cap.
- A reply cut off at 4,096 generated tokens surfaces as a failed turn
  (`finish_reason: "length"`); none observed near that size, but check error
  traces in the first days.
- `history-summaries` / `memory-extraction`: confirm the nightly runs complete
  instead of timing out; a single batch still over 300 s on the wire will
  still fail and should prompt revisiting batch size.
- Constant interactive traffic starves background jobs by design; if backlogs
  grow (summaries days behind), consider a fairness valve.

## Other open items

- **Local Telegram Bot API server (`todo`; operator-requested, 2026-08-01)** —
  the standard Bot API caps bot uploads at 50 MB, which is what forces the
  attach-or-fail path for most videos. Running the official
  `telegram-bot-api` server locally raises the ceiling to 2 GB, so nearly every
  browser-agent download could actually reach the chat. Scope when picked up: a
  new Compose service, grammY pointed at the local endpoint (`apiRoot`), token
  logout/login migration between cloud and local API, and a decision on where
  its file store lives. New infrastructure — present the design per the
  Decision Notes process before building.

- **Ukrainian idiomatic joke requests never trigger tools on gemma4:12b
  (`blocked` on a model decision;** from the 2026-07-27 "lied about scheduling"
  trace `64067530…`**)** — a persona-mode, third-person recurring gag request
  in idiomatic Ukrainian ("let \<persona\> send everyone ... once a day",
  phrased colloquially) made the model claim it had scheduled the task without
  calling `tasks_create`. Fixes landed: the base prompt's Honesty rules now
  bind action claims to tool calls (in character too), the Conversation rules
  treat third-person requests about the bot as requests to it, and the
  `tasks_create` description covers joke/third-person recurring phrasings —
  verified live: the model no longer fabricates the action, and both the
  identical English joke phrasing and a plain Ukrainian daily-reminder request
  now select `tasks_create`. But the idiomatic-Ukrainian variant failed 5/5
  live runs — a cross-lingual gap in gemma4:12b itself. The English variant is
  pinned in `features/scheduled-tasks/server/tool-selection.integration.test.ts`;
  the Ukrainian one is deliberately NOT pinned in code (no Cyrillic in code —
  user rule, 2026-07-27) and lives only in the exported trace. Next decision
  needed (operator): try a stronger/tool-tuned model in Settings for the reply
  path, or accept the gap; re-verify against the trace phrasing after any
  model change. Related observation feeding the same decision: the plain
  English "what reminders do I have?" live case intermittently fabricates a
  full reminder list without calling `tasks_list` (seen 2 of ~6 live suite
  runs, 2026-07-27) — same bluffing pattern, worth including when evaluating a
  replacement model.

- **Context-free reminders + bluffing instead of searching history
  (`in-progress`;** from the 2026-07-28 traces `257ad4e9…` and `925ecf31…`, plus
  the operator's account of how the task was set up**)** — one incident, two
  defects, at opposite ends of the same feature.

  *What happened.* A person was discussed in the chat over several days. A user
  asked the bot to remind another participant daily who that person is. The bot
  created a scheduled task whose instruction was the surface phrasing of the
  request ("remind X who \<person\> is") rather than the substance, so every fire
  delivered that sentence back — a reminder that points at a fact instead of
  carrying it. When the reminded user then asked outright who the person was, the
  bot never called a history tool across five consecutive turns
  (`finish_reason: stop`, zero tool calls, all 21 tools offered), accused them of
  faking amnesia, and answered with an empty metaphor. Its own reasoning trace
  states it cannot find the term, then improvises anyway.

  *Root cause of the reminder half.* `fireScheduledTask` composes base prompt +
  persona + specialist + language + directive and **loads no transcript at all**
  (`features/scheduled-tasks/server/fire.ts`), so the firing model has no way to
  know what the instruction refers to. `tasks_create` only ever asked for a
  "self-contained" instruction without saying that self-contained means carrying
  the facts.

  *Fixes landed* (design decision — operator, 2026-07-28: fix at **both** ends
  rather than either alone, since a 12B model may miss either step):
  1. **Grounding** block in `BASE_SYSTEM_PROMPT`
     (`features/bot-messaging/server/prompt.ts`) — factual claims limited to
     transcript / durable memory / this-turn tool results; searching history is
     mandatory for an unfindable reference; "I don't know" is an acceptable
     answer; covering a gap by accusing the asker is forbidden; the persona
     governs tone and never truth.
  2. **`TASKS_CREATE_DESCRIPTION`** (extracted to an exported constant so it can
     be pinned) — states that a fire sees only the instruction text, requires
     `history_search` → `history_get_in_range` before creating a task that
     references chat-specific people/events/topics, requires the findings be
     written into the instruction, and says to ask the user rather than store an
     empty pointer. Same rule echoed on the `instruction` field of
     `tasks_create`/`tasks_update`.
  3. **`buildTaskDirectiveMessage`** (`fire.ts`) — second line of defence: tells
     the fire it has no transcript, to look the reference up in history before
     writing, and to be honest rather than parrot the directive when the lookup
     comes up empty. The fire already runs with the full toolset bound to the
     task's chat, so the lookup is available.

  Files changed: `features/bot-messaging/server/prompt.ts` + `prompt.test.ts`,
  `features/scheduled-tasks/server/mcp-tools.ts` + `mcp-tools.test.ts`,
  `features/scheduled-tasks/server/fire.ts` + `fire.test.ts`. Verified:
  `npm test` (74 files, 727 passed), `npm run lint`, `npm run typecheck` — all
  clean.

  *Live re-test of the reply half: failed* (trace `f79f84a2…`, 2026-07-28). Asked
  "хто такий Мурадян?" the bot again called no tool and again answered with a
  metaphor. Its reasoning block names the source explicitly: *"looking at my
  previous response (#13164), I defined it as a symbol of bypassing direct routes"*,
  padded with general knowledge (*"in common underground/internet/tech contexts
  (especially in Ukraine), 'Muradyan' often refers to…"*). The term occurs five
  times in the 24-hour window: twice asserted by the bot, three times as
  participants asking what it means. **No human ever said what it is** — the bot
  invented it, then read its own invention back as established fact.

  *Root cause of the miss.* Grounding declared "the transcript" a source
  wholesale, and a bot line is transcript. The rule's own bot-specific clause
  ("if you cannot back it up, say so") reads as being about *honesty under
  challenge*, not about *what counts as evidence*, so a self-confirming loop
  passed it.

  *Second round of fixes* (design decision — operator, 2026-07-28: **rank the
  sources**, prioritize user-sourced information over bot-sourced; enforcement
  stays in the prompt — *"we never solve model problems by code"* — so no gating,
  forced retrieval, or verifier pass):
  4. **Grounding** rewritten around source rank: fact = what a *person here*
     said, durable memory, or a this-turn tool result. The bot's own messages are
     "never a source" and are declared unreliable outright — wrong, stale,
     polluted by the conversation, or invented. People outrank the bot; a user
     correction is taken as correct. A term appearing *only* in the bot's own
     lines is named as the not-known case, with re-deriving a meaning from its
     own earlier wording forbidden. Mirrors what memory extraction already does
     (`EXTRACTION_SYSTEM` refuses to harvest facts from bot lines).
  5. **`TRANSCRIPT_PREAMBLE`** (`features/history/server/format.ts`) — says it at
     the point of use: the other people's lines are what was said, the bot's own
     are not evidence and may be wrong or invented.
  6. **History tool results carry provenance**
     (`features/history/server/mcp-tools.ts`) — each line names its author in
     words (`a participant` / `you (the bot)`) instead of the wire role, and a
     result whose every row is bot-authored appends
     `SELF_AUTHORED_ONLY_NOTE` ("…this result confirms nothing… Treat this as not
     found."). The only code-side change, and only because the prompt's source
     ranking is unusable if a lookup hands back rows without saying whose they
     are. `structuredContent.role` is unchanged for machine consumers.

  Files changed (round 2): `features/bot-messaging/server/prompt.ts` +
  `prompt.test.ts`, `features/history/server/format.ts` + `format.test.ts`,
  `features/history/server/mcp-tools.ts` + new `mcp-tools.test.ts`. Verified:
  `npm test` (75 files, 739 passed), `npm run lint`, `npm run typecheck` — all
  clean.

  *Third round: dedicated `context` field* (rework — user direction, 2026-07-31:
  instead of one-liner instructions the bot has to **gather and save context**
  when creating a task; asking for the facts to be woven into the instruction
  text, round 1's approach, still produced one-liners in practice):
  7. **`scheduled_tasks.context` column** (nullable text; migration
     `db/migrations/0045_first_metal_master.sql`) threaded through the row
     mapper, repository insert/update, service create/update (trim + 4000-char
     bound, blank stores null), and `ScheduledTask`.
  8. **Tool contract**: `tasks_create` gains a **required** `context` input —
     the gathered background, written self-contained for a reader with no chat
     transcript; `''` allowed only for a fully self-contained instruction.
     `TASKS_CREATE_DESCRIPTION` reworked around "GATHER CONTEXT BEFORE
     CREATING" (from the visible conversation or `history_search` /
     `history_get_in_range`), keeping the ask-instead-of-storing-a-pointer and
     third-person/gag rules. `tasks_update` gains an optional `context`
     replacement; `tasks_get`/`tasks_list` structured views include it.
  9. **Fire prompt** (`buildTaskDirectiveMessage`) — a "Saved context" block
     carries the stored background into the fire; the history lookup stays as
     fallback for tasks that predate the field.
  10. **Dashboard** — optional Context textarea on create and edit
     (`ScheduledTasksManager`), context shown on task cards; dashboard API
     create/patch accept it (`context: null` clears on patch).

  Files changed (round 3): `db/schema.ts` + migration 0045,
  `features/scheduled-tasks/{types.ts, server/repository.ts, server/schema.ts,
  server/service.ts, server/mcp-tools.ts, server/fire.ts,
  ui/ScheduledTasksManager.tsx}`, `app/api/scheduled-tasks/route.ts`, tests
  (`fire.test.ts`, `mcp-tools.test.ts`, `scheduled-tasks.integration.test.ts`).
  Verified: `npm run lint`, `npm run typecheck` clean; `npm test` 84 files /
  852 passed; `npm run test:integration` 25 files / 338 passed (11 live files
  skipped); `npm run build` green after the operator re-ran the `data/pg`
  chmod (the recurrence is tracked below).

  *New evidence for the model half* (trace `e5f96e23…`, 2026-07-31): asked (in
  Ukrainian) to *update* the Muradyan task with the PS5/donations backstory,
  gemma4:12b's reasoning correctly narrowed to the scheduled task and literally
  ended "Let's do that check" (meaning `tasks_list`) — then the generation
  emitted a plain chat message claiming the context was saved
  (`finish_reason: stop`, `tool_calls: null`, all 25 tools offered). The
  decision died crossing from the reasoning channel to generation; no prompt
  text can bind that. Two levers, both operator decisions: (a) the standing
  model-replacement question below; (b) injecting the chat's scheduled tasks
  into the reply-turn system context (like memory/rules) so "the task" resolves
  without a `tasks_list` round-trip — costs tokens per turn, not implemented.

  **Remaining risk / next step (operator):** still unverified live, and still the
  same gemma4:12b tool-avoidance pattern as the `tasks_list` fabrication in the
  item above — round 1's prompt text was ignored, and rounds 2–3 add more prompt
  text plus a required tool field, so the model may ignore them too. Re-run
  live: ask the bot who "Мурадян" is again; a pass is "I don't know / nobody
  here ever said". Also re-run the task half (create a reminder that references
  a chat-only topic — a pass now includes a filled `context` on the created
  row; then ask the bot what that topic is). Existing thin task instructions
  are deliberately **not** migrated — operator fixes those through the bot
  (decision, 2026-07-28); old rows simply have `context = null` and keep the
  history-lookup fallback. If the model still refuses to search, this folds
  into the same model-replacement decision. Known remaining laundering path,
  not addressed: `history_recall_topics`
  serves daily topic summaries, which are written over both sides of the
  conversation — a bot-invented term can therefore re-enter through a summary
  with no author attached. Decide whether summaries should mark, or exclude,
  bot-sourced content.

- **`npm run build` dies on `data/pg` whenever the bundled Postgres recreates it
  (`done` for now — one host-side fix, may recur).** Turbopack walks the project
  tree and `data/pg` is created `drwx------` owned by the container's postgres uid,
  so the build ends in `Permission denied (os error 13) … reading dir "…/data/pg"`
  with a `TurbopackInternalError` — nothing to do with the code (`eslint.config.mjs`
  already ignores `data/**` for the same reason; Turbopack has no equivalent).
  The operator ran the chmod on 2026-07-29 and the build was green again. It
  **recurred** on 2026-07-31 (a fresh Postgres volume recreated the dir); the
  operator re-ran the chmod the same day. **Recurred again on 2026-08-01**,
  blocking the build check for the chat-delivery overhaul above, and **still
  failing later the same day** for the poller-supervision work. Four recurrences
  now — worth a documented pre-build step (or a Turbopack-side exclusion if one
  appears).

- **Traces bind-mount permissions (`blocked` on an operator decision;** from
  the 2026-07-22 prod data-loss incident**)** — Docker auto-creates
  `./data/traces` root-owned while the app runs as the non-root `app` user, so
  trace flushes fail with EACCES (now surfaced via the data-loss banner, the
  Overview card and `/api/health`). Host-side workaround: chown the bind mount
  to the container's `app` uid. The permanent Dockerfile fix (root entrypoint
  chowns the mount, then drops to `app` via su-exec) was proposed but not
  implemented — a container security-posture change that needs the operator's
  decision.
- **Search-engine cascade (operator's call)** — engines rank themselves by
  success stats, so the blocked-engines-first configured order self-heals; the
  open question is adding **Brave** as a fourth engine (measured best on
  2026-07-26: 45 relevant results).
- **Memory General-knowledge cleanup (verify)** — the wrong pre-fix lines in
  the General knowledge document (2026-07-17 incident) needed manual removal on
  `/memory`; the pruning merge only runs when a new `general` note arrives.
  Verify the cleanup happened; drop this item if it did.
