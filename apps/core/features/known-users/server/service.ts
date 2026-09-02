import "server-only";

import { parseScopedRef, scopedRef } from "@assistant-hub-swarm/contracts";

import { getStoreDb, type StoreDb } from "@/server/store/db";
import { getGroupMembers } from "@/features/known-groups/server/repository";
import { isGroupChatId } from "@/lib/telegram";
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
  type TelegramUserProfile,
} from "./repository";
import {
  updateAliasesSchema,
  type KnownUser,
  type UpdateAliases,
  type UpdateUserLanguage,
} from "./schema";

/**
 * Known-users domain service — the boundary Route Handlers, Server Components,
 * and the Telegram runtime call. Remembering a user is a high-frequency passive
 * upsert (not traced); editing aliases is an operator action (traced).
 */

const FEATURE = FEATURES["known-users"];

/**
 * The transitional v1 shadow directory this service reads is telegram-shaped
 * (`known_users.user_id` IS a Telegram user id), so a bare id from the
 * message path names a tg person. Curated writes go to the owning source by
 * scoped ref, and the shadow row is keyed by that ref's source-local id —
 * one place to change when Phase 6 collapses the shadow.
 */
const tgUserRef = (userId: string) => scopedRef("tg", "user", userId);

/** A known user record is already client-safe (no secrets). */
function toClient(record: KnownUserRecord): KnownUser {
  return record;
}

/** All known users, most-recently-seen first. */
export async function listUsers(db: StoreDb = getStoreDb()): Promise<KnownUser[]> {
  return (await listKnownUsers(db)).map(toClient);
}

/** One known user by id, or null. */
export async function getUser(userId: string, db: StoreDb = getStoreDb()): Promise<KnownUser | null> {
  const record = await getKnownUser(db, userId);
  return record ? toClient(record) : null;
}

/**
 * Display labels for a set of user ids, keyed by id. Every requested id gets a
 * label — an id with no known-user row falls back to `User <id>` — so a caller
 * naming people to the model never has to choose between a blank and an id it
 * would then have to explain.
 */
export async function getUserLabels(
  userIds: readonly string[],
  db: StoreDb = getStoreDb(),
): Promise<Map<string, string>> {
  const wanted = [...new Set(userIds.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const records = await getKnownUsersByIds(db, wanted);
  const byId = new Map(records.map((record) => [record.userId, formatKnownUserLabel(record)]));
  return new Map(wanted.map((id) => [id, byId.get(id) ?? `User ${id}`]));
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
  userId: string,
  db: StoreDb = getStoreDb(),
): Promise<UserContext | null> {
  const user = await getKnownUser(db, userId);
  if (!user) return null;
  const content = formatUserContext({ label: formatKnownUserLabel(user), aliases: user.aliases });
  return { content, data: { userId, aliasCount: user.aliases.length } };
}

/** Whether the freshly captured Telegram profile differs from the stored one. */
function userProfileChanged(before: KnownUserRecord, profile: TelegramUserProfile): boolean {
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
  profile: TelegramUserProfile,
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
 * Server-only: remember (upsert) a Telegram user who messaged the bot. Refreshes
 * the profile fields, preserves operator-curated aliases. A trace is recorded only
 * when the capture actually adds or changes data (see {@link traceUserCapture}).
 * Never throws into the message path — a capture failure must not drop the reply.
 */
export async function rememberUser(
  profile: TelegramUserProfile,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  try {
    const before = await getKnownUser(db, profile.userId);
    await upsertKnownUser(db, profile);
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
  chatId: string,
  reference: string,
  db: StoreDb = getStoreDb(),
): Promise<ResolveChatUserResult> {
  // The chat's participants: for a group, its (shadow-kept) membership
  // roster; a private chat's one participant is its peer (chat id = user
  // id). The mirror itself lives with the owning source since the split.
  const participantIds = isGroupChatId(chatId)
    ? (await getGroupMembers(db, chatId)).map((member) => member.userId)
    : [chatId];
  const users = await getKnownUsersByIds(db, participantIds);
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
  params: { chatId: string; reference: string; aliases: string[] },
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

      const resolved = await resolveChatUserByReference(params.chatId, params.reference, db);
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
      await writeSourceUser(tgUserRef(user.userId), { aliases: parsed.data.aliases });
      const record = await setKnownUserAliases(db, user.userId, parsed.data.aliases);
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
  const userId = parseScopedRef(userRef).id;
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
      const record = await setKnownUserLanguage(db, userId, input.language);
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
  userId: string,
  db: StoreDb = getStoreDb(),
): Promise<string | null> {
  const user = await getKnownUser(db, userId);
  return user?.language ?? null;
}

/** Replace a known user's alias list, recorded as a trace. */
export async function updateAliases(
  userRef: string,
  input: UpdateAliases,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<KnownUser> {
  const userId = parseScopedRef(userRef).id;
  return withTrace(
    { feature: FEATURE.id, action: "update-aliases", trigger, inputSummary: `user ${userRef}` },
    async (trace) => {
      await trace.event({ type: "input", message: "aliases update", data: { userId, aliases: input.aliases } });
      // Source first, shadow second — see updateLanguage.
      await writeSourceUser(userRef, { aliases: input.aliases });
      const record = await setKnownUserAliases(db, userId, input.aliases);
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
