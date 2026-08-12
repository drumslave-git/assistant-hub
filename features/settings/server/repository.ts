import "server-only";

import { eq } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { settings, type SettingsRow } from "@/db/schema";

/**
 * Typed persistence for the single settings row. Pure data access: no policy, no
 * validation, no masking (the service decides what to expose). Every function
 * takes a {@link DrizzleDb} so it runs against the pool or a test instance.
 *
 * LLM configuration is per **role** — chat, embedding, audio (STT), vision,
 * speech (TTS), image generation, browser agent. Each role stores a backend id
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
  /** Browser-agent backend id; null → the chat backend. */
  browserBackendId: string | null;
  /** Browser-agent model id; null → the chat model drives browsing. */
  browserModel: string | null;
  activePersonalityId: string | null;
  telegramBotToken: string | null;
  tavilyApiKey: string | null;
  ownerUsername: string | null;
  ownerUserId: string | null;
  maintenanceModeEnabled: boolean;
  /** Operator IANA timezone for wall-clock features (scheduled tasks). */
  timezone: string;
  /** Local `HH:MM` (in `timezone`) every daily background job runs at. */
  dailyJobsRunTime: string;
  /** Hard ceiling (GB) on any single browser-agent download, for every tool. */
  browserDownloadLimitGb: number;
  /** Operator password (scrypt, self-describing). Secret — never in any view. */
  operatorPasswordHash: string | null;
  /** Session-cookie HMAC key. Secret — never in any view. */
  sessionSecret: string | null;
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
  browserBackendId?: string | null;
  browserModel?: string | null;
  activePersonalityId?: string | null;
  telegramBotToken?: string | null;
  tavilyApiKey?: string | null;
  ownerUsername?: string | null;
  ownerUserId?: string | null;
  maintenanceModeEnabled?: boolean;
  timezone?: string;
  dailyJobsRunTime?: string;
  browserDownloadLimitGb?: number;
  operatorPasswordHash?: string | null;
  sessionSecret?: string | null;
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

const cache = new WeakMap<DrizzleDb, CacheEntry>();

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
    browserBackendId: row.browserBackendId,
    browserModel: row.browserModel,
    activePersonalityId: row.activePersonalityId,
    telegramBotToken: row.telegramBotToken,
    tavilyApiKey: row.tavilyApiKey,
    ownerUsername: row.ownerUsername,
    ownerUserId: row.ownerUserId,
    maintenanceModeEnabled: row.maintenanceModeEnabled,
    timezone: row.timezone,
    dailyJobsRunTime: row.dailyJobsRunTime,
    browserDownloadLimitGb: row.browserDownloadLimitGb,
    operatorPasswordHash: row.operatorPasswordHash,
    sessionSecret: row.sessionSecret,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The settings record, or null when it has never been written. */
export async function getSettingsRecord(db: DrizzleDb): Promise<SettingsRecord | null> {
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
  db: DrizzleDb,
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
