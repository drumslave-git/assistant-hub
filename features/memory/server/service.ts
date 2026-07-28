import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getGroupMembers } from "@/features/known-groups/server/repository";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUser, getKnownUsersByIds } from "@/features/known-users/server/repository";
import { resolveChatUserByReference } from "@/features/known-users/server/service";
import { getEmbeddingRuntime } from "@/features/settings/server/service";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { embedOne } from "@/server/llm/embeddings";
import { publishEvent } from "@/server/realtime/hub";
import { withTrace, type TraceRecorder } from "@/server/trace";

import { formatMemoryContext, splitMemoryFacts } from "../format";
import type { GeneralMemory, MemoryEntry, MemoryMatch, MemoryScope, UserMemory } from "../types";
import {
  addMemoryEntry,
  countPendingEntries,
  deleteGeneralMemory,
  deleteMemoryEntries,
  deleteUserMemory,
  getGeneralMemory,
  getUserMemoriesFor,
  getUserMemory,
  listMemoryEntries,
  listUserMemories,
  searchMemories,
  upsertGeneralMemory,
  upsertUserMemory,
} from "./repository";
import type { UpdateGeneralMemory, UpdateUserMemory } from "./schema";

/**
 * Memory domain service — the boundary the memory tools, the reply runtime, the
 * dashboard, and the Route Handlers call. Owns policy (who may be remembered,
 * what gets injected), embedding, and trace recording; persistence lives in the
 * repository and the nightly merge in `consolidate.ts`.
 */

const FEATURE = FEATURES.memory;

/* -------------------------------------------------------------- embedding */

/**
 * Embed one text (a fact for storage, or a search query), or null when no
 * embedding model is configured or the provider call fails.
 *
 * Null is a first-class outcome, not swallowed breakage: memory is stored,
 * injected, and read back regardless — only *semantic search* over that row is
 * lost (search degrades to lexical-only), and the dashboard shows the row as
 * unembedded. Making an operator edit fail because an embedding endpoint is
 * down would be the worse trade.
 */
async function tryEmbed(text: string): Promise<number[] | null> {
  const runtime = await getEmbeddingRuntime().catch(() => null);
  if (!runtime) return null;
  return embedOne(runtime, text).catch(() => null);
}

/* --------------------------------------------------------- reply injection */

/** The long-term-memory block injected into a reply (parallel of UserContext). */
export interface MemoryContext {
  content: string;
  /** Trace payload for the "memory loaded" step. */
  data: { userIds: string[]; factCount: number; generalFactCount: number };
}

/**
 * Server-only: what the bot durably knows — about the people in this
 * conversation, and in general — formatted for injection as a system message on a
 * reply. Null only when it knows nothing at all.
 *
 * Who counts as "the people in this conversation" (recorded decision): the sender
 * always, plus — in a group — every known participant, so the bot can follow a
 * conversation *about* someone it knows without being asked to look them up. Only
 * people with a stored memory contribute anything, so that half is bounded by how
 * many people the bot actually remembers, not by the roster size.
 *
 * General knowledge is injected on **every** reply (operator decision,
 * 2026-07-16) — it was previously tool-only. So this returns a context even when
 * the bot knows nobody here, or there is no identified sender at all: the general
 * document does not depend on who is talking.
 *
 * Only **consolidated** memory is injected (user decision). A note saved earlier
 * today is deliberately not folded in: it was said in this conversation, and the
 * conversation itself is already in the prompt verbatim (the 24-hour history
 * window), so injecting the raw note again would restate what the model can
 * already read. Memory is what *survived consolidation* — the merged, deduplicated,
 * contradiction-resolved picture — not a running log of everything ever saved.
 */
export async function getMemoryContext(
  params: { chatId: string; senderId: string | null; isGroup: boolean },
  db: DrizzleDb = getDb(),
): Promise<MemoryContext | null> {
  const ids: string[] = [];
  if (params.senderId) ids.push(params.senderId);

  if (params.isGroup) {
    const members = await getGroupMembers(db, params.chatId);
    for (const member of members) {
      if (!ids.includes(member.userId)) ids.push(member.userId);
    }
  }

  const userIds = ids;
  const [documents, users, general] = await Promise.all([
    userIds.length > 0 ? getUserMemoriesFor(db, userIds) : Promise.resolve([]),
    userIds.length > 0 ? getKnownUsersByIds(db, userIds) : Promise.resolve([]),
    getGeneralMemory(db),
  ]);

  const documentBy = new Map(documents.map((d) => [d.userId, d]));
  const labelBy = new Map(users.map((u) => [u.userId, formatKnownUserLabel(u)]));

  let factCount = 0;
  const blocks = userIds.map((userId) => {
    const stored = documentBy.get(userId);
    const facts = stored ? splitMemoryFacts(stored.content) : [];
    factCount += facts.length;
    return {
      userId,
      label: labelBy.get(userId) ?? `User ${userId}`,
      isSender: userId === params.senderId,
      facts,
    };
  });

  const generalFacts = general ? splitMemoryFacts(general.content) : [];

  const content = formatMemoryContext(blocks, generalFacts);
  if (!content) return null;

  return {
    content,
    data: {
      // Only the people actually represented in the block — a participant the bot
      // knows nothing about contributes nothing and is not claimed in the trace.
      userIds: blocks.filter((b) => b.facts.length > 0).map((b) => b.userId),
      factCount,
      generalFactCount: generalFacts.length,
    },
  };
}

/* -------------------------------------------------- subject identity policy */

/** A resolved subject, or the refusal to hand back to the model. */
export type MemorySubjectResult = { ok: true; userId: string } | { ok: false; error: string };

/**
 * Who a `user`-scope memory operation is about, as a known-user id.
 *
 * The model never sees numeric ids, so it names a person the way the conversation
 * does — first name, @username, a nickname — and that reference is resolved against
 * the *participants of this chat only*, so a tool can never reach someone who has
 * not messaged here. With no reference at all it binds the speaker (the only
 * subject in a DM, and the common case in a group).
 *
 * A reference that matches nobody is not a dead end any more (operator decision,
 * 2026-07-28): the refusal points the model at `general`, where a fact about an
 * outsider belongs. See {@link import("../prompt").UNIDENTIFIED_PERSON_RULE}.
 */
export async function resolveMemorySubject(
  params: { person?: string; chatId: string; speakerId: string | null | undefined },
  db: DrizzleDb = getDb(),
): Promise<MemorySubjectResult> {
  const reference = params.person?.trim();
  if (!reference) {
    if (!params.speakerId) {
      return { ok: false, error: "No one is identified to save this about — name the person." };
    }
    return { ok: true, userId: params.speakerId };
  }

  const resolved = await resolveChatUserByReference(params.chatId, reference, db);
  if (resolved.status === "not_found") {
    return {
      ok: false,
      error:
        `No one in this chat is known as "${reference}", so a fact cannot be filed under them. ` +
        "Save it with scope 'general' instead, keeping their name in the fact itself — that is " +
        "where a fact about someone outside this chat belongs.",
    };
  }
  if (resolved.status === "ambiguous") {
    return {
      ok: false,
      error: `"${reference}" matches ${resolved.count} people here — be more specific (e.g. use their @username).`,
    };
  }
  return { ok: true, userId: resolved.user.userId };
}

/**
 * The gate on the other side: a `general` note may be *about* a person, but only
 * one who has no memory of their own.
 *
 * This is what keeps the identity model at the door rather than inside the shared
 * document. If the named person is a participant of this chat, the fact has a real
 * home and belongs there — filing it as general instead would put a line about
 * someone the bot knows into a document that has no ids, which is how name-keyed
 * lines about different people used to be merged into one subject.
 *
 * Only enforceable when the model declares the subject in `person`; a general note
 * with no subject named is taken at its word as being about nobody.
 */
export async function checkGeneralNoteSubject(
  params: { person?: string; chatId: string },
  db: DrizzleDb = getDb(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const reference = params.person?.trim();
  if (!reference) return { ok: true };

  const resolved = await resolveChatUserByReference(params.chatId, reference, db);
  if (resolved.status === "ambiguous") {
    return {
      ok: false,
      error: `"${reference}" matches ${resolved.count} people here — be more specific (e.g. use their @username).`,
    };
  }
  // Nobody here goes by that name: exactly the case general knowledge is for.
  if (resolved.status === "not_found") return { ok: true };

  return {
    ok: false,
    error:
      `"${reference}" is ${formatKnownUserLabel(resolved.user)}, someone in this chat, so a fact ` +
      "about them is not general knowledge — it belongs in their own memory. Save it again with " +
      `scope 'user' and person "${reference}".`,
  };
}

/* --------------------------------------------------------------- tool reads */

/**
 * One person's consolidated memory document, as facts (`memory_get`).
 *
 * `user` scope only: general knowledge is injected into every reply (operator
 * decision), so a tool that returned it would hand the model text already sitting
 * in its context.
 *
 * Consolidated memory only (user decision) — the pending queue is not readable
 * through the tools. What a tool returns is therefore exactly what the operator
 * sees stored on the dashboard, with no second, shadow set of facts that exist
 * only until the next nightly run.
 */
export async function readMemory(
  params: { userId?: string | null },
  db: DrizzleDb = getDb(),
): Promise<MemoryMatch[]> {
  const userId = params.userId?.trim();
  if (!userId) return [];
  const stored = await getUserMemory(db, userId);
  if (!stored) return [];
  return splitMemoryFacts(stored.content).map((content) => ({
    scope: "user" as const,
    userId,
    content,
  }));
}

/**
 * Hybrid search over consolidated **user** memory (`memory_search`): semantic and
 * lexical, fused by reciprocal rank.
 *
 * General knowledge is not searched — it is already in the prompt. What is worth
 * searching is what is *not* injected: the documents of people who are not in this
 * conversation.
 *
 * Consolidated memory only (user decision) — the pending queue is not searched.
 * A fact saved earlier in this conversation is not lost to the model: the
 * conversation itself is in the prompt, and the history tools reach the rest of
 * it. Memory answers "what do I durably know", not "what did I just hear".
 */
export async function searchMemory(
  params: { queries: string[]; limit: number },
  db: DrizzleDb = getDb(),
): Promise<MemoryMatch[]> {
  const collected = new Map<string, MemoryMatch>();

  for (const query of params.queries) {
    const vector = await tryEmbed(query);
    const hits = await searchMemories(db, {
      queryText: query,
      queryVector: vector,
      limit: params.limit,
    });
    for (const hit of hits) {
      const key = `${hit.scope}|${hit.userId ?? ""}|${hit.content}`;
      if (!collected.has(key)) collected.set(key, hit);
    }
  }

  return [...collected.values()];
}

/* -------------------------------------------------------------- tool writes */

/**
 * Queue one durable fact from the `memory_save` tool.
 *
 * A `user` fact must name a person the bot has actually met (the id comes from
 * the injected context, so a hallucinated one is a real possibility) — otherwise
 * it would be filed under a stranger and never surface. The rejection is returned
 * to the model as a tool error, not thrown at the reply.
 */
export async function saveMemoryNote(
  params: { scope: MemoryScope; userId: string | null; content: string; chatId: string | null },
  db: DrizzleDb = getDb(),
): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; error: string }> {
  if (params.scope === "user") {
    const userId = params.userId?.trim();
    if (!userId) {
      return { ok: false, error: "A 'user' memory needs the id of the person it is about." };
    }
    const known = await getKnownUser(db, userId);
    if (!known) {
      return {
        ok: false,
        error: `No known person has id ${userId}. Use an id from the conversation context.`,
      };
    }
  }

  const entry = await addMemoryEntry(db, {
    scope: params.scope,
    userId: params.scope === "user" ? params.userId : null,
    content: params.content,
    chatId: params.chatId,
  });
  publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id });
  return { ok: true, entry };
}

/* ---------------------------------------------------------------- dashboard */

/** One person's memory, resolved with their label (dashboard). */
export interface UserMemoryView extends UserMemory {
  userLabel: string;
  /** Notes about this person still waiting for the nightly job. */
  pendingNotes: number;
}

/** A pending note resolved with its subject's label (dashboard). */
export interface MemoryEntryView extends MemoryEntry {
  /** Label of the person the note is about; null for a `general` note. */
  userLabel: string | null;
}

/** Everything the dashboard page shows. */
export interface MemoryView {
  entries: MemoryEntryView[];
  users: UserMemoryView[];
  /** The single general-knowledge document, or null when nothing is stored yet. */
  general: GeneralMemory | null;
  /** General notes still waiting for the nightly merge. */
  generalPendingNotes: number;
}

export async function getMemoryView(db: DrizzleDb = getDb()): Promise<MemoryView> {
  const [entries, users, general] = await Promise.all([
    listMemoryEntries(db),
    listUserMemories(db),
    getGeneralMemory(db),
  ]);

  const userIds = [
    ...users.map((u) => u.userId),
    ...entries.map((e) => e.userId).filter((id): id is string => id != null),
  ];
  const known = await getKnownUsersByIds(db, userIds);
  const labels = new Map(known.map((u) => [u.userId, formatKnownUserLabel(u)]));
  const labelFor = (userId: string) => labels.get(userId) ?? `User ${userId}`;

  const pendingCount = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.userId) continue;
    pendingCount.set(entry.userId, (pendingCount.get(entry.userId) ?? 0) + 1);
  }

  return {
    entries: entries.map((e) => ({
      ...e,
      userLabel: e.userId ? labelFor(e.userId) : null,
    })),
    users: users.map((u) => ({
      ...u,
      userLabel: labelFor(u.userId),
      pendingNotes: pendingCount.get(u.userId) ?? 0,
    })),
    general,
    generalPendingNotes: entries.filter((e) => e.scope === "general").length,
  };
}

/** Notes waiting for the next consolidation run — the job card's backlog. */
export function countPendingNotes(db: DrizzleDb = getDb()): Promise<number> {
  return countPendingEntries(db);
}

/* -------------------------------------------------------- operator mutations */

/** Trigger for an operator action taken on the dashboard. */
const operatorTrigger: TraceTrigger = { kind: "dashboard", actor: "operator" };

/** Run one operator mutation inside a trace, publishing the live update on success. */
async function traced<T>(
  action: string,
  inputSummary: string,
  run: (trace: TraceRecorder) => Promise<T>,
): Promise<T> {
  return withTrace(
    { feature: FEATURE.id, action, trigger: operatorTrigger, inputSummary },
    async (trace) => {
      const result = await run(trace);
      await trace.succeed({ outputSummary: "ok" });
      publishEvent(FEATURE.realtimeTopic, { feature: FEATURE.id });
      return result;
    },
  );
}

/** Rewrite one person's memory document by hand. Re-embeds so search stays honest. */
export async function editUserMemory(
  userId: string,
  input: UpdateUserMemory,
  db: DrizzleDb = getDb(),
): Promise<UserMemory> {
  return traced(
    "edit-user-memory",
    `user ${userId}`,
    async (trace) => {
      const known = await getKnownUser(db, userId);
      if (!known) throw ApiError.notFound(`No known user with id ${userId}`);

      const before = await getUserMemory(db, userId);
      // Re-embed the new text rather than keeping the old vector: a stale vector
      // would keep matching searches for text the document no longer contains.
      const stored = await upsertUserMemory(db, {
        userId,
        content: input.content,
        embedding: await tryEmbed(input.content),
      });
      await trace.event({
        type: "step",
        message: "memory document rewritten",
        data: { userId, before: before?.content ?? null, after: stored.content, embedded: stored.embedded },
      });
      return stored;
    },
  );
}

/** Forget one person: their document and (by cascade) their pending notes. */
export async function forgetUser(userId: string, db: DrizzleDb = getDb()): Promise<void> {
  return traced(
    "delete-user-memory",
    `user ${userId}`,
    async (trace) => {
      const before = await getUserMemory(db, userId);
      const deleted = await deleteUserMemory(db, userId);
      if (!deleted) throw ApiError.notFound(`No memory stored for user ${userId}`);
      await trace.event({
        type: "step",
        message: "memory document deleted",
        data: { userId, deleted: before?.content ?? null },
      });
    },
  );
}

/**
 * Rewrite the general-knowledge document by hand. No re-embedding: the document
 * is never searched, only injected.
 */
export async function editGeneralMemory(
  input: UpdateGeneralMemory,
  db: DrizzleDb = getDb(),
): Promise<GeneralMemory> {
  return traced(
    "edit-general-memory",
    input.content.slice(0, 80),
    async (trace) => {
      const before = await getGeneralMemory(db);
      const stored = await upsertGeneralMemory(db, input.content);
      await trace.event({
        type: "step",
        message: "general knowledge rewritten",
        data: { before: before?.content ?? null, after: stored.content },
      });
      return stored;
    },
  );
}

/** Forget all general knowledge. */
export async function forgetGeneralMemory(db: DrizzleDb = getDb()): Promise<void> {
  return traced(
    "delete-general-memory",
    "general knowledge",
    async (trace) => {
      const before = await getGeneralMemory(db);
      const deleted = await deleteGeneralMemory(db);
      if (!deleted) throw ApiError.notFound("No general knowledge is stored");
      await trace.event({
        type: "step",
        message: "general knowledge deleted",
        data: { deleted: before?.content ?? null },
      });
    },
  );
}

/** Discard a pending note before the nightly job folds it in. */
export async function discardMemoryEntry(id: string, db: DrizzleDb = getDb()): Promise<void> {
  return traced(
    "discard-note",
    id,
    async (trace) => {
      const deleted = await deleteMemoryEntries(db, [id]);
      if (deleted === 0) throw ApiError.notFound(`No pending memory note with id ${id}`);
      await trace.event({ type: "step", message: "pending note discarded", data: { entryId: id } });
    },
  );
}
