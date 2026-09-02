import { z } from "zod";

/**
 * Scoped entity refs — how one app points at another app's entity without a
 * foreign key into its database (PLAN.md, "Data ownership").
 *
 * A ref is `source:kind:id`, e.g. `tg:user:12345`, `tg:chat:-100987`,
 * `chat:thread:e1f2...`. The `id` is the owning app's own key, verbatim —
 * whatever that app uses (numeric Telegram ids as strings, app-generated
 * UUIDs). Memory, tasks, traces and person links store these strings; only
 * the owning app ever resolves one against its database.
 */

/**
 * Source ids are open (user decision, 2026-09-02): a transport picks its own
 * slug and announces it at registration, and the core validates events
 * against the transports that actually registered — never against a list
 * compiled into a package, because a new transport must connect with zero
 * core edits. The shape is the only rule: it becomes the prefix of every
 * scoped ref, the slug of the transport's MCP tools (`tg__reply_to_message`)
 * and the `source` on every event, and it cannot change once refs are
 * stored.
 */
export const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The one built-in source: the web chat, served in-process by the core. */
export const WEB_CHAT_SOURCE = "chat";

/** A source id — a slug matching {@link SOURCE_ID_PATTERN}. */
export type SourceId = string;

export function isSourceId(value: string): boolean {
  return SOURCE_ID_PATTERN.test(value);
}

/** Zod schema for a source id (shape only; registration is checked at runtime). */
export const sourceIdSchema = z
  .string()
  .regex(SOURCE_ID_PATTERN, "a source id is a short lowercase slug (letters, digits, dashes)");

/** Entity kinds refs can point at. */
export const REF_KINDS = ["user", "chat", "thread", "message"] as const;
export type RefKind = (typeof REF_KINDS)[number];

export interface ScopedRef {
  source: SourceId;
  kind: RefKind;
  /** The owning app's own id, verbatim. Never empty. */
  id: string;
}

/**
 * `source:kind:id`. The id may itself contain `:` — parsing splits on the
 * first two separators only.
 */
export type ScopedRefString = `${SourceId}:${RefKind}:${string}`;

export function formatScopedRef(ref: ScopedRef): ScopedRefString {
  if (!ref.id) {
    throw new Error("scoped ref id must not be empty");
  }
  if (!isSourceId(ref.source)) {
    throw new Error(`not a source id: ${JSON.stringify(ref.source)}`);
  }
  return `${ref.source}:${ref.kind}:${ref.id}`;
}

/** Shorthand for {@link formatScopedRef}. */
export function scopedRef(source: SourceId, kind: RefKind, id: string): ScopedRefString {
  return formatScopedRef({ source, kind, id });
}

const KIND_SET: ReadonlySet<string> = new Set(REF_KINDS);

/**
 * Parse a scoped-ref string, or return null when it is not one (malformed
 * source, unknown kind, missing parts, empty id).
 */
export function tryParseScopedRef(value: string): ScopedRef | null {
  const first = value.indexOf(":");
  if (first < 0) return null;
  const second = value.indexOf(":", first + 1);
  if (second < 0) return null;
  const source = value.slice(0, first);
  const kind = value.slice(first + 1, second);
  const id = value.slice(second + 1);
  if (!isSourceId(source) || !KIND_SET.has(kind) || id.length === 0) return null;
  return { source, kind: kind as RefKind, id };
}

/** Parse a scoped-ref string; throws on anything that is not one. */
export function parseScopedRef(value: string): ScopedRef {
  const parsed = tryParseScopedRef(value);
  if (!parsed) {
    throw new Error(`not a scoped ref: ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function isScopedRef(value: string): value is ScopedRefString {
  return tryParseScopedRef(value) !== null;
}

/** Zod schema for a scoped-ref string (validates source shape, kind, non-empty id). */
export const scopedRefSchema = z
  .string()
  .refine(isScopedRef, { message: "must be a scoped ref (source:kind:id)" });
