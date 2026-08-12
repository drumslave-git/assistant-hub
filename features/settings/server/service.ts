import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import {
  getBackendById,
  type BackendRecord,
} from "@/features/backends/server/repository";
import { getKnownUser } from "@/features/known-users/server/repository";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { LlmBackendId } from "@/lib/llm-backend";
import type { TraceTrigger } from "@/lib/trace";
import { listModels } from "@/server/llm/client";
import {
  probeEmbeddings,
  type EmbeddingProbe,
  type EmbeddingRuntime,
} from "@/server/llm/embeddings";
import { probeImages, type ImageProbe, type ImageRuntime } from "@/server/llm/images";
import { probeSpeech, type SpeechProbe, type SpeechRuntime } from "@/server/llm/speech";
import {
  probeTranscription,
  type TranscriptionProbe,
  type TranscriptionRuntime,
} from "@/server/llm/transcription";
import { tinySilenceWav } from "@/server/media/audio";
import { withTrace, type TraceRecorder } from "@/server/trace";
import {
  getSettingsRecord,
  SETTINGS_ID,
  upsertSettings,
  type SettingsPatch,
  type SettingsRecord,
} from "./repository";
import type { Settings, TestRoleConnection, UpdateSettings } from "./schema";

/**
 * Settings domain service — the boundary the Route Handlers and Server
 * Components call. LLM configuration is per **role** (chat, embedding, audio,
 * vision, speech, image generation, browser agent): each role references a
 * backend from the catalog (`features/backends`) and picks a model; a null
 * backend id means "use the chat backend", and for the audio/vision/browser
 * roles a null model additionally means "use the chat model" (main by default).
 *
 * Reads never expose secrets. Writes and connection tests are recorded as
 * traces; secret values are redacted from trace data.
 */

const FEATURE = FEATURES["settings"];

/** Project an internal record to the client-safe shape (masking secrets). */
function toClientSettings(record: SettingsRecord | null): Settings {
  return {
    chatBackendId: record?.chatBackendId ?? null,
    model: record?.model ?? null,
    embeddingBackendId: record?.embeddingBackendId ?? null,
    embeddingModel: record?.embeddingModel ?? null,
    imageBackendId: record?.imageBackendId ?? null,
    imageModel: record?.imageModel ?? null,
    speechBackendId: record?.speechBackendId ?? null,
    speechModel: record?.speechModel ?? null,
    speechVoice: record?.speechVoice ?? null,
    audioBackendId: record?.audioBackendId ?? null,
    audioModel: record?.audioModel ?? null,
    visionBackendId: record?.visionBackendId ?? null,
    visionModel: record?.visionModel ?? null,
    browserBackendId: record?.browserBackendId ?? null,
    browserModel: record?.browserModel ?? null,
    telegramBotTokenConfigured: Boolean(record?.telegramBotToken),
    webSearchConfigured: Boolean(record?.tavilyApiKey),
    ownerUsername: record?.ownerUsername ?? null,
    ownerUserId: record?.ownerUserId ?? null,
    maintenanceModeEnabled: record?.maintenanceModeEnabled ?? false,
    timezone: record?.timezone ?? "UTC",
    dailyJobsRunTime: record?.dailyJobsRunTime ?? DEFAULT_DAILY_JOBS_RUN_TIME,
    browserDownloadLimitGb: record?.browserDownloadLimitGb ?? DEFAULT_BROWSER_DOWNLOAD_LIMIT_GB,
    updatedAt: record?.updatedAt ?? null,
  };
}

/** Current settings (no secret values), or empty defaults when never configured. */
export async function getSettings(db: DrizzleDb = getDb()): Promise<Settings> {
  return toClientSettings(await getSettingsRecord(db));
}

/**
 * Server-only: the raw Telegram bot token, or null when unset. Used by the bot
 * manager to start the poller — never exposed through an API or to clients.
 */
export async function getTelegramBotToken(db: DrizzleDb = getDb()): Promise<string | null> {
  return (await getSettingsRecord(db))?.telegramBotToken ?? null;
}

/**
 * Server-only: the stored Tavily API key, or null when unset. Read at call time
 * by the web-search MCP tool so a key change takes effect without re-registering.
 * Never exposed through an API or to clients.
 */
export async function getWebSearchApiKey(db: DrizzleDb = getDb()): Promise<string | null> {
  return (await getSettingsRecord(db))?.tavilyApiKey ?? null;
}

/** A fully resolved role runtime: where to call, with what, and which model. */
export interface LlmRuntime {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  backend: LlmBackendId;
}

/**
 * Resolve one role's backend row: its own selection, falling back to the chat
 * backend when it has none. Null when neither is configured (or the referenced
 * row is gone, which the FK prevents but a torn read could still see).
 */
async function resolveRoleBackend(
  db: DrizzleDb,
  record: SettingsRecord | null,
  roleBackendId: string | null,
): Promise<BackendRecord | null> {
  const id = roleBackendId ?? record?.chatBackendId ?? null;
  return id ? getBackendById(db, id) : null;
}

/**
 * Server-only: the saved chat (main) connection + model, or null when not fully
 * configured. Used by the conversation core to generate replies.
 */
export async function getLlmRuntime(db: DrizzleDb = getDb()): Promise<LlmRuntime | null> {
  const record = await getSettingsRecord(db);
  if (!record?.chatBackendId || !record.model) return null;
  const backend = await getBackendById(db, record.chatBackendId);
  if (!backend) return null;
  return {
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKey,
    model: record.model,
    backend: backend.type,
  };
}

/**
 * Resolve the embedding connection. The backend falls back to the chat backend
 * when the role has none of its own (the common case: chat and embeddings
 * served by the same host). A model is mandatory: without one there is nothing
 * to call, and embedding-backed capabilities stay off rather than guessing a
 * model id.
 */
async function toEmbeddingRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
): Promise<EmbeddingRuntime | null> {
  if (!record?.embeddingModel) return null;
  const backend = await resolveRoleBackend(db, record, record.embeddingBackendId);
  if (!backend) return null;
  return {
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKey,
    backend: backend.type,
    model: record.embeddingModel,
  };
}

/**
 * Server-only: the saved embedding connection + model, or null when embeddings
 * are not configured. Read at call time (like the Tavily key) so a change takes
 * effect without a restart. Callers must treat null as "semantic recall is
 * unavailable" and degrade honestly, never throw.
 */
export async function getEmbeddingRuntime(
  db: DrizzleDb = getDb(),
): Promise<EmbeddingRuntime | null> {
  return toEmbeddingRuntime(db, await getSettingsRecord(db));
}

/**
 * Resolve the image-generation connection. Same shape as
 * {@link toEmbeddingRuntime}: the backend falls back to the chat one, and a
 * model is mandatory — without one the `image_generate` tool stays unavailable
 * rather than guessing a model id.
 */
async function toImageRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
): Promise<ImageRuntime | null> {
  if (!record?.imageModel) return null;
  const backend = await resolveRoleBackend(db, record, record.imageBackendId);
  if (!backend) return null;
  return {
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKey,
    backend: backend.type,
    model: record.imageModel,
  };
}

/**
 * Server-only: the saved image connection + model, or null when image generation
 * is not configured. Read at call time (like the embedding runtime) so a change
 * takes effect without a restart. Callers must treat null as "image generation is
 * unavailable" and degrade honestly — the tool is simply not offered.
 */
export async function getImageRuntime(db: DrizzleDb = getDb()): Promise<ImageRuntime | null> {
  return toImageRuntime(db, await getSettingsRecord(db));
}

/**
 * Resolve the speech (TTS) connection. Same shape as {@link toEmbeddingRuntime}:
 * the backend falls back to the chat one, and a model is mandatory — without
 * one voice replies stay off rather than guessing a model id.
 */
async function toSpeechRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
): Promise<SpeechRuntime | null> {
  if (!record?.speechModel) return null;
  const backend = await resolveRoleBackend(db, record, record.speechBackendId);
  if (!backend) return null;
  return {
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKey,
    backend: backend.type,
    model: record.speechModel,
    voice: record.speechVoice,
  };
}

/**
 * Server-only: the saved speech connection + model + voice, or null when voice
 * replies are not configured. Read at call time (like the embedding runtime) so
 * a change takes effect without a restart. Callers must treat null as "voice
 * replies are unavailable" and fall back to text — never throw.
 */
export async function getSpeechRuntime(db: DrizzleDb = getDb()): Promise<SpeechRuntime | null> {
  return toSpeechRuntime(db, await getSettingsRecord(db));
}

/**
 * Resolve the audio (STT) connection. The backend falls back to the chat one;
 * the model is mandatory — a null audio model means voice messages are
 * transcribed by the chat model via `input_audio` (the "main by default"
 * behavior), never by calling `/v1/audio/transcriptions` with a guessed id.
 */
async function toAudioRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
): Promise<TranscriptionRuntime | null> {
  if (!record?.audioModel) return null;
  const backend = await resolveRoleBackend(db, record, record.audioBackendId);
  if (!backend) return null;
  return {
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKey,
    backend: backend.type,
    model: record.audioModel,
  };
}

/**
 * Server-only: the saved audio (STT) connection + model, or null when no
 * dedicated STT model is configured (voice then transcribes via the chat
 * model's `input_audio`). Read at call time so a change takes effect without a
 * restart.
 */
export async function getAudioRuntime(
  db: DrizzleDb = getDb(),
): Promise<TranscriptionRuntime | null> {
  return toAudioRuntime(db, await getSettingsRecord(db));
}

/**
 * Server-only: the vision connection + model — the describer every photo,
 * video frame, and sticker goes through. Falls back to the chat backend and
 * chat model per unset half ("main by default"), so it is null only when
 * nothing resolves to a full connection.
 */
export async function getVisionRuntime(db: DrizzleDb = getDb()): Promise<LlmRuntime | null> {
  const record = await getSettingsRecord(db);
  const model = record?.visionModel ?? record?.model ?? null;
  if (!record || !model) return null;
  const backend = await resolveRoleBackend(db, record, record.visionBackendId);
  if (!backend) return null;
  return { baseUrl: backend.baseUrl, apiKey: backend.apiKey, model, backend: backend.type };
}

/**
 * Server-only: the browser-agent LLM connection + model. Falls back to the chat
 * backend and chat model per unset half ("main by default"), so it is null only
 * when nothing resolves to a full connection.
 */
export async function getBrowserLlmRuntime(db: DrizzleDb = getDb()): Promise<LlmRuntime | null> {
  const record = await getSettingsRecord(db);
  const model = record?.browserModel ?? record?.model ?? null;
  if (!record || !model) return null;
  const backend = await resolveRoleBackend(db, record, record.browserBackendId);
  if (!backend) return null;
  return { baseUrl: backend.baseUrl, apiKey: backend.apiKey, model, backend: backend.type };
}

/**
 * Server-only: the operator timezone (IANA name, defaulting to `UTC`). Used by
 * the scheduled-tasks feature to interpret wall-clock schedules.
 */
export async function getTimezone(db: DrizzleDb = getDb()): Promise<string> {
  return (await getSettingsRecord(db))?.timezone ?? "UTC";
}

/** Fallback run time for the daily jobs when settings have never been written. */
export const DEFAULT_DAILY_JOBS_RUN_TIME = "04:00";

/**
 * Server-only: the local `HH:MM` (in the operator timezone) at which **every**
 * daily background job runs — self-improvement, history summarization, and any
 * future nightly job. One setting for all of them (user decision): they share the
 * same reason for running overnight, so they share the window.
 */
export async function getDailyJobsRunTime(db: DrizzleDb = getDb()): Promise<string> {
  return (await getSettingsRecord(db))?.dailyJobsRunTime ?? DEFAULT_DAILY_JOBS_RUN_TIME;
}

/** Default hard ceiling on a single browser-agent download (user decision, 2026-07-29). */
export const DEFAULT_BROWSER_DOWNLOAD_LIMIT_GB = 10;

/**
 * Server-only: the hard ceiling **in bytes** on a single browser-agent download,
 * for every download tool — a plain file, a muxed stream, a yt-dlp extraction.
 * Purely a disk guard; it never picks a lower quality. Read at call time so a
 * change applies without a restart.
 */
export async function getBrowserDownloadLimitBytes(db: DrizzleDb = getDb()): Promise<number> {
  const gb = (await getSettingsRecord(db))?.browserDownloadLimitGb ?? DEFAULT_BROWSER_DOWNLOAD_LIMIT_GB;
  return gb * 1024 * 1024 * 1024;
}

/**
 * Server-only: the active personality's id, or null when none is chosen. Used by
 * the personalities feature to resolve the persona composed into replies.
 */
export async function getActivePersonalityId(db: DrizzleDb = getDb()): Promise<string | null> {
  return (await getSettingsRecord(db))?.activePersonalityId ?? null;
}

/** The owner + maintenance state the bot needs to police an incoming message. */
export interface BotPolicy {
  /** Owner's numeric user id (chosen from known users), or null when unset. */
  ownerUserId: string | null;
  /** Whether maintenance mode is on. */
  maintenanceModeEnabled: boolean;
}

/**
 * Server-only: read the owner/maintenance policy. The owner is chosen by id from
 * the known-users list, so this is a pure read — no resolution needed. Cheap
 * enough to run per message.
 */
export async function getBotPolicy(db: DrizzleDb = getDb()): Promise<BotPolicy> {
  const record = await getSettingsRecord(db);
  return {
    ownerUserId: record?.ownerUserId ?? null,
    maintenanceModeEnabled: record?.maintenanceModeEnabled ?? false,
  };
}

/** The role backend-id/model column pairs (audio included; see the exemption note). */
const ROLE_FIELDS = [
  { label: "chat", modelKey: "model", backendKey: "chatBackendId" },
  { label: "embedding", modelKey: "embeddingModel", backendKey: "embeddingBackendId" },
  { label: "image", modelKey: "imageModel", backendKey: "imageBackendId" },
  { label: "speech", modelKey: "speechModel", backendKey: "speechBackendId" },
  { label: "audio", modelKey: "audioModel", backendKey: "audioBackendId" },
  { label: "vision", modelKey: "visionModel", backendKey: "visionBackendId" },
  { label: "browser", modelKey: "browserModel", backendKey: "browserBackendId" },
] as const;

/**
 * Model selections that are picked from a backend's `/v1/models` listing.
 * Audio is deliberately absent: whisper-class servers often expose no listing,
 * so absence from one proves nothing (the UI field allows free text for the
 * same reason) — an audio selection is never cleared on unverifiable evidence.
 */
const LISTED_MODEL_ROLES = ROLE_FIELDS.filter((r) => r.label !== "audio");

type RoleBackendKey = (typeof ROLE_FIELDS)[number]["backendKey"];
type RoleModelKey = (typeof ROLE_FIELDS)[number]["modelKey"];

/** Translate a validated update into a column patch (empty secret clears it). */
function toPatch(input: UpdateSettings): SettingsPatch {
  const patch: SettingsPatch = {};
  for (const { modelKey, backendKey } of ROLE_FIELDS) {
    if (input[backendKey] !== undefined) patch[backendKey] = input[backendKey];
    if (input[modelKey] !== undefined) patch[modelKey] = input[modelKey];
  }
  if (input.speechVoice !== undefined) {
    patch.speechVoice = input.speechVoice === "" ? null : input.speechVoice;
  }
  if (input.telegramBotToken !== undefined) {
    patch.telegramBotToken = input.telegramBotToken === "" ? null : input.telegramBotToken;
  }
  if (input.tavilyApiKey !== undefined) {
    patch.tavilyApiKey = input.tavilyApiKey === "" ? null : input.tavilyApiKey;
  }
  if (input.maintenanceModeEnabled !== undefined) {
    patch.maintenanceModeEnabled = input.maintenanceModeEnabled;
  }
  if (input.timezone !== undefined) {
    if (!isValidIanaTimezone(input.timezone)) {
      throw ApiError.badRequest(`Unknown timezone: ${input.timezone}`);
    }
    patch.timezone = input.timezone;
  }
  if (input.dailyJobsRunTime !== undefined) {
    patch.dailyJobsRunTime = input.dailyJobsRunTime;
  }
  if (input.browserDownloadLimitGb !== undefined) {
    patch.browserDownloadLimitGb = input.browserDownloadLimitGb;
  }
  return patch;
}

/** Whether `Intl` recognizes the given IANA timezone name. */
function isValidIanaTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every backend id named in the patch must exist in the catalog — a typo'd or
 * deleted id would otherwise surface later as an FK error (or, worse for the
 * operator, a role silently resolving to nothing).
 */
async function validateBackendIds(db: DrizzleDb, patch: SettingsPatch): Promise<void> {
  for (const { backendKey } of ROLE_FIELDS) {
    const id = patch[backendKey];
    if (id === undefined || id === null) continue;
    if (!(await getBackendById(db, id))) {
      throw ApiError.badRequest(`Unknown backend for ${backendKey}: ${id}`);
    }
  }
}

/**
 * Resolve the owner selection into a column patch. The owner is picked by id from
 * known users; we validate it exists and denormalize the @username for display.
 * A null id clears the owner.
 */
async function ownerPatch(
  db: DrizzleDb,
  ownerUserId: string | null,
): Promise<Pick<SettingsPatch, "ownerUserId" | "ownerUsername">> {
  if (!ownerUserId) return { ownerUserId: null, ownerUsername: null };
  const user = await getKnownUser(db, ownerUserId);
  if (!user) throw ApiError.badRequest("Selected owner is not a known user");
  return { ownerUserId: user.userId, ownerUsername: user.username };
}

/** Redact secrets before they reach trace storage. */
function redact(input: UpdateSettings): Record<string, unknown> {
  const { telegramBotToken, tavilyApiKey, ...rest } = input;
  const out: Record<string, unknown> = { ...rest };
  if (telegramBotToken !== undefined) out.telegramBotToken = "«redacted»";
  if (tavilyApiKey !== undefined) out.tavilyApiKey = "«redacted»";
  return out;
}

/**
 * Bound on the model listing a save performs to verify stored selections
 * against a repointed role. An explicit save can afford a little more than a
 * page load, but it must never hang the Save button on a dead host.
 */
const STALE_MODEL_CHECK_TIMEOUT_MS = 10_000;

/** A role field's value once the patch is applied over the stored record. */
function effective<K extends RoleBackendKey | RoleModelKey>(
  before: SettingsRecord | null,
  patch: SettingsPatch,
  key: K,
): string | null {
  const patched = patch[key];
  return patched !== undefined ? patched : (before?.[key] ?? null);
}

/**
 * Clear model selections that a backend change has made stale.
 *
 * A model id is only meaningful on the backend it was picked from. When a patch
 * repoints a role — its own backend id changes, or the chat backend changes and
 * the role inherits it — the newly effective backend is asked for its model
 * list and any stored selection it verifiably does not serve is cleared in the
 * same write, instead of failing later inside a background job against a
 * backend that never had it.
 *
 * Deliberate limits, all on the side of not destroying configuration:
 * - A model set in this very patch is trusted — the operator just chose it.
 * - When the new backend cannot be listed (down, slow, key rejected), nothing
 *   is cleared: absence is only acted on when it is proven.
 * - Audio is exempt (see {@link LISTED_MODEL_ROLES}).
 *
 * Mutates `patch`; returns human labels of what was cleared.
 */
async function clearStaleModelSelections(
  db: DrizzleDb,
  before: SettingsRecord | null,
  patch: SettingsPatch,
  trace: TraceRecorder,
): Promise<string[]> {
  // Only a backend-id change can repoint where a model is served.
  if (ROLE_FIELDS.every(({ backendKey }) => patch[backendKey] === undefined)) return [];

  const checks: Array<{ label: string; modelKey: RoleModelKey; model: string; backendId: string }> =
    [];
  for (const role of LISTED_MODEL_ROLES) {
    if (patch[role.modelKey] !== undefined) continue;
    const model = before?.[role.modelKey] ?? null;
    if (!model) continue;
    // The chat role's own backend *is* the chat one, so its fallback is a no-op.
    const ownBefore = before?.[role.backendKey] ?? null;
    const ownAfter = effective(before, patch, role.backendKey);
    const effBefore = ownBefore ?? before?.chatBackendId ?? null;
    const effAfter = ownAfter ?? effective(before, patch, "chatBackendId");
    if (!effAfter || effAfter === effBefore) continue;
    checks.push({ label: role.label, modelKey: role.modelKey, model, backendId: effAfter });
  }
  if (checks.length === 0) return [];

  // One listing per distinct backend, shared by every role now pointing at it.
  const byBackend = new Map<string, typeof checks>();
  for (const check of checks) {
    byBackend.set(check.backendId, [...(byBackend.get(check.backendId) ?? []), check]);
  }

  const cleared: string[] = [];
  for (const [backendId, group] of byBackend) {
    const backend = await getBackendById(db, backendId);
    if (!backend) continue;
    let served: string[];
    try {
      served = await listModels(
        { baseUrl: backend.baseUrl, apiKey: backend.apiKey, backend: backend.type },
        STALE_MODEL_CHECK_TIMEOUT_MS,
      );
    } catch (err) {
      await trace.event({
        type: "step",
        level: "warn",
        message: `Could not list models on ${backend.baseUrl} — stored model selections left unchanged`,
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      continue;
    }
    for (const check of group) {
      if (served.includes(check.model)) continue;
      patch[check.modelKey] = null;
      cleared.push(`${check.label} model`);
      await trace.event({
        type: "step",
        level: "warn",
        message: `Cleared ${check.label} model — "${check.model}" is not served by ${backend.baseUrl}`,
        data: { model: check.model, endpoint: backend.baseUrl },
      });
    }
  }
  return cleared;
}

/**
 * Clear role model selections a **backend edit** has made stale: every role
 * whose effective backend is the given (just-repointed) row gets its stored
 * model verified against the new endpoint's listing, and verifiably unserved
 * ones are cleared in one settings write. Same doctrine as
 * {@link clearStaleModelSelections} — a failed listing clears nothing, audio is
 * exempt. Called by the backends service after a URL/key change.
 *
 * Returns human labels of what was cleared.
 */
export async function clearRoleModelsNotServed(
  backend: BackendRecord,
  trace: TraceRecorder,
  db: DrizzleDb = getDb(),
): Promise<string[]> {
  const record = await getSettingsRecord(db);
  if (!record) return [];

  const affected = LISTED_MODEL_ROLES.filter((role) => {
    const eff = record[role.backendKey] ?? record.chatBackendId;
    return eff === backend.id && Boolean(record[role.modelKey]);
  });
  if (affected.length === 0) return [];

  let served: string[];
  try {
    served = await listModels(
      { baseUrl: backend.baseUrl, apiKey: backend.apiKey, backend: backend.type },
      STALE_MODEL_CHECK_TIMEOUT_MS,
    );
  } catch (err) {
    await trace.event({
      type: "step",
      level: "warn",
      message: `Could not list models on ${backend.baseUrl} — role model selections left unchanged`,
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }

  const patch: SettingsPatch = {};
  const cleared: string[] = [];
  for (const role of affected) {
    const model = record[role.modelKey];
    if (!model || served.includes(model)) continue;
    patch[role.modelKey] = null;
    cleared.push(`${role.label} model`);
    await trace.event({
      type: "step",
      level: "warn",
      message: `Cleared ${role.label} model — "${model}" is not served by ${backend.baseUrl}`,
      data: { model, endpoint: backend.baseUrl },
    });
  }
  if (cleared.length > 0) {
    await upsertSettings(db, patch);
    await trace.event({ type: "db", message: "stale role models cleared on settings row" });
  }
  return cleared;
}

/** Apply a validated partial update, recording the change as a trace. */
export async function updateSettings(
  input: UpdateSettings,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<Settings> {
  const fields = Object.keys(input);
  return withTrace(
    { feature: FEATURE.id, action: "update", trigger, inputSummary: fields.join(", ") },
    async (trace) => {
      await trace.event({ type: "input", message: "settings update", data: redact(input) });
      const patch = toPatch(input);
      await validateBackendIds(db, patch);
      if (input.ownerUserId !== undefined) {
        Object.assign(patch, await ownerPatch(db, input.ownerUserId));
      }
      const cleared = await clearStaleModelSelections(
        db,
        await getSettingsRecord(db),
        patch,
        trace,
      );
      const record = await upsertSettings(db, patch);
      await trace.event({ type: "db", message: "settings row upserted" });
      await trace.succeed({
        outputSummary:
          cleared.length > 0
            ? `Updated ${fields.join(", ")}; cleared stale ${cleared.join(", ")}`
            : `Updated ${fields.join(", ")}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [SETTINGS_ID] },
      });
      return toClientSettings(record);
    },
  );
}

/**
 * Merge a probe input over the stored record for one role, then resolve it
 * exactly as the runtime does — so a passing test means the *runtime*
 * connection works, not some test-only variant of it.
 */
function mergeRoleInput(
  record: SettingsRecord | null,
  input: TestRoleConnection,
  keys: { backendKey: RoleBackendKey; modelKey: RoleModelKey },
): SettingsRecord {
  const base = record ?? EMPTY_RECORD;
  return {
    ...base,
    [keys.backendKey]:
      input.backendId !== undefined ? input.backendId : base[keys.backendKey],
    [keys.modelKey]: input.model !== undefined ? input.model : base[keys.modelKey],
  };
}

/**
 * Probe the embedding configuration by actually embedding a short string, and
 * report the vector width it produced. A real probe, not a config-presence check:
 * it proves the endpoint answers, the key is accepted, the model exists, and — the
 * failure this catches that nothing else would — that the model's width matches
 * the `vector` columns. A mismatched model is reported as a bad request with the
 * two numbers, since every later insert would fail deep inside a background job.
 *
 * Unsupplied fields fall back to what is stored, so the operator can test the
 * saved configuration without re-sending anything.
 */
export async function testEmbeddings(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<EmbeddingProbe> {
  const record = await getSettingsRecord(db);
  const merged = mergeRoleInput(record, input, {
    backendKey: "embeddingBackendId",
    modelKey: "embeddingModel",
  });
  const runtime = await toEmbeddingRuntime(db, merged);

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-embeddings",
      trigger,
      inputSummary: merged.embeddingModel ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose an embedding model (and a backend, unless the chat backend serves embeddings).",
        );
      }
      await trace.event({
        type: "external_call",
        message: `POST ${runtime.baseUrl} /embeddings`,
        data: { model: runtime.model },
      });
      const probe = await probeEmbeddings(runtime);
      await trace.event({
        type: "output",
        message: `${probe.dimensions}-dimensional vector returned`,
        data: probe,
      });
      await trace.succeed({ outputSummary: `${probe.model} → ${probe.dimensions} dimensions` });
      return probe;
    },
  );
}

/**
 * Probe the image configuration, recording the attempt as a trace. Same contract
 * as {@link testEmbeddings}: submitted values are merged over the stored record and
 * resolved through the *runtime* resolver, so a passing test means the connection
 * the `image_generate` tool will actually use works.
 */
export async function testImages(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ImageProbe> {
  const record = await getSettingsRecord(db);
  const merged = mergeRoleInput(record, input, {
    backendKey: "imageBackendId",
    modelKey: "imageModel",
  });
  const runtime = await toImageRuntime(db, merged);

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-images",
      trigger,
      inputSummary: merged.imageModel ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose an image model (and a backend, unless the chat backend serves images).",
        );
      }
      await trace.event({
        type: "external_call",
        message: `GET ${runtime.baseUrl} /models`,
        data: { model: runtime.model },
      });
      const probe = await probeImages(runtime);
      await trace.event({
        type: "output",
        message: `image model "${probe.model}" is served by the endpoint`,
        data: probe,
      });
      await trace.succeed({ outputSummary: `${probe.model} served (${probe.modelCount} models)` });
      return probe;
    },
  );
}

/**
 * Probe the speech configuration, recording the attempt as a trace. Same contract
 * as {@link testImages}: submitted values are merged over the stored record and
 * resolved through the *runtime* resolver, so a passing test means the connection
 * voice replies will actually use works.
 */
export async function testSpeech(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<SpeechProbe> {
  const record = await getSettingsRecord(db);
  const merged = mergeRoleInput(record, input, {
    backendKey: "speechBackendId",
    modelKey: "speechModel",
  });
  const runtime = await toSpeechRuntime(db, merged);

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-speech",
      trigger,
      inputSummary: merged.speechModel ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose a speech model (and a backend, unless the chat backend serves speech).",
        );
      }
      await trace.event({
        type: "external_call",
        message: `GET ${runtime.baseUrl} /models`,
        data: { model: runtime.model },
      });
      const probe = await probeSpeech(runtime);
      await trace.event({
        type: "output",
        message: `speech model "${probe.model}" is served by the endpoint`,
        data: probe,
      });
      await trace.succeed({ outputSummary: `${probe.model} served (${probe.modelCount} models)` });
      return probe;
    },
  );
}

/**
 * Probe the audio (STT) configuration by actually transcribing a fraction of a
 * second of generated silence — a **real** probe, like embeddings: whisper-class
 * servers often have no `/v1/models`, so only a genuine `/v1/audio/transcriptions`
 * call proves the endpoint, key, and model work. Recorded as a trace; submitted
 * values are merged over the stored record and resolved through the runtime
 * resolver, so a passing test means the voice path's connection works.
 */
export async function testAudio(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<TranscriptionProbe> {
  const record = await getSettingsRecord(db);
  const merged = mergeRoleInput(record, input, {
    backendKey: "audioBackendId",
    modelKey: "audioModel",
  });
  const runtime = await toAudioRuntime(db, merged);

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-audio",
      trigger,
      inputSummary: merged.audioModel ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose an audio model (and a backend, unless the chat backend serves transcription).",
        );
      }
      await trace.event({
        type: "external_call",
        message: `POST ${runtime.baseUrl} /audio/transcriptions`,
        data: { model: runtime.model },
      });
      const probe = await probeTranscription(runtime, tinySilenceWav());
      await trace.event({
        type: "output",
        message: `transcription endpoint responded`,
        data: probe,
      });
      await trace.succeed({ outputSummary: `${probe.model} transcribed the probe audio` });
      return probe;
    },
  );
}

/** Field defaults for merging a partial probe input onto a never-written settings row. */
const EMPTY_RECORD: SettingsRecord = {
  chatBackendId: null,
  model: null,
  embeddingBackendId: null,
  embeddingModel: null,
  imageBackendId: null,
  imageModel: null,
  speechBackendId: null,
  speechModel: null,
  speechVoice: null,
  audioBackendId: null,
  audioModel: null,
  visionBackendId: null,
  visionModel: null,
  browserBackendId: null,
  browserModel: null,
  activePersonalityId: null,
  telegramBotToken: null,
  tavilyApiKey: null,
  ownerUsername: null,
  ownerUserId: null,
  maintenanceModeEnabled: false,
  timezone: "UTC",
  dailyJobsRunTime: DEFAULT_DAILY_JOBS_RUN_TIME,
  browserDownloadLimitGb: DEFAULT_BROWSER_DOWNLOAD_LIMIT_GB,
  operatorPasswordHash: null,
  sessionSecret: null,
  updatedAt: null,
};
