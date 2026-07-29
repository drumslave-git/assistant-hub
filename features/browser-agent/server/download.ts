import "server-only";

import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { isSafePublicUrl, normalizeUrl } from "@/features/link-fetch/url-safety";
import { hostResolvesPublic } from "@/features/link-fetch/server/resolve-safety";

import { buildDownloadFilename } from "../files";

/**
 * Generic file download for the browser agent: stream a public URL to the
 * project's downloads folder, SSRF-checked at every redirect hop, with a size
 * cap. This is the plain-HTTP primitive (`browser_download_file`); the HLS/DASH
 * stream primitive (`browser_download_stream`) lives in `stream-download.ts` and
 * reuses the SSRF/naming helpers exported here. Neither encodes *which* file to
 * fetch — the agent finds the URL (via the page or the network) and picks the
 * matching tool.
 */

/**
 * Downloads folder. `DOWNLOADS_DIR` env is a deploy-time bootstrap override (like
 * `DATABASE_URL`/`TRACES_DIR`), not runtime config; it defaults to `./downloads`
 * for local dev.
 *
 * Under `docker compose` it is set to `/app/data/downloads` and bind-mounted to the
 * host, because this directory is the only copy of a downloaded file that was too
 * large to attach to the chat — an unmounted container path would lose it on the
 * next image replacement.
 */
export const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads");

/** Operator-facing health of the download write path — see {@link getDownloadStorageHealth}. */
export interface DownloadStorageHealth {
  ok: boolean;
  /** The downloads directory when ok; the failure message when not. */
  detail: string;
}

/**
 * Probe the REAL write path — create a file in the downloads directory and remove
 * it — mirroring {@link import("@/server/trace/store").getTraceStorageHealth}. Never
 * an env-presence guess and never an `fs.access(W_OK)` guess: a Docker bind mount the
 * container user cannot write to satisfies both and still fails every download.
 *
 * A create-then-unlink (rather than the trace probe's zero-byte append to a file that
 * exists anyway) because there is no always-present file here, and it exercises exactly
 * what a download does — `mkdir -p`, then open a new file for writing. The probe file is
 * pid-scoped and removed, so concurrent probes cannot collide and nothing is left in a
 * directory the operator browses.
 *
 * Unlike traces, an unwritable directory here destroys nothing silently: the download
 * throws, the tool reports it, and the failure lands on the run row. This probe exists
 * so the operator learns about it from the dashboard instead of from a user's failed
 * request.
 */
export async function getDownloadStorageHealth(): Promise<DownloadStorageHealth> {
  const probe = path.join(DOWNLOADS_DIR, `.write-probe-${process.pid}`);
  try {
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
    await fs.writeFile(probe, "");
    return { ok: true, detail: DOWNLOADS_DIR };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await fs.rm(probe, { force: true }).catch(() => undefined);
  }
}

/** A file streamed to the downloads folder. */
export interface DiskDownload {
  filePath: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}

const MAX_REDIRECTS = 5;
const HEADER_TIMEOUT_MS = 60_000;

/** Browser-like headers: plenty of file hosts refuse a bare fetch. Shared with the stream downloader. */
export const DOWNLOAD_HEADERS = (url: URL): Record<string, string> => ({
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  referer: url.origin + "/",
  accept: "*/*",
});

/**
 * Full SSRF check for a URL about to be fetched server-side: shape (scheme,
 * no credentials, public-looking host) plus DNS (the host must resolve to a
 * public address). Throws with a safety message on any failure. Exported so the
 * stream downloader guards its manifest + segment URLs the same way.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized || !isSafePublicUrl(normalized)) {
    throw new Error("URL blocked for safety (private network or unsupported scheme)");
  }
  const url = new URL(normalized);
  if (!(await hostResolvesPublic(url.hostname, new Map()))) {
    throw new Error("URL blocked for safety (hostname resolves to a private network address)");
  }
  return url;
}

/** Follow redirects manually so every hop is SSRF-checked before it is fetched. */
async function resolveFinalResponse(
  rawUrl: string,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = await assertPublicUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: DOWNLOAD_HEADERS(current),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { response, finalUrl: current };
        await response.body?.cancel().catch(() => {});
        current = await assertPublicUrl(new URL(location, current).toString());
        continue;
      }
      return { response, finalUrl: current };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Too many redirects fetching ${rawUrl}`);
}

/** Pick a non-colliding filename in the downloads dir (adds " (n)" if needed). Shared. */
export async function uniqueFilename(filename: string): Promise<string> {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = filename;
  let n = 1;
  for (;;) {
    try {
      await fs.access(path.join(DOWNLOADS_DIR, candidate));
      candidate = `${stem} (${n})${ext}`;
      n += 1;
    } catch {
      return candidate;
    }
  }
}

/** Live progress of an in-flight file download. */
export interface DownloadProgress {
  /** Bytes written so far. */
  receivedBytes: number;
  /** Total from Content-Length, or 0 when the server didn't send it. */
  totalBytes: number;
  /** Throughput over the last window, bytes/second. */
  bytesPerSec: number;
}

/** Minimum gap between progress emits, so a fast download can't flood the caller. */
const PROGRESS_INTERVAL_MS = 700;

export interface DownloadOptions {
  /**
   * Hard ceiling in bytes (`settings.browser_download_limit_gb`). One number for
   * every download tool; passed in rather than read here so this module stays a
   * generic primitive with no settings dependency.
   */
  maxBytes: number;
  /** Page title used to name the file. */
  title?: string | null;
  /** Called (throttled) while the body streams to disk. */
  onProgress?: (progress: DownloadProgress) => void;
}

/**
 * Download a URL to the downloads folder, naming the file from the page title.
 * Streams to disk (a large file never sits in memory) with the size cap; a
 * failed/oversized transfer removes the partial file and throws. Reports live
 * byte progress via `options.onProgress`.
 *
 * Over the cap this aborts and deletes the partial — unlike the stream and media
 * tools, which can leave a usable truncated file. An arbitrary HTTP body cut in
 * half is not a smaller version of itself.
 */
export async function downloadToDisk(
  rawUrl: string,
  options: DownloadOptions,
): Promise<DiskDownload> {
  const { response, finalUrl } = await resolveFinalResponse(rawUrl);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Download failed: empty response body");

  const mime = (response.headers.get("content-type") ?? "application/octet-stream")
    .split(";")[0]
    .trim();
  const totalBytes = Number(response.headers.get("content-length")) || 0;

  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  const filename = await uniqueFilename(
    buildDownloadFilename(options.title, finalUrl.toString(), mime),
  );
  const filePath = path.join(DOWNLOADS_DIR, filename);

  const { onProgress } = options;
  let written = 0;
  let lastEmit = Date.now();
  let lastBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > options.maxBytes) {
        cb(new Error(`Download exceeds the ${Math.round(options.maxBytes / 1024 ** 3)} GB cap`));
        return;
      }
      if (onProgress) {
        const now = Date.now();
        const elapsed = now - lastEmit;
        if (elapsed >= PROGRESS_INTERVAL_MS) {
          onProgress({
            receivedBytes: written,
            totalBytes,
            bytesPerSec: ((written - lastBytes) * 1000) / elapsed,
          });
          lastEmit = now;
          lastBytes = written;
        }
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(filePath),
    );
  } catch (err) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw err;
  }

  return { filePath, filename, mime, sizeBytes: written };
}
