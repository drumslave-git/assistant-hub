import "server-only";

import {
  WEB_CHAT_SOURCE,
  parseScopedRef,
  scopedRef,
  tryParseScopedRef,
  type SourceId,
} from "@assistant-hub-swarm/contracts";

import { getAccountById } from "@/server/auth/accounts";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { listChatParticipantIds } from "@/features/known-groups/server/repository";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { writeSourceUser } from "@/server/source/directory";
import { startTrace, withTrace } from "@/server/trace";
import { formatKnownUserLabel, formatUserContext } from "../format";
import { matchUsersByReference } from "../match";
import {
  getKnownUser,
  getKnownUsersByIds,
  listKnownUsers,
  setKnownUserAliases,
  setKnownUserLanguage,
  upsertKnownUser,
  type KnownUserRecord,
  type SourceUserProfile,
} from "./repository";
import {
  updateAliasesSchema,
  type KnownUser,
  type UpdateAliases,
  type UpdateUserLanguage,
} from "./schema";

/**
 * Known-users domain service — the boundary Route Handlers, Server Components,
 * and the turn runtime call. Remembering a user is a high-frequency passive
 * upsert (not traced); editing aliases is an operator action (traced). Every
 * read names the source the ids belong to; a curated write is addressed by
 * scoped ref, which names it.
 */

const FEATURE = FEATURES["known-users"];

/** A known user record is already client-safe (no secrets). */
function toClient(record: KnownUserRecord): KnownUser {
  return record;
}

/** All of one source's known users, most-recently-seen first. */
export async function listUsers(
  source: SourceId,
  db: StoreDb = getStoreDb(),
): Promise<KnownUser[]> {
  return (await listKnownUsers(db, source)).map(toClient);
}

/** One known user by id, or null. */
export async function getUser(
  source: SourceId,
  userId: string,
  db: StoreDb = getStoreDb(),
): Promise<KnownUser | null> {
  const record = await getKnownUser(db, source, userId);
  return record ? toClient(record) : null;
}

/**
 * Display labels for a set of user ids, keyed by id. Every requested id gets a
 * label — an id with no known-user row falls back to `User <id>` — so a caller
 * naming people to the model never has to choose between a blank and an id it
 * would then have to explain.
 */
export async function getUserLabels(
  source: SourceId,
  userIds: readonly string[],
  db: StoreDb = getStoreDb(),
): Promise<Map<string, string>> {
  const wanted = [...new Set(userIds.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const records = await getKnownUsersByIds(db, source, wanted);
  const byId = new Map(records.map((record) => [record.userId, formatKnownUserLabel(record)]));
  return new Map(wanted.map((id) => [id, byId.get(id) ?? `User ${id}`]));
}

/**
 * Human labels for a set of user refs (`tg:user:123`, `chat:user:<uuid>`),
 * keyed by ref — a transport's people from its directory, web users from the
 * account roster. A ref nobody knows is absent; the caller picks its fallback.
 */
export async function getUserLabelsByRef(
  refs: readonly string[],
  db: StoreDb = getStoreDb(),
): Promise<Map<string, string>> {
  const byRef = new Map<string, string>();
  const idsBySource = new Map<SourceId, string[]>();
  const accountIds: string[] = [];
  for (const ref of new Set(refs)) {
    const parsed = tryParseScopedRef(ref);
    if (parsed?.kind !== "user") continue;
    if (parsed.source === WEB_CHAT_SOURCE) accountIds.push(parsed.id);
    else idsBySource.set(parsed.source, [...(idsBySource.get(parsed.source) ?? []), parsed.id]);
  }
  for (const [source, ids] of idsBySource) {
    for (const user of await getKnownUsersByIds(db, source, ids)) {
      byRef.set(scopedRef(source, "user", user.userId), formatKnownUserLabel(user));
    }
  }
  for (const id of accountIds) {
    const account = await getAccountById(id, db).catch(() => null);
    if (account) {
      byRef.set(scopedRef(WEB_CHAT_SOURCE, "user", id), account.displayName ?? account.username);
    }
  }
  return byRef;
}

/** The identity block injected into a private-chat reply (parallel of GroupContext). */
export interface UserContext {
  content: string;
  /** Trace payload for the "chat context loaded" step. */
  data: { userId: string; aliasCount: number };
}

/**
 * Server-only: build the private-chat identity block for a reply — who the bot is
 * talking to and their known aliases — so the model can address them and has a
 * concrete reference name for the `update_user_aliases` tool. The DM parallel of
 * {@link import("@/features/known-groups/server/service").getGroupContext}. Returns
 * null when the user is not yet known (nothing useful to inject).
 */
export async function getUserContext(
  source: SourceId,
  userId: string,
  db: StoreDb = getStoreDb(),
): Promise<UserContext | null> {
  const user = await getKnownUser(db, source, userId);
  if (!user) return null;
  const content = formatUserContext({ label: formatKnownUserLabel(user), aliases: user.aliases });
  return { content, data: { userId, aliasCount: user.aliases.length } };
}

/** Whether the freshly captured profile differs from the stored one. */
function userProfileChanged(before: KnownUserRecord, profile: SourceUserProfile): boolean {
  return (
    before.username !== profile.username ||
    before.firstName !== profile.firstName ||
    before.lastName !== profile.lastName
  );
}

/**
 * Record a trace for a passive capture only when it actually changed data: a
 * newly seen user, or a profile-field change on an existing one. Identical
 * re-sightings are intentionally untraced (they happen on every message). The
 * upsert still bumps `updatedAt` regardless, so "last seen" ordering is unaffected.
 */
async function traceUserCapture(
  before: KnownUserRecord | null,
  profile: SourceUserProfile,
): Promise<void> {
  if (before && !userProfileChanged(before, profile)) return;
  const added = !before;

  const label = profile.username ? `@${profile.username}` : profile.userId;
  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action: added ? "capture-user" : "update-profile",
      trigger: { kind: "transport", actor: profile.userId },
      inputSummary: label,
    }
  );
  await trace.event({
    type: "db",
    level: "success",
    message: added ? "new user captured" : "profile updated",
    data: added ? { profile } : { before, after: profile },
  });
  await trace.succeed({
    outputSummary: added ? `captured ${label}` : `profile updated for ${label}`,
    relatedIds: { [FEATURE.relatedIdsKey]: [profile.userId] },
  });
}

/**
 * Server-only: remember (upsert) a user who messaged the bot. Refreshes the
 * profile fields, preserves operator-curated aliases. A trace is recorded only
 * when the capture actually adds or changes data (see {@link traceUserCapture}).
 * Never throws into the message path — a capture failure must not drop the reply.
 */
export async function rememberUser(
  source: SourceId,
  profile: SourceUserProfile,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  try {
    const before = await getKnownUser(db, source, profile.userId);
    await upsertKnownUser(db, source, profile);
    publishEvent(FEATURE.realtimeTopic);
    await traceUserCapture(before, profile);
  } catch {
    // Best-effort capture; swallow so message handling continues.
  }
}

/** Set of a user's own lowercased names — aliases already implied by identity. */
function ownNames(user: KnownUserRecord): Set<string> {
  const out = new Set<string>();
  const add = (value: string | null | undefined) => {
    const v = value?.trim().toLowerCase();
    if (v) out.add(v);
  };
  add(user.username);
  add(user.firstName);
  add(user.lastName);
  for (const alias of user.aliases) add(alias);
  return out;
}

/**
 * Outcome of resolving a name reference to a single participant of a chat. Shared
 * by every context-bound tool that lets the model name a person by a name it
 * already sees (aliases, memory) rather than a numeric id it does not have.
 */
export type ResolveChatUserResult =
  | { status: "matched"; user: KnownUserRecord }
  | { status: "not_found" }
  | { status: "ambiguous"; count: number };

/**
 * Server-only: resolve a name reference (first name, @username, or known nickname)
 * to a single participant of `chatId`. Chat-scoped — only people who have messaged
 * in this chat can match — so a tool can never touch an unrelated user. Returns the
 * lone match, or `not_found`/`ambiguous` for the caller to surface to the model.
 */
export async function resolveChatUserByReference(
  source: SourceId,
  chatId: string,
  reference: string,
  db: StoreDb = getStoreDb(),
): Promise<ResolveChatUserResult> {
  // The chat's participants: a group's roster, or whoever has messaged in a
  // direct chat — the same "people who have spoken here" either way.
  const participantIds = await listChatParticipantIds(db, source, chatId);
  const users = await getKnownUsersByIds(db, source, participantIds);
  const matches = matchUsersByReference(users, reference);
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous", count: matches.length };
  return { status: "matched", user: matches[0] };
}

/** Outcome of an alias-from-reference update, mapped by the tool to a reply. */
export type AddAliasByReferenceResult =
  | { status: "updated"; user: KnownUser; added: string[] }
  | { status: "noop"; user: KnownUser }
  | { status: "not_found" }
  | { status: "ambiguous"; count: number }
  | { status: "invalid"; reason: string };

/**
 * Resolve a name reference to a participant of `chatId` and add nickname(s) to
 * their known-user aliases — the write behind the `update_user_aliases` MCP tool.
 * Chat-scoped (only people who have messaged in this chat can be matched) so a
 * tool can never touch an unrelated user. Recorded as a trace so operators see
 * model-driven alias changes on the Users Debug page alongside their own edits.
 */
export async function addAliasByReference(
  params: { source: SourceId; chatId: string; reference: string; aliases: string[] },
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<AddAliasByReferenceResult> {
  return withTrace(
    { feature: FEATURE.id, action: "add-aliases", trigger, inputSummary: params.reference },
    async (trace) => {
      await trace.event({
        type: "input",
        message: "alias from tool",
        data: { reference: params.reference, aliases: params.aliases },
      });

      const resolved = await resolveChatUserByReference(
        params.source,
        params.chatId,
        params.reference,
        db,
      );
      if (resolved.status === "not_found") {
        await trace.skip(`no participant matches "${params.reference}"`);
        return { status: "not_found" };
      }
      if (resolved.status === "ambiguous") {
        await trace.skip(`"${params.reference}" is ambiguous — ${resolved.count} matches`);
        return { status: "ambiguous", count: resolved.count };
      }

      const user = resolved.user;
      const known = ownNames(user);
      // Aliases are plain names — strip a leading `@` so "@alice" is recognized as
      // the (already-known) username rather than stored as a distinct nickname.
      const toAdd = params.aliases
        .map((a) => a.trim().replace(/^@+/, "").trim())
        .filter((a) => a && !known.has(a.toLowerCase()));

      if (toAdd.length === 0) {
        await trace.skip("nothing new to add", {
          relatedIds: { [FEATURE.relatedIdsKey]: [user.userId] },
        });
        return { status: "noop", user: toClient(user) };
      }

      const parsed = updateAliasesSchema.safeParse({ aliases: [...user.aliases, ...toAdd] });
      if (!parsed.success) {
        const reason = parsed.error.issues[0]?.message ?? "Invalid aliases";
        await trace.skip(`rejected: ${reason}`, {
          relatedIds: { [FEATURE.relatedIdsKey]: [user.userId] },
        });
        return { status: "invalid", reason };
      }

      // Source first, shadow second — see updateLanguage.
      await writeSourceUser(scopedRef(params.source, "user", user.userId), {
        aliases: parsed.data.aliases,
      });
      const record = await setKnownUserAliases(db, params.source, user.userId, parsed.data.aliases);
      if (!record) throw ApiError.notFound("Unknown user");
      await trace.event({ type: "db", message: "aliases updated (source + shadow)", data: { aliases: parsed.data.aliases } });
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: `+${toAdd.length} alias(es) for ${user.userId}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [user.userId] },
      });
      return { status: "updated", user: toClient(record), added: toAdd };
    },
  );
}

/** Replace a user's operator-configured DM reply language, recorded as a trace. */
export async function updateLanguage(
  userRef: string,
  input: UpdateUserLanguage,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<KnownUser> {
  const { source, id: userId } = parseScopedRef(userRef);
  return withTrace(
    { feature: FEATURE.id, action: "update-language", trigger, inputSummary: `user ${userRef}` },
    async (trace) => {
      await trace.event({
        type: "input",
        message: "language update",
        data: { userId, language: input.language },
      });
      // The source owns the directory: the edit lands there first, then in
      // the local shadow the readers (and the next event refresh) agree with.
      await writeSourceUser(userRef, { language: input.language });
      const record = await setKnownUserLanguage(db, source, userId, input.language);
      if (!record) throw ApiError.notFound("Unknown user");
      await trace.event({ type: "db", message: "language updated (source + shadow)" });
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: input.language ? `language set to ${input.language}` : "language cleared",
        relatedIds: { [FEATURE.relatedIdsKey]: [userId] },
      });
      return toClient(record);
    },
  );
}

/**
 * Server-only: the operator-configured reply language for a user's private (DM)
 * chat, or null when none is set (the runtime falls back to the default). Read on
 * the message path — a private chat's id equals the user id.
 */
export async function getUserLanguage(
  source: SourceId,
  userId: string,
  db: StoreDb = getStoreDb(),
): Promise<string | null> {
  const user = await getKnownUser(db, source, userId);
  return user?.language ?? null;
}

/** Replace a known user's alias list, recorded as a trace. */
export async function updateAliases(
  userRef: string,
  input: UpdateAliases,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<KnownUser> {
  const { source, id: userId } = parseScopedRef(userRef);
  return withTrace(
    { feature: FEATURE.id, action: "update-aliases", trigger, inputSummary: `user ${userRef}` },
    async (trace) => {
      await trace.event({ type: "input", message: "aliases update", data: { userId, aliases: input.aliases } });
      // Source first, shadow second — see updateLanguage.
      await writeSourceUser(userRef, { aliases: input.aliases });
      const record = await setKnownUserAliases(db, source, userId, input.aliases);
      if (!record) throw ApiError.notFound("Unknown user");
      await trace.event({ type: "db", message: "aliases updated" });
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: `${input.aliases.length} alias(es)`,
        relatedIds: { [FEATURE.relatedIdsKey]: [userId] },
      });
      return toClient(record);
    },
  );
}
