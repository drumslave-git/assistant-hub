import "server-only";

import type { SourceId } from "@assistant-hub-swarm/contracts";

import { getStoreDb, type StoreDb } from "@/server/store/db";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type {
  ChatCompletionResult,
  ChatMessage,
  LlmCallTrace,
} from "@/server/llm/client";
import { publishEvent } from "@/server/realtime/hub";
import { mediaSources } from "@/server/turn/source-media";
import { startTrace, type TraceRecorder } from "@/server/trace";

import {
  getAudioRuntime,
  getLlmRuntime,
  getVisionRuntime,
} from "@/features/settings/server/service";
import { buildTranscribeMessages, readTranscript } from "@/features/voice/format";
import { chatCompletion, type LlmPriority } from "@/server/llm/client";
import { transcribeAudio, type TranscriptionResult } from "@/server/llm/transcription";
import { toWavForTranscription } from "@/server/media/audio";

import { renderMediaSuffix } from "../format";
import type { ImagePayload, MediaAnnotation, MediaView } from "../types";
import { buildDescribeMessages } from "./describe";
import {
  getMediaAnnotations,
  getMediaByMessage,
  getMediaById,
  markDescribed,
  type MediaRecord,
} from "./repository";
import { sourceLabels } from "@/server/source/directory";

/**
 * Vision domain service — the boundary the turn pipeline, the backfill and
 * the dashboard call.
 *
 * Ingest is the transports' job: each one downloads and normalizes its
 * platform's media and the core's ingest stores the pending row. What lives
 * here is **describe** (traced, a meaningful action): for the addressed turn
 * the stored image is captioned immediately and the bytes are dropped
 * (`markDescribed`), so past turns read as text in the transcript. The rest
 * stay pending for the backfill job (priority 8).
 */

const FEATURE = FEATURES["vision"];

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

export interface DescribeDeps {
  /**
   * Run the describe completion. The call records itself (endpoint, model, full
   * body, usage) on the trace passed via the shared LLM tracing layer.
   */
  complete: (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;
  /**
   * Dedicated STT for voice rows (`/v1/audio/transcriptions`), present when the
   * operator configured an audio (STT) model in `transcriptions` mode. When
   * set, voice transcription uses it **instead of** any `input_audio` path
   * (user decision: support both, whisper preferred when configured).
   */
  transcribe?: (wav: Buffer) => Promise<TranscriptionResult>;
  /**
   * Where `transcribe` sends the request, recorded on the trace — the STT route
   * is not a chat completion, so its recording stays at this call site.
   */
  transcribeTarget?: { baseUrl: string; model: string };
  /**
   * The `input_audio` transcription path's completion: the audio (STT) role's
   * own connection when one is configured in `chat` mode, else the **chat**
   * (main) connection — which may differ from `complete` when the operator gave
   * the vision role its own backend/model. Absent means `complete` serves both
   * (they resolved to the same connection).
   */
  completeAudio?: (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;
}

/**
 * The real {@link DescribeDeps}, resolved from DB settings at call time: the
 * vision role's connection for describing, plus whichever audio path the
 * operator configured for voice rows. Null when no vision model is set.
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
    complete: (messages, trace) =>
      chatCompletion(conn, {
        model: vision.model,
        messages,
        priority,
        ...(trace ? { trace } : {}),
      }),
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
          completeAudio: (messages: ChatMessage[], trace?: LlmCallTrace) =>
            chatCompletion(
              { baseUrl: stt.baseUrl, apiKey: stt.apiKey, backend: stt.backend },
              { model: stt.model, messages, priority, ...(trace ? { trace } : {}) },
            ),
        }
      : chatDiffers
        ? {
            completeAudio: (messages: ChatMessage[], trace?: LlmCallTrace) =>
              chatCompletion(
                { baseUrl: chat.baseUrl, apiKey: chat.apiKey, backend: chat.backend },
                { model: chat.model, messages, priority, ...(trace ? { trace } : {}) },
              ),
          }
        : {}),
  };
}

/**
 * Where a describe/transcribe pass reads its media and writes the result.
 * The default is this app's database (v1); the queue-consumer path (redesign
 * Phase 2) supplies a port backed by the owning source app's internal media
 * API — same flow, same trace shape, different storage owner (user decision,
 * 2026-08-22: core provides the feature, the app provides the storage).
 */
export interface MediaStorePort {
  getByMessage(chatId: string, sourceMessageId: string): Promise<MediaRecord | null>;
  /** Store a description on a still-pending row (bytes dropped); null = lost race. */
  markDescribed(id: string, description: string): Promise<MediaRecord | null>;
  getById(id: string): Promise<MediaRecord | null>;
}

/** The database-backed {@link MediaStorePort} for one source (tests, direct reads). */
export function dbMediaStore(db: StoreDb, source: SourceId): MediaStorePort {
  return {
    getByMessage: (chatId, sourceMessageId) =>
      getMediaByMessage(db, source, chatId, sourceMessageId),
    markDescribed: (id, description) => markDescribed(db, id, description),
    getById: (id) => getMediaById(db, id),
  };
}

/** How a describe/transcribe pass records itself and where it reads/writes. */
export interface DescribeAndStoreOptions {
  db?: StoreDb;
  /** The source whose row is described, when no `store` is given (the database-backed port is then built for it). */
  source?: SourceId;
  /** Storage owner override — see {@link MediaStorePort}. Default: this DB. */
  store?: MediaStorePort;
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
  params: { chatId: string; sourceMessageId: string },
  deps: DescribeDeps,
  options: DescribeAndStoreOptions = {},
): Promise<MediaRecord | null> {
  const store =
    options.store ??
    (options.source
      ? dbMediaStore(options.db ?? getStoreDb(), options.source)
      : (() => {
          throw new Error("describeAndStore needs a media store or the source whose row this is");
        })());
  const media = await store.getByMessage(params.chatId, params.sourceMessageId).catch(
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
            kind: "transport",
            actor: params.chatId,
            correlationId: `${params.chatId}:${params.sourceMessageId}`,
          },
          inputSummary: `media on message ${params.sourceMessageId}`,
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
        const messages = buildTranscribeMessages(wav.toString("base64"), "wav");
        const result = await completeAudio(messages, {
          recorder: trace,
          callKind: "voice-transcribe",
          label: "transcribe",
        });
        rawText = result.content;
      }

      const outcome = readTranscript(rawText);
      if (outcome.kind === "empty") {
        // A transcriber that answers with nothing has failed, whatever status it
        // dressed the response up in. Storing that would mark the row described,
        // drop the audio bytes, and make the failure permanent *and* invisible —
        // the row reads "transcribed" with no content and no pass ever retries it.
        throw ApiError.serviceUnavailable(
          deps.transcribe
            ? "Transcription endpoint returned no text"
            : "Transcription model returned no text",
        );
      }
      // "(no speech)" is terminal on purpose: the transcriber listened and
      // reported silence, so leaving the row pending would make the backfill
      // re-transcribe a speechless recording forever.
      const transcript = outcome.kind === "no-speech" ? "(no speech)" : outcome.text;
      const stored = await storeDescription(store, trace, media, transcript, {
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
    const result = await deps.complete(messages, {
      recorder: trace,
      callKind: "vision-describe",
      label: "describe",
    });

    const description = result.content.trim();
    if (!description) return await skip("empty description");

    const stored = await storeDescription(store, trace, media, description, {
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
  store: MediaStorePort,
  trace: TraceRecorder,
  media: MediaRecord,
  text: string,
  event: { message: string; extra?: Record<string, unknown> },
): Promise<MediaRecord> {
  const updated = await store.markDescribed(media.id, text);
  if (updated) {
    await trace.event({
      type: "db",
      message: event.message,
      data: { ...event.extra, mediaId: media.id, chars: text.length },
    });
    return updated;
  }
  const current = await store.getById(media.id).catch(() => null);
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
  source: SourceId,
  chatId: string,
  sourceMessageIds: readonly string[],
  db: StoreDb = getStoreDb(),
): Promise<Map<string, MediaAnnotation>> {
  return getMediaAnnotations(db, source, chatId, sourceMessageIds);
}

/**
 * Rendered media suffixes (` [photo: <description>]` / ` [photo]`) keyed by
 * the platform's message id — how a media message reads as text. Shared by
 * the reply transcript window and the `/history` display so both show the
 * same annotation.
 */
export async function getMediaSuffixesForMessages(
  source: SourceId,
  chatId: string,
  sourceMessageIds: readonly string[],
  db: StoreDb = getStoreDb(),
): Promise<Map<string, string>> {
  const annotations = await getMediaAnnotations(db, source, chatId, sourceMessageIds);
  const suffixes = new Map<string, string>();
  for (const [id, annotation] of annotations) {
    const suffix = renderMediaSuffix(annotation);
    if (suffix) suffixes.set(id, suffix);
  }
  return suffixes;
}

/** Map a stored row to its dashboard view (bytes → preview only while pending). */
/**
 * Where a source's stored bytes can be fetched, for the sources that keep
 * them after describing. A lookup, so a new source app adds a line rather
 * than a branch — and an absent entry simply means "gone once described",
 * which is Telegram's lifecycle.
 */
const BYTES_URL: Partial<Record<SourceId, (id: string) => string>> = {
  chat: (id) => `/api/chat/media/${encodeURIComponent(id)}`,
};

function toView(record: MediaRecord, source: SourceId, sourceLabel: string): MediaView {
  // Show the picture whenever the source still has it. A described transport
  // row has dropped its bytes and shows none; a web thread keeps them, since
  // it is the only archive its images have.
  const frames =
    record.frames && record.frames.length > 0
      ? record.frames.map((base64) => `data:image/jpeg;base64,${base64}`)
      : null;
  return {
    id: record.id,
    source,
    sourceLabel,
    chatId: record.chatId,
    sourceMessageId: record.sourceMessageId,
    kind: record.kind,
    status: record.status,
    description: record.description,
    preview: record.dataBase64
      ? `data:${record.mimeType ?? "image/jpeg"};base64,${record.dataBase64}`
      : null,
    bytesUrl: record.dataBase64 ? null : (BYTES_URL[source]?.(record.id) ?? null),
    frames,
    createdAt: record.createdAt,
    describedAt: record.describedAt,
  };
}

/**
 * The media rows live with the owning sources since the split; a deployment
 * running none of them throws for the caller (the vision page renders its
 * unavailable state) rather than silently listing nothing.
 */
async function requireMediaSources() {
  const sources = await mediaSources();
  if (sources.length === 0) {
    throw new Error("no media source is registered");
  }
  return sources;
}

/**
 * Recent media for the dashboard, newest first — merged across every source,
 * each row tagged with the app that holds it. One source failing is not worth
 * an empty gallery, so it is skipped and the rest render.
 */
export async function listMedia(limit = 100): Promise<MediaView[]> {
  const [sources, labels] = await Promise.all([requireMediaSources(), sourceLabels()]);
  const perSource = await Promise.all(
    sources.map(async (source) =>
      source
        .listRecent(limit)
        .then((rows) =>
          rows.map((row) => toView(row, source.source, labels.get(source.source) ?? source.source)),
        )
        .catch(() => [] as MediaView[]),
    ),
  );
  return perSource
    .flat()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

/** One media row by id (dashboard detail), or null. Ids are unique per source. */
export async function getMediaDetail(id: string): Promise<MediaRecord | null> {
  for (const source of await requireMediaSources()) {
    const found = await source.store.getById(id).catch(() => null);
    if (found) return found;
  }
  return null;
}

/** Count of media rows still awaiting a description (backfill backlog size). */
export async function getPendingMediaCount(): Promise<number> {
  const counts = await Promise.all(
    (await requireMediaSources()).map((source) => source.countPending().catch(() => 0)),
  );
  return counts.reduce((total, count) => total + count, 0);
}
