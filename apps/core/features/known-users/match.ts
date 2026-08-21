/**
 * Pure matching of a free-text name reference to known users. No server or DB
 * imports, so it is unit-testable in isolation and shared by the alias-from-tool
 * flow. A model refers to people by the names it sees in the conversation
 * (first name, @username, an existing nickname), never by numeric id — so this
 * resolves those references, case-insensitively and exactly, against a candidate
 * set of the user's own names.
 */

/** The identity fields a reference can match against. */
export interface UserMatchCandidate {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  aliases: string[];
}

/** Every lowercased name a reference could exactly match for one user. */
function candidateNames(user: UserMatchCandidate): Set<string> {
  const out = new Set<string>();
  const add = (value: string | null | undefined) => {
    const v = value?.trim().toLowerCase();
    if (v) out.add(v);
  };
  add(user.username);
  add(user.firstName);
  add(user.lastName);
  add([user.firstName, user.lastName].filter(Boolean).join(" "));
  for (const alias of user.aliases) add(alias);
  return out;
}

/** Normalize a reference for matching: trim, drop a leading `@`, lowercase. */
export function normalizeReference(reference: string): string {
  return reference.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Users whose own names (username, first/last/full name, or an existing alias)
 * exactly match `reference` (case-insensitive). Empty when nothing matches; more
 * than one when the reference is ambiguous (e.g. two people share a first name).
 */
export function matchUsersByReference<T extends UserMatchCandidate>(
  users: readonly T[],
  reference: string,
): T[] {
  const ref = normalizeReference(reference);
  if (!ref) return [];
  return users.filter((user) => candidateNames(user).has(ref));
}
