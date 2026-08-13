/**
 * Pure presentation helpers for known groups. No server or DB imports, so both
 * Server Components and Client Components can use them, and the roster builder is
 * unit-testable in isolation.
 */

export interface KnownGroupLabelParts {
  title: string | null;
  chatId: string;
}

/** Human label for a group: its title, or a fallback id. */
export function formatKnownGroupLabel(group: KnownGroupLabelParts): string {
  const title = group.title?.trim();
  return title ? title : `Group ${group.chatId}`;
}

/** One participant, already reduced to a display label and their aliases. */
export interface GroupContextMember {
  /** Numeric Telegram user id — the exact form anything identifying a person takes. */
  userId: string;
  label: string;
  aliases: string[];
}

export interface GroupContextParts {
  title: string | null;
  notes: string | null;
  members: GroupContextMember[];
}

/**
 * Build the group-context block injected into the model's prompt for a group
 * reply: the group's title/notes and a roster of its known participants (with the
 * alternate names each may be addressed by). Returns null when there is nothing
 * useful to inject (no members and no notes), so the caller can skip it.
 */
export function formatGroupContext(parts: GroupContextParts): string | null {
  const notes = parts.notes?.trim();
  if (parts.members.length === 0 && !notes) return null;

  const title = parts.title?.trim();
  const lines: string[] = [];
  lines.push(
    title ? `You are chatting in the Telegram group "${title}".` : "You are chatting in a Telegram group.",
  );
  if (notes) lines.push(`About this group: ${notes}`);
  if (parts.members.length > 0) {
    lines.push(
      "Known participants of this group (people who have talked here). Use this to recognize who is who and who is being referred to — the same person may be addressed by any of their listed names. The number in brackets is that person's exact user id, and is the only correct way to identify them where an id is asked for; never guess one:",
    );
    for (const member of parts.members) {
      const also = member.aliases.length > 0 ? ` — also known as: ${member.aliases.join(", ")}` : "";
      lines.push(`- ${member.label} [user id ${member.userId}]${also}`);
    }
  }
  return lines.join("\n");
}
