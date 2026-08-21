import "server-only";

/**
 * Download a Telegram file's bytes by `file_id`. Server-only: it uses the bot
 * token to hit the Telegram file API. Kept independent of grammy so the vision
 * service can also re-download during backfill without a live `Context`.
 */

const TELEGRAM_API = "https://api.telegram.org";
const FILE_TIMEOUT_MS = 120_000;

/** Resolve a `file_id` to its temporary Telegram file path, or null. */
export async function getTelegramFilePath(token: string, fileId: string): Promise<string | null> {
  const res = (await fetch(
    `${TELEGRAM_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) },
  ).then((r) => r.json())) as { ok: boolean; result?: { file_path?: string } };
  return res.ok && res.result?.file_path ? res.result.file_path : null;
}

/** The raw bytes of a Telegram file as base64 + a mime hint, or null on failure. */
export async function downloadTelegramFile(
  token: string,
  fileId: string,
): Promise<{ base64: string; mimeHint: string } | null> {
  const filePath = await getTelegramFilePath(token, fileId);
  if (!filePath) return null;

  const res = await fetch(`${TELEGRAM_API}/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "jpg";
  const mimeHint =
    ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : ext === "oga" || ext === "ogg"
          ? "audio/ogg" // Telegram voice messages (OGG/Opus, `.oga`)
          : ext === "mp3"
            ? "audio/mpeg"
            : "image/jpeg";
  return { base64: buffer.toString("base64"), mimeHint };
}
