# Settings

**Feature id:** `settings` · **Dashboard:** `/settings`

The operator's configuration surface. All runtime product configuration lives in one
typed database row and is edited here — not in environment variables. LLM endpoints
themselves live in the [Backends catalog](backends.md); settings roles reference
them by id.

The field-by-field reference is in [Configuration](../configuration.md). This page
covers how the feature works.

## One row, typed columns

`settings`, `id = 'singleton'`, enforced by a `check` constraint. New settings are
added as **typed columns with a default plus a migration** — not as a JSON blob — so
every setting has a type, a bound, and a place in the zod contract.

The repository always reads and writes the one row and is pure data access. It returns
the raw secrets; the **service** decides what to expose and does the masking. Callers
must never hand a repository record to a client.

## Secrets are write-only

| Field | Client sees |
| --- | --- |
| The bot token, the Tavily key | Only `…Configured: boolean` |
| The password hash, the session secret | Nothing |

(Endpoint API keys live on backend rows now — same write-only rule, exposed as
`apiKeyConfigured` on the backend.)

Semantics on `PATCH`:

| Sent | Result |
| --- | --- |
| Field omitted | Stored value untouched |
| Field = `null` | Cleared |
| Field = a string | Replaced |

## Roles

LLM configuration is per **role**: each role stores a backend id from the
catalog (null = "use the chat backend") plus a model id, picked through a
searchable combobox fed by that backend's live `/v1/models` listing.

| Role | Model unset means |
| --- | --- |
| **Chat** (main) | Bot unconfigured. The one role that must support thinking and tool calls |
| **Embeddings** | Semantic recall off |
| **Images** | Image generation off |
| **Speech** (TTS) | Voice replies off |
| **Audio** (STT) | Voice transcribed by the chat model via `input_audio` (main by default) |
| **Vision** | The chat model describes media (main by default) |
| **Browser agent** | Browsing thinks on the chat model (main by default) |

## The form

`SettingsForm` is a Client Component with one tab per concern — the seven roles
above plus **Telegram** (bot token, owner, maintenance mode), **General**
(timezone, daily run time, browser download cap), **Integrations** (Tavily) and
**Security** (password change; its own endpoint and button) — and **one** Save
button below them that persists every changed field regardless of which tab is
active.

The form sends **only changed fields**, and the service depends on that: a model
absent from the patch is a *stored* selection. When the same patch repoints the
backend serving it — the role's own backend id changes, or the chat backend
changes and the role inherits it — `clearStaleModelSelections` lists the newly
effective backend's models and clears any stored selection it verifiably does
not serve, in the same write, with a warn event per cleared model on the update
trace. A model sent in the same patch is trusted as an explicit choice; when
the listing fails nothing is cleared (absence must be proven); the audio model
is exempt only in `transcriptions` mode, because whisper-class servers often
expose no listing — in `chat` mode it is an ordinary chat model the backend
must list, so it is verified like the rest.

The form owns the case that check cannot see: a selection stale against the
*unchanged* backend. Each role's model list is preloaded (and fetched live when
a role is pointed elsewhere); a successfully listed backend that does not serve
the stored model flags it on its tab, and the save sends it as null. Either
way, everything cleared is named next to the Save button.

The repeated machinery lives in shared modules rather than being copied per
role: `ui/connection.ts` holds the probe flow, the write-only secret-input
state machine, and the per-backend model cache; `RoleSection.tsx` is the
section shell every role tab differs from only by wording; the searchable
model select is the shared `Combobox` UI-kit component.

All seven LLM role tabs are then produced by **one** renderer (`roleTab` in
`SettingsForm.tsx`) from a `RoleTabSpec` per role, so the behaviour they must
share is decided once and cannot drift:

| Shared behaviour | Rule |
| --- | --- |
| Probe invalidation | Changing the backend or the model clears that role's probe result — every probe now tests a specific model, so neither survives a change |
| Test availability | A role whose empty model means "use the chat model" (audio, vision, browser) is testable without one; a role whose empty model means "off" (embeddings, images, speech) is not. Chat needs both a backend and a model, having no fallback of its own |
| Stale warning | Comes from the fetched model list, for every role whose model is listable |
| Result rendering | One shared `ProbeReport` view for all seven |

Only genuine differences are per-role data: wording, the probe endpoint,
free-text entry (audio), extra fields (speech's voice, audio's transcription
mode), and whether the role inherits the chat backend. How a probe's *result*
looks is not among them — every probe reports the same shape (see below).

## Probes exercise the real thing, and show it

Every "Test …" button performs the role's actual work and reports the exchange —
what was sent, what came back — not a green tick. Each is recorded as a trace.
Probe inputs are `{ backendId?, model? }`; omitted fields fall back to what is
stored, and resolution goes through the same runtime resolver the feature uses,
including the chat-model fallback for audio, vision and the browser agent.

| Probe | Sends | Receives |
| --- | --- | --- |
| `test-chat` | A short question | The reply **and** the hidden reasoning behind it |
| `test-embeddings` | A phrase | The vector, with its width |
| `test-images` | A prompt | The generated image |
| `test-speech` | A phrase and the configured voice | The synthesized audio, playable |
| `test-audio` | A fraction of a second of generated silence | The transcript |
| `test-vision` | A generated PNG | The model's description of it |
| `test-browser` | A prompt and one trivial tool | Whether the tool was called, and the answer |

The reason each is a real call rather than a model listing:

- **Chat**: a listing says nothing about whether the *selected* model answers.
  The reasoning matters as much as the reply — this role must support thinking,
  those tokens are invisible in the answer, and a model that returns no
  reasoning when it should is otherwise only caught by reading a live trace.
- **Embeddings**: only a real call reveals the vector width, which must match
  the stored 1024-wide columns or every later insert fails inside a background job.
- **Images**: a listed model still fails on the size it is asked for, returns a
  URL the provider then 404s, or answers with an empty payload. Seeing the
  picture settles all three.
- **Speech**: the *voice* is the half a listing cannot check — an endpoint that
  serves the model still rejects or silently substitutes an unknown voice.
- **Audio**: whisper-class servers often serve `/v1/audio/transcriptions`
  without `/v1/models` at all.
- **Vision**: a listing cannot reveal a missing image-input modality.
- **Browser agent**: a listing cannot reveal missing tool-call support, and
  browsing is nothing but tool calls. A model that answers without calling the
  tool is reported, not failed — the connection demonstrably works, and how
  strictly a model obeys is the operator's judgement.

Results are rendered by one shared component (`ProbeReportView`) from one shared
shape (`ProbeReport`: a model, a latency, and labelled input/output parts that
are text, an image, audio or a vector). That is what keeps seven very different
exchanges legible in the same way — and why adding a probe means describing what
it exchanged, not writing another result panel.

Image and audio bytes are replaced by their size in **trace** bodies, the same
convention the vision describer follows; the dashboard renders the real artifact
from the API response instead.

## Honest initial render

`/settings` is a Server Component that **actually reads** settings, the backend
catalog, and each backend's model list from the database/endpoints for the
initial render. If the read fails (database unset or unreachable) it shows the
real error rather than a misleading "looks fine" — a genuine probe, not an
env-presence guess.

## Related but not on the form

| Concern | Owned by |
| --- | --- |
| Backend endpoints (URL, key, server type) | The [Backends page](backends.md) and `/api/backends` |
| Operator password and session secret | `/setup` and the auth service. See [Security](../architecture/security.md) |
| Active personality | `/personalities` and `PUT /api/personalities/active` |

## Consumers

Other code does not read the settings row directly; it asks the settings service for a
resolved runtime:

| Consumer | Asks for |
| --- | --- |
| Reply pipeline | `getLlmRuntime()` (chat), active persona prompt, owner/maintenance policy, timezone |
| Every daily scheduler | The run time, the timezone, and whether an LLM is configured |
| Embedding/image/speech paths | Their role runtime (`getEmbeddingRuntime` …), chat-backend fallback applied |
| Voice path | `getAudioRuntime()` (STT), chat-model `input_audio` fallback when null |
| Vision describer | `getVisionRuntime()` — chat backend/model unless overridden |
| Browser agent | `getBrowserLlmRuntime()` — chat backend/model unless overridden |
| Telegram bot manager | The bot token |
| Search fallback | The Tavily key, read at call time |

Because these are resolved per run or per turn, a settings change takes effect
immediately — no restart.

## API

`GET /api/settings` (masked), `PATCH /api/settings` (partial, at least one field),
and the four `POST /api/settings/test-*` role probes.

## Tracing

Feature `settings`, `relatedIdsKey` `settings`. Every update and every probe is traced,
so "when did the model change, and to what" is answerable from Debug.

## Tests

Unit: `server/schema.test.ts` (shapes, bounds, and that the client-facing schema
exposes no secret). Integration: `server/settings.integration.test.ts` (persistence,
masking, role runtime resolution incl. chat fallbacks, stale-model clearing).
