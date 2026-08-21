import "server-only";

import { getSpeechRuntime } from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { synthesizeSpeech } from "@/server/llm/speech";
import { toOpusOggForTelegram } from "@/server/media/audio";
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
      trigger: { kind: "telegram", actor: params.chatId, correlationId: params.correlationId },
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
    const ogg = await toOpusOggForTelegram(mp3);
    await trace.event({
      type: "step",
      message: "audio transcoded for Telegram",
      data: { mp3Bytes: mp3.length, oggBytes: ogg.length },
    });
    await trace.succeed({ outputSummary: `${ogg.length} bytes of OGG/Opus speech` });
    return { base64: ogg.toString("base64"), filename: "voice.ogg" };
  } catch (err) {
    await trace.fail(err);
    return null;
  }
}
