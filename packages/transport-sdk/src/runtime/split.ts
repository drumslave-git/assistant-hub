/**
 * Cutting a long answer into platform-sized messages.
 *
 * The core hands over the whole answer and knows no platform's cap — it says
 * what to deliver and the transport decides how — so the cut happens here, at
 * natural boundaries (paragraph → line → sentence → word), and the answer is
 * delivered as a short sequence of messages rather than truncated or refused.
 * Every part is reported as its own `message.delivered`, so the core's mirror
 * holds all of it.
 *
 * Only the cap differs between platforms, which is why this is one function
 * with an argument rather than one per transport: Telegram allows 4096 and
 * Discord 2000, and a copied algorithm would drift on the third.
 */

/**
 * Where to cut the next chunk: the last paragraph break inside the limit, else
 * the last line break, else the last sentence end, else the last space — each
 * only if it doesn't leave a degenerately small chunk — else a hard cut.
 */
function findCut(text: string, max: number): number {
  // One past the limit, so a boundary sitting exactly at the limit is found.
  const window = text.slice(0, max + 1);
  const floor = Math.floor(max / 2);

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
  return max;
}

/**
 * Split text into messages of at most `max` UTF-16 code units, at natural
 * boundaries. Empty input yields no chunks.
 */
export function splitMessage(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    const cut = findCut(rest, max);
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
