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
import {
  buildAnalyzerMessages,
  parseAnalyzerVerdict,
} from "@/features/bot-messaging/server/address-analyzer";
import {
  buildSummaryPrompt,
  parseSummaryTopics,
  SUMMARY_SYSTEM,
  type SummarizableMessage,
} from "@/features/history/summary";
import { buildDescribeMessages } from "@/features/vision/server/describe";
import {
  chatCompletion,
  listModels,
  sanitizeMessagesForTrace,
  type ChatMessage,
} from "@/server/llm/client";
import { readReasoningFor } from "@/server/llm/backends";
import { runClassifier } from "@/server/llm/classifier";
import { chatCompletionWithTools } from "@/server/llm/tool-loop";
import { probeEmbeddings, type EmbeddingRuntime } from "@/server/llm/embeddings";
import { probeImages, type ImageRuntime } from "@/server/llm/images";
import { probeSpeech, type SpeechRuntime } from "@/server/llm/speech";
import { probeTranscription, type TranscriptionRuntime } from "@/server/llm/transcription";
import { tinySilenceWav } from "@/server/media/audio";
import { tinyProbePng } from "@/server/media/image";
import { saveSourceOwner } from "@/server/transports/status";
import { withTrace, type TraceRecorder } from "@/server/trace";
import { getEnv } from "@/server/env";
import {
  getSettingsRecord,
  SETTINGS_ID,
  upsertSettings,
  type SettingsPatch,
  type SettingsRecord,
} from "./repository";
import {
  getStoreSettings,
  upsertStoreSettings,
  STORE_SETTINGS_DEFAULTS,
  type StoreSettingsPatch,
  type StoreSettingsRecord,
} from "./store-repository";
import type {
  ProbePart,
  ProbeReport,
  Settings,
  TestAudioConnection,
  TestRoleConnection,
  UpdateSettings,
} from "./schema";

/**
 * Settings domain service — the boundary the Route Handlers and Server
 * Components call. LLM configuration is per **role** (chat, embedding, audio,
 * vision, speech, image generation, browser agent, classifiers, background
 * jobs): each role references a backend from the catalog (`features/backends`)
 * and picks a model; a null backend id means "use the chat backend", and for
 * the audio/vision/browser/classifier/background roles a null model
 * additionally means "use the chat model" (main by default).
 *
 * Reads never expose secrets. Writes and connection tests are recorded as
 * traces; secret values are redacted from trace data.
 */

const FEATURE = FEATURES["settings"];

/**
 * The store-owned half of the settings, read best-effort. A deployment that
 * has not been given the v2 store yet (the transitional `STORE_DATABASE_URL`
 * is optional until the Phase 6 cutover) simply reads the defaults instead of
 * failing the whole settings page; writes to these fields are NOT forgiving —
 * see {@link updateSettings}.
 */
async function readStoreSettings(): Promise<StoreSettingsRecord> {
  if (!getEnv().STORE_DATABASE_URL) return { ...STORE_SETTINGS_DEFAULTS };
  try {
    return await getStoreSettings();
  } catch (err) {
    console.warn(
      "Core store settings unreadable — showing defaults:",
      err instanceof Error ? err.message : String(err),
    );
    return { ...STORE_SETTINGS_DEFAULTS };
  }
}

/** Project the internal records to the client-safe shape (masking secrets). */
function toClientSettings(record: SettingsRecord | null, store: StoreSettingsRecord): Settings {
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
    audioTranscriptionMode: record?.audioTranscriptionMode ?? "transcriptions",
    visionBackendId: record?.visionBackendId ?? null,
    visionModel: record?.visionModel ?? null,
    classifierBackendId: record?.classifierBackendId ?? null,
    classifierModel: record?.classifierModel ?? null,
    backgroundBackendId: record?.backgroundBackendId ?? null,
    backgroundModel: record?.backgroundModel ?? null,
    browserBackendId: record?.browserBackendId ?? null,
    browserModel: record?.browserModel ?? null,
    webSearchConfigured: Boolean(record?.tavilyApiKey),
    ownerUsername: record?.ownerUsername ?? null,
    ownerUserId: record?.ownerUserId ?? null,
    maintenanceModeEnabled: record?.maintenanceModeEnabled ?? false,
    assistantLoopGuardTurns: store.assistantLoopGuardTurns,
    timezone: record?.timezone ?? "UTC",
    dailyJobsRunTime: record?.dailyJobsRunTime ?? DEFAULT_DAILY_JOBS_RUN_TIME,
    browserDownloadLimitGb: record?.browserDownloadLimitGb ?? DEFAULT_BROWSER_DOWNLOAD_LIMIT_GB,
    updatedAt: record?.updatedAt ?? null,
  };
}

/** Current settings (no secret values), or empty defaults when never configured. */
export async function getSettings(db: DrizzleDb = getDb()): Promise<Settings> {
  const [record, store] = await Promise.all([getSettingsRecord(db), readStoreSettings()]);
  return toClientSettings(record, store);
}

/**
 * Server-only: the bot-to-bot loop guard — how many assistant turns a chat
 * may hold in a row before every assistant there stays silent until a human
 * speaks (user decision, 2026-08-24: default 3, deterministic, never an LLM
 * judgement). Read at call time so an operator change applies without a
 * restart, exactly like {@link getTimezone}.
 */
export async function getAssistantLoopGuardTurns(): Promise<number> {
  return (await readStoreSettings()).assistantLoopGuardTurns;
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
  return toChatRuntime(db, await getSettingsRecord(db));
}

/** The chat resolver behind {@link getLlmRuntime}, shared with the probe. */
async function toChatRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
): Promise<LlmRuntime | null> {
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
 * behavior), never by calling an STT endpoint with a guessed id. The mode says
 * how the dedicated connection takes audio: the `/v1/audio/transcriptions`
 * endpoint, or an `input_audio` chat completion of its own.
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
    mode: record.audioTranscriptionMode,
  };
}

/**
 * The transcription connection the voice path actually uses when no dedicated
 * STT model is configured: the chat (main) model carrying the audio as an
 * `input_audio` chat-completion part. Null when chat itself is unconfigured.
 */
async function toChatFallbackTranscriptionRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
): Promise<TranscriptionRuntime | null> {
  if (!record?.chatBackendId || !record.model) return null;
  const backend = await getBackendById(db, record.chatBackendId);
  if (!backend) return null;
  return {
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKey,
    backend: backend.type,
    model: record.model,
    mode: "chat",
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
 * Resolve a **"main by default"** role: one that falls back to the chat backend
 * and the chat model per unset half, so it is null only when nothing resolves
 * to a full connection. Vision, browser agent, classifiers and background jobs
 * all work this way — they are ordinary chat completions that the operator may
 * want to run somewhere else, not capabilities that switch off without a model
 * of their own (that shape is {@link toEmbeddingRuntime}'s).
 */
async function toInheritingRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
  modelKey: "visionModel" | "browserModel" | "classifierModel" | "backgroundModel",
  backendKey: "visionBackendId" | "browserBackendId" | "classifierBackendId" | "backgroundBackendId",
): Promise<LlmRuntime | null> {
  const model = record?.[modelKey] ?? record?.model ?? null;
  if (!record || !model) return null;
  const backend = await resolveRoleBackend(db, record, record[backendKey]);
  if (!backend) return null;
  return { baseUrl: backend.baseUrl, apiKey: backend.apiKey, model, backend: backend.type };
}

/**
 * Server-only: the vision connection + model — the describer every photo,
 * video frame, and sticker goes through.
 */
export async function getVisionRuntime(db: DrizzleDb = getDb()): Promise<LlmRuntime | null> {
  return toVisionRuntime(db, await getSettingsRecord(db));
}

/** The vision resolver behind {@link getVisionRuntime}, shared with the probe. */
async function toVisionRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
): Promise<LlmRuntime | null> {
  return toInheritingRuntime(db, record, "visionModel", "visionBackendId");
}

/** Server-only: the browser-agent LLM connection + model. */
export async function getBrowserLlmRuntime(db: DrizzleDb = getDb()): Promise<LlmRuntime | null> {
  return toBrowserRuntime(db, await getSettingsRecord(db));
}

/** The browser resolver behind {@link getBrowserLlmRuntime}, shared with the probe. */
async function toBrowserRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
): Promise<LlmRuntime | null> {
  return toInheritingRuntime(db, record, "browserModel", "browserBackendId");
}

/**
 * Server-only: the connection the **per-message classifications** run on — the
 * addressing analyzer and its verifier, the honesty gate over a drafted reply,
 * and the standing-rule match. One question about one piece of text, answered
 * as a small JSON verdict, with no tools, history or persona
 * (`server/llm/classifier.ts` owns the call bounds).
 *
 * These are the reply path's latency floor: every group message pays an
 * addressing check plus a rule match before a reply is even considered, so this
 * is the role to point at a small fast model. Null only when the chat role it
 * falls back to is unconfigured too.
 */
export async function getClassifierRuntime(db: DrizzleDb = getDb()): Promise<LlmRuntime | null> {
  return toClassifierRuntime(db, await getSettingsRecord(db));
}

/** The classifier resolver behind {@link getClassifierRuntime}, shared with the probe. */
async function toClassifierRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
): Promise<LlmRuntime | null> {
  return toInheritingRuntime(db, record, "classifierModel", "classifierBackendId");
}

/**
 * Server-only: the connection the **offline jobs** run on — history
 * summarization, memory extraction and consolidation, analytics insights, and
 * self-improvement reflection. Long transcripts in, structured output out, at
 * background priority: nobody is waiting, but what these write is what later
 * replies recall, so quality matters more than latency here.
 *
 * Deliberately *not* used by anything a person is waiting on: a scheduled task
 * fires a real chat reply and stays on the chat role.
 */
export async function getBackgroundRuntime(db: DrizzleDb = getDb()): Promise<LlmRuntime | null> {
  return toBackgroundRuntime(db, await getSettingsRecord(db));
}

/** The background resolver behind {@link getBackgroundRuntime}, shared with the probe. */
async function toBackgroundRuntime(
  db: DrizzleDb,
  record: SettingsRecord | null,
): Promise<LlmRuntime | null> {
  return toInheritingRuntime(db, record, "backgroundModel", "backgroundBackendId");
}

/**
 * Server-only: the operator timezone (IANA name, defaulting to `UTC`). Used by
 * the tasks feature to interpret wall-clock schedules.
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

/**
 * The maintenance state the bot needs to police an incoming message. Owner
 * identity is deliberately NOT here since the split: the owning source stamps
 * `sender.isOwner` on every inbound event (its settings are authoritative —
 * the core's owner columns are a display denormalization only), and tasks
 * carry `createdByOwner` stamped at creation, so no core code compares user
 * ids against an owner id.
 */
export interface BotPolicy {
  /** Whether maintenance mode is on. */
  maintenanceModeEnabled: boolean;
}

/** Server-only: read the maintenance policy. Cheap enough to run per message. */
export async function getBotPolicy(db: DrizzleDb = getDb()): Promise<BotPolicy> {
  const record = await getSettingsRecord(db);
  return {
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
  { label: "classifier", modelKey: "classifierModel", backendKey: "classifierBackendId" },
  { label: "background", modelKey: "backgroundModel", backendKey: "backgroundBackendId" },
] as const;

/**
 * Model selections that are picked from a backend's `/v1/models` listing and
 * can therefore be verified against it. Audio counts only in `chat`
 * transcription mode, where the STT model is an ordinary chat model the
 * backend must list. In `transcriptions` mode whisper-class servers often
 * expose no listing, so absence from one proves nothing (the UI field allows
 * free text for the same reason) — there an audio selection is never cleared
 * on unverifiable evidence.
 */
function listedModelRoles(audioMode: "transcriptions" | "chat") {
  return ROLE_FIELDS.filter((r) => r.label !== "audio" || audioMode === "chat");
}

type RoleBackendKey = (typeof ROLE_FIELDS)[number]["backendKey"];
type RoleModelKey = (typeof ROLE_FIELDS)[number]["modelKey"];

/** Translate a validated update into a column patch (empty secret clears it). */
function toPatch(input: UpdateSettings): SettingsPatch {
  const patch: SettingsPatch = {};
  for (const { modelKey, backendKey } of ROLE_FIELDS) {
    if (input[backendKey] !== undefined) patch[backendKey] = input[backendKey];
    if (input[modelKey] !== undefined) patch[modelKey] = input[modelKey];
  }
  if (input.audioTranscriptionMode !== undefined) {
    patch.audioTranscriptionMode = input.audioTranscriptionMode;
  }
  if (input.speechVoice !== undefined) {
    patch.speechVoice = input.speechVoice === "" ? null : input.speechVoice;
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

/** The half of a validated update that belongs to the v2 core store. */
function toStorePatch(input: UpdateSettings): StoreSettingsPatch {
  const patch: StoreSettingsPatch = {};
  if (input.assistantLoopGuardTurns !== undefined) {
    patch.assistantLoopGuardTurns = input.assistantLoopGuardTurns;
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
  const { tavilyApiKey, ...rest } = input;
  const out: Record<string, unknown> = { ...rest };
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
 * - Audio is exempt only in `transcriptions` mode (see {@link listedModelRoles}).
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
  const audioMode =
    patch.audioTranscriptionMode ?? before?.audioTranscriptionMode ?? "transcriptions";
  for (const role of listedModelRoles(audioMode)) {
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
 * exempt only in `transcriptions` mode. Called by the backends service after a
 * URL/key change.
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

  const affected = listedModelRoles(record.audioTranscriptionMode).filter((role) => {
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
        const owner = await ownerPatch(db, input.ownerUserId);
        // Owner identity lives with the source since the split — it resolves
        // `isOwner` per inbound event. Routed there first; the v1 columns
        // stay as the shadow the transitional policy reads.
        await saveSourceOwner({
          ownerUsername: owner.ownerUsername ?? null,
          ownerUserId: owner.ownerUserId ?? null,
        });
        await trace.event({
          type: "step",
          message: "owner routed to the telegram service settings",
        });
        Object.assign(patch, owner);
      }
      const cleared = await clearStaleModelSelections(
        db,
        await getSettingsRecord(db),
        patch,
        trace,
      );
      const record = await upsertSettings(db, patch);
      await trace.event({ type: "db", message: "settings row upserted" });
      // The store-owned half (fields with no v1 column — see
      // `store-repository.ts`). Unlike the read path this does NOT fall back:
      // a save the operator watched must never report success it did not
      // achieve.
      const storePatch = toStorePatch(input);
      let store: StoreSettingsRecord;
      if (Object.keys(storePatch).length > 0) {
        store = await upsertStoreSettings(storePatch);
        await trace.event({ type: "db", message: "core store settings row upserted" });
      } else {
        store = await readStoreSettings();
      }
      await trace.succeed({
        outputSummary:
          cleared.length > 0
            ? `Updated ${fields.join(", ")}; cleared stale ${cleared.join(", ")}`
            : `Updated ${fields.join(", ")}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [SETTINGS_ID] },
      });
      return toClientSettings(record, store);
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
 * Every "Test …" button exercises the role for real and reports the exchange:
 * what was sent, and what came back. The helpers below are what keep the seven
 * probes reporting it the same way.
 */

/** Short bound for the chat probe — one tiny completion, an operator is waiting. */
const CHAT_PROBE_TIMEOUT_MS = 60_000;

/**
 * What the chat probe asks. Short enough to answer in a sentence, but a real
 * question rather than "say OK": a model that is thinking should have something
 * to think about, so the reasoning channel below is exercised too.
 */
const CHAT_PROBE_PROMPT = "In one short sentence, what is the capital of France and why is it there?";

/**
 * Probe the chat (main) configuration by actually completing a prompt, and
 * report both the reply and the hidden reasoning behind it.
 *
 * It used to list the backend's models, which says nothing about whether the
 * *selected* model answers — the failure the operator actually cares about.
 * Showing the reasoning matters as much as the reply: this role must support
 * thinking, the tokens it costs are invisible in the answer, and an empty
 * reasoning channel on a model that should think is exactly the misconfiguration
 * that is otherwise only discovered by reading a live reply's trace.
 */
export async function testChat(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ProbeReport> {
  const record = await getSettingsRecord(db);
  const merged = mergeRoleInput(record, input, {
    backendKey: "chatBackendId",
    modelKey: "model",
  });
  const runtime = await toChatRuntime(db, merged);

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-chat",
      trigger,
      inputSummary: merged.model ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest("Choose a chat backend and model first.");
      }
      const startedAt = Date.now();
      const messages: ChatMessage[] = [{ role: "user", content: CHAT_PROBE_PROMPT }];
      await trace.event({
        type: "external_call",
        message: `POST ${runtime.baseUrl} /chat/completions`,
        data: { model: runtime.model, messages },
      });
      const completed = await chatCompletion(
        { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend },
        { model: runtime.model, messages, timeoutMs: CHAT_PROBE_TIMEOUT_MS },
      );
      await trace.event({
        type: "output",
        message: "chat endpoint answered",
        // The provider's raw response body, verbatim (full-raw-bodies rule).
        data: completed.responseBody ?? { content: completed.content },
      });
      const reasoning = readReasoningFor(runtime.backend, completed.responseBody);
      const result = report(
        runtime.model,
        startedAt,
        [{ kind: "text", label: "Prompt", text: CHAT_PROBE_PROMPT }],
        [
          { kind: "text", label: "Message", text: completed.content.trim() },
          {
            kind: "text",
            label: "Reasoning",
            // Named as absent rather than omitted: "this model returned no
            // thinking" is a finding for a role that is supposed to think.
            text: reasoning?.trim() || "(none returned — this model did not think out loud)",
          },
        ],
      );
      await trace.succeed({ outputSummary: `${runtime.model} answered the probe prompt` });
      return result;
    },
  );
}

/** Assemble one probe's report, timing it from the moment the call started. */
function report(
  model: string,
  startedAt: number,
  input: ProbePart[],
  output: ProbePart[],
): ProbeReport {
  return { model, input, output, latencyMs: Date.now() - startedAt };
}

/** How many leading components of a vector are worth showing. */
const VECTOR_PREVIEW_LENGTH = 8;

/** A vector part: the width, plus enough of the head to see it is a real embedding. */
function vectorPart(label: string, vector: number[]): ProbePart {
  return {
    kind: "vector",
    label,
    dimensions: vector.length,
    preview: vector.slice(0, VECTOR_PREVIEW_LENGTH),
  };
}

/**
 * A report as it goes into a trace: image and audio bytes are replaced with
 * their size. Same convention as the vision describer — a trace records that an
 * artifact was exchanged and how big it was, never megabytes of base64 (the
 * dashboard renders the real thing from the API response instead).
 */
function sanitizeReportForTrace(probe: ProbeReport): unknown {
  const strip = (parts: ProbePart[]) =>
    parts.map((part) =>
      part.kind === "image" || part.kind === "audio"
        ? { kind: part.kind, label: part.label, bytes: dataUrlByteLength(part.dataUrl) }
        : part,
    );
  return { ...probe, input: strip(probe.input), output: strip(probe.output) };
}

/** Decoded byte length of a `data:` URL's payload. */
function dataUrlByteLength(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.floor((base64.length * 3) / 4);
}

/**
 * Probe the embedding configuration by actually embedding a short phrase, and
 * report the vector it produced. A real probe, not a config-presence check:
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
): Promise<ProbeReport> {
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
      const startedAt = Date.now();
      await trace.event({
        type: "external_call",
        message: `POST ${runtime.baseUrl} /embeddings`,
        data: { model: runtime.model },
      });
      const probe = await probeEmbeddings(runtime);
      const result = report(
        probe.model,
        startedAt,
        [{ kind: "text", label: "Phrase", text: probe.phrase }],
        [vectorPart("Vector", probe.vector)],
      );
      await trace.event({
        type: "output",
        message: `${probe.dimensions}-dimensional vector returned`,
        data: sanitizeReportForTrace(result),
      });
      await trace.succeed({ outputSummary: `${probe.model} → ${probe.dimensions} dimensions` });
      return result;
    },
  );
}

/**
 * Probe the image configuration by actually drawing a small picture, recording
 * the attempt as a trace. Same contract as {@link testEmbeddings}: submitted
 * values are merged over the stored record and resolved through the *runtime*
 * resolver, so a passing test means the connection the `image_generate` tool
 * will actually use works — and the operator sees what it drew.
 */
export async function testImages(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ProbeReport> {
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
      const startedAt = Date.now();
      await trace.event({
        type: "external_call",
        message: `POST ${runtime.baseUrl} /images/generations`,
        data: { model: runtime.model },
      });
      const probe = await probeImages(runtime);
      const result = report(
        probe.model,
        startedAt,
        [{ kind: "text", label: "Prompt", text: probe.prompt }],
        [{ kind: "image", label: "Generated image", dataUrl: pngDataUrl(probe.imageBase64) }],
      );
      await trace.event({
        type: "output",
        message: `image model "${probe.model}" generated an image`,
        data: sanitizeReportForTrace(result),
      });
      await trace.succeed({ outputSummary: `${probe.model} drew the test prompt` });
      return result;
    },
  );
}

/** A `data:` URL for generated PNG bytes — what the dashboard renders. */
function pngDataUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}

/**
 * Probe the speech configuration by actually synthesizing a short phrase,
 * recording the attempt as a trace. Same contract as {@link testImages}:
 * submitted values are merged over the stored record and resolved through the
 * *runtime* resolver, so a passing test means the connection voice replies will
 * actually use works — in the voice they will actually use.
 */
export async function testSpeech(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ProbeReport> {
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
      const startedAt = Date.now();
      await trace.event({
        type: "external_call",
        message: `POST ${runtime.baseUrl} /audio/speech`,
        data: { model: runtime.model, voice: runtime.voice },
      });
      const probe = await probeSpeech(runtime);
      const result = report(
        probe.model,
        startedAt,
        [
          { kind: "text", label: "Phrase", text: probe.phrase },
          { kind: "text", label: "Voice", text: probe.voice },
        ],
        [
          {
            kind: "audio",
            label: "Synthesized audio",
            dataUrl: `data:audio/mpeg;base64,${probe.audioBase64}`,
          },
        ],
      );
      await trace.event({
        type: "output",
        message: `speech model "${probe.model}" synthesized the test phrase`,
        data: sanitizeReportForTrace(result),
      });
      await trace.succeed({ outputSummary: `${probe.model} spoke in "${probe.voice}"` });
      return result;
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
  input: TestAudioConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ProbeReport> {
  const record = await getSettingsRecord(db);
  const merged = mergeRoleInput(record, input, {
    backendKey: "audioBackendId",
    modelKey: "audioModel",
  });
  if (input.transcriptionMode !== undefined) {
    merged.audioTranscriptionMode = input.transcriptionMode;
  }
  // No dedicated STT model: probe the exact fallback the voice path uses — the
  // chat model taking the audio through an `input_audio` chat completion.
  const runtime =
    (await toAudioRuntime(db, merged)) ?? (await toChatFallbackTranscriptionRuntime(db, merged));

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-audio",
      trigger,
      inputSummary: merged.audioModel ?? merged.model ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose an audio model, or configure the chat role it falls back to.",
        );
      }
      await trace.event({
        type: "external_call",
        message:
          runtime.mode === "chat"
            ? `POST ${runtime.baseUrl} /chat/completions (input_audio)`
            : `POST ${runtime.baseUrl} /audio/transcriptions`,
        data: { model: runtime.model, mode: runtime.mode },
      });
      const startedAt = Date.now();
      const wav = tinySilenceWav();
      const probe = await probeTranscription(runtime, wav);
      const result = report(
        probe.model,
        startedAt,
        [
          {
            kind: "audio",
            label: "Sent audio (generated silence)",
            dataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
          },
          { kind: "text", label: "Mode", text: TRANSCRIPTION_MODE_LABELS[runtime.mode] },
        ],
        [
          {
            kind: "text",
            label: "Transcript",
            // Silence usually transcribes to nothing, which is a pass, not a
            // blank the operator should be left to interpret.
            text: probe.text || "(empty — expected, the probe audio is silence)",
          },
        ],
      );
      await trace.event({
        type: "output",
        message: `transcription endpoint responded`,
        data: sanitizeReportForTrace(result),
      });
      await trace.succeed({ outputSummary: `${probe.model} transcribed the probe audio` });
      return result;
    },
  );
}

/** How each transcription mode reads on a probe report. */
const TRANSCRIPTION_MODE_LABELS: Record<"transcriptions" | "chat", string> = {
  transcriptions: "/v1/audio/transcriptions",
  chat: "chat completion with an input_audio part",
};

/**
 * Probe the vision configuration by actually describing a tiny generated image
 * — a **real** probe, like audio: a model listing cannot say whether a model
 * accepts image input (a provider lists a text-only model all the same), so
 * only a genuine vision completion proves the endpoint, key, and model work.
 * Recorded as a trace; submitted values are merged over the stored record and
 * resolved through the runtime resolver — including the fallback to the chat
 * model — so a passing test means the describer's connection works.
 */
export async function testVision(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ProbeReport> {
  const record = await getSettingsRecord(db);
  const merged = mergeRoleInput(record, input, {
    backendKey: "visionBackendId",
    modelKey: "visionModel",
  });
  const runtime = await toVisionRuntime(db, merged);

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-vision",
      trigger,
      inputSummary: merged.visionModel ?? merged.model ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose a vision model, or configure the chat role it falls back to.",
        );
      }
      const startedAt = Date.now();
      const image = await tinyProbePng();
      const imageBase64 = image.toString("base64");
      const messages = buildDescribeMessages([{ base64: imageBase64, mimeHint: "image/png" }], null);
      await trace.event({
        type: "external_call",
        message: `POST ${runtime.baseUrl} /chat/completions (vision)`,
        data: { model: runtime.model, messages: sanitizeMessagesForTrace(messages) },
      });
      const completed = await chatCompletion(
        { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend },
        { model: runtime.model, messages, timeoutMs: VISION_PROBE_TIMEOUT_MS },
      );
      await trace.event({
        type: "output",
        message: "vision endpoint described the test image",
        // The provider's raw response body, verbatim (full-raw-bodies rule).
        data: completed.responseBody ?? { content: completed.content },
      });
      const result = report(
        runtime.model,
        startedAt,
        [{ kind: "image", label: "Sent image", dataUrl: pngDataUrl(imageBase64) }],
        [{ kind: "text", label: "Description", text: completed.content.trim() }],
      );
      await trace.succeed({ outputSummary: `${runtime.model} described the test image` });
      return result;
    },
  );
}

/** Short bound for the vision probe — one tiny image, an operator is waiting. */
const VISION_PROBE_TIMEOUT_MS = 20_000;

/** Short bound for the browser probe — one trivial tool round, same reasoning. */
const BROWSER_PROBE_TIMEOUT_MS = 30_000;

/**
 * The one tool the browser probe offers. Deliberately trivial and side-effect
 * free: the question is not whether the model can browse, it is whether this
 * connection can carry a tool call at all.
 */
const BROWSER_PROBE_TOOL = {
  type: "function" as const,
  function: {
    name: "probe_echo",
    description: "Return the text you are asked to echo. Call this to answer.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The text to echo back." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

/**
 * Probe the browser-agent configuration by running one real tool round: the
 * model is offered a single trivial tool and asked to use it. A **real** probe
 * for the same reason as vision — a model listing cannot say whether a model
 * supports tool calling, and browsing is nothing but tool calls, so a model
 * that cannot make one fails every browse job while looking perfectly
 * configured. Recorded as a trace; submitted values are merged over the stored
 * record and resolved through the runtime resolver, including the fallback to
 * the chat model.
 *
 * A model that answers without calling the tool is reported, not thrown: the
 * connection demonstrably works, and how strictly a model obeys "use the tool"
 * is a quality judgement for the operator, not a pass/fail this can make.
 */
export async function testBrowser(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ProbeReport> {
  const record = await getSettingsRecord(db);
  const merged = mergeRoleInput(record, input, {
    backendKey: "browserBackendId",
    modelKey: "browserModel",
  });
  const runtime = await toBrowserRuntime(db, merged);

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-browser",
      trigger,
      inputSummary: merged.browserModel ?? merged.model ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose a browser-agent model, or configure the chat role it falls back to.",
        );
      }
      const startedAt = Date.now();
      const prompt = 'Call the probe_echo tool with the text "ready", then reply with its result.';
      const messages: ChatMessage[] = [{ role: "user", content: prompt }];
      await trace.event({
        type: "external_call",
        message: `POST ${runtime.baseUrl} /chat/completions (tools)`,
        data: { model: runtime.model, messages, tools: [BROWSER_PROBE_TOOL] },
      });
      let calledTool = false;
      const completed = await chatCompletionWithTools(
        { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend },
        {
          model: runtime.model,
          messages,
          tools: [BROWSER_PROBE_TOOL],
          callTool: async (_name, args) => {
            calledTool = true;
            return { text: String(args.text ?? "") };
          },
          maxRounds: 2,
          timeoutMs: BROWSER_PROBE_TIMEOUT_MS,
        },
      );
      await trace.event({
        type: "output",
        message: calledTool
          ? "browser model called the probe tool"
          : "browser model answered without calling the tool",
        // The provider's raw response body, verbatim (full-raw-bodies rule).
        data: completed.responseBody ?? { content: completed.content },
      });
      const result = report(
        runtime.model,
        startedAt,
        [
          { kind: "text", label: "Prompt", text: prompt },
          { kind: "text", label: "Tool offered", text: BROWSER_PROBE_TOOL.function.name },
        ],
        [
          {
            kind: "text",
            label: "Tool call",
            text: calledTool
              ? `${BROWSER_PROBE_TOOL.function.name} was called`
              : "none — the model answered without using the tool",
          },
          { kind: "text", label: "Answer", text: completed.content.trim() },
        ],
      );
      await trace.succeed({
        outputSummary: calledTool
          ? `${runtime.model} completed a tool call`
          : `${runtime.model} answered but made no tool call`,
      });
      return result;
    },
  );
}

/**
 * Short bound for the classifier probe. Deliberately tight: this role exists to
 * be fast, and a verdict that takes longer than this is a finding, not a wait
 * worth extending.
 */
const CLASSIFIER_PROBE_TIMEOUT_MS = 30_000;

/**
 * The synthetic bot the classifier probe judges against. Not the operator's own
 * identity: the probe must give the same answer on every installation, and the
 * real display name may be a word that legitimately appears in ordinary
 * sentences, which would make a correct verdict look wrong.
 */
const CLASSIFIER_PROBE_BOT = { id: 0, username: "probe_bot", displayName: "Zylbot" };

/** A group message that plainly addresses {@link CLASSIFIER_PROBE_BOT} by name. */
const CLASSIFIER_PROBE_MESSAGE = "Zylbot, can you check the schedule for tomorrow?";

/**
 * Probe the classifier role by running the **real addressing check** — the same
 * prompt builder, call bounds and verdict parser the bot runs on every
 * undecided group message — over a synthetic message that names a synthetic
 * bot, and report the verdict it produced.
 *
 * A real classification rather than a model listing, for the reason this role
 * exists: what it must do is answer a small JSON question quickly and in a
 * shape the parser accepts. A model can be served, listed and reachable and
 * still fail every one of those — by thinking for ten seconds, by wrapping the
 * JSON in prose, or by emitting no verdict at all — and each of those failures
 * is silent in production (an unreadable verdict reads as "not addressed", so
 * the bot simply stops answering when called).
 *
 * The expected verdict is *addressed*. A different verdict is reported, not
 * thrown: whether a model classifies well is the operator's judgement to make
 * from the evidence, and only a transport failure is this probe's to fail on.
 */
export async function testClassifier(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ProbeReport> {
  const record = await getSettingsRecord(db);
  const merged = mergeRoleInput(record, input, {
    backendKey: "classifierBackendId",
    modelKey: "classifierModel",
  });
  const runtime = await toClassifierRuntime(db, merged);

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-classifier",
      trigger,
      inputSummary: merged.classifierModel ?? merged.model ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose a classifier model, or configure the chat role it falls back to.",
        );
      }
      const startedAt = Date.now();
      const messages = buildAnalyzerMessages({
        bot: CLASSIFIER_PROBE_BOT,
        chatType: "supergroup",
        text: CLASSIFIER_PROBE_MESSAGE,
      });
      await trace.event({
        type: "external_call",
        message: `POST ${runtime.baseUrl} /chat/completions (classification)`,
        data: { model: runtime.model, messages },
      });
      const completed = await runClassifier(runtime, messages, {
        timeoutMs: CLASSIFIER_PROBE_TIMEOUT_MS,
      });
      await trace.event({
        type: "output",
        message: "classifier answered the addressing check",
        // The provider's raw response body, verbatim (full-raw-bodies rule).
        data: completed.responseBody ?? { content: completed.content },
      });
      const verdict = parseAnalyzerVerdict(completed.content, { text: CLASSIFIER_PROBE_MESSAGE });
      const result = report(
        runtime.model,
        startedAt,
        [
          { kind: "text", label: "Bot display name", text: CLASSIFIER_PROBE_BOT.displayName },
          { kind: "text", label: "Message to classify", text: CLASSIFIER_PROBE_MESSAGE },
        ],
        [
          { kind: "text", label: "Raw answer", text: completed.content.trim() || "(empty)" },
          {
            kind: "text",
            label: "Parsed verdict",
            text: verdict.addressed
              ? `addressed — cited "${verdict.matchedText}" (expected: addressed)`
              : `not addressed — ${verdict.reason} (expected: addressed)`,
          },
        ],
      );
      await trace.succeed({
        outputSummary: verdict.addressed
          ? `${runtime.model} classified the probe message as addressed`
          : `${runtime.model} answered, but the verdict was "${verdict.reason}"`,
      });
      return result;
    },
  );
}

/**
 * Bound for the background probe. Wide, unlike every other probe here: this
 * role's calls are the slow ones by design (long transcripts, structured
 * output), and its model may well be a large one the operator accepts waiting
 * for at night.
 */
const BACKGROUND_PROBE_TIMEOUT_MS = 120_000;

/** A tiny synthetic chat-day for the background probe to distil. */
const BACKGROUND_PROBE_TRANSCRIPT: SummarizableMessage[] = [
  {
    telegramMessageId: 101,
    role: "user",
    content: "The staging deploy is failing again — the migration step times out.",
    label: "Ada",
    userId: null,
    sentAt: "2026-01-01T10:00:00.000Z",
  },
  {
    telegramMessageId: 102,
    role: "user",
    content: "I'll raise the statement timeout and rerun it after lunch.",
    label: "Bo",
    userId: null,
    sentAt: "2026-01-01T10:02:00.000Z",
  },
  {
    telegramMessageId: 103,
    role: "user",
    content: "Also we agreed to move the weekly sync to Thursday.",
    label: "Ada",
    userId: null,
    sentAt: "2026-01-01T10:05:00.000Z",
  },
];

/**
 * Probe the background role by running the **real summarizer** — the same
 * system prompt, transcript format and topic parser the nightly history job
 * uses — over a tiny synthetic chat-day, and report the topics it produced.
 *
 * A real pass rather than a listing, because what this role must do is not
 * "answer" but "answer in a shape another job then stores": every topic here
 * becomes a row that later replies recall. A model that writes a fine paragraph
 * and no JSON, or invents message ids that were never in the transcript,
 * produces empty or misleading summaries night after night in total silence —
 * the job reports success either way, since a day that distils to nothing is a
 * legitimate outcome.
 *
 * Reported, not thrown, on a poor answer — same reasoning as the classifier
 * probe. Zero topics is a legible result, and the raw answer is shown next to
 * it so the operator can see whether the model wrote prose instead of JSON.
 */
export async function testBackground(
  input: TestRoleConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ProbeReport> {
  const record = await getSettingsRecord(db);
  const merged = mergeRoleInput(record, input, {
    backendKey: "backgroundBackendId",
    modelKey: "backgroundModel",
  });
  const runtime = await toBackgroundRuntime(db, merged);

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-background",
      trigger,
      inputSummary: merged.backgroundModel ?? merged.model ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose a background model, or configure the chat role it falls back to.",
        );
      }
      const startedAt = Date.now();
      const prompt = buildSummaryPrompt("2026-01-01", BACKGROUND_PROBE_TRANSCRIPT);
      const messages: ChatMessage[] = [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: prompt },
      ];
      await trace.event({
        type: "external_call",
        message: `POST ${runtime.baseUrl} /chat/completions (summarize)`,
        data: { model: runtime.model, messages },
      });
      const completed = await chatCompletion(
        { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend },
        {
          model: runtime.model,
          messages,
          timeoutMs: BACKGROUND_PROBE_TIMEOUT_MS,
          // The priority the real jobs run at, so the probe queues behind live
          // replies exactly as they do.
          priority: "background",
        },
      );
      await trace.event({
        type: "output",
        message: "background model summarized the probe transcript",
        // The provider's raw response body, verbatim (full-raw-bodies rule).
        data: completed.responseBody ?? { content: completed.content },
      });
      const topics = parseSummaryTopics(completed.content);
      const result = report(
        runtime.model,
        startedAt,
        [{ kind: "text", label: "Transcript", text: prompt }],
        [
          {
            kind: "text",
            label: "Topics parsed",
            text:
              topics.length > 0
                ? topics
                    .map((t, i) => `${i + 1}. ${t.content} [#${t.messageIds.join(", #")}]`)
                    .join("\n")
                : "(none — the answer held no usable topics)",
          },
          { kind: "text", label: "Raw answer", text: completed.content.trim() || "(empty)" },
        ],
      );
      await trace.succeed({
        outputSummary: `${runtime.model} produced ${topics.length} topic(s) from the probe transcript`,
      });
      return result;
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
  audioTranscriptionMode: "transcriptions",
  visionBackendId: null,
  visionModel: null,
  classifierBackendId: null,
  classifierModel: null,
  backgroundBackendId: null,
  backgroundModel: null,
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
