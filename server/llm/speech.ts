import "server-only";

import { ApiError } from "@/lib/api-error";

import { createOpenAiClient, toLlmError, type LlmConnection } from "./client";

/**
 * Speech synthesis on an OpenAI-compatible `/v1/audio/speech` endpoint. Server-only.
 * Twin of `images.ts`: the connection comes from DB-backed settings
 * (`speech_base_url`/`speech_api_key`/`speech_model`/`speech_voice`, falling back
 * to the LLM connection), and the same client serves the Settings probe and the
 * voice-reply path.
 */

/** Synthesis is slower than chat token streaming but bounded by reply length. */
const SPEECH_TIMEOUT_MS = 120_000;

/** Bound on the Settings probe, which synthesizes one short phrase. */
const PROBE_TIMEOUT_MS = 30_000;

/** What the probe speaks — short, so the render is quick and the audio is checkable. */
const PROBE_PHRASE = "This is a voice test.";

/**
 * Fallback voice name when none is configured: OpenAI's default, which
 * OpenAI-compatible local servers (openedai-speech, kokoro) also map.
 */
export const DEFAULT_SPEECH_VOICE = "alloy";

/** A resolved speech connection: where to call, which model, and which voice. */
export interface SpeechRuntime extends LlmConnection {
  model: string;
  /** Voice name for the endpoint; null → {@link DEFAULT_SPEECH_VOICE}. */
  voice: string | null;
}

/**
 * Synthesize speech for a reply, returning MP3 bytes (the one response format
 * every OpenAI-compatible implementation serves; the caller transcodes to
 * OGG/Opus for Telegram). Throws a clean {@link ApiError} on provider/network
 * failure or an empty payload.
 */
export async function synthesizeSpeech(
  runtime: SpeechRuntime,
  input: string,
  timeoutMs: number = SPEECH_TIMEOUT_MS,
): Promise<Buffer> {
  try {
    const response = await createOpenAiClient(runtime).audio.speech.create(
      {
        model: runtime.model,
        voice: runtime.voice?.trim() || DEFAULT_SPEECH_VOICE,
        input,
        response_format: "mp3",
      },
      { timeout: timeoutMs },
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw ApiError.serviceUnavailable("Speech endpoint returned no audio data");
    }
    return bytes;
  } catch (err) {
    throw toLlmError(err, runtime.baseUrl);
  }
}

/** What the speech probe said and what came back. */
export interface SpeechProbe {
  model: string;
  /** The phrase the probe asked for, and the voice it asked for it in. */
  phrase: string;
  voice: string;
  /** The synthesized MP3, base64-encoded, so the operator can play it. */
  audioBase64: string;
}

/**
 * Real probe of the speech configuration: actually synthesizes a short phrase
 * and hands back the audio.
 *
 * It used to only list models. But the voice name is the half a listing cannot
 * check — an endpoint that serves the model still rejects or silently
 * substitutes an unknown voice, and the first time anyone notices is a voice
 * reply in the wrong voice, or none at all. Hearing the clip settles both.
 */
export async function probeSpeech(runtime: SpeechRuntime): Promise<SpeechProbe> {
  const audio = await synthesizeSpeech(runtime, PROBE_PHRASE, PROBE_TIMEOUT_MS);
  return {
    model: runtime.model,
    phrase: PROBE_PHRASE,
    voice: runtime.voice?.trim() || DEFAULT_SPEECH_VOICE,
    audioBase64: audio.toString("base64"),
  };
}
