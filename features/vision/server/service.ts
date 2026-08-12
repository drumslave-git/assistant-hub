import "server-only";

import type { Message } from "@grammyjs/types";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { FEATURES } from "@/lib/features";
import { llmUsageOf, sanitizeMessagesForTrace, type ChatCompletionResult, type ChatMessage } from "@/server/llm/client";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace, type TraceRecorder } from "@/server/trace";

import {
  getAudioRuntime,
  getLlmRuntime,
  getVisionRuntime,
} from "@/features/settings/server/service";
import { buildTranscribeMessages, parseTranscript } from "@/features/voice/format";
import { chatCompletion, type LlmPriority } from "@/server/llm/client";
import { transcribeAudio, type TranscriptionResult } from "@/server/llm/transcription";
import { toWavForTranscription } from "@/server/media/audio";

import { detectMessageMedia } from "../detect";
import { frameSequenceHint, renderMediaSuffix } from "../format";
import type { DetectedMedia, ImagePayload, MediaAnnotation, MediaKind, MediaView } from "../types";
import { buildDescribeMessages } from "./describe";
import { VIDEO_FRAME_COUNT, extractVideoFrames } from "./frames";
import { normalizeImageForChat } from "./normalize";
import {
  countPendingMedia,
  getMediaAnnotations,
  getMediaByMessage,
  getMediaById,
  insertMedia,
  insertUnavailableMedia,
  listRecentMedia,
  markDescribed,
  type MediaRecord,
} from "./repository";
import { downloadTelegramFile } from "./telegram-files";

/**
 * Vision domain service — the boundary the Telegram runtime and dashboard call.
 *
 * Two paths:
 *  - **Ingest** (passive, untraced, high-volume like history capture): every
 *    incoming media message is downloaded, normalized to a bounded JPEG, and
 *    stored (bytes in `media_blobs`) with `status = 'pending'`.
 *  - **Describe** (traced, a meaningful action): for the addressed turn the
 *    stored image is captioned immediately and the bytes are dropped
 *    (`markDescribed`), so past turns read as text in the transcript. The rest
 *    stay pending for the backfill job (priority 8).
 */

const FEATURE = FEATURES["vision"];

/** Load-and-normalize an image by Telegram file id. Best-effort — null on any failure. */
async function loadImage(token: string, fileId: string): Promise<ImagePayload | null> {
  try {
    const raw = await downloadTelegramFile(token, fileId);
    if (!raw) return null;
    return await normalizeImageForChat(raw.base64);
  } catch {
    return null;
  }
}

/**
 * The loadable image(s) for a detected media, plus the describe `hint` stored on
 * the row and the reply `note` shown to the model this turn. A still image is one
 * image; a video/GIF is the ordered sequence of frames sampled with ffmpeg (the
 * Telegram single-frame thumbnail is the fallback when extraction is
 * unavailable). Best-effort — resolves null when nothing can be read.
 */
interface LoadedMedia {
  images: ImagePayload[];
  /** Raw audio bytes for a voice message (stored as-is, transcribed later). */
  audio: { base64: string; mimeHint: string } | null;
  /** Stored on the row + fed to the describe pass (sticker emoji / frame-sequence note). */
  hint: string | null;
  /** Injected into the current reply turn so the model reads it in context (video/GIF only). */
  note: string | null;
}

/** Sample a video/GIF into an ordered sequence of normalized frames, or null on failure. */
async function loadVideoFrames(
  token: string,
  detected: DetectedMedia,
): Promise<LoadedMedia | null> {
  const raw = await downloadTelegramFile(token, detected.fileId);
  if (!raw) return null;
  const input = Buffer.from(raw.base64, "base64");
  const frames = await extractVideoFrames(input, {
    count: VIDEO_FRAME_COUNT,
    durationSec: detected.durationSec,
  });
  if (frames.length === 0) return null;
  // Normalize each frame to a bounded JPEG so it is sent full-resolution.
  const images = await Promise.all(
    frames.map((frame) => normalizeImageForChat(frame.toString("base64"))),
  );
  const kind = detected.kind === "animation" ? "animation" : "video";
  const hint = frameSequenceHint(kind, images.length);
  return { images, audio: null, hint, note: hint };
}

/** Resolve a detected media to loadable images/audio + hints. Best-effort — null on failure. */
async function loadDetectedMedia(
  token: string,
  detected: DetectedMedia,
): Promise<LoadedMedia | null> {
  // A voice message stores its bytes as-is (OGG/Opus) — no normalization; the
  // transcode to a model-readable format happens at transcription time.
  if (detected.isAudio) {
    const raw = await downloadTelegramFile(token, detected.fileId).catch(() => null);
    if (!raw) return null;
    return {
      images: [],
      audio: { base64: raw.base64, mimeHint: raw.mimeHint },
      hint: detected.visionHint,
      note: null,
    };
  }

  if (!detected.isVideo) {
    const image = await loadImage(token, detected.fileId);
    return image ? { images: [image], audio: null, hint: detected.visionHint, note: null } : null;
  }

  // Video/GIF: sample frames with ffmpeg; on any failure fall back to the
  // Telegram single-frame thumbnail so the media is still recognized.
  const sequence = await loadVideoFrames(token, detected).catch(() => null);
  if (sequence) return sequence;

  if (detected.thumbnailFileId) {
    const thumb = await loadImage(token, detected.thumbnailFileId);
    if (thumb) {
      const kind = detected.kind === "animation" ? "animation" : "video";
      const hint = frameSequenceHint(kind, 1);
      return { images: [thumb], audio: null, hint, note: hint };
    }
  }
  return null;
}

/**
 * Ingest media on an incoming message: download, normalize, and store a pending
 * row. Returns the normalized image(s) for immediate use in the reply pass plus
 * the stored row (or null when the message has no media). Best-effort: media
 * that cannot be loaded is recorded as `unavailable` and returns no images.
 * Passive and untraced — the stored row is the record.
 */
export async function ingestMessageMedia(
  params: { token: string; chatId: string; telegramMessageId: number; message: Message },
  db: DrizzleDb = getDb(),
): Promise<{
  images: ImagePayload[];
  kind: MediaKind;
  note: string | null;
  /**
   * The stored row for this message: the fresh insert, or — for a re-delivered
   * update — the row that already existed (possibly already described, so its
   * text can be reused instead of paying for a second pass). Null only when the
   * row could not be stored at all (e.g. the history mirror row is missing, so
   * the FK rejects the insert) — callers must then skip describe/transcribe
   * work for this turn.
   */
  media: MediaRecord | null;
} | null> {
  const detected = detectMessageMedia(params.message);
  if (!detected) return null;

  const loaded = await loadDetectedMedia(params.token, detected);
  if (!loaded) {
    await insertUnavailableMedia(db, {
      id: crypto.randomUUID(),
      chatId: params.chatId,
      telegramMessageId: params.telegramMessageId,
      kind: detected.kind,
      fileId: detected.fileId,
      fileUniqueId: detected.fileUniqueId,
      visionHint: detected.visionHint,
    }).catch(() => null);
    publishEvent(FEATURE.realtimeTopic);
    return null;
  }

  // A still image stores its single frame; a video/GIF stores the whole frame
  // sequence (its first frame doubles as the dashboard preview); a voice message
  // stores its raw audio (played back on the dashboard while pending).
  const isSequence = loaded.images.length > 1;
  const inserted = await insertMedia(db, {
    id: crypto.randomUUID(),
    chatId: params.chatId,
    telegramMessageId: params.telegramMessageId,
    kind: detected.kind,
    fileId: detected.fileId,
    fileUniqueId: detected.fileUniqueId,
    mimeType: loaded.audio ? loaded.audio.mimeHint : loaded.images[0].mimeHint,
    dataBase64: loaded.audio ? loaded.audio.base64 : loaded.images[0].base64,
    frames: isSequence ? loaded.images.map((image) => image.base64) : null,
    visionHint: loaded.hint,
  }).catch(() => null);
  // Conflict (re-delivered update) → the existing row is the truth, not a failure.
  const media =
    inserted ??
    (await getMediaByMessage(db, params.chatId, params.telegramMessageId).catch(() => null));
  publishEvent(FEATURE.realtimeTopic);

  return { images: loaded.images, kind: detected.kind, note: loaded.note, media };
}

/**
 * Provenance hint stored on a bot-generated image's media row.
 *
 * Deliberately states *that* the bot drew the image and **not** what it was asked
 * to draw. The prompt is available at the call site and it is tempting to pass it
 * along, but a describer told what the picture is supposed to contain writes a
 * paraphrase of the prompt instead of a recognition of the image — and diffusion
 * models routinely miss or mangle parts of a prompt. The whole reason the
 * generated image is stored as ordinary media is to learn what actually came out,
 * so the hint must not answer the question the describer is being asked.
 */
const GENERATED_IMAGE_HINT =
  "This image was generated by the bot itself, in response to a request in this chat.";

/**
 * Store an image the bot generated and just sent, as ordinary media — the same
 * `message_media` row, lifecycle, and describer that user-sent pictures get. It
 * lands `pending` and is recognized either by the backfill job or, like any
 * pending row, on demand; on describe its bytes are dropped and the description is
 * what remains in history. That is what lets a later turn know what the bot drew.
 *
 * Bytes are already in hand (the provider returned them), so unlike
 * {@link ingestMessageMedia} there is nothing to download — but they are still put
 * through the same normalization, so a stored generated image is byte-for-byte the
 * same kind of thing as a stored received one.
 *
 * Passive and untraced (the stored row is the record), and best-effort: a failure
 * to store must not undo an image the user can already see in their chat.
 */
export async function ingestGeneratedImage(
  params: {
    chatId: string;
    telegramMessageId: number;
    fileId: string;
    fileUniqueId?: string | null;
    base64: string;
  },
  db: DrizzleDb = getDb(),
): Promise<MediaRecord | null> {
  const normalized = await normalizeImageForChat(params.base64).catch(() => null);
  if (!normalized) return null;
  const record = await insertMedia(db, {
    id: crypto.randomUUID(),
    chatId: params.chatId,
    telegramMessageId: params.telegramMessageId,
    kind: "photo",
    fileId: params.fileId,
    fileUniqueId: params.fileUniqueId ?? null,
    mimeType: normalized.mimeHint,
    dataBase64: normalized.base64,
    visionHint: GENERATED_IMAGE_HINT,
  }).catch(() => null);
  publishEvent(FEATURE.realtimeTopic);
  return record;
}

/**
 * Images for a replied-to media message, so "what is this?" as a reply to an
 * earlier image resolves to it. Reuses the stored bytes when present, otherwise
 * re-downloads by file id. Returns null when the message has no media or it can't
 * be loaded.
 */
export async function loadReplyTargetImages(
  params: { token: string; chatId: string; message: Message },
  db: DrizzleDb = getDb(),
): Promise<{ images: ImagePayload[]; kind: MediaKind; note: string | null } | null> {
  const detected = detectMessageMedia(params.message);
  if (!detected) return null;

  const stored = await getMediaByMessage(db, params.chatId, params.message.message_id).catch(
    () => null,
  );

  // A replied-to voice message resolves to its transcript (the chat model reads
  // text, not audio, in the reply turn). Transcription is eager, so the stored
  // row almost always has one; without it there is nothing useful to attach.
  if (detected.isAudio) {
    if (stored?.description) {
      return {
        images: [],
        kind: detected.kind,
        note: `Transcript of that voice message: ${stored.description}`,
      };
    }
    return null;
  }

  // Reuse the stored image(s) — a photo, or a video's full frame sequence — when
  // present, so a reply to old media needs no re-download or re-extraction.
  const storedImages = storedMediaImages(stored);
  if (storedImages) {
    return { images: storedImages, kind: detected.kind, note: stored?.visionHint ?? null };
  }

  const loaded = await loadDetectedMedia(params.token, detected);
  return loaded ? { images: loaded.images, kind: detected.kind, note: loaded.note } : null;
}

/** The stored image sequence for a media row (frames for a video, else the single image). */
function storedMediaImages(media: MediaRecord | null): ImagePayload[] | null {
  if (!media) return null;
  // A voice row's bytes are audio — never an image sequence.
  if (media.kind === "voice") return null;
  if (media.frames && media.frames.length > 0) {
    return media.frames.map((base64) => ({ base64, mimeHint: "image/jpeg" }));
  }
  if (media.dataBase64) {
    return [{ base64: media.dataBase64, mimeHint: media.mimeType ?? "image/jpeg" }];
  }
  return null;
}

/** Collaborators for the describe pass; injected so it is unit-testable. */
export interface DescribeDeps {
  /** Run the describe completion; returns the text plus usage/model for tracing. */
  complete: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
  /**
   * Where `complete` sends the request (base URL + model id), recorded on the
   * trace's request event — the operator must be able to see which endpoint and
   * model a describe/transcribe actually hit, especially when it fails.
   */
  target?: { baseUrl: string; model: string };
  /**
   * Dedicated STT for voice rows (`/v1/audio/transcriptions`), present when the
   * operator configured an audio (STT) model in `transcriptions` mode. When
   * set, voice transcription uses it **instead of** any `input_audio` path
   * (user decision: support both, whisper preferred when configured).
   */
  transcribe?: (wav: Buffer) => Promise<TranscriptionResult>;
  /** Where `transcribe` sends the request, recorded like {@link target}. */
  transcribeTarget?: { baseUrl: string; model: string };
  /**
   * The `input_audio` transcription path's completion: the audio (STT) role's
   * own connection when one is configured in `chat` mode, else the **chat**
   * (main) connection — which may differ from `complete` when the operator gave
   * the vision role its own backend/model. Absent means `complete` serves both
   * (they resolved to the same connection).
   */
  completeAudio?: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
  /** Where `completeAudio` sends the request, recorded like {@link target}. */
  audioTarget?: { baseUrl: string; model: string };
}

/**
 * The real {@link DescribeDeps}, resolved from DB settings at call time: the
 * vision runtime for describes (the chat connection unless the vision role is
 * overridden), the chat runtime for the `input_audio` transcription fallback,
 * plus the dedicated audio (STT) endpoint when one is configured. Null when
 * nothing resolves. Shared by the live message path and the backfill
 * scheduler so the two can never resolve differently — only the dispatch
 * priority differs: a describe inside a live turn goes out interactive, the
 * backfill's passes wait for a quiet endpoint.
 */
export async function resolveDescribeDeps(
  priority: LlmPriority = "interactive",
): Promise<DescribeDeps | null> {
  const vision = await getVisionRuntime().catch(() => null);
  if (!vision) return null;
  const conn = { baseUrl: vision.baseUrl, apiKey: vision.apiKey, backend: vision.backend };
  const stt = await getAudioRuntime().catch(() => null);
  const chat = await getLlmRuntime().catch(() => null);
  const chatDiffers =
    chat && (chat.baseUrl !== vision.baseUrl || chat.model !== vision.model);
  return {
    complete: (messages) => chatCompletion(conn, { model: vision.model, messages, priority }),
    target: { baseUrl: vision.baseUrl, model: vision.model },
    ...(stt && stt.mode === "transcriptions"
      ? {
          transcribe: (wav: Buffer) => transcribeAudio(stt, wav),
          transcribeTarget: { baseUrl: stt.baseUrl, model: stt.model },
        }
      : {}),
    // A chat-mode audio role rides the `input_audio` branch — the same request
    // shape as the fallback, with usage recorded on the trace — but on its own
    // connection. Without one, the voice fallback belongs to the chat model
    // ("audio: main by default"), split out only when the vision role actually
    // points elsewhere.
    ...(stt && stt.mode === "chat"
      ? {
          completeAudio: (messages) =>
            chatCompletion(
              { baseUrl: stt.baseUrl, apiKey: stt.apiKey, backend: stt.backend },
              { model: stt.model, messages, priority },
            ),
          audioTarget: { baseUrl: stt.baseUrl, model: stt.model },
        }
      : chatDiffers
        ? {
            completeAudio: (messages) =>
              chatCompletion(
                { baseUrl: chat.baseUrl, apiKey: chat.apiKey, backend: chat.backend },
                { model: chat.model, messages, priority },
              ),
            audioTarget: { baseUrl: chat.baseUrl, model: chat.model },
          }
        : {}),
  };
}

/** How a describe/transcribe pass records itself and where it reads/writes. */
export interface DescribeAndStoreOptions {
  db?: DrizzleDb;
  /**
   * Record into this (open) trace instead of opening a dedicated one — the live
   * reply path passes its reply trace so the whole turn reads as one flow. The
   * parent is never settled here: a failure becomes a warn event and a null
   * return, and the caller decides how the turn proceeds. Without it (backfill),
   * the pass opens and settles its own `vision/describe` / `voice/transcribe`
   * trace as before.
   */
  trace?: TraceRecorder;
}

/**
 * Describe a message's stored media and drop its bytes. Dispatches by kind: an
 * image/video is captioned by the vision model; a voice message is transcribed
 * (dedicated STT endpoint when configured, else the audio-capable chat model)
 * with the transcript stored as its description. A row that is already
 * described resolves to its stored text without spending a call. A no-op
 * (skipped) when the message has no pending media. Best-effort: on failure the
 * row stays `pending` for the backfill job to retry.
 *
 * The returned record always carries the description that was produced or
 * found — never a stale null because a concurrent pass won the DB write.
 */
export async function describeAndStore(
  params: { chatId: string; telegramMessageId: number },
  deps: DescribeDeps,
  options: DescribeAndStoreOptions = {},
): Promise<MediaRecord | null> {
  const db = options.db ?? getDb();
  const media = await getMediaByMessage(db, params.chatId, params.telegramMessageId).catch(
    () => null,
  );
  const isVoice = media?.kind === "voice";
  const feature = isVoice ? FEATURES["voice"] : FEATURE;
  const relatedKey = feature.relatedIdsKey ?? FEATURE.relatedIdsKey;
  // Own trace only when no parent was given (backfill / standalone passes).
  const ownTrace = options.trace
    ? null
    : await startTrace(
        {
          feature: feature.id,
          action: isVoice ? "transcribe" : "describe",
          trigger: {
            kind: "telegram",
            actor: params.chatId,
            correlationId: `${params.chatId}:${params.telegramMessageId}`,
          },
          inputSummary: `media on message ${params.telegramMessageId}`,
        }
      );
  const trace = options.trace ?? ownTrace!;

  /** Nothing to do: settle an owned trace as skipped, or leave a step in the parent. */
  const skip = async (reason: string): Promise<null> => {
    if (ownTrace) await ownTrace.skip(reason);
    else await trace.event({ type: "step", message: reason });
    return null;
  };

  try {
    if (!media) return await skip("no media stored for this message");

    // A re-delivered update (or a pass that lost an earlier race) finds the row
    // already described: its stored text is the answer — reuse it, spend nothing.
    if (media.status === "described" && media.description) {
      await trace.event({
        type: "db",
        message: isVoice
          ? "voice message already transcribed — reusing stored transcript"
          : "media already described — reusing stored description",
        data: { mediaId: media.id, chars: media.description.length },
      });
      if (ownTrace) {
        await ownTrace.succeed({
          outputSummary: media.description,
          relatedIds: { [relatedKey]: [media.id] },
        });
      }
      return media;
    }

    if (isVoice) {
      const audioBase64 = media.status === "pending" ? media.dataBase64 : null;
      if (!audioBase64) return await skip("no pending voice message to transcribe");

      // OGG/Opus → 16 kHz mono WAV: what both transcription paths consume. A
      // transcode failure leaves the row pending.
      const wav = await toWavForTranscription(Buffer.from(audioBase64, "base64"));

      let rawText: string;
      if (deps.transcribe) {
        // Dedicated STT endpoint (whisper-class), preferred when configured.
        await trace.event({
          type: "external_call",
          message: "transcription request",
          data: {
            ...(deps.transcribeTarget
              ? { endpoint: deps.transcribeTarget.baseUrl, model: deps.transcribeTarget.model }
              : {}),
            wavBytes: wav.length,
          },
        });
        const result = await deps.transcribe(wav);
        await trace.event({
          type: "output",
          message: "transcription response",
          // The provider's raw response body, verbatim (full-raw-bodies rule).
          data: result.responseBody ?? { text: result.text },
        });
        rawText = result.text;
      } else {
        // Fallback: the audio-capable chat model via an `input_audio` part.
        // `completeAudio` (the chat connection) when the vision role points
        // elsewhere; otherwise `complete` already is the chat connection.
        const completeAudio = deps.completeAudio ?? deps.complete;
        const audioTarget = deps.audioTarget ?? deps.target;
        const messages = buildTranscribeMessages(wav.toString("base64"), "wav");
        // The whole request as sent — endpoint, model, and the full
        // (byte-redacted) body — so a failing transcription names what was
        // actually called.
        await trace.event({
          type: "llm_request",
          message: "transcribe request",
          data: {
            ...(audioTarget ? { endpoint: audioTarget.baseUrl, model: audioTarget.model } : {}),
            messages: sanitizeMessagesForTrace(messages),
          },
        });

        const result = await completeAudio(messages);
        await trace.event({
          type: "llm_response",
          message: "transcribe response",
          // The provider's raw response body, verbatim (full-raw-bodies rule).
          data: result.responseBody ?? { content: result.content },
          usage: { ...llmUsageOf(result), callKind: "voice-transcribe" },
        });
        rawText = result.content;
      }

      // "(no speech)" is terminal on purpose: leaving a speechless recording
      // pending would make the backfill re-transcribe it forever.
      const transcript = parseTranscript(rawText) || "(no speech)";
      const stored = await storeDescription(db, trace, media, transcript, {
        message: "voice message transcribed",
      });
      publishEvent(FEATURE.realtimeTopic);
      if (ownTrace) {
        await ownTrace.succeed({
          outputSummary: stored.description ?? transcript,
          relatedIds: { [relatedKey]: [media.id] },
        });
      }
      return stored;
    }

    const images = media.status === "pending" ? storedMediaImages(media) : null;
    if (!images) return await skip("no pending media to describe");

    // A video/GIF describes from its ordered frame sequence; a still image from
    // its single frame. The hint tells the model the frames are one clip in order.
    const messages = buildDescribeMessages(images, media.visionHint);
    await trace.event({
      type: "llm_request",
      message: "describe request",
      data: {
        ...(deps.target ? { endpoint: deps.target.baseUrl, model: deps.target.model } : {}),
        messages: sanitizeMessagesForTrace(messages),
      },
    });

    const result = await deps.complete(messages);
    await trace.event({
      type: "llm_response",
      message: "describe response",
      // The provider's raw response body, verbatim (full-raw-bodies rule).
      data: result.responseBody ?? { content: result.content },
      usage: { ...llmUsageOf(result), callKind: "vision-describe" },
    });

    const description = result.content.trim();
    if (!description) return await skip("empty description");

    const stored = await storeDescription(db, trace, media, description, {
      message: "media described",
      extra: { kind: media.kind },
    });
    publishEvent(FEATURE.realtimeTopic);
    if (ownTrace) {
      await ownTrace.succeed({
        outputSummary: stored.description ?? description,
        relatedIds: { [relatedKey]: [media.id] },
      });
    }
    return stored;
  } catch (err) {
    if (ownTrace) {
      await ownTrace.fail(err);
    } else {
      // Never settle the parent (the reply goes on) — but the failure must be
      // visible in its flow, not just in a caller's fallback behavior.
      await trace.event({
        type: "error",
        level: "warn",
        message: isVoice ? "voice transcription failed" : "media describe failed",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    return null;
  }
}

/**
 * Persist a produced description honestly. `markDescribed` only lands on a row
 * still `pending`; when a concurrent pass won the write during the LLM call,
 * the paid-for text is not discarded and the trace does not pretend a clean
 * write happened — the stored row (the winner's text) is re-read and returned,
 * with a warn event saying so. The returned record always carries a description.
 */
async function storeDescription(
  db: DrizzleDb,
  trace: TraceRecorder,
  media: MediaRecord,
  text: string,
  event: { message: string; extra?: Record<string, unknown> },
): Promise<MediaRecord> {
  const updated = await markDescribed(db, media.id, text);
  if (updated) {
    await trace.event({
      type: "db",
      message: event.message,
      data: { ...event.extra, mediaId: media.id, chars: text.length },
    });
    return updated;
  }
  const current = await getMediaById(db, media.id).catch(() => null);
  const description = current?.description ?? text;
  await trace.event({
    type: "db",
    level: "warn",
    message: `${event.message} — a concurrent pass already described this row; reusing the stored text`,
    data: { ...event.extra, mediaId: media.id, chars: description.length },
  });
  return {
    ...(current ?? media),
    description,
    status: "described",
    dataBase64: null,
    frames: null,
  };
}

/** Media annotations for a set of messages in a chat (for the history transcript). */
export async function getMediaAnnotationsForMessages(
  chatId: string,
  telegramMessageIds: number[],
  db: DrizzleDb = getDb(),
): Promise<Map<number, MediaAnnotation>> {
  return getMediaAnnotations(db, chatId, telegramMessageIds);
}

/**
 * Rendered media suffixes (` [photo: <description>]` / ` [photo]`) keyed by
 * Telegram message id — how a media message reads as text. Shared by the reply
 * transcript window and the `/history` display so both show the same annotation.
 */
export async function getMediaSuffixesForMessages(
  chatId: string,
  telegramMessageIds: number[],
  db: DrizzleDb = getDb(),
): Promise<Map<number, string>> {
  const annotations = await getMediaAnnotations(db, chatId, telegramMessageIds);
  const suffixes = new Map<number, string>();
  for (const [id, annotation] of annotations) {
    const suffix = renderMediaSuffix(annotation);
    if (suffix) suffixes.set(id, suffix);
  }
  return suffixes;
}

/** Map a stored row to its dashboard view (bytes → preview only while pending). */
function toView(record: MediaRecord): MediaView {
  const pending = record.status === "pending";
  // A video/GIF exposes all its sampled frames; a still image exposes one preview.
  const frames =
    pending && record.frames && record.frames.length > 0
      ? record.frames.map((base64) => `data:image/jpeg;base64,${base64}`)
      : null;
  return {
    id: record.id,
    chatId: record.chatId,
    telegramMessageId: record.telegramMessageId,
    kind: record.kind,
    status: record.status,
    description: record.description,
    preview:
      pending && record.dataBase64
        ? `data:${record.mimeType ?? "image/jpeg"};base64,${record.dataBase64}`
        : null,
    frames,
    createdAt: record.createdAt,
    describedAt: record.describedAt,
  };
}

/** Recent media for the dashboard, newest first. */
export async function listMedia(limit = 100, db: DrizzleDb = getDb()): Promise<MediaView[]> {
  const rows = await listRecentMedia(db, limit);
  return rows.map(toView);
}

/** One media row by id (dashboard detail), or null. */
export async function getMediaDetail(id: string, db: DrizzleDb = getDb()): Promise<MediaRecord | null> {
  return getMediaById(db, id);
}

/** Count of media rows still awaiting a description (backfill backlog size). */
export async function getPendingMediaCount(db: DrizzleDb = getDb()): Promise<number> {
  return countPendingMedia(db);
}
