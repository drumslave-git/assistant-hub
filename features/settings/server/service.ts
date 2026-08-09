import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getKnownUser } from "@/features/known-users/server/repository";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import { DEFAULT_LLM_BACKEND, type LlmBackendId } from "@/lib/llm-backend";
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

/** Short timeout so opening the Settings page stays responsive against a dead endpoint. */
const MODELS_PRELOAD_TIMEOUT_MS = 5_000;
import { withTrace, type TraceRecorder } from "@/server/trace";
import {
  getSettingsRecord,
  SETTINGS_ID,
  upsertSettings,
  type SettingsPatch,
  type SettingsRecord,
} from "./repository";
import type {
  Settings,
  TestConnection,
  TestEmbeddings,
  TestImages,
  TestSpeech,
  TestTranscription,
  UpdateSettings,
} from "./schema";

/**
 * Settings domain service — the boundary the Route Handlers and Server
 * Components call. Reads never expose the API key (only `apiKeyConfigured`).
 * Writes and connection tests are recorded as traces; the API key value is
 * redacted from trace data.
 */

const FEATURE = FEATURES["settings"];

/** Project an internal record to the client-safe shape (masking the secret). */
function toClientSettings(record: SettingsRecord | null): Settings {
  return {
    llmBaseUrl: record?.llmBaseUrl ?? null,
    llmBackend: record?.llmBackend ?? DEFAULT_LLM_BACKEND,
    model: record?.model ?? null,
    apiKeyConfigured: Boolean(record?.llmApiKey),
    telegramBotTokenConfigured: Boolean(record?.telegramBotToken),
    webSearchConfigured: Boolean(record?.tavilyApiKey),
    embeddingBaseUrl: record?.embeddingBaseUrl ?? null,
    embeddingBackend: record?.embeddingBackend ?? DEFAULT_LLM_BACKEND,
    embeddingModel: record?.embeddingModel ?? null,
    embeddingApiKeyConfigured: Boolean(record?.embeddingApiKey),
    imageBaseUrl: record?.imageBaseUrl ?? null,
    imageBackend: record?.imageBackend ?? DEFAULT_LLM_BACKEND,
    imageModel: record?.imageModel ?? null,
    imageApiKeyConfigured: Boolean(record?.imageApiKey),
    speechBaseUrl: record?.speechBaseUrl ?? null,
    speechBackend: record?.speechBackend ?? DEFAULT_LLM_BACKEND,
    speechModel: record?.speechModel ?? null,
    speechVoice: record?.speechVoice ?? null,
    speechApiKeyConfigured: Boolean(record?.speechApiKey),
    transcriptionBaseUrl: record?.transcriptionBaseUrl ?? null,
    transcriptionBackend: record?.transcriptionBackend ?? DEFAULT_LLM_BACKEND,
    transcriptionModel: record?.transcriptionModel ?? null,
    transcriptionApiKeyConfigured: Boolean(record?.transcriptionApiKey),
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
 * Best-effort model list for the saved endpoint, so the Settings page can
 * populate the model dropdown on load without a manual "Test connection".
 * Returns an empty list (never throws) when unconfigured or unreachable — the
 * form still lets the operator test the connection explicitly.
 */
export async function listAvailableModels(db: DrizzleDb = getDb()): Promise<string[]> {
  const record = await getSettingsRecord(db);
  if (!record?.llmBaseUrl) return [];
  try {
    return await listModels(
      { baseUrl: record.llmBaseUrl, apiKey: record.llmApiKey },
      MODELS_PRELOAD_TIMEOUT_MS,
    );
  } catch {
    return [];
  }
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

/**
 * Server-only: the saved LLM connection + model, or null when not fully
 * configured. Used by the conversation core to generate replies.
 */
export async function getLlmRuntime(
  db: DrizzleDb = getDb(),
): Promise<{
  baseUrl: string;
  apiKey: string | null;
  model: string;
  backend: LlmBackendId;
} | null> {
  const record = await getSettingsRecord(db);
  if (!record?.llmBaseUrl || !record.model) return null;
  return {
    baseUrl: record.llmBaseUrl,
    apiKey: record.llmApiKey,
    model: record.model,
    backend: record.llmBackend,
  };
}

/**
 * Resolve the embedding connection from a settings record. The endpoint falls
 * back to the LLM connection when no embedding base URL is configured (the common
 * case: chat and embeddings served by the same host) — and with it the key, since
 * a key belongs to the host it authenticates. A model is mandatory: without one
 * there is nothing to call, and embedding-backed capabilities stay off rather
 * than guessing a model id.
 */
function toEmbeddingRuntime(record: SettingsRecord | null): EmbeddingRuntime | null {
  if (!record?.embeddingModel) return null;
  const ownEndpoint = Boolean(record.embeddingBaseUrl);
  const baseUrl = ownEndpoint ? record.embeddingBaseUrl : record.llmBaseUrl;
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: ownEndpoint ? record.embeddingApiKey : record.llmApiKey,
    // The backend follows the host, exactly like the key above: falling back to
    // the LLM endpoint means inheriting the server that answers there.
    backend: ownEndpoint ? record.embeddingBackend : record.llmBackend,
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
  return toEmbeddingRuntime(await getSettingsRecord(db));
}

/**
 * Resolve the image-generation connection from a settings record. Same shape as
 * {@link toEmbeddingRuntime}: the endpoint (and its key) fall back to the LLM
 * connection when no image base URL is set, and a model is mandatory — without
 * one the `image_generate` tool stays unavailable rather than guessing a model id.
 */
function toImageRuntime(record: SettingsRecord | null): ImageRuntime | null {
  if (!record?.imageModel) return null;
  const ownEndpoint = Boolean(record.imageBaseUrl);
  const baseUrl = ownEndpoint ? record.imageBaseUrl : record.llmBaseUrl;
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: ownEndpoint ? record.imageApiKey : record.llmApiKey,
    backend: ownEndpoint ? record.imageBackend : record.llmBackend,
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
  return toImageRuntime(await getSettingsRecord(db));
}

/**
 * Resolve the speech (TTS) connection from a settings record. Same shape as
 * {@link toEmbeddingRuntime}: the endpoint (and its key) fall back to the LLM
 * connection when no speech base URL is set, and a model is mandatory — without
 * one voice replies stay off rather than guessing a model id.
 */
function toSpeechRuntime(record: SettingsRecord | null): SpeechRuntime | null {
  if (!record?.speechModel) return null;
  const ownEndpoint = Boolean(record.speechBaseUrl);
  const baseUrl = ownEndpoint ? record.speechBaseUrl : record.llmBaseUrl;
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: ownEndpoint ? record.speechApiKey : record.llmApiKey,
    backend: ownEndpoint ? record.speechBackend : record.llmBackend,
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
  return toSpeechRuntime(await getSettingsRecord(db));
}

/**
 * Best-effort model list for the speech endpoint, so the Settings page can
 * populate its model dropdown. Uses the speech base URL when set, else the LLM
 * one. Never throws — an unreachable endpoint yields an empty list.
 */
export async function listAvailableSpeechModels(db: DrizzleDb = getDb()): Promise<string[]> {
  const record = await getSettingsRecord(db);
  const baseUrl = record?.speechBaseUrl || record?.llmBaseUrl;
  if (!baseUrl) return [];
  const apiKey = record?.speechBaseUrl ? record.speechApiKey : record?.llmApiKey;
  try {
    return await listModels({ baseUrl, apiKey }, MODELS_PRELOAD_TIMEOUT_MS);
  } catch {
    return [];
  }
}

/**
 * Resolve the transcription (STT) connection from a settings record. Same shape
 * as {@link toEmbeddingRuntime}: the endpoint (and its key) fall back to the LLM
 * connection when no transcription base URL is set, and a model is mandatory —
 * without one, voice transcription falls back to the chat model's `input_audio`
 * path rather than calling `/v1/audio/transcriptions` with a guessed model id.
 */
function toTranscriptionRuntime(record: SettingsRecord | null): TranscriptionRuntime | null {
  if (!record?.transcriptionModel) return null;
  const ownEndpoint = Boolean(record.transcriptionBaseUrl);
  const baseUrl = ownEndpoint ? record.transcriptionBaseUrl : record.llmBaseUrl;
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: ownEndpoint ? record.transcriptionApiKey : record.llmApiKey,
    backend: ownEndpoint ? record.transcriptionBackend : record.llmBackend,
    model: record.transcriptionModel,
  };
}

/**
 * Server-only: the saved transcription connection + model, or null when no
 * dedicated STT endpoint is configured (voice then transcribes via the chat
 * model's `input_audio`). Read at call time so a change takes effect without a
 * restart.
 */
export async function getTranscriptionRuntime(
  db: DrizzleDb = getDb(),
): Promise<TranscriptionRuntime | null> {
  return toTranscriptionRuntime(await getSettingsRecord(db));
}

/**
 * Best-effort model list for the transcription endpoint, so the Settings page
 * can suggest model ids. Whisper-class servers often serve
 * `/v1/audio/transcriptions` without `/v1/models`, so an empty list is normal —
 * the form falls back to free-text entry. Never throws.
 */
export async function listAvailableTranscriptionModels(
  db: DrizzleDb = getDb(),
): Promise<string[]> {
  const record = await getSettingsRecord(db);
  const baseUrl = record?.transcriptionBaseUrl || record?.llmBaseUrl;
  if (!baseUrl) return [];
  const apiKey = record?.transcriptionBaseUrl ? record.transcriptionApiKey : record?.llmApiKey;
  try {
    return await listModels({ baseUrl, apiKey }, MODELS_PRELOAD_TIMEOUT_MS);
  } catch {
    return [];
  }
}

/**
 * Best-effort model list for the image endpoint, so the Settings page can populate
 * its model dropdown. Uses the image base URL when set, else the LLM one. Never
 * throws — an unreachable endpoint yields an empty list.
 */
export async function listAvailableImageModels(db: DrizzleDb = getDb()): Promise<string[]> {
  const record = await getSettingsRecord(db);
  const baseUrl = record?.imageBaseUrl || record?.llmBaseUrl;
  if (!baseUrl) return [];
  const apiKey = record?.imageBaseUrl ? record.imageApiKey : record?.llmApiKey;
  try {
    return await listModels({ baseUrl, apiKey }, MODELS_PRELOAD_TIMEOUT_MS);
  } catch {
    return [];
  }
}

/**
 * Best-effort model list for the embedding endpoint, so the Settings page can
 * populate its model dropdown. Uses the embedding base URL when set, else the LLM
 * one. Never throws — an unreachable endpoint yields an empty list.
 */
export async function listAvailableEmbeddingModels(db: DrizzleDb = getDb()): Promise<string[]> {
  const record = await getSettingsRecord(db);
  const baseUrl = record?.embeddingBaseUrl || record?.llmBaseUrl;
  if (!baseUrl) return [];
  const apiKey = record?.embeddingBaseUrl ? record.embeddingApiKey : record?.llmApiKey;
  try {
    return await listModels({ baseUrl, apiKey }, MODELS_PRELOAD_TIMEOUT_MS);
  } catch {
    return [];
  }
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

/** Translate a validated update into a column patch (empty key string clears it). */
function toPatch(input: UpdateSettings): SettingsPatch {
  const patch: SettingsPatch = {};
  if (input.llmBaseUrl !== undefined) patch.llmBaseUrl = input.llmBaseUrl;
  if (input.llmBackend !== undefined) patch.llmBackend = input.llmBackend;
  if (input.model !== undefined) patch.model = input.model;
  if (input.apiKey !== undefined) patch.llmApiKey = input.apiKey === "" ? null : input.apiKey;
  if (input.telegramBotToken !== undefined) {
    patch.telegramBotToken = input.telegramBotToken === "" ? null : input.telegramBotToken;
  }
  if (input.tavilyApiKey !== undefined) {
    patch.tavilyApiKey = input.tavilyApiKey === "" ? null : input.tavilyApiKey;
  }
  if (input.embeddingBaseUrl !== undefined) patch.embeddingBaseUrl = input.embeddingBaseUrl;
  if (input.embeddingBackend !== undefined) patch.embeddingBackend = input.embeddingBackend;
  if (input.embeddingModel !== undefined) patch.embeddingModel = input.embeddingModel;
  if (input.embeddingApiKey !== undefined) {
    patch.embeddingApiKey = input.embeddingApiKey === "" ? null : input.embeddingApiKey;
  }
  if (input.imageBaseUrl !== undefined) patch.imageBaseUrl = input.imageBaseUrl;
  if (input.imageBackend !== undefined) patch.imageBackend = input.imageBackend;
  if (input.imageModel !== undefined) patch.imageModel = input.imageModel;
  if (input.imageApiKey !== undefined) {
    patch.imageApiKey = input.imageApiKey === "" ? null : input.imageApiKey;
  }
  if (input.speechBaseUrl !== undefined) patch.speechBaseUrl = input.speechBaseUrl;
  if (input.speechBackend !== undefined) patch.speechBackend = input.speechBackend;
  if (input.speechModel !== undefined) patch.speechModel = input.speechModel;
  if (input.speechApiKey !== undefined) {
    patch.speechApiKey = input.speechApiKey === "" ? null : input.speechApiKey;
  }
  if (input.speechVoice !== undefined) {
    patch.speechVoice = input.speechVoice === "" ? null : input.speechVoice;
  }
  if (input.transcriptionBaseUrl !== undefined) {
    patch.transcriptionBaseUrl = input.transcriptionBaseUrl;
  }
  if (input.transcriptionBackend !== undefined) patch.transcriptionBackend = input.transcriptionBackend;
  if (input.transcriptionModel !== undefined) {
    patch.transcriptionModel = input.transcriptionModel;
  }
  if (input.transcriptionApiKey !== undefined) {
    patch.transcriptionApiKey = input.transcriptionApiKey === "" ? null : input.transcriptionApiKey;
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
  const {
    apiKey,
    telegramBotToken,
    tavilyApiKey,
    embeddingApiKey,
    imageApiKey,
    speechApiKey,
    transcriptionApiKey,
    ...rest
  } = input;
  const out: Record<string, unknown> = { ...rest };
  if (apiKey !== undefined) out.apiKey = "«redacted»";
  if (telegramBotToken !== undefined) out.telegramBotToken = "«redacted»";
  if (tavilyApiKey !== undefined) out.tavilyApiKey = "«redacted»";
  if (embeddingApiKey !== undefined) out.embeddingApiKey = "«redacted»";
  if (imageApiKey !== undefined) out.imageApiKey = "«redacted»";
  if (speechApiKey !== undefined) out.speechApiKey = "«redacted»";
  if (transcriptionApiKey !== undefined) out.transcriptionApiKey = "«redacted»";
  return out;
}

/**
 * Bound on the model listing a save performs to verify stored selections
 * against a repointed endpoint. An explicit save can afford a little more than
 * a page load, but it must never hang the Save button on a dead host.
 */
const STALE_MODEL_CHECK_TIMEOUT_MS = 10_000;

/**
 * Model selections that are picked from an endpoint's `/v1/models` listing, and
 * the connection fields resolving where each is served. Transcription is
 * deliberately absent: whisper-class servers often expose no listing, so
 * absence from one proves nothing (the UI field is free text for the same
 * reason) — a transcription selection is never cleared on unverifiable
 * evidence.
 */
const LISTED_MODEL_SECTIONS = [
  { label: "chat", modelKey: "model", baseUrlKey: "llmBaseUrl", apiKeyKey: "llmApiKey" },
  {
    label: "embedding",
    modelKey: "embeddingModel",
    baseUrlKey: "embeddingBaseUrl",
    apiKeyKey: "embeddingApiKey",
  },
  { label: "image", modelKey: "imageModel", baseUrlKey: "imageBaseUrl", apiKeyKey: "imageApiKey" },
  {
    label: "speech",
    modelKey: "speechModel",
    baseUrlKey: "speechBaseUrl",
    apiKeyKey: "speechApiKey",
  },
] as const;

type ConnField =
  | (typeof LISTED_MODEL_SECTIONS)[number]["modelKey"]
  | (typeof LISTED_MODEL_SECTIONS)[number]["baseUrlKey"]
  | (typeof LISTED_MODEL_SECTIONS)[number]["apiKeyKey"];

/** A connection field's value once the patch is applied over the stored record. */
function effective(
  before: SettingsRecord | null,
  patch: SettingsPatch,
  key: ConnField,
): string | null {
  const patched = patch[key];
  return patched !== undefined ? patched : (before?.[key] ?? null);
}

/**
 * Clear model selections that a connection change has made stale.
 *
 * A model id is only meaningful on the endpoint it was picked from. When a
 * patch repoints that endpoint — the LLM base URL changes and a section reuses
 * that connection, or a section's own URL changes (including falling back to
 * the LLM one) — the new endpoint is asked for its model list and any stored
 * selection it verifiably does not serve is cleared in the same write, instead
 * of failing later inside a background job against a backend that never had it.
 *
 * Deliberate limits, all on the side of not destroying configuration:
 * - A model set in this very patch is trusted — the operator just chose it.
 * - When the new endpoint cannot be listed (down, slow, key rejected), nothing
 *   is cleared: absence is only acted on when it is proven.
 * - Transcription is exempt (see {@link LISTED_MODEL_SECTIONS}).
 *
 * Mutates `patch`; returns human labels of what was cleared.
 */
async function clearStaleModelSelections(
  before: SettingsRecord | null,
  patch: SettingsPatch,
  trace: TraceRecorder,
): Promise<string[]> {
  // Only a base-URL change can repoint where a model is served.
  const urlKeys = ["llmBaseUrl", "embeddingBaseUrl", "imageBaseUrl", "speechBaseUrl"] as const;
  if (urlKeys.every((key) => patch[key] === undefined)) return [];

  const checks: Array<
    (typeof LISTED_MODEL_SECTIONS)[number] & { model: string; url: string; apiKey: string | null }
  > = [];
  for (const section of LISTED_MODEL_SECTIONS) {
    if (patch[section.modelKey] !== undefined) continue;
    const model = before?.[section.modelKey] ?? null;
    if (!model) continue;
    // The chat section's base URL *is* the LLM one, so its fallback is a no-op.
    const urlBefore = before?.[section.baseUrlKey] ?? before?.llmBaseUrl ?? null;
    const ownAfter = effective(before, patch, section.baseUrlKey);
    const urlAfter = ownAfter ?? effective(before, patch, "llmBaseUrl");
    if (!urlAfter || urlAfter === urlBefore) continue;
    // The key follows the host, exactly as the runtime resolves it.
    const apiKey = ownAfter
      ? effective(before, patch, section.apiKeyKey)
      : effective(before, patch, "llmApiKey");
    checks.push({ ...section, model, url: urlAfter, apiKey });
  }
  if (checks.length === 0) return [];

  // One listing per distinct endpoint, shared by every section now pointing at it.
  const byEndpoint = new Map<string, typeof checks>();
  for (const check of checks) {
    const key = `${check.url} ${check.apiKey ?? ""}`;
    byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), check]);
  }

  const cleared: string[] = [];
  for (const group of byEndpoint.values()) {
    const { url, apiKey } = group[0];
    let served: string[];
    try {
      served = await listModels({ baseUrl: url, apiKey }, STALE_MODEL_CHECK_TIMEOUT_MS);
    } catch (err) {
      await trace.event({
        type: "step",
        level: "warn",
        message: `Could not list models on ${url} — stored model selections left unchanged`,
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
        message: `Cleared ${check.label} model — "${check.model}" is not served by ${url}`,
        data: { model: check.model, endpoint: url },
      });
    }
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
      if (input.ownerUserId !== undefined) {
        Object.assign(patch, await ownerPatch(db, input.ownerUserId));
      }
      const cleared = await clearStaleModelSelections(await getSettingsRecord(db), patch, trace);
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
 * Probe an OpenAI-compatible endpoint and return its model ids. Uses the given
 * key, or falls back to the stored key when `apiKey` is omitted (so the URL can
 * be re-tested without resending the secret). Recorded as a trace.
 */
export async function testConnection(
  input: TestConnection,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<{ models: string[] }> {
  return withTrace(
    { feature: FEATURE.id, action: "test-connection", trigger, inputSummary: input.llmBaseUrl },
    async (trace) => {
      const apiKey =
        input.apiKey !== undefined ? input.apiKey : (await getSettingsRecord(db))?.llmApiKey ?? null;
      await trace.event({ type: "external_call", message: `GET ${input.llmBaseUrl} /models` });
      const models = await listModels({ baseUrl: input.llmBaseUrl, apiKey });
      await trace.event({ type: "output", message: `${models.length} models returned` });
      await trace.succeed({ outputSummary: `${models.length} models` });
      return { models };
    },
  );
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
 * saved configuration without re-sending the secret.
 */
export async function testEmbeddings(
  input: TestEmbeddings,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<EmbeddingProbe> {
  const record = await getSettingsRecord(db);
  // Merge the submitted (possibly unsaved) values over the stored record, then
  // resolve exactly as the runtime does — so a passing test means the *runtime*
  // connection works, not some test-only variant of it.
  const runtime = toEmbeddingRuntime({
    ...(record ?? EMPTY_RECORD),
    embeddingBaseUrl:
      input.embeddingBaseUrl !== undefined
        ? input.embeddingBaseUrl
        : (record?.embeddingBaseUrl ?? null),
    embeddingApiKey:
      input.embeddingApiKey !== undefined
        ? input.embeddingApiKey || null
        : (record?.embeddingApiKey ?? null),
    embeddingModel:
      input.embeddingModel !== undefined
        ? input.embeddingModel
        : (record?.embeddingModel ?? null),
  });

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-embeddings",
      trigger,
      inputSummary: input.embeddingModel ?? record?.embeddingModel ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose an embedding model (and a base URL, unless the LLM connection serves embeddings).",
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
  input: TestImages,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ImageProbe> {
  const record = await getSettingsRecord(db);
  const runtime = toImageRuntime({
    ...(record ?? EMPTY_RECORD),
    imageBaseUrl:
      input.imageBaseUrl !== undefined ? input.imageBaseUrl : (record?.imageBaseUrl ?? null),
    imageApiKey:
      input.imageApiKey !== undefined
        ? input.imageApiKey || null
        : (record?.imageApiKey ?? null),
    imageModel: input.imageModel !== undefined ? input.imageModel : (record?.imageModel ?? null),
  });

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-images",
      trigger,
      inputSummary: input.imageModel ?? record?.imageModel ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose an image model (and a base URL, unless the LLM connection serves images).",
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
  input: TestSpeech,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<SpeechProbe> {
  const record = await getSettingsRecord(db);
  const runtime = toSpeechRuntime({
    ...(record ?? EMPTY_RECORD),
    speechBaseUrl:
      input.speechBaseUrl !== undefined ? input.speechBaseUrl : (record?.speechBaseUrl ?? null),
    speechApiKey:
      input.speechApiKey !== undefined
        ? input.speechApiKey || null
        : (record?.speechApiKey ?? null),
    speechModel:
      input.speechModel !== undefined ? input.speechModel : (record?.speechModel ?? null),
  });

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-speech",
      trigger,
      inputSummary: input.speechModel ?? record?.speechModel ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose a speech model (and a base URL, unless the LLM connection serves speech).",
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
 * Probe the transcription configuration by actually transcribing a fraction of a
 * second of generated silence — a **real** probe, like embeddings: whisper-class
 * servers often have no `/v1/models`, so only a genuine `/v1/audio/transcriptions`
 * call proves the endpoint, key, and model work. Recorded as a trace; submitted
 * values are merged over the stored record and resolved through the runtime
 * resolver, so a passing test means the voice path's connection works.
 */
export async function testTranscription(
  input: TestTranscription,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<TranscriptionProbe> {
  const record = await getSettingsRecord(db);
  const runtime = toTranscriptionRuntime({
    ...(record ?? EMPTY_RECORD),
    transcriptionBaseUrl:
      input.transcriptionBaseUrl !== undefined
        ? input.transcriptionBaseUrl
        : (record?.transcriptionBaseUrl ?? null),
    transcriptionApiKey:
      input.transcriptionApiKey !== undefined
        ? input.transcriptionApiKey || null
        : (record?.transcriptionApiKey ?? null),
    transcriptionModel:
      input.transcriptionModel !== undefined
        ? input.transcriptionModel
        : (record?.transcriptionModel ?? null),
  });

  return withTrace(
    {
      feature: FEATURE.id,
      action: "test-transcription",
      trigger,
      inputSummary: input.transcriptionModel ?? record?.transcriptionModel ?? "(no model)",
    },
    async (trace) => {
      if (!runtime) {
        throw ApiError.badRequest(
          "Choose a transcription model (and a base URL, unless the LLM connection serves transcription).",
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
  llmBaseUrl: null,
  llmApiKey: null,
  llmBackend: DEFAULT_LLM_BACKEND,
  model: null,
  activePersonalityId: null,
  telegramBotToken: null,
  tavilyApiKey: null,
  embeddingBaseUrl: null,
  embeddingApiKey: null,
  embeddingBackend: DEFAULT_LLM_BACKEND,
  embeddingModel: null,
  imageBaseUrl: null,
  imageApiKey: null,
  imageBackend: DEFAULT_LLM_BACKEND,
  imageModel: null,
  speechBaseUrl: null,
  speechApiKey: null,
  speechBackend: DEFAULT_LLM_BACKEND,
  speechModel: null,
  speechVoice: null,
  transcriptionBaseUrl: null,
  transcriptionApiKey: null,
  transcriptionBackend: DEFAULT_LLM_BACKEND,
  transcriptionModel: null,
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
