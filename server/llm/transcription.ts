import "server-only";

import { toFile } from "openai";

import { buildTranscribeMessages } from "@/features/voice/format";
import { chatCompletion, createOpenAiClient, toLlmError, type LlmConnection } from "./client";

/**
 * Speech-to-text for the audio (STT) role. Server-only. Twin of `speech.ts`:
 * the connection comes from DB-backed settings (the audio role's backend +
 * model), and the same client serves the Settings probe, the status probe, and
 * the voice-message path.
 *
 * Two transcription modes (user decision, 2026-08-12 — support both):
 * - `transcriptions`: the OpenAI-style `/v1/audio/transcriptions` endpoint
 *   (whisper.cpp server, speaches/faster-whisper, LocalAI…).
 * - `chat`: a chat completion carrying the audio as an `input_audio` part —
 *   for providers (e.g. OpenRouter) that only take audio through chat
 *   completions on audio-capable models.
 */

/** How the audio role's endpoint accepts audio. */
export type TranscriptionMode = "transcriptions" | "chat";

/** Transcribing minutes of audio is slower than chat but bounded by the cap. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Short timeout for the Settings probe, which transcribes a fraction of a second. */
const PROBE_TIMEOUT_MS = 15_000;

/** A resolved transcription connection: where to call, which model, and how. */
export interface TranscriptionRuntime extends LlmConnection {
  model: string;
  mode: TranscriptionMode;
}

/** What a transcription call produced, shaped for trace recording. */
export interface TranscriptionResult {
  /**
   * What the endpoint said, trimmed and otherwise verbatim — in both modes.
   * Deliberately unclassified: only the caller can tell an explicit "no speech"
   * from an empty answer apart from each other (`readTranscript`), and this
   * layer collapsing them would destroy that distinction before it is asked.
   */
  text: string;
  latencyMs: number;
  /** Raw response object returned by the endpoint (for Debug bodies). */
  responseBody: unknown;
}

/**
 * Transcribe WAV audio on the dedicated STT connection, in the runtime's mode.
 * Throws a clean `ApiError` (via `toLlmError`) on provider/network failure.
 *
 * The live voice path routes `chat`-mode runtimes through the vision service's
 * `input_audio` branch instead (which records token usage on its trace); this
 * dispatch keeps every other caller of a runtime honest about its mode.
 */
export async function transcribeAudio(
  runtime: TranscriptionRuntime,
  wav: Buffer,
): Promise<TranscriptionResult> {
  if (runtime.mode === "chat") return transcribeViaChat(runtime, wav, TRANSCRIBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const response = await createOpenAiClient(runtime).audio.transcriptions.create(
      {
        model: runtime.model,
        file: await toFile(wav, "voice.wav", { type: "audio/wav" }),
      },
      { timeout: TRANSCRIBE_TIMEOUT_MS },
    );
    return {
      text: (response.text ?? "").trim(),
      latencyMs: Date.now() - start,
      responseBody: response,
    };
  } catch (err) {
    throw toLlmError(err, runtime.baseUrl);
  }
}

/** The `chat` mode: one strict transcribe turn carrying the audio part. */
async function transcribeViaChat(
  runtime: TranscriptionRuntime,
  wav: Buffer,
  timeoutMs: number,
): Promise<TranscriptionResult> {
  const result = await chatCompletion(runtime, {
    model: runtime.model,
    messages: buildTranscribeMessages(wav.toString("base64"), "wav"),
    timeoutMs,
  });
  return {
    text: result.content.trim(),
    latencyMs: result.latencyMs,
    responseBody: result.responseBody,
  };
}

/** What a connection test learned about the configured transcription endpoint. */
export interface TranscriptionProbe {
  model: string;
  /** What the endpoint transcribed the probe silence as (usually empty). */
  text: string;
}

/**
 * Real probe of the transcription configuration: transcribes a fraction of a
 * second of generated silence, in the runtime's mode. Unlike the image/speech
 * probes a model listing proves nothing here — whisper-class servers often
 * serve `/v1/audio/transcriptions` without `/v1/models`, and no listing can say
 * whether a chat model accepts audio input — while the silence call is cheap,
 * fast, and exercises exactly the request the voice path will make.
 */
export async function probeTranscription(
  runtime: TranscriptionRuntime,
  probeWav: Buffer,
): Promise<TranscriptionProbe> {
  if (runtime.mode === "chat") {
    const result = await transcribeViaChat(runtime, probeWav, PROBE_TIMEOUT_MS);
    return { model: runtime.model, text: result.text };
  }
  try {
    const response = await createOpenAiClient(runtime).audio.transcriptions.create(
      {
        model: runtime.model,
        file: await toFile(probeWav, "probe.wav", { type: "audio/wav" }),
      },
      { timeout: PROBE_TIMEOUT_MS },
    );
    return { model: runtime.model, text: (response.text ?? "").trim() };
  } catch (err) {
    throw toLlmError(err, runtime.baseUrl);
  }
}
