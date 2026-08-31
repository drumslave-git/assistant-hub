import "server-only";

import { eq } from "drizzle-orm";

import { settings, type SettingsRow } from "../../../store/schema";
import type { StoreDb } from "@/server/store/db";

/**
 * Typed persistence for the single settings row. Pure data access: no policy, no
 * validation, no masking (the service decides what to expose). Every function
 * takes a {@link StoreDb} so it runs against the pool or a test instance.
 *
 * LLM configuration is per **role** — chat, embedding, audio (STT), vision,
 * speech (TTS), image generation, browser agent, classifiers, background jobs.
 * Each role stores a backend id
 * (referencing the `backends` catalog; null means "use the chat backend") and a
 * model id. Endpoint URLs and keys live on the backend rows, not here.
 */

/** Fixed primary key of the one settings row (enforced by a DB check constraint). */
export const SETTINGS_ID = "singleton";

/** Internal settings record, including the secret bot token and keys. */
export interface SettingsRecord {
  /** Chat (main) backend id; null means the bot is unconfigured. */
  chatBackendId: string | null;
  /** Selected chat model id; null when none picked. */
  model: string | null;
  /** Embedding backend id; null → the chat backend. */
  embeddingBackendId: string | null;
  /** Embedding model id; null disables embedding-backed capabilities. */
  embeddingModel: string | null;
  /** Image-generation backend id; null → the chat backend. */
  imageBackendId: string | null;
  /** Image model id; null disables image generation. */
  imageModel: string | null;
  /** Speech (TTS) backend id; null → the chat backend. */
  speechBackendId: string | null;
  /** Speech (TTS) model id; null disables voice replies. */
  speechModel: string | null;
  /** Voice name for the speech endpoint; null → endpoint default. */
  speechVoice: string | null;
  /** Audio (STT) backend id; null → the chat backend. */
  audioBackendId: string | null;
  /** Audio (STT) model id; null → voice falls back to the chat model. */
  audioModel: string | null;
  /** How the audio role transcribes: the transcriptions endpoint, or chat `input_audio`. */
  audioTranscriptionMode: "transcriptions" | "chat";
  /** Vision backend id; null → the chat backend. */
  visionBackendId: string | null;
  /** Vision model id; null → the chat model describes media. */
  visionModel: string | null;
  /** Classifier backend id; null → the chat backend. */
  classifierBackendId: string | null;
  /** Classifier model id; null → the chat model answers the per-message checks. */
  classifierModel: string | null;
  /** Background-jobs backend id; null → the chat backend. */
  backgroundBackendId: string | null;
  /** Background-jobs model id; null → the chat model runs the offline jobs. */
  backgroundModel: string | null;
  /** Browser-agent backend id; null → the chat backend. */
  browserBackendId: string | null;
  /** Browser-agent model id; null → the chat model drives browsing. */
  browserModel: string | null;
  tavilyApiKey: string | null;
  maintenanceModeEnabled: boolean;
  /** Bot-to-bot loop guard (consecutive assistant turns before silence). */
  assistantLoopGuardTurns: number;
  /** Operator IANA timezone for wall-clock features (scheduled tasks). */
  timezone: string;
  /** Local `HH:MM` (in `timezone`) every daily background job runs at. */
  dailyJobsRunTime: string;
  /** Hard ceiling (GB) on any single browser-agent download, for every tool. */
  browserDownloadLimitGb: number;
  updatedAt: string | null;
}

/** Columns a write may touch. Undefined = leave unchanged. */
export interface SettingsPatch {
  chatBackendId?: string | null;
  model?: string | null;
  embeddingBackendId?: string | null;
  embeddingModel?: string | null;
  imageBackendId?: string | null;
  imageModel?: string | null;
  speechBackendId?: string | null;
  speechModel?: string | null;
  speechVoice?: string | null;
  audioBackendId?: string | null;
  audioModel?: string | null;
  audioTranscriptionMode?: "transcriptions" | "chat";
  visionBackendId?: string | null;
  visionModel?: string | null;
  classifierBackendId?: string | null;
  classifierModel?: string | null;
  backgroundBackendId?: string | null;
  backgroundModel?: string | null;
  browserBackendId?: string | null;
  browserModel?: string | null;
  tavilyApiKey?: string | null;
  maintenanceModeEnabled?: boolean;
  assistantLoopGuardTurns?: number;
  timezone?: string;
  dailyJobsRunTime?: string;
  browserDownloadLimitGb?: number;
}

/**
 * Handling one message reads the settings row several times (policy, persona,
 * timezone, language, LLM runtime…), and every scheduler tick re-reads it. The
 * row changes only through {@link upsertSettings}, so a short-lived cache keeps
 * "read at call time so changes apply without restart" while collapsing those
 * reads to one query per window. Keyed per db handle so test databases never
 * share entries with the app pool. Disabled under Vitest: integration tests
 * truncate tables underneath the repository, which no invalidation here can see.
 */
const SETTINGS_CACHE_TTL_MS = process.env.VITEST ? 0 : 3_000;

interface CacheEntry {
  record: SettingsRecord | null;
  expiresAt: number;
}

const cache = new WeakMap<StoreDb, CacheEntry>();

function mapRow(row: SettingsRow): SettingsRecord {
  return {
    chatBackendId: row.chatBackendId,
    model: row.model,
    embeddingBackendId: row.embeddingBackendId,
    embeddingModel: row.embeddingModel,
    imageBackendId: row.imageBackendId,
    imageModel: row.imageModel,
    speechBackendId: row.speechBackendId,
    speechModel: row.speechModel,
    speechVoice: row.speechVoice,
    audioBackendId: row.audioBackendId,
    audioModel: row.audioModel,
    audioTranscriptionMode: row.audioTranscriptionMode,
    visionBackendId: row.visionBackendId,
    visionModel: row.visionModel,
    classifierBackendId: row.classifierBackendId,
    classifierModel: row.classifierModel,
    backgroundBackendId: row.backgroundBackendId,
    backgroundModel: row.backgroundModel,
    browserBackendId: row.browserBackendId,
    browserModel: row.browserModel,
    tavilyApiKey: row.tavilyApiKey,
    maintenanceModeEnabled: row.maintenanceModeEnabled,
    assistantLoopGuardTurns: row.assistantLoopGuardTurns,
    timezone: row.timezone,
    dailyJobsRunTime: row.dailyJobsRunTime,
    browserDownloadLimitGb: row.browserDownloadLimitGb,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The settings record, or null when it has never been written. */
export async function getSettingsRecord(db: StoreDb): Promise<SettingsRecord | null> {
  const cached = cache.get(db);
  if (cached && cached.expiresAt > Date.now()) return cached.record;
  const row = await db.query.settings.findFirst({ where: eq(settings.id, SETTINGS_ID) });
  const record = row ? mapRow(row) : null;
  cache.set(db, { record, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return record;
}

/**
 * Upsert a patch onto the single row, touching only the provided columns.
 * Returns the full, updated record.
 */
export async function upsertSettings(
  db: StoreDb,
  patch: SettingsPatch,
): Promise<SettingsRecord> {
  const changed = { ...patch, updatedAt: new Date() };
  const [row] = await db
    .insert(settings)
    .values({ id: SETTINGS_ID, ...changed })
    .onConflictDoUpdate({ target: settings.id, set: changed })
    .returning();
  const record = mapRow(row);
  cache.set(db, { record, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return record;
}
