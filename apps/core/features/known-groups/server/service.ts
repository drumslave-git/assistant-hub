import "server-only";

import { parseScopedRef, type SourceId } from "@assistant-hub-swarm/contracts";

import { getStoreDb, type StoreDb } from "@/server/store/db";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getUserContext, getUserLanguage } from "@/features/known-users/server/service";
import { listSourceChatSenderIds } from "@/server/source-store/repository";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { writeSourceChat } from "@/server/source/directory";
import { startTrace, withTrace } from "@/server/trace";
import { formatGroupContext } from "../format";
import {
  getGroupMembers,
  getKnownGroup,
  groupMembershipExists,
  listGroupMemberships,
  listKnownGroups,
  recordGroupMembership,
  setKnownGroupLanguage,
  setKnownGroupNotes,
  upsertKnownGroup,
  isGroupChat,
  type KnownGroupRecord,
  type KnownGroupSummaryRecord,
  type SourceGroupProfile,
} from "./repository";
import type {
  KnownGroup,
  KnownGroupSummary,
  UpdateGroupLanguage,
  UpdateGroupNotes,
} from "./schema";

/**
 * Known-groups domain service — the boundary Route Handlers, Server Components,
 * and the turn runtime call. Capturing group activity is a high-frequency
 * passive upsert (not traced); editing notes is an operator action (traced).
 * Mirrors the known-users service. Every read names the source the ids belong
 * to; a curated write is addressed by scoped ref, which names it.
 */

const FEATURE = FEATURES["known-groups"];

/** Cap the injected roster so a busy group's context stays bounded. */
const ROSTER_LIMIT = 50;

/** A known-group record is already client-safe (no secrets). */
function toClientGroup(record: KnownGroupRecord): KnownGroup {
  return record;
}

function toClientSummary(record: KnownGroupSummaryRecord): KnownGroupSummary {
  return record;
}

/** All of one source's known groups (with member counts), most-recently-seen first. */
export async function listGroups(
  source: SourceId,
  db: StoreDb = getStoreDb(),
): Promise<KnownGroupSummary[]> {
  return (await listKnownGroups(db, source)).map(toClientSummary);
}

/**
 * Who belongs to which group, across every group, for a view that already has
 * the user profiles it needs to label them (the tasks page's per-group
 * people picker).
 */
export async function listMemberships(
  source: SourceId,
  db: StoreDb = getStoreDb(),
): Promise<{ chatId: string; userId: string }[]> {
  return listGroupMemberships(db, source);
}

/**
 * Server-only: remember (upsert) a group the bot is active in and record the
 * sender as a member. Refreshes the profile fields, preserves operator-curated
 * notes. Never throws into the message path — a capture failure must not drop the
 * reply. Assumes the sender's known-user row already exists (the runtime upserts
 * it first) so the membership FK is satisfied.
 */
export async function rememberGroupActivity(
  source: SourceId,
  params: SourceGroupProfile & { userId: string | null },
  db: StoreDb = getStoreDb(),
): Promise<void> {
  try {
    const before = await getKnownGroup(db, source, params.chatId);
    const memberExisted =
      params.userId != null
        ? await groupMembershipExists(db, source, params.chatId, params.userId)
        : true;
    await upsertKnownGroup(db, source, {
      chatId: params.chatId,
      title: params.title,
      type: params.type,
    });
    if (params.userId) {
      await recordGroupMembership(db, source, params.chatId, params.userId);
    }
    publishEvent(FEATURE.realtimeTopic);
    await traceGroupCapture(before, memberExisted, params);
  } catch {
    // Best-effort capture; swallow so message handling continues.
  }
}

/** Whether the freshly captured group profile differs from the stored one. */
function groupProfileChanged(before: KnownGroupRecord, params: SourceGroupProfile): boolean {
  return before.title !== params.title || before.type !== params.type;
}

/**
 * Record a trace for a passive group capture only when it actually changed data: a
 * newly seen group, a group profile change, or a newly seen member. Identical
 * re-sightings are intentionally untraced (they happen on every group message).
 * The upserts still refresh `updatedAt`/`last_seen_at` regardless, so ordering and
 * the roster stay current.
 */
async function traceGroupCapture(
  before: KnownGroupRecord | null,
  memberExisted: boolean,
  params: SourceGroupProfile & { userId: string | null },
): Promise<void> {
  const groupAdded = !before;
  const groupChanged = before ? groupProfileChanged(before, params) : false;
  const newMember = params.userId != null && !memberExisted;
  if (!groupAdded && !groupChanged && !newMember) return;

  const label = params.title ?? params.chatId;
  const after = { chatId: params.chatId, title: params.title, type: params.type };
  const action = groupAdded ? "capture-group" : groupChanged ? "update-profile" : "member-joined";
  const trace = await startTrace(
    {
      feature: FEATURE.id,
      action,
      trigger: { kind: "transport", actor: params.userId ?? params.chatId },
      inputSummary: label,
    }
  );
  if (groupAdded) {
    await trace.event({
      type: "db",
      level: "success",
      message: "new group captured",
      data: { profile: after },
    });
  } else if (groupChanged) {
    await trace.event({
      type: "db",
      level: "success",
      message: "group profile updated",
      data: { before, after },
    });
  }
  if (newMember) {
    await trace.event({
      type: "db",
      level: "success",
      message: "new member seen",
      data: { userId: params.userId },
    });
  }
  const summary = groupAdded
    ? `captured ${label}`
    : groupChanged
      ? `profile updated for ${label}`
      : `new member in ${label}`;
  await trace.succeed({
    outputSummary: summary,
    relatedIds: { [FEATURE.relatedIdsKey]: [params.chatId] },
  });
}

/** Replace a group's operator notes, recorded as a trace. */
export async function updateNotes(
  chatRef: string,
  input: UpdateGroupNotes,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<KnownGroup> {
  const { source, id: chatId } = parseScopedRef(chatRef);
  return withTrace(
    { feature: FEATURE.id, action: "update-notes", trigger, inputSummary: `group ${chatRef}` },
    async (trace) => {
      await trace.event({ type: "input", message: "notes update", data: { chatId, notes: input.notes } });
      // The source owns the directory: the edit lands there first, then in
      // the local shadow (the next event refresh would otherwise revert it).
      await writeSourceChat(chatRef, { notes: input.notes });
      const record = await setKnownGroupNotes(db, source, chatId, input.notes);
      if (!record) throw ApiError.notFound("Unknown group");
      await trace.event({ type: "db", message: "notes updated (source + shadow)" });
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: input.notes ? "notes set" : "notes cleared",
        relatedIds: { [FEATURE.relatedIdsKey]: [chatId] },
      });
      return toClientGroup(record);
    },
  );
}

/** Replace a group's operator-configured reply language, recorded as a trace. */
export async function updateLanguage(
  chatRef: string,
  input: UpdateGroupLanguage,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<KnownGroup> {
  const { source, id: chatId } = parseScopedRef(chatRef);
  return withTrace(
    { feature: FEATURE.id, action: "update-language", trigger, inputSummary: `group ${chatRef}` },
    async (trace) => {
      await trace.event({
        type: "input",
        message: "language update",
        data: { chatId, language: input.language },
      });
      // Source first, shadow second — see updateNotes.
      await writeSourceChat(chatRef, { language: input.language });
      const record = await setKnownGroupLanguage(db, source, chatId, input.language);
      if (!record) throw ApiError.notFound("Unknown group");
      await trace.event({ type: "db", message: "language updated (source + shadow)" });
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: input.language ? `language set to ${input.language}` : "language cleared",
        relatedIds: { [FEATURE.relatedIdsKey]: [chatId] },
      });
      return toClientGroup(record);
    },
  );
}

/**
 * Server-only: the operator-configured reply language for a group, or null when
 * none is set (the runtime falls back to the default). Read on the message path.
 */
export async function getGroupLanguage(
  source: SourceId,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<string | null> {
  const group = await getKnownGroup(db, source, chatId);
  return group?.language ?? null;
}

/**
 * The person on the other side of a direct chat: whoever has messaged in
 * it (a direct chat keeps no roster row). Null when nobody has yet, or the
 * chat is a group.
 */
async function directChatPeer(
  db: StoreDb,
  source: SourceId,
  chatId: string,
): Promise<string | null> {
  if (await isGroupChat(db, source, chatId)) return null;
  const [peer] = await listSourceChatSenderIds(source, chatId, db);
  return peer ?? null;
}

/**
 * The operator-configured reply language for any chat: the group's own
 * setting, or the peer's DM setting for a direct chat. Null when none is set.
 * For the out-of-turn callers (a timed task's fire, a browser run's report)
 * that hold a chat id and no event to say what kind of chat it is.
 */
export async function getChatLanguage(
  source: SourceId,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<string | null> {
  if (await isGroupChat(db, source, chatId)) return getGroupLanguage(source, chatId, db);
  const peer = await directChatPeer(db, source, chatId);
  return peer ? getUserLanguage(source, peer, db) : null;
}

/**
 * The identity context block for any chat: a group's roster, or the one
 * person of a direct chat. Null when there is nothing useful to inject.
 */
export async function getChatContext(
  source: SourceId,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<string | null> {
  if (await isGroupChat(db, source, chatId)) {
    return (await getGroupContext(source, chatId, db))?.content ?? null;
  }
  const peer = await directChatPeer(db, source, chatId);
  return peer ? ((await getUserContext(source, peer, db))?.content ?? null) : null;
}

/** The current-day group context block injected into a group reply, or null. */
export interface GroupContext {
  content: string;
  memberCount: number;
}

/**
 * Server-only: build the group-context block for a reply — the group's title/notes
 * and a roster of its known participants (name + operator aliases), so the model
 * can recognize who is who even for people who have not spoken today. Returns null
 * when there is nothing useful to inject.
 */
export async function getGroupContext(
  source: SourceId,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<GroupContext | null> {
  const [group, members] = await Promise.all([
    getKnownGroup(db, source, chatId),
    getGroupMembers(db, source, chatId, ROSTER_LIMIT),
  ]);
  const content = formatGroupContext({
    title: group?.title ?? null,
    notes: group?.notes ?? null,
    members: members.map((member) => ({
      userId: member.userId,
      label: formatKnownUserLabel(member),
      aliases: member.aliases,
    })),
  });
  if (!content) return null;
  return { content, memberCount: members.length };
}
