/**
 * Reply formatting for Telegram delivery.
 *
 * v1 sends replies as plain text (no `parse_mode`) — correct and safe for any
 * model output. Rich markdown/HTML rendering is a later enhancement. The only
 * hard rule here is Telegram's 4096-character per-message limit: a long answer
 * is split at natural boundaries ({@link splitReply}) and delivered as several
 * messages rather than silently truncated.
 */

/** Telegram's maximum message length, in UTF-16 code units. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

const ELLIPSIS = "\n…";

/**
 * Trim and truncate reply text to Telegram's length limit — for single-message
 * contexts (scheduled-task fires, whose trace correlates on the one delivered
 * message id). The conversational reply path splits instead ({@link splitReply}).
 */
export function formatReply(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return trimmed;
  return trimmed.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * Where to cut the next chunk: the last paragraph break inside the limit, else
 * the last line break, else the last sentence end, else the last space — each
 * only if it doesn't leave a degenerately small chunk — else a hard cut.
 */
function findCut(text: string): number {
  // One past the limit, so a boundary sitting exactly at the limit is found.
  const window = text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH + 1);
  const floor = Math.floor(TELEGRAM_MAX_MESSAGE_LENGTH / 2);

  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= floor) return paragraph;
  const line = window.lastIndexOf("\n");
  if (line >= floor) return line;

  let sentence = -1;
  const sentenceEnd = /[.!?…]\s/g;
  for (let m = sentenceEnd.exec(window); m; m = sentenceEnd.exec(window)) {
    sentence = m.index + 1; // cut after the punctuation, before the whitespace
  }
  if (sentence >= floor) return sentence;

  const space = window.lastIndexOf(" ");
  if (space >= floor) return space;
  return TELEGRAM_MAX_MESSAGE_LENGTH;
}

/**
 * Split reply text into Telegram-sized messages at natural boundaries
 * (paragraph → line → sentence → word), so a long answer is delivered whole
 * as a short sequence of messages instead of being cut off. Empty input
 * yields no chunks.
 */
export function splitReply(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
    const cut = findCut(rest);
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
