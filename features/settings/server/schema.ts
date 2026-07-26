import { z } from "zod";

/**
 * Settings validation contract — the single source of truth for the shape and
 * bounds of the DB-backed configuration. Shared by the service, the Route
 * Handlers, and the dashboard form.
 *
 * The LLM API key is a secret: it is accepted on input but never returned. The
 * client-facing {@link settingsSchema} exposes only `apiKeyConfigured`.
 */

const baseUrl = z.string().trim().url().max(500);
const model = z.string().trim().min(1).max(200);
const apiKey = z.string().trim().max(500);
const botToken = z.string().trim().max(200);

/** Owner is chosen from known users; the id is Telegram's numeric user id. */
const ownerUserId = z.string().trim().regex(/^\d+$/, "Invalid user id");

/** Local wall-clock time as `HH:MM` (24-hour). */
const timeOfDay = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM (24-hour)");

/** Settings as returned to clients — no secret values. */
export const settingsSchema = z.object({
  /** OpenAI-compatible endpoint base URL, or null when unconfigured. */
  llmBaseUrl: baseUrl.nullable(),
  /** Selected chat model id, or null when none picked. */
  model: model.nullable(),
  /** Whether an API key is stored (the value itself is never exposed). */
  apiKeyConfigured: z.boolean(),
  /** Whether a Telegram bot token is stored (the value itself is never exposed). */
  telegramBotTokenConfigured: z.boolean(),
  /** Whether a Tavily API key is stored, enabling the browsing agent's search fallback (value never exposed). */
  webSearchConfigured: z.boolean(),
  /** Embedding endpoint base URL, or null to reuse the LLM connection. */
  embeddingBaseUrl: baseUrl.nullable(),
  /** Selected embedding model id, or null when none picked (semantic recall off). */
  embeddingModel: model.nullable(),
  /** Whether an embedding API key is stored (the value itself is never exposed). */
  embeddingApiKeyConfigured: z.boolean(),
  /** Image endpoint base URL, or null to reuse the LLM connection. */
  imageBaseUrl: baseUrl.nullable(),
  /** Selected image model id, or null when none picked (image generation off). */
  imageModel: model.nullable(),
  /** Whether an image API key is stored (the value itself is never exposed). */
  imageApiKeyConfigured: z.boolean(),
  /** Speech endpoint base URL, or null to reuse the LLM connection. */
  speechBaseUrl: baseUrl.nullable(),
  /** Selected speech (TTS) model id, or null when none picked (voice replies off). */
  speechModel: model.nullable(),
  /** Voice name for the speech endpoint, or null for the endpoint default. */
  speechVoice: z.string().nullable(),
  /** Whether a speech API key is stored (the value itself is never exposed). */
  speechApiKeyConfigured: z.boolean(),
  /** Transcription endpoint base URL, or null to reuse the LLM connection. */
  transcriptionBaseUrl: baseUrl.nullable(),
  /** Selected transcription model id, or null → voice falls back to the chat model. */
  transcriptionModel: model.nullable(),
  /** Whether a transcription API key is stored (the value itself is never exposed). */
  transcriptionApiKeyConfigured: z.boolean(),
  /** Owner's numeric user id (chosen from known users), or null when unset. */
  ownerUserId: z.string().nullable(),
  /** Owner's @username, denormalized from the chosen known user (display only). */
  ownerUsername: z.string().nullable(),
  /** Whether maintenance mode is on. */
  maintenanceModeEnabled: z.boolean(),
  /** Operator IANA timezone for wall-clock features (scheduled tasks). */
  timezone: z.string(),
  /** Local `HH:MM` (in `timezone`) every daily background job runs at. */
  dailyJobsRunTime: z.string(),
  /** Largest browser-agent download (MB) also attached to the chat. */
  browserDownloadMaxMb: z.number().int(),
  /** Last write time, or null if never configured. */
  updatedAt: z.string().datetime().nullable(),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * Partial update input. Any subset may be provided; at least one field is
 * required. `apiKey` is write-only: a non-empty string sets it, an empty string
 * or null clears it, and omitting it leaves the stored key untouched.
 */
export const updateSettingsSchema = z
  .object({
    llmBaseUrl: baseUrl.nullable(),
    model: model.nullable(),
    apiKey: apiKey.nullable(),
    telegramBotToken: botToken.nullable(),
    tavilyApiKey: apiKey.nullable(),
    embeddingBaseUrl: baseUrl.nullable(),
    embeddingApiKey: apiKey.nullable(),
    embeddingModel: model.nullable(),
    imageBaseUrl: baseUrl.nullable(),
    imageApiKey: apiKey.nullable(),
    imageModel: model.nullable(),
    speechBaseUrl: baseUrl.nullable(),
    speechApiKey: apiKey.nullable(),
    speechModel: model.nullable(),
    speechVoice: z.string().trim().max(100).nullable(),
    transcriptionBaseUrl: baseUrl.nullable(),
    transcriptionApiKey: apiKey.nullable(),
    transcriptionModel: model.nullable(),
    ownerUserId: ownerUserId.nullable(),
    maintenanceModeEnabled: z.boolean(),
    timezone: z.string().trim().min(1).max(64),
    dailyJobsRunTime: timeOfDay,
    /** Bounded 1–50: Telegram's bot upload ceiling. */
    browserDownloadMaxMb: z.number().int().min(1).max(50),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one setting to update",
  });

export type UpdateSettings = z.infer<typeof updateSettingsSchema>;

/**
 * Input for the connection test. `apiKey` is optional: omit it to test with the
 * currently-stored key (useful when the URL changes but the key stays).
 */
export const testConnectionSchema = z.object({
  llmBaseUrl: baseUrl,
  apiKey: apiKey.nullable().optional(),
});

export type TestConnection = z.infer<typeof testConnectionSchema>;

/**
 * Input for the embeddings probe. Every field is optional: omitted ones fall back
 * to what is stored, so the operator can test the saved configuration without
 * re-entering it (and without the secret ever leaving the server). A blank base
 * URL means "use the LLM connection", exactly as at runtime.
 */
export const testEmbeddingsSchema = z.object({
  embeddingBaseUrl: baseUrl.nullable().optional(),
  embeddingApiKey: apiKey.nullable().optional(),
  embeddingModel: model.nullable().optional(),
});

export type TestEmbeddings = z.infer<typeof testEmbeddingsSchema>;

/**
 * Input for the image probe. Optional-everywhere for the same reason as
 * {@link testEmbeddingsSchema}: omitted fields fall back to what is stored, so the
 * saved configuration can be tested without re-entering the secret. A blank base
 * URL means "use the LLM connection", exactly as at runtime.
 */
export const testImagesSchema = z.object({
  imageBaseUrl: baseUrl.nullable().optional(),
  imageApiKey: apiKey.nullable().optional(),
  imageModel: model.nullable().optional(),
});

export type TestImages = z.infer<typeof testImagesSchema>;

/**
 * Input for the speech probe. Optional-everywhere for the same reason as
 * {@link testEmbeddingsSchema}: omitted fields fall back to what is stored, so the
 * saved configuration can be tested without re-entering the secret. A blank base
 * URL means "use the LLM connection", exactly as at runtime.
 */
export const testSpeechSchema = z.object({
  speechBaseUrl: baseUrl.nullable().optional(),
  speechApiKey: apiKey.nullable().optional(),
  speechModel: model.nullable().optional(),
});

export type TestSpeech = z.infer<typeof testSpeechSchema>;

/**
 * Input for the transcription probe. Optional-everywhere for the same reason as
 * {@link testEmbeddingsSchema}: omitted fields fall back to what is stored, so the
 * saved configuration can be tested without re-entering the secret. A blank base
 * URL means "use the LLM connection", exactly as at runtime.
 */
export const testTranscriptionSchema = z.object({
  transcriptionBaseUrl: baseUrl.nullable().optional(),
  transcriptionApiKey: apiKey.nullable().optional(),
  transcriptionModel: model.nullable().optional(),
});

export type TestTranscription = z.infer<typeof testTranscriptionSchema>;
