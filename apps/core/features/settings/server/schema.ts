import { z } from "zod";

/**
 * Settings validation contract — the single source of truth for the shape and
 * bounds of the DB-backed configuration. Shared by the service, the Route
 * Handlers, and the dashboard form.
 *
 * LLM configuration is per **role** (chat, embedding, audio, vision, speech,
 * image generation, browser agent, classifiers, background jobs): each role
 * picks a backend from the catalog (`features/backends`) by id — null meaning
 * "use the chat backend" —
 * and a model. Endpoint URLs and API keys live on the backend rows.
 *
 * The bot token and integration keys are secrets: accepted on input but never
 * returned. The client-facing {@link settingsSchema} exposes only
 * `…Configured` booleans for them.
 */

const model = z.string().trim().min(1).max(200);
const apiKey = z.string().trim().max(500);
const botToken = z.string().trim().max(200);

/**
 * How the audio role transcribes: the OpenAI-style `/v1/audio/transcriptions`
 * endpoint (whisper-class servers), or a chat completion carrying the audio as
 * an `input_audio` part (providers like OpenRouter that only take audio through
 * chat on audio-capable models).
 */
export const transcriptionModeSchema = z.enum(["transcriptions", "chat"]);

/** A backend id from the catalog; null = "use the chat backend". */
const backendId = z.string().trim().min(1).max(100);

/** Owner is chosen from known users; the id is Telegram's numeric user id. */
const ownerUserId = z.string().trim().regex(/^\d+$/, "Invalid user id");

/** Local wall-clock time as `HH:MM` (24-hour). */
const timeOfDay = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM (24-hour)");

/** Settings as returned to clients — no secret values. */
export const settingsSchema = z.object({
  /** Chat (main) backend id, or null when the bot is unconfigured. */
  chatBackendId: backendId.nullable(),
  /** Selected chat model id, or null when none picked. */
  model: model.nullable(),
  /** Embedding backend id, or null to use the chat backend. */
  embeddingBackendId: backendId.nullable(),
  /** Selected embedding model id, or null when none picked (semantic recall off). */
  embeddingModel: model.nullable(),
  /** Image backend id, or null to use the chat backend. */
  imageBackendId: backendId.nullable(),
  /** Selected image model id, or null when none picked (image generation off). */
  imageModel: model.nullable(),
  /** Speech backend id, or null to use the chat backend. */
  speechBackendId: backendId.nullable(),
  /** Selected speech (TTS) model id, or null when none picked (voice replies off). */
  speechModel: model.nullable(),
  /** Voice name for the speech endpoint, or null for the endpoint default. */
  speechVoice: z.string().nullable(),
  /** Audio (STT) backend id, or null to use the chat backend. */
  audioBackendId: backendId.nullable(),
  /** Selected audio (STT) model id, or null → voice falls back to the chat model. */
  audioModel: model.nullable(),
  /** How the audio role transcribes (meaningful while an audio model is set). */
  audioTranscriptionMode: transcriptionModeSchema,
  /** Vision backend id, or null to use the chat backend. */
  visionBackendId: backendId.nullable(),
  /** Selected vision model id, or null → the chat model describes media. */
  visionModel: model.nullable(),
  /** Classifier backend id, or null to use the chat backend. */
  classifierBackendId: backendId.nullable(),
  /** Selected classifier model id, or null → the per-message checks run on the chat model. */
  classifierModel: model.nullable(),
  /** Background-jobs backend id, or null to use the chat backend. */
  backgroundBackendId: backendId.nullable(),
  /** Selected background-jobs model id, or null → the offline jobs run on the chat model. */
  backgroundModel: model.nullable(),
  /** Browser-agent backend id, or null to use the chat backend. */
  browserBackendId: backendId.nullable(),
  /** Selected browser-agent model id, or null → browsing runs on the chat model. */
  browserModel: model.nullable(),
  /** Whether a Telegram bot token is stored (the value itself is never exposed). */
  telegramBotTokenConfigured: z.boolean(),
  /** Whether a Tavily API key is stored, enabling the browsing agent's search fallback (value never exposed). */
  webSearchConfigured: z.boolean(),
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
  /** Hard ceiling (GB) on any single browser-agent download, for every tool. */
  browserDownloadLimitGb: z.number().int(),
  /** Last write time, or null if never configured. */
  updatedAt: z.string().datetime().nullable(),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * Partial update input. Any subset may be provided; at least one field is
 * required. Backend ids are validated against the catalog by the service.
 * Secrets are write-only: a non-empty string sets one, an empty string or null
 * clears it, and omitting it leaves the stored value untouched.
 */
export const updateSettingsSchema = z
  .object({
    chatBackendId: backendId.nullable(),
    model: model.nullable(),
    embeddingBackendId: backendId.nullable(),
    embeddingModel: model.nullable(),
    imageBackendId: backendId.nullable(),
    imageModel: model.nullable(),
    speechBackendId: backendId.nullable(),
    speechModel: model.nullable(),
    speechVoice: z.string().trim().max(100).nullable(),
    audioBackendId: backendId.nullable(),
    audioModel: model.nullable(),
    audioTranscriptionMode: transcriptionModeSchema,
    visionBackendId: backendId.nullable(),
    visionModel: model.nullable(),
    classifierBackendId: backendId.nullable(),
    classifierModel: model.nullable(),
    backgroundBackendId: backendId.nullable(),
    backgroundModel: model.nullable(),
    browserBackendId: backendId.nullable(),
    browserModel: model.nullable(),
    telegramBotToken: botToken.nullable(),
    tavilyApiKey: apiKey.nullable(),
    ownerUserId: ownerUserId.nullable(),
    maintenanceModeEnabled: z.boolean(),
    timezone: z.string().trim().min(1).max(64),
    dailyJobsRunTime: timeOfDay,
    /** Bounded 1–100 GB: a disk guard, not a quality choice. */
    browserDownloadLimitGb: z.number().int().min(1).max(100),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one setting to update",
  });

export type UpdateSettings = z.infer<typeof updateSettingsSchema>;

/**
 * Input for one role's connection probe (embeddings, images, speech, audio).
 * Every field is optional: omitted ones fall back to what is stored, so the
 * operator can test the saved configuration without re-entering it. A null
 * `backendId` means "use the chat backend", exactly as at runtime.
 */
export const testRoleConnectionSchema = z.object({
  backendId: backendId.nullable().optional(),
  model: model.nullable().optional(),
});

export type TestRoleConnection = z.infer<typeof testRoleConnectionSchema>;

/**
 * The audio probe additionally takes the transcription mode, so "Test audio"
 * exercises the same call style the voice path will use with the form's
 * current (possibly unsaved) mode choice.
 */
export const testAudioConnectionSchema = testRoleConnectionSchema.extend({
  transcriptionMode: transcriptionModeSchema.optional(),
});

export type TestAudioConnection = z.infer<typeof testAudioConnectionSchema>;

/**
 * One labelled piece of what a probe sent or got back, in the few shapes the
 * dashboard knows how to render. Roles differ in what they exchange — a phrase
 * and a vector, a prompt and an image, silence and a transcript — but not in
 * how that is reported, so every probe speaks in these parts and one component
 * renders all of them.
 */
export const probePartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), label: z.string(), text: z.string() }),
  /** A `data:` URL — the actual bytes, so the operator sees the real artifact. */
  z.object({ kind: z.literal("image"), label: z.string(), dataUrl: z.string() }),
  z.object({ kind: z.literal("audio"), label: z.string(), dataUrl: z.string() }),
  z.object({
    kind: z.literal("vector"),
    label: z.string(),
    dimensions: z.number().int(),
    /** The leading components, enough to see it is a real embedding. */
    preview: z.array(z.number()),
  }),
]);

export type ProbePart = z.infer<typeof probePartSchema>;

/**
 * What a role probe actually exercised: the model it ran on, what went in, and
 * what came out. Every "Test …" button reports this, so a passing test is
 * legible as the real exchange rather than a green tick.
 */
export const probeReportSchema = z.object({
  model: z.string(),
  input: z.array(probePartSchema),
  output: z.array(probePartSchema),
  latencyMs: z.number().int(),
});

export type ProbeReport = z.infer<typeof probeReportSchema>;
