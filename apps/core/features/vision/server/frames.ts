import "server-only";

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeDurationSec, runFfmpeg } from "@/server/media/ffmpeg";

/**
 * Video/GIF frame sampling for vision. Telegram delivers gifs and videos as mp4,
 * which sharp cannot decode, so frames are pulled with the system `ffmpeg` binary
 * (shared runner in `server/media/ffmpeg.ts`; user decision — system ffmpeg over
 * a bundled/WASM build; see Decision Notes). Always {@link VIDEO_FRAME_COUNT}
 * frames are sampled **evenly across the whole clip** (ffmpeg
 * `fps=count/duration`), so short and long clips alike are covered end to end —
 * never just the opening frames. The caller sends them to the model as an
 * ordered image sequence (see `format.frameSequenceHint`/`toVisionParts`).
 */

/** Frames sampled from every clip, evenly spread across its full length. */
export const VIDEO_FRAME_COUNT = 10;

/**
 * Sample up to `count` JPEG frames evenly across a clip. Writes the input to a
 * temp dir, runs ffmpeg, reads the frames back, and always cleans up. The
 * duration drives even spacing (`fps = count/duration`); when it is not supplied
 * (e.g. a video sent as a document) it is probed with ffprobe so frames still
 * span the whole clip rather than clustering at the start. Throws if ffmpeg is
 * unavailable or fails (the caller falls back to the thumbnail).
 */
export async function extractVideoFrames(
  input: Buffer,
  opts: { count: number; durationSec: number | null },
): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), "vision-frames-"));
  try {
    const inputPath = join(dir, "input");
    await writeFile(inputPath, input);

    let duration = opts.durationSec && opts.durationSec > 0 ? opts.durationSec : null;
    if (!duration) duration = await probeDurationSec(inputPath);

    const args = ["-hide_banner", "-loglevel", "error", "-i", inputPath];
    // Spread `count` frames evenly across the known duration; without a duration
    // fall back to the leading frames (better than nothing).
    if (opts.count > 1 && duration && duration > 0) {
      const fps = opts.count / duration;
      args.push("-vf", `fps=${fps.toFixed(6)}`);
    }
    args.push("-frames:v", String(opts.count), "-q:v", "3", join(dir, "frame_%03d.jpg"));
    await runFfmpeg(args);

    const files = (await readdir(dir)).filter((f) => f.startsWith("frame_")).sort();
    const frames: Buffer[] = [];
    for (const file of files) frames.push(await readFile(join(dir, file)));
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
