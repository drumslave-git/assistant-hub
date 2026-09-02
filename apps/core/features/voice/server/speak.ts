import "server-only";

import type { SourceId } from "@assistant-hub/contracts";

import { getSpeechRuntime } from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { synthesizeSpeech } from "@/server/llm/speech";
import { toOpusOggVoice } from "@/server/media/audio";
import { startTrace } from "@/server/trace";

/**
 * Voice-reply synthesis: reply text → MP3 on the configured speech endpoint →
 * OGG/Opus for Telegram's `sendVoice`. Traced under `voice`/`synthesize`,
 * correlated with the reply trace by `chatId:messageId`.
 */

const FEATURE = FEATURES["voice"];

/**
 * Synthesize a reply chunk as a Telegram-ready voice payload, or null when the
 * speech endpoint is unconfigured (no trace — every text-only deployment would
 * be noise) or synthesis/transcoding failed (traced as the failure it is). The
 * caller falls back to the plain text send either way.
 */
export async function synthesizeVoiceReply(params: {
  /** Which source the turn belongs to (the trace's trigger kind). */
  source?: SourceId;
  chatId: string;
  /** `chatId:messageId` of the turn being answered — links to the reply trace. */
  correlationId: string;
  text: string;
}): Promise<{ base64: string; filename: string } | null> {
  const runtime = await getSpeechRuntime().catch(() => null);
  if (!runtime) return null;

  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: "synthesize",
      // The way in, named honestly — a web thread's voice reply is not a
      // telegram one, and Debug filters on this.
      trigger: {
        kind: params.source === "chat" ? "chat" : "transport",
        actor: params.chatId,
        correlationId: params.correlationId,
      },
      // The whole spoken text, never trimmed.
      inputSummary: params.text,
    }
  );
  try {
    await trace.event({
      type: "external_call",
      message: "speech synthesis request",
      data: {
        baseUrl: runtime.baseUrl,
        model: runtime.model,
        voice: runtime.voice,
        chars: params.text.length,
      },
    });
    const mp3 = await synthesizeSpeech(runtime, params.text);
    const ogg = await toOpusOggVoice(mp3);
    await trace.event({
      type: "step",
      message: "audio transcoded to OGG/Opus",
      data: { mp3Bytes: mp3.length, oggBytes: ogg.length },
    });
    await trace.succeed({ outputSummary: `${ogg.length} bytes of OGG/Opus speech` });
    return { base64: ogg.toString("base64"), filename: "voice.ogg" };
  } catch (err) {
    await trace.fail(err);
    return null;
  }
}
