/**
 * How a reply cites a message it is talking about: `#13488`, or the numero
 * sign (`№`, written as an escape to keep this source ASCII) that a model
 * reaches for in some languages. Anchored to a boundary so a URL fragment
 * (`example.com/a#12`) and a word-shaped hashtag (`#weekend`) are both left
 * alone — only a delimiter followed by digits counts.
 *
 * Core-owned since Phase 7: the `#<id>` anchor is the transcript renderer's
 * convention and the mirror the whitelist checks against lives here; the
 * transport only turns whitelisted ids into platform links.
 */
export const MESSAGE_REF_PATTERN = /(^|[\s(\[«"'—-])([#№])(\d{1,12})\b/gu;

/** Every message id a text cites, de-duplicated, in first-appearance order. */
export function findMessageRefs(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(MESSAGE_REF_PATTERN)) {
    const id = match[3];
    if (Number.isSafeInteger(Number(id)) && Number(id) > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
