/**
 * Pure filename helpers for browser-agent downloads: turn a page title + URL +
 * content-type into a safe, meaningful filename. Client-safe (no node imports)
 * so they are cheap to unit-test. Grounded in the MVP `web-browse/download-store.ts`,
 * generalized beyond media files.
 */

const INVALID_FILENAME_CHARS = new Set('<>:"/\\|?*'.split(""));

/** Human-readable byte size (KB/MB/GB), shared by download progress + the UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
}

/** One in-flight transfer's progress line, shared by every download tool. */
export function formatTransferLine(progress: {
  receivedBytes: number;
  totalBytes: number;
  bytesPerSec: number;
}): string {
  const rate = `(${formatBytes(progress.bytesPerSec)}/s)`;
  return progress.totalBytes
    ? `Downloading ${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)} ${rate}`
    : `Downloading ${formatBytes(progress.receivedBytes)} ${rate}`;
}

/**
 * Sanitize to a safe single-segment filename, keeping Unicode letters (page
 * titles are often non-Latin) and only stripping characters invalid on disk
 * (reserved punctuation + control characters).
 */
export function safeFilename(name: string): string {
  // Take the last path segment ourselves — path.basename() treats "a:" as a
  // Windows drive, which would drop the leading segment cross-platform.
  const segment = name.split(/[/\\]/).pop() ?? "";
  const cleaned = segment
    .split("")
    .filter((ch) => ch.charCodeAt(0) >= 32 && !INVALID_FILENAME_CHARS.has(ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 150) : "download.bin";
}

/** Common content-type → extension fallbacks when the URL path has none. */
const MIME_EXTENSIONS: [match: string, ext: string][] = [
  ["pdf", "pdf"],
  ["zip", "zip"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/svg", "svg"],
  ["audio/mpeg", "mp3"],
  ["audio/ogg", "ogg"],
  ["mp4", "mp4"],
  ["webm", "webm"],
  ["text/html", "html"],
  ["text/plain", "txt"],
  ["json", "json"],
  ["csv", "csv"],
];

/** File extension (no dot) for a URL, falling back to the content-type. */
export function extForUrl(url: string, mime: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split("?")[0] ?? "";
  }
  const match = pathname.replace(/\/+$/, "").match(/\.([a-z0-9]{2,5})$/i);
  if (match) return match[1].toLowerCase();
  const m = mime.toLowerCase();
  for (const [needle, ext] of MIME_EXTENSIONS) {
    if (m.includes(needle)) return ext;
  }
  return "bin";
}

/**
 * Extension → content type, for a file that arrived without one. The HTTP
 * downloaders read `Content-Type` off the response; the media downloader only
 * ever sees a file yt-dlp wrote to disk, so its type has to come from the name.
 * Covers the containers yt-dlp actually produces; anything else is served as a
 * generic binary, which Telegram sends as a plain document.
 */
const EXTENSION_MIMES: Record<string, string> = {
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  opus: "audio/opus",
  ogg: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
  aac: "audio/aac",
};

/** Content type for a filename, by extension. Falls back to a generic binary. */
export function mimeForFilename(filename: string): string {
  const ext = filename.match(/\.([a-z0-9]{1,5})$/i)?.[1].toLowerCase() ?? "";
  return EXTENSION_MIMES[ext] ?? "application/octet-stream";
}

/**
 * Reduce an SEO-style page title to its core name: the leading segment before a
 * " — " / " – " / " - " / " | " separator (which usually introduces a site name
 * or descriptor). "Foo — annual report" → "Foo"; "Bar | Site" → "Bar".
 */
export function primaryTitle(title: string): string {
  const first = title.split(/\s[—–\-|]\s/)[0]?.trim() ?? "";
  return first.length >= 2 ? first : title.trim();
}

/** Build a download filename from a page title + the URL/content-type extension. */
export function buildDownloadFilename(
  title: string | null | undefined,
  url: string,
  mime: string,
): string {
  let urlBase = "download";
  try {
    const basename = new URL(url).pathname.replace(/\/+$/, "").split("/").pop();
    if (basename) urlBase = basename;
  } catch {
    /* keep default */
  }
  const raw = primaryTitle((title ?? "").trim()) || urlBase;
  const stem = safeFilename(raw).replace(/\.[a-z0-9]{1,5}$/i, "").trim() || "download";
  return `${stem}.${extForUrl(url, mime)}`;
}
