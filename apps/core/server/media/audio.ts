import "server-only";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFfmpeg } from "./ffmpeg";

/**
 * Audio transcoding for voice messages, on the shared system ffmpeg:
 *
 *  - Telegram delivers voice as OGG/Opus, which OpenAI-compatible `input_audio`
 *    parts do not accept (the spec allows only `wav`/`mp3`), so transcription
 *    converts to 16 kHz mono WAV — whisper-class models' native rate, and the
 *    most universally decodable container.
 *  - Speech endpoints answer `/v1/audio/speech` with MP3 (the one format every
 *    implementation serves), while Telegram's `sendVoice` needs OGG/Opus for a
 *    real voice bubble, so synthesis converts the other way.
 */

/**
 * Transcription cap: a WAV minute is ~1.9 MB before base64 and audio tokens are
 * expensive, so an hour-long recording must not ride into the model whole. Ten
 * minutes covers any real voice message.
 */
export const MAX_TRANSCRIBE_SECONDS = 600;

/** Run one in→out ffmpeg conversion through a temp dir, always cleaning up. */
async function transcode(input: Buffer, outName: string, args: string[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "voice-audio-"));
  try {
    const inputPath = join(dir, "input");
    const outputPath = join(dir, outName);
    await writeFile(inputPath, input);
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", inputPath, ...args, outputPath]);
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Voice bytes (any container ffmpeg reads — OGG/Opus in practice) → 16 kHz mono
 * PCM WAV, capped at {@link MAX_TRANSCRIBE_SECONDS}. Throws if ffmpeg is
 * unavailable or fails (the caller leaves the row pending for a retry).
 */
export function toWavForTranscription(input: Buffer): Promise<Buffer> {
  return transcode(input, "out.wav", [
    "-t",
    String(MAX_TRANSCRIBE_SECONDS),
    "-ar",
    "16000",
    "-ac",
    "1",
    "-f",
    "wav",
  ]);
}

/**
 * Synthesized speech (MP3) → OGG/Opus mono, the format Telegram `sendVoice`
 * requires to render a real voice bubble (an MP3 upload shows as a music file).
 */
export function toOpusOggForTelegram(input: Buffer): Promise<Buffer> {
  return transcode(input, "out.ogg", ["-c:a", "libopus", "-b:a", "48k", "-ac", "1"]);
}

/**
 * A minimal valid mono 16-bit PCM WAV of silence, built in memory (no ffmpeg).
 * Used by the transcription probe: a fraction of a second is enough to prove the
 * endpoint accepts and processes audio.
 */
export function tinySilenceWav(durationMs = 200, sampleRate = 16_000): Buffer {
  const samples = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}
