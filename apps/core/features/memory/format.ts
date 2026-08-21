/**
 * Prompt-context formatting for memory. Pure/client-safe (mirrors
 * `features/known-users/format.ts` and `features/self-improvement/format.ts`):
 * the server service resolves the data, these functions shape the text injected
 * into the reply prompt.
 *
 * **Both** scopes are injected (operator decision, 2026-07-16): the durable
 * picture of the people in this conversation, and the whole general-knowledge
 * document, on every reply. General memory used to be tool-only — retrieved a few
 * facts at a time — on the reasoning that it grows without bound and most of it is
 * irrelevant to any one question. The trade was reversed because knowledge the bot
 * has to *think to look up* is knowledge it mostly does not use; the nightly merge
 * is what keeps the document from sprawling.
 *
 * Only *consolidated* memory is injected: the pending queue is not folded in (user
 * decision). What the model sees is the merged, deduplicated, contradiction-resolved
 * picture — not a running log of every note ever saved.
 */

/** One person's memory, ready to render. */
export interface UserMemoryBlock {
  /** Human label of the person (known-user label shape). */
  label: string;
  /** Whether this person is the one who sent the message being answered. */
  isSender: boolean;
  /** Durable facts about them, one per line, most-durable first. */
  facts: string[];
}

/** Split a stored memory document into its individual fact lines. */
export function splitMemoryFacts(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * The long-term memory block injected as a system message on a reply: what the
 * bot durably knows about the people in this conversation, followed by its
 * general knowledge. Returns null when it knows nothing at all (nothing useful to
 * inject).
 *
 * People come first and general knowledge second, deliberately: the model is
 * answering a person, so who they are is the context everything else is read
 * against. Either half may be absent — a stranger in a chat with general
 * knowledge stored still gets that knowledge, and a known person in a bot with no
 * general knowledge still gets their own facts.
 *
 * The sender is marked, because in a group the model must not confuse a fact
 * about a bystander with a fact about the person it is answering.
 */
export function formatMemoryContext(
  blocks: UserMemoryBlock[],
  generalFacts: string[] = [],
): string | null {
  const usable = blocks.filter((block) => block.facts.length > 0);
  if (usable.length === 0 && generalFacts.length === 0) return null;

  const lines: string[] = [];

  if (usable.length > 0) {
    lines.push("Long-term memory — what you durably know about the people in this conversation:");
    for (const block of usable) {
      const who = block.isSender ? `${block.label} (the person you are replying to)` : block.label;
      lines.push(`${who}:`);
      for (const fact of block.facts) lines.push(`- ${fact}`);
    }
  }

  if (generalFacts.length > 0) {
    if (usable.length > 0) lines.push("");
    lines.push("General knowledge you durably hold (not about anyone in particular):");
    for (const fact of generalFacts) lines.push(`- ${fact}`);
  }

  lines.push(
    "Use this to stay consistent with what you already know. Do not recite it back unprompted, " +
      "and do not treat it as more current than what is said in this conversation.",
  );
  return lines.join("\n");
}
