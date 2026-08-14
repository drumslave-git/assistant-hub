# Backends

**Feature id:** `backends` · **Dashboard:** `/backends`

The operator's catalog of LLM endpoints. Each backend is one named
server — base URL, optional API key, and which inference server answers there
(`ollama`, `llamacpp`, `vllm`, `anthropic`, or generic; see the
backend-normalization layer in [LLM & MCP](../architecture/llm-and-mcp.md)).
Most types speak the OpenAI wire shape; `anthropic` is the exception — it rides
the native Anthropic API (`x-api-key` auth, native `/v1/models` listing) and
serves the chat-shaped roles only (chat, vision, browser agent, classifiers,
background); embeddings, images, speech and transcription-mode audio refuse it
with a named error, and its adapter also rearranges the prompt's interleaved
system turns into the placement the native API allows (see
[LLM & MCP](../architecture/llm-and-mcp.md)). A Gemini endpoint is configured as
a generic OpenAI-compatible backend; the thought signature it attaches to every
tool call is carried back automatically, without which no tool-using reply
completes. The settings roles (chat,
embeddings, images, speech, audio, vision, browser agent) reference backends by
id instead of carrying their own URL/key copies — one server, entered once,
picked everywhere.

## CRUD

`features/backends` follows the standard feature contract: zod schemas,
repository (pure data access; records carry the raw key and never reach a
client), service (validation, masking, trace recording), thin Route Handlers.

- **Create / edit**: name (unique case-insensitively), URL, write-only API key
  (exposed as `apiKeyConfigured`; empty clears, omitted keeps), server type.
  A **Detect** button (`POST /api/backends/detect`) fingerprints the endpoint
  (`/api/version` → Ollama, `/props` → llama.cpp, `/version` → vLLM) as a
  suggestion only — the operator picks (user decision, 2026-08-07).
- **Delete** is refused (409) while any settings role points at the backend;
  the error names the roles. The settings FKs are `on delete restrict` as the
  backstop.
- **Test connection** (`POST /api/backends/test`) lists the endpoint's models —
  one call proves the host answers and the key is accepted, and the returned
  ids double as the model preview shown on the card. Testing an unsaved form
  takes `{ baseUrl, apiKey? }`; testing a stored backend takes `{ backendId }`
  and falls back to the stored key so the secret never round-trips.

## Repointing a backend repoints every role on it

Editing a backend's URL or key re-verifies the stored model selection of every
role whose effective backend is that row (a role with no backend of its own
rides on the chat backend's row): the new endpoint is listed once and any model
it verifiably does not serve is cleared in the same operation, with warn events
on the update trace and the cleared roles reported back to the form. A failed
listing clears nothing, and the audio model is exempt only in `transcriptions`
mode (whisper-class servers often list nothing) — the same doctrine as a
settings save.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/backends` | The catalog (masked) |
| `POST` | `/api/backends` | Create |
| `PATCH` | `/api/backends/{id}` | Edit; returns `{ backend, clearedModels }` |
| `DELETE` | `/api/backends/{id}` | Delete (409 while in use) |
| `GET` | `/api/backends/{id}/models` | The models a stored backend serves (feeds the Settings dropdowns) |
| `POST` | `/api/backends/test` | Connection test + model preview |
| `POST` | `/api/backends/detect` | Fingerprint the server type |

## Tracing

Feature `backends`, `relatedIdsKey` `backends`. Every mutation and connection
test is traced; API keys are redacted from trace data.

## Tests

Integration: `server/backends.integration.test.ts` (CRUD, name uniqueness,
key write-only semantics, the in-use delete guard, connection tests with
stored-key fallback, stale-model clearing on repoint).
