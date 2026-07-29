import "server-only";

import { eq } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { settings, type SettingsRow } from "@/db/schema";

/**
 * Typed persistence for the single settings row. Pure data access: no policy, no
 * validation, no masking (the service decides what to expose). Every function
 * takes a {@link DrizzleDb} so it runs against the pool or a test instance.
 *
 * The record includes the raw API key — callers must never return it to clients.
 */

/** Fixed primary key of the one settings row (enforced by a DB check constraint). */
export const SETTINGS_ID = "singleton";

/** Internal settings record, including the secret API key and bot token. */
export interface SettingsRecord {
  llmBaseUrl: string | null;
  llmApiKey: string | null;
  model: string | null;
  activePersonalityId: string | null;
  telegramBotToken: string | null;
  tavilyApiKey: string | null;
  /** Embedding endpoint base URL; null means "reuse the LLM connection". */
  embeddingBaseUrl: string | null;
  /** Embedding endpoint API key (only used with `embeddingBaseUrl`). */
  embeddingApiKey: string | null;
  /** Embedding model id; null disables embedding-backed capabilities. */
  embeddingModel: string | null;
  /** Image endpoint base URL; null means "reuse the LLM connection". */
  imageBaseUrl: string | null;
  /** Image endpoint API key (only used with `imageBaseUrl`). */
  imageApiKey: string | null;
  /** Image model id; null disables image generation. */
  imageModel: string | null;
  /** Speech endpoint base URL; null means "reuse the LLM connection". */
  speechBaseUrl: string | null;
  /** Speech endpoint API key (only used with `speechBaseUrl`). */
  speechApiKey: string | null;
  /** Speech (TTS) model id; null disables voice replies. */
  speechModel: string | null;
  /** Voice name for the speech endpoint; null → endpoint default. */
  speechVoice: string | null;
  /** Transcription endpoint base URL; null means "reuse the LLM connection". */
  transcriptionBaseUrl: string | null;
  /** Transcription endpoint API key (only used with `transcriptionBaseUrl`). */
  transcriptionApiKey: string | null;
  /** Transcription (STT) model id; null → voice falls back to the chat model. */
  transcriptionModel: string | null;
  ownerUsername: string | null;
  ownerUserId: string | null;
  maintenanceModeEnabled: boolean;
  /** Operator IANA timezone for wall-clock features (scheduled tasks). */
  timezone: string;
  /** Local `HH:MM` (in `timezone`) every daily background job runs at. */
  dailyJobsRunTime: string;
  /** Largest browser-agent download (MB) also attached to the chat. */
  browserDownloadMaxMb: number;
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
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;
  model?: string | null;
  activePersonalityId?: string | null;
  telegramBotToken?: string | null;
  tavilyApiKey?: string | null;
  embeddingBaseUrl?: string | null;
  embeddingApiKey?: string | null;
  embeddingModel?: string | null;
  imageBaseUrl?: string | null;
  imageApiKey?: string | null;
  imageModel?: string | null;
  speechBaseUrl?: string | null;
  speechApiKey?: string | null;
  speechModel?: string | null;
  speechVoice?: string | null;
  transcriptionBaseUrl?: string | null;
  transcriptionApiKey?: string | null;
  transcriptionModel?: string | null;
  ownerUsername?: string | null;
  ownerUserId?: string | null;
  maintenanceModeEnabled?: boolean;
  timezone?: string;
  dailyJobsRunTime?: string;
  browserDownloadMaxMb?: number;
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
    llmBaseUrl: row.llmBaseUrl,
    llmApiKey: row.llmApiKey,
    model: row.model,
    activePersonalityId: row.activePersonalityId,
    telegramBotToken: row.telegramBotToken,
    tavilyApiKey: row.tavilyApiKey,
    embeddingBaseUrl: row.embeddingBaseUrl,
    embeddingApiKey: row.embeddingApiKey,
    embeddingModel: row.embeddingModel,
    imageBaseUrl: row.imageBaseUrl,
    imageApiKey: row.imageApiKey,
    imageModel: row.imageModel,
    speechBaseUrl: row.speechBaseUrl,
    speechApiKey: row.speechApiKey,
    speechModel: row.speechModel,
    speechVoice: row.speechVoice,
    transcriptionBaseUrl: row.transcriptionBaseUrl,
    transcriptionApiKey: row.transcriptionApiKey,
    transcriptionModel: row.transcriptionModel,
    ownerUsername: row.ownerUsername,
    ownerUserId: row.ownerUserId,
    maintenanceModeEnabled: row.maintenanceModeEnabled,
    timezone: row.timezone,
    dailyJobsRunTime: row.dailyJobsRunTime,
    browserDownloadMaxMb: row.browserDownloadMaxMb,
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
