/**
 * Pure presentation helpers for known users. No server or DB imports, so both
 * Server Components and Client Components (owner dropdown, users table) can use
 * them.
 */

export interface KnownUserLabelParts {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  userId: string;
}

/** Human label for a known user: name, @username, or a fallback id. */
export function formatKnownUserLabel(user: KnownUserLabelParts): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  if (name && user.username) return `${name} (@${user.username})`;
  if (name) return name;
  if (user.username) return `@${user.username}`;
  return `User ${user.userId}`;
}

/** The person on the other side of a private chat, reduced to label + aliases. */
export interface UserContextParts {
  label: string;
  aliases: string[];
}

/**
 * Build the identity block injected as a system message for a private (one-on-one)
 * reply: who the bot is talking to and the other names they go by. The parallel of
 * {@link import("../known-groups/format").formatGroupContext} for DMs — pure
 * identity facts only. How to act on a newly mentioned nickname lives in the
 * `update_user_aliases` tool's own description, not here (the prompt/context stays
 * tool-agnostic).
 */
export function formatUserContext(parts: UserContextParts): string {
  const also =
    parts.aliases.length > 0 ? ` They are also known as: ${parts.aliases.join(", ")}.` : "";
  return `You are in a private, one-on-one Telegram chat with ${parts.label}.${also}`;
}
