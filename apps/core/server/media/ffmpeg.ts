import "server-only";

import { spawn } from "node:child_process";

/**
 * Shared system-`ffmpeg` runner (user decision — system ffmpeg over a
 * bundled/WASM build; see Decision Notes). Extracted from the vision frame
 * sampler when voice messages became the second and third consumers (OGG→WAV
 * for transcription, MP3→OGG/Opus for Telegram voice replies).
 */

/** Kill a stuck ffmpeg/ffprobe run rather than hang the reply. */
const FFMPEG_TIMEOUT_MS = 60_000;
const FFPROBE_TIMEOUT_MS = 15_000;

/** Run ffmpeg to completion, rejecting on non-zero exit, spawn error, or timeout. */
export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, FFMPEG_TIMEOUT_MS);

    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/** Probe a media file's duration (seconds) with ffprobe, or null if unavailable. */
export function probeDurationSec(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, FFPROBE_TIMEOUT_MS);
    proc.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      const n = Number.parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}
