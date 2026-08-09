# Settings

**Feature id:** `settings` · **Dashboard:** `/settings`

The operator's configuration surface. All runtime product configuration lives in one
typed database row and is edited here — not in environment variables.

The field-by-field reference is in [Configuration](../configuration.md). This page
covers how the feature works.

## One row, typed columns

`settings`, `id = 'singleton'`, enforced by a `check` constraint. New settings are
added as **typed columns with a default plus a migration** — not as a JSON blob — so
every setting has a type, a bound, and a place in the zod contract.

The repository always reads and writes the one row and is pure data access. It returns
the raw API keys; the **service** decides what to expose and does the masking. Callers
must never hand a repository record to a client.

## Secrets are write-only

| Field | Client sees |
| --- | --- |
| Every API key, the bot token, the Tavily key | Only `…Configured: boolean` |
| The password hash, the session secret | Nothing |

Semantics on `PATCH`:

| Sent | Result |
| --- | --- |
| Field omitted | Stored value untouched |
| Field = `null` | Cleared |
| Field = a string | Replaced |

`test-connection` falls back to the **stored** key when `apiKey` is omitted, so a base
URL can be re-tested without the browser resending the secret.

## The form

`SettingsForm` is a Client Component with nine tabs — one per concern — and **one**
Save button below them that persists every changed field regardless of which tab is
active:

| Tab | Holds |
| --- | --- |
| **LLM** | The chat endpoint, key, backend and model — without which the bot cannot run |
| **Embeddings** | The endpoint powering semantic recall over history summaries and memory search |
| **Images** | The endpoint powering image generation |
| **Speech** | The endpoint powering voice replies |
| **Transcription** | The speech-to-text endpoint for voice messages (chat-model fallback) |
| **Telegram** | Bot token, owner, maintenance mode |
| **General** | Timezone, daily run time, the browser download disk cap |
| **Integrations** | Optional feature keys — Tavily, the browsing agent's search fallback |
| **Security** | Operator password change — its own endpoint and button, not part of the settings patch |

The form sends **only changed fields**, and the service depends on that: a model
absent from the patch is a *stored* selection. When the same patch repoints the
endpoint serving it — the LLM base URL changes and a section reuses that
connection, or a section's own URL changes (including falling back to the LLM
one) — `clearStaleModelSelections` lists the new endpoint's models and clears
any stored selection it verifiably does not serve, in the same write, with a
warn event per cleared model on the update trace. A model sent in the same
patch is trusted as an explicit choice; when the listing fails nothing is
cleared (absence must be proven); the transcription model is exempt because
whisper-class servers often expose no listing. The form surfaces the outcome
twice: a freshly-tested LLM list flags a provably-stale selection on its own
tab, and whatever the server actually cleared is named next to the Save button.

The repeated machinery lives in shared modules rather than being copied per section:
`ui/connection.ts` holds the probe flow and the write-only secret-input state machines
(the form previously carried three hand-rolled copies of the first and five of the
second), and `ConnectionSection.tsx` is the section shell that the
embeddings/images/speech/transcription tabs differ from only by wording.

## Probes are real calls

Every "Test …" button makes an actual request, and each is recorded as a trace:

| Probe | What it actually does | Why that probe |
| --- | --- | --- |
| `test-connection` | `GET /v1/models` | Returns the model list the form then offers |
| `test-embeddings` | Embeds a short string | Proves the endpoint is reachable, the key is accepted, the model exists, **and** that its vectors fit the stored 1024-wide columns — none of which a model listing establishes |
| `test-images` | Checks the configured model is served | A real generation costs time and money and proves nothing extra |
| `test-speech` | Checks the configured model is served | Nothing about a voice reply can only be learned by rendering one |
| `test-transcription` | Transcribes a fraction of a second of generated silence | A model listing proves nothing here — whisper-class servers often serve `/v1/audio/transcriptions` without `/v1/models` |

The connection probe uses a short timeout so opening the Settings page stays responsive
against a dead endpoint.

## Honest initial render

`/settings` is a Server Component that **actually reads** settings from the database
for the initial render. If that read fails (database unset or unreachable) it shows the
real error rather than a misleading "looks fine" — a genuine probe, not an
env-presence guess.

## Related but not on the form

| Concern | Owned by |
| --- | --- |
| Operator password and session secret | `/setup` and the auth service. See [Security](../architecture/security.md) |
| Active personality | `/personalities` and `PUT /api/personalities/active` |

## Consumers

Other code does not read the settings row directly; it asks the settings service for a
resolved runtime:

| Consumer | Asks for |
| --- | --- |
| Reply pipeline | LLM connection, model, active persona prompt, owner/maintenance policy, timezone |
| Every daily scheduler | The run time, the timezone, and whether an LLM is configured |
| Embedding/image/speech/transcription paths | Their own runtime, with the core-connection fallback applied |
| Telegram bot manager | The bot token |
| Search fallback | The Tavily key, read at call time |

Because these are resolved per run or per turn, a settings change takes effect
immediately — no restart.

## API

`GET /api/settings` (masked), `PATCH /api/settings` (partial, at least one field),
and the five `POST /api/settings/test-*` probes.

## Tracing

Feature `settings`, `relatedIdsKey` `settings`. Every update and every probe is traced,
so "when did the model change, and to what" is answerable from Debug.

## Tests

Unit: `server/schema.test.ts` (shapes, bounds, and that the client-facing schema
exposes no secret). Integration: `server/settings.integration.test.ts` (persistence,
masking, fallback resolution).
