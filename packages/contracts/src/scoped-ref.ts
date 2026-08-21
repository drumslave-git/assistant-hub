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

/** The source apps that exist. Adding a source (Signal, …) extends this. */
export const SOURCE_IDS = ["tg", "chat"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

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
  return `${ref.source}:${ref.kind}:${ref.id}`;
}

/** Shorthand for {@link formatScopedRef}. */
export function scopedRef(source: SourceId, kind: RefKind, id: string): ScopedRefString {
  return formatScopedRef({ source, kind, id });
}

const SOURCE_SET: ReadonlySet<string> = new Set(SOURCE_IDS);
const KIND_SET: ReadonlySet<string> = new Set(REF_KINDS);

/**
 * Parse a scoped-ref string, or return null when it is not one (unknown
 * source/kind, missing parts, empty id).
 */
export function tryParseScopedRef(value: string): ScopedRef | null {
  const first = value.indexOf(":");
  if (first < 0) return null;
  const second = value.indexOf(":", first + 1);
  if (second < 0) return null;
  const source = value.slice(0, first);
  const kind = value.slice(first + 1, second);
  const id = value.slice(second + 1);
  if (!SOURCE_SET.has(source) || !KIND_SET.has(kind) || id.length === 0) return null;
  return { source: source as SourceId, kind: kind as RefKind, id };
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

/** Zod schema for a scoped-ref string (validates source, kind, non-empty id). */
export const scopedRefSchema = z
  .string()
  .refine(isScopedRef, { message: "must be a scoped ref (source:kind:id)" });
