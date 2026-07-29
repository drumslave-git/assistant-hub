/**
 * Pure yt-dlp helpers for the media downloader: the argument vector, the progress
 * lines it prints, and the error text it fails with. No I/O and no node imports,
 * so the whole contract with the binary is unit-testable without it installed —
 * the same split `hls.ts` uses for the stream downloader.
 *
 * yt-dlp exists here because a media site's player has no file to GET and no
 * manifest to mux: YouTube (and YouTube Music, SoundCloud, Vimeo, …) serve
 * ciphered adaptive streams whose URLs are derived by the page's own JavaScript.
 * Neither `browser_download_file` nor `browser_download_stream` can reach them.
 */

/** What to pull off a media page: the soundtrack alone, or the video. */
export type MediaMode = "audio" | "video";

/** Live progress of an in-flight yt-dlp download (same shape the file downloader reports). */
export interface MediaProgress {
  receivedBytes: number;
  totalBytes: number;
  bytesPerSec: number;
}

/**
 * Marker + fields yt-dlp prints per progress tick. `--progress-template` renders
 * exactly this, so the parser reads a fixed shape instead of yt-dlp's
 * human-facing status line (which carries ANSI codes and changes between
 * versions). Unknown numeric fields render as `NA`.
 */
const PROGRESS_TEMPLATE =
  "download:YTDLP_PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s " +
  "%(progress.total_bytes_estimate)s %(progress.speed)s";

/**
 * Build the yt-dlp argument vector for one media page.
 *
 * - `--no-playlist` matters: a YouTube Music watch URL usually carries a playlist
 *   id, and without this one track becomes the whole radio queue.
 * - `--ignore-config` / `--no-cache-dir` keep the run hermetic — no stray config
 *   file changing behaviour, and no write to a home directory the container's
 *   non-root user may not have.
 * - Output goes to a caller-owned working directory under yt-dlp's own title
 *   template; the caller renames the result into the downloads folder. yt-dlp
 *   knows the real media title ("VIRUS (Fytch Remix)"), which beats the page
 *   title the other download tools use ("VIRUS (Fytch Remix) - YouTube").
 */
export function buildYtDlpArgs(params: {
  url: string;
  mode: MediaMode;
  outputDir: string;
  /**
   * Hard ceiling in bytes (`settings.browser_download_limit_gb`), shared with the
   * other download tools. Not a quality limit — the format selectors below always
   * take the best available audio/video. yt-dlp checks this against the format's
   * declared size and refuses *before* downloading, so nothing is written at all.
   */
  maxBytes: number;
}): string[] {
  const format =
    params.mode === "audio"
      ? // Best audio-only rendition, extracted into its native container (m4a/opus)
        // rather than transcoded to mp3 — re-encoding a lossy source only loses more.
        ["-f", "bestaudio/best", "-x"]
      : // Best video + best audio, merged; mp4 is a preference, and yt-dlp falls
        // back to a container that can actually hold the chosen codecs.
        ["-f", "bestvideo*+bestaudio/best", "--merge-output-format", "mp4"];

  return [
    "--ignore-config",
    "--no-cache-dir",
    "--no-playlist",
    "--newline",
    "--progress",
    "--progress-template",
    PROGRESS_TEMPLATE,
    "--socket-timeout",
    "30",
    "--retries",
    "3",
    "--max-filesize",
    String(params.maxBytes),
    "-P",
    params.outputDir,
    "-o",
    // 120, not the 150 `safeFilename` allows: that cap counts the extension, so a
    // longer title would come back with ".m4a" sliced off it.
    "%(title).120s.%(ext)s",
    ...format,
    // Everything after this is a URL, never an option — the model supplies it.
    "--",
    params.url,
  ];
}

/** Read one number yt-dlp printed; `NA`, empty and non-positive all mean "unknown". */
function progressNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Parse one line of yt-dlp output into progress, or null when the line is
 * anything else (yt-dlp interleaves plenty of informational lines).
 */
export function parseYtDlpProgress(line: string): MediaProgress | null {
  const match = line.trim().match(/^YTDLP_PROGRESS\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
  if (!match) return null;
  return {
    receivedBytes: progressNumber(match[1]),
    // The exact total when the server declared one, otherwise yt-dlp's estimate.
    totalBytes: progressNumber(match[2]) || progressNumber(match[3]),
    bytesPerSec: progressNumber(match[4]),
  };
}

/**
 * Reduce yt-dlp's stderr to the part worth reporting: its own `ERROR:` lines when
 * there are any (they name the real cause — private video, region block, sign-in
 * wall, unsupported site), otherwise the tail. Bounded, because this text reaches
 * the model and the run's activity feed.
 */
export function summarizeYtDlpError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errors = lines.filter((line) => /^ERROR:/i.test(line));
  return (errors.length > 0 ? errors : lines).slice(-2).join(" | ").slice(0, 400);
}
