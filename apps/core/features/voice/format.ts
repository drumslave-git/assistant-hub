import type { ChatContentPart, ChatMessage } from "@/server/llm/client";

import { NO_SPEECH_MARKER, VOICE_TRANSCRIBE_SYSTEM, VOICE_TRANSCRIBE_USER } from "./prompt";

/**
 * Pure formatting helpers for voice messages: how audio becomes a model content
 * part and how a transcript reads in the reply turn. No server imports (types
 * only), so they are unit-testable in isolation — the same split vision's
 * `format.ts` follows.
 */

/** Build the OpenAI `input_audio` content part for transcription-ready audio. */
export function toAudioPart(base64: string, format: "wav" | "mp3"): ChatContentPart {
  return { type: "input_audio", input_audio: { data: base64, format } };
}

/**
 * Assemble the messages for a context-free transcription pass: the strict
 * transcribe system prompt plus one `user` turn carrying the audio. The service
 * runs it through the LLM client and records the trace.
 */
export function buildTranscribeMessages(base64: string, format: "wav" | "mp3"): ChatMessage[] {
  return [
    { role: "system", content: VOICE_TRANSCRIBE_SYSTEM },
    {
      role: "user",
      content: [{ type: "text", text: VOICE_TRANSCRIBE_USER }, toAudioPart(base64, format)],
    },
  ];
}

/**
 * What a transcription attempt actually produced.
 *
 * The three cases must stay apart, because two of them look identical as text
 * and mean opposite things: a transcriber that says {@link NO_SPEECH_MARKER} has
 * answered (the recording holds no speech — a terminal fact about the audio),
 * while one that says nothing at all has failed (a fact about the call, which a
 * retry may well fix). Collapsing both to an empty string is what let a failed
 * transcription be stored as a finished one.
 */
export type TranscriptOutcome =
  /** Real speech, trimmed. */
  | { kind: "text"; text: string }
  /** The transcriber explicitly reported nothing spoken. Terminal. */
  | { kind: "no-speech" }
  /** Nothing came back at all, however the endpoint dressed it up. A failure. */
  | { kind: "empty" };

/** Classify a transcription completion into its {@link TranscriptOutcome}. */
export function readTranscript(content: string): TranscriptOutcome {
  const text = content.trim();
  if (!text) return { kind: "empty" };
  if (text.toLowerCase() === NO_SPEECH_MARKER) return { kind: "no-speech" };
  return { kind: "text", text };
}

/**
 * The system-side note telling the reply model its current turn was spoken, not
 * typed — injected alongside the transcript so the bot answers the voice message
 * naturally instead of commenting on receiving "text".
 */
export const VOICE_TURN_NOTE =
  "The user sent this message as a voice message; the text above is its transcript. " +
  "Respond to what they said as in a normal conversation.";

/**
 * The note for a voice message whose transcription failed (endpoint down,
 * unreadable audio): the bot must own up rather than answer thin air.
 */
export const VOICE_UNAVAILABLE_NOTE =
  "The user sent a voice message, but it could not be transcribed. " +
  "Tell them you couldn't listen to their voice message and ask them to try again or type it.";
