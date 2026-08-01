import type { BrowserDownloadRecord } from "./types";

/**
 * Pure formatting for browser-agent chat output. Client-safe so the dashboard and
 * the runner share the exact wording, and so it is unit-testable without a run.
 */

/** Human MB for a byte count (whole numbers; sub-MB rounds up to `<1`). */
function formatMb(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return "<1 MB";
  return `${Math.round(mb)} MB`;
}

/**
 * One download as a chat line: filename · size (never a raw file URL). Says where
 * to find it only when the file itself did not reach the chat — if the user has the
 * attachment, pointing at a server folder they cannot browse is noise.
 */
export function formatDownloadLine(record: BrowserDownloadRecord): string {
  const suffix = record.deliveredToChat ? "" : " — in the downloads folder";
  return `📎 ${record.filename} (${formatMb(record.sizeBytes)})${suffix}`;
}

/**
 * The end-of-run message body: the agent's report, followed by a recap of the
 * given downloads. Callers pass only the files that did NOT reach the chat — a
 * delivered attachment speaks for itself, and repeating it under the report was
 * noise. With nothing to recap the report stands alone.
 */
export function formatRunReport(report: string, downloads: BrowserDownloadRecord[]): string {
  const body = report.trim();
  if (downloads.length === 0) return body;
  const lines = downloads.map(formatDownloadLine).join("\n");
  return `${body}\n\nFiles:\n${lines}`;
}
