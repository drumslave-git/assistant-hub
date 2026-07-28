import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import {
  chatMessages,
  generalMemories,
  groupMembers,
  knownGroups,
  knownUsers,
} from "@/db/schema";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";

import { runMemoryConsolidation, type ConsolidateDeps } from "./consolidate";
import { runMemoryExtraction, type ExtractDeps } from "./extract";
import { getGeneralMemory, getUserMemory, listMemoryEntries, searchMemories } from "./repository";
import {
  checkGeneralNoteSubject,
  editGeneralMemory,
  editUserMemory,
  forgetGeneralMemory,
  getMemoryContext,
  readMemory,
  resolveMemorySubject,
  saveMemoryNote,
  searchMemory,
} from "./service";

/**
 * Integration coverage for memory against a real Postgres with pgvector: both
 * producers of the pending queue (the `memory_save` write path and passive
 * extraction from the history mirror), the nightly consolidation (per-person
 * document merge and per-note general reconcile) with a deterministic LLM, the
 * hybrid search, and the reply-context injection.
 */

let ctx: TestDb;
let prevDatabaseUrl: string | undefined;

beforeAll(async () => {
  ctx = await startTestDb();
  prevDatabaseUrl = process.env.DATABASE_URL;
  // The service reaches the DB through the app's own pool (`getDb()`), so bind it.
  process.env.DATABASE_URL = ctx.connectionUri;
});

afterAll(async () => {
  await closePool();
  if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDatabaseUrl;
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const CHAT_ID = "555";
const GROUP_ID = "-100777";
const ADA = "100";
const GRACE = "200";

async function seedUser(userId: string, firstName: string, aliases: string[] = []): Promise<void> {
  await ctx.db
    .insert(knownUsers)
    .values({ userId, username: firstName.toLowerCase(), firstName, aliases })
    .onConflictDoNothing();
}

/** A group both people take part in. */
async function seedGroup(): Promise<void> {
  await ctx.db
    .insert(knownGroups)
    .values({ chatId: GROUP_ID, title: "Test group", type: "supergroup" })
    .onConflictDoNothing();
  await ctx.db
    .insert(groupMembers)
    .values([
      { chatId: GROUP_ID, userId: ADA },
      { chatId: GROUP_ID, userId: GRACE },
    ])
    .onConflictDoNothing();
}

/**
 * A deterministic pseudo-embedding: stable per text, and the right width. Enough
 * to exercise the vector column, the HNSW index, and cosine ordering for real
 * without reaching a provider.
 */
function fakeEmbedding(text: string): number[] {
  const seed = [...text].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return Array.from({ length: 1024 }, (_, k) => Math.sin(seed + k) / 10);
}

/** A deterministic LLM: each call returns the next scripted response. */
function scriptedLlm(responses: string[]): {
  deps: ConsolidateDeps;
  calls: ChatMessage[][];
} {
  const calls: ChatMessage[][] = [];
  let i = 0;
  return {
    calls,
    deps: {
      complete: async (messages): Promise<ChatCompletionResult> => {
        calls.push(messages);
        const content = responses[i++] ?? "";
        return { content, model: "test-model", latencyMs: 1 } as ChatCompletionResult;
      },
      embed: async (texts) => texts.map(fakeEmbedding),
      db: ctx.db,
    },
  };
}

describe("memory_save (the write path)", () => {
  it("queues a user fact and refuses one about a person the bot has never met", async () => {
    await seedUser(ADA, "Ada");

    const saved = await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    expect(saved.ok).toBe(true);

    // A hallucinated id must not be filed under a stranger where it would never surface.
    const rejected = await saveMemoryNote(
      { scope: "user", userId: "999999", content: "Lives on Mars.", chatId: CHAT_ID },
      ctx.db,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("999999");

    const entries = await listMemoryEntries(ctx.db);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: "user", userId: ADA, content: "Lives in Lisbon." });
  });

  it("queues a general fact with no person attached", async () => {
    const saved = await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup is at 09:30.", chatId: CHAT_ID },
      ctx.db,
    );
    expect(saved.ok).toBe(true);
    const entries = await listMemoryEntries(ctx.db);
    expect(entries[0]).toMatchObject({ scope: "general", userId: null });
  });
});

/**
 * Which document a fact is allowed to land in. The rule (operator decision,
 * 2026-07-28): someone this chat knows gets their own document and may not be
 * written into shared knowledge; anyone else is shared knowledge and must not be
 * lost. Both halves are enforced here, at the gate, so the merge prompts never
 * have to guess who the bot can identify.
 */
describe("subject placement", () => {
  /** Both people have spoken in the group, so both resolve as participants. */
  async function seedSpeakers(): Promise<void> {
    await seedUser(ADA, "Ada");
    await seedUser(GRACE, "Grace");
    await seedGroup();
    await ctx.db.insert(chatMessages).values([
      {
        chatId: GROUP_ID,
        telegramMessageId: 1,
        role: "user",
        userId: ADA,
        content: "hi",
        sentAt: new Date("2026-07-28T10:00:00.000Z"),
      },
      {
        chatId: GROUP_ID,
        telegramMessageId: 2,
        role: "user",
        userId: GRACE,
        content: "hello",
        sentAt: new Date("2026-07-28T10:01:00.000Z"),
      },
    ]);
  }

  it("binds an unnamed subject to the speaker, and resolves a named participant", async () => {
    await seedSpeakers();

    const speaker = await resolveMemorySubject(
      { chatId: GROUP_ID, speakerId: ADA },
      ctx.db,
    );
    expect(speaker).toEqual({ ok: true, userId: ADA });

    const named = await resolveMemorySubject(
      { person: "Grace", chatId: GROUP_ID, speakerId: ADA },
      ctx.db,
    );
    expect(named).toEqual({ ok: true, userId: GRACE });
  });

  /**
   * The reversal of the 2026-07-17 rule: this used to tell the model to drop the
   * fact, which silently destroyed facts the bot had just been asked to remember.
   */
  it("points a fact about an outsider at general knowledge instead of dropping it", async () => {
    await seedSpeakers();

    const subject = await resolveMemorySubject(
      { person: "Muradyan", chatId: GROUP_ID, speakerId: ADA },
      ctx.db,
    );
    expect(subject.ok).toBe(false);
    if (!subject.ok) {
      expect(subject.error).toContain("'general'");
      expect(subject.error).not.toContain("Drop");
    }
  });

  it("lets a general fact be about someone this chat does not know", async () => {
    await seedSpeakers();

    expect(await checkGeneralNoteSubject({ person: "Muradyan", chatId: GROUP_ID }, ctx.db)).toEqual({
      ok: true,
    });
    // No subject named at all: knowledge about nobody, taken at its word.
    expect(await checkGeneralNoteSubject({ chatId: GROUP_ID }, ctx.db)).toEqual({ ok: true });
  });

  it("refuses a general fact about someone who has a document of their own", async () => {
    await seedSpeakers();

    const allowed = await checkGeneralNoteSubject({ person: "Ada", chatId: GROUP_ID }, ctx.db);
    expect(allowed.ok).toBe(false);
    if (!allowed.ok) {
      expect(allowed.error).toContain("'user'");
      expect(allowed.error).toContain("Ada");
    }
  });
});

describe("reply injection", () => {
  /** Consolidate one person's pending notes into their document. */
  async function consolidate(document: string): Promise<void> {
    await runMemoryConsolidation(scriptedLlm([JSON.stringify({ memory: document })]).deps);
  }

  it("injects a person's consolidated memory, marking them as the sender", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    await consolidate("Lives in Lisbon.");

    const context = await getMemoryContext(
      { chatId: CHAT_ID, senderId: ADA, isGroup: false },
      ctx.db,
    );
    expect(context?.content).toContain("Ada (@ada) (the person you are replying to)");
    expect(context?.content).toContain("Lives in Lisbon.");
    expect(context?.data).toMatchObject({ userIds: [ADA], factCount: 1 });
  });

  it("does NOT inject a pending note â€” memory is what survived consolidation", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );

    // The note exists, but nothing has been consolidated, so there is no memory to
    // inject. (The fact is not lost to the model: it was said in this conversation,
    // which the reply already carries verbatim.)
    expect(
      await getMemoryContext({ chatId: CHAT_ID, senderId: ADA, isGroup: false }, ctx.db),
    ).toBeNull();
  });

  it("injects the other participants' memory in a group, marking only the sender", async () => {
    await seedUser(ADA, "Ada");
    await seedUser(GRACE, "Grace");
    await seedGroup();
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: GROUP_ID },
      ctx.db,
    );
    await saveMemoryNote(
      { scope: "user", userId: GRACE, content: "Works nights.", chatId: GROUP_ID },
      ctx.db,
    );
    await runMemoryConsolidation(
      scriptedLlm(['{"memory": "Lives in Lisbon."}', '{"memory": "Works nights."}']).deps,
    );

    const context = await getMemoryContext(
      { chatId: GROUP_ID, senderId: ADA, isGroup: true },
      ctx.db,
    );
    expect(context?.content).toContain("Ada (@ada) (the person you are replying to)");
    expect(context?.content).toContain("Lives in Lisbon.");
    expect(context?.content).toContain("Grace (@grace):");
    expect(context?.content).toContain("Works nights.");
    expect(context?.content).not.toContain("Grace (@grace) (the person you are replying to)");
  });

  it("injects nothing in a private chat about someone it knows nothing about", async () => {
    await seedUser(ADA, "Ada");
    expect(
      await getMemoryContext({ chatId: CHAT_ID, senderId: ADA, isGroup: false }, ctx.db),
    ).toBeNull();
  });

  /**
   * The reverse of what this asserted until 2026-07-16, when general knowledge was
   * tool-only: a general fact now reaches the prompt on its own, without the model
   * having to think to look it up.
   */
  it("injects general knowledge once consolidated, with no tool call needed", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup is at 09:30.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(
      scriptedLlm([JSON.stringify({ memory: "Standup is at 09:30." })]).deps,
    );

    const context = await getMemoryContext(
      { chatId: CHAT_ID, senderId: ADA, isGroup: false },
      ctx.db,
    );
    expect(context?.content).toContain("Standup is at 09:30.");
    expect(context?.data).toMatchObject({ generalFactCount: 1 });
  });

  it("still injects nothing from a general note that is only pending", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup is at 09:30.", chatId: CHAT_ID },
      ctx.db,
    );
    // Queued but not consolidated — memory is what survived the merge.
    expect(
      await getMemoryContext({ chatId: CHAT_ID, senderId: ADA, isGroup: false }, ctx.db),
    ).toBeNull();
  });
});

describe("nightly consolidation â€” user documents", () => {
  it("merges pending notes into one document per person, then consumes the notes", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Porto.", chatId: CHAT_ID },
      ctx.db,
    );
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Likes rye bread.", chatId: CHAT_ID },
      ctx.db,
    );

    const { deps, calls } = scriptedLlm([
      '{"memory": "Lives in Porto.\\nLikes rye bread."}',
    ]);
    const result = await runMemoryConsolidation(deps);

    expect(result.usersUpdated).toBe(1);
    expect(result.consumed).toBe(2);
    // One call per PERSON, not per note â€” the model must see the whole picture.
    expect(calls).toHaveLength(1);
    expect(calls[0].at(-1)?.content).toContain("Ada");

    const stored = await getUserMemory(ctx.db, ADA);
    expect(stored?.content).toBe("Lives in Porto.\nLikes rye bread.");
    expect(stored?.embedded).toBe(true);
    // Consumed notes are gone, so a re-run costs nothing.
    expect(await listMemoryEntries(ctx.db)).toHaveLength(0);

    const second = await runMemoryConsolidation(deps);
    expect(second.summary).toBe("nothing to consolidate");
  });

  it("resolves a contradiction by rewriting the document, not appending to it", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Porto.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Porto."}']).deps);

    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Moved to Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    const { deps, calls } = scriptedLlm(['{"memory": "Lives in Lisbon."}']);
    await runMemoryConsolidation(deps);

    // The existing document was offered to the merge, so the model could supersede it.
    expect(calls[0].at(-1)?.content).toContain("Lives in Porto.");
    const stored = await getUserMemory(ctx.db, ADA);
    expect(stored?.content).toBe("Lives in Lisbon.");
    expect(stored?.content).not.toContain("Porto");
  });

  it("leaves memory and the notes untouched when the merge returns nothing usable", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Porto.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Porto."}']).deps);

    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Likes rye.", chatId: CHAT_ID },
      ctx.db,
    );
    const result = await runMemoryConsolidation(scriptedLlm(["I'm afraid I can't do that."]).deps);

    // A garbage response must never erase a document that took months to build.
    expect(result.failed).toBe(1);
    expect(result.usersUpdated).toBe(0);
    expect((await getUserMemory(ctx.db, ADA))?.content).toBe("Lives in Porto.");
    // ...and the note survives for the next run rather than being silently dropped.
    expect(await listMemoryEntries(ctx.db)).toHaveLength(1);
  });

  it("keeps going when one person's merge fails", async () => {
    await seedUser(ADA, "Ada");
    await seedUser(GRACE, "Grace");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    await saveMemoryNote(
      { scope: "user", userId: GRACE, content: "Works nights.", chatId: CHAT_ID },
      ctx.db,
    );

    const { deps } = scriptedLlm(["garbage", '{"memory": "Works nights."}']);
    const result = await runMemoryConsolidation(deps);

    expect(result.failed).toBe(1);
    expect(result.usersUpdated).toBe(1);
    // The successful person is stored; the failed one's note remains pending.
    const remaining = await listMemoryEntries(ctx.db);
    expect(remaining).toHaveLength(1);
  });
});

describe("nightly consolidation — general knowledge", () => {
  /** Seed the general document directly (it is a singleton row). */
  async function seedGeneral(content: string): Promise<void> {
    await ctx.db.insert(generalMemories).values({ content });
  }

  it("merges pending notes into the single document", async () => {
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup is at 09:30.", chatId: CHAT_ID },
      ctx.db,
    );
    const result = await runMemoryConsolidation(
      scriptedLlm([JSON.stringify({ memory: "Standup is at 09:30." })]).deps,
    );

    expect(result.generalUpdated).toBe(true);
    const stored = await getGeneralMemory(ctx.db);
    expect(stored?.content).toBe("Standup is at 09:30.");
    expect(await listMemoryEntries(ctx.db)).toHaveLength(0);
  });

  it("shows the existing document to the merge, so a correction can supersede a line", async () => {
    await seedGeneral("Standup is at 09:30.\nDeploys happen on Thursdays.");
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup moved to 10:00.", chatId: CHAT_ID },
      ctx.db,
    );

    const { deps, calls } = scriptedLlm([
      JSON.stringify({ memory: "Standup is at 10:00.\nDeploys happen on Thursdays." }),
    ]);
    const result = await runMemoryConsolidation(deps);

    const prompt = calls[0].at(-1)?.content as string;
    expect(prompt).toContain("Standup is at 09:30.");
    expect(prompt).toContain("- Standup moved to 10:00.");

    expect(result.generalUpdated).toBe(true);
    const stored = await getGeneralMemory(ctx.db);
    expect(stored?.content).toBe("Standup is at 10:00.\nDeploys happen on Thursdays.");
  });

  /**
   * The whole run now costs ONE general call regardless of backlog — the point of
   * merging a document rather than reconciling note by note.
   */
  it("spends one LLM call for the whole general backlog", async () => {
    for (const content of ["Standup is at 09:30.", "Deploys on Thursdays.", "Fridays are quiet."]) {
      await saveMemoryNote({ scope: "general", userId: null, content, chatId: CHAT_ID }, ctx.db);
    }

    const { deps, calls } = scriptedLlm([
      JSON.stringify({ memory: "Standup is at 09:30.\nDeploys on Thursdays.\nFridays are quiet." }),
    ]);
    const result = await runMemoryConsolidation(deps);

    expect(calls).toHaveLength(1);
    expect(result.consumed).toBe(3);
    expect(await listMemoryEntries(ctx.db)).toHaveLength(0);
  });

  /**
   * The property that matters most: a garbage response must never be able to
   * erase a shared document that took months to accumulate.
   */
  it("leaves the document untouched and the notes pending when the merge returns nothing", async () => {
    await seedGeneral("Standup is at 09:30.");
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Deploys on Thursdays.", chatId: CHAT_ID },
      ctx.db,
    );

    const result = await runMemoryConsolidation(scriptedLlm(['{"memory": ""}']).deps);

    expect(result.failed).toBe(1);
    expect(result.generalUpdated).toBe(false);
    expect((await getGeneralMemory(ctx.db))?.content).toBe("Standup is at 09:30.");
    // Not consumed — the note gets another chance tomorrow.
    expect(await listMemoryEntries(ctx.db)).toHaveLength(1);
  });

  it("stores a fact about a person it cannot key on, rather than losing it", async () => {
    // Nobody is a known user here, so this could never be a `user` document —
    // general knowledge is what keeps it.
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Bob lives in Porto.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(
      scriptedLlm([JSON.stringify({ memory: "Bob lives in Porto." })]).deps,
    );
    expect((await getGeneralMemory(ctx.db))?.content).toBe("Bob lives in Porto.");
  });
});

describe("consolidation without an embedding model", () => {
  it("still stores and injects memory â€” only semantic search is lost", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );

    const { deps } = scriptedLlm(['{"memory": "Lives in Lisbon."}']);
    const result = await runMemoryConsolidation({ ...deps, embed: null });

    expect(result.usersUpdated).toBe(1);
    const stored = await getUserMemory(ctx.db, ADA);
    expect(stored?.content).toBe("Lives in Lisbon.");
    expect(stored?.embedded).toBe(false);

    // Still injected into replies, embedding or not.
    const context = await getMemoryContext(
      { chatId: CHAT_ID, senderId: ADA, isGroup: false },
      ctx.db,
    );
    expect(context?.content).toContain("Lives in Lisbon.");
  });
});

describe("general knowledge injection", () => {
  async function seedGeneral(content: string): Promise<void> {
    await ctx.db.insert(generalMemories).values({ content });
  }

  it("injects the general document into a reply, alongside the sender's own memory", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Lisbon."}']).deps);
    await seedGeneral("Standup is at 09:30.\nBob lives in Porto.");

    const context = await getMemoryContext(
      { chatId: CHAT_ID, senderId: ADA, isGroup: false },
      ctx.db,
    );
    expect(context?.content).toContain("Ada (@ada) (the person you are replying to)");
    expect(context?.content).toContain("Lives in Lisbon.");
    expect(context?.content).toContain("General knowledge you durably hold");
    expect(context?.content).toContain("Standup is at 09:30.");
    expect(context?.content).toContain("Bob lives in Porto.");
    expect(context?.data).toMatchObject({ factCount: 1, generalFactCount: 2 });
  });

  /**
   * The point of injecting it: general knowledge does not depend on who is
   * talking, so a stranger the bot knows nothing about still gets it.
   */
  it("injects general knowledge even when the bot knows nobody in the chat", async () => {
    await seedGeneral("Standup is at 09:30.");

    const context = await getMemoryContext(
      { chatId: CHAT_ID, senderId: "999999", isGroup: false },
      ctx.db,
    );
    expect(context?.content).toContain("Standup is at 09:30.");
    expect(context?.data).toMatchObject({ userIds: [], factCount: 0, generalFactCount: 1 });
  });

  it("injects general knowledge when there is no identified sender at all", async () => {
    await seedGeneral("Standup is at 09:30.");

    const context = await getMemoryContext(
      { chatId: CHAT_ID, senderId: null, isGroup: false },
      ctx.db,
    );
    expect(context?.content).toContain("Standup is at 09:30.");
  });

  it("still injects nothing when the bot knows nothing at all", async () => {
    expect(
      await getMemoryContext({ chatId: CHAT_ID, senderId: ADA, isGroup: false }, ctx.db),
    ).toBeNull();
  });
});

describe("search", () => {
  it("finds a consolidated fact about a person by wording", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Ada bakes sourdough every weekend.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(
      scriptedLlm(['{"memory": "Ada bakes sourdough every weekend."}']).deps,
    );

    const hits = await searchMemories(ctx.db, {
      queryText: "sourdough",
      queryVector: null,
      limit: 8,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ scope: "user", userId: ADA });
  });

  /**
   * General knowledge is injected into every reply, so searching it would hand
   * the model text already in its context. Not an oversight — the reason search
   * exists at all is to reach what is NOT injected.
   */
  it("does NOT search general knowledge — it is already in every prompt", async () => {
    await saveMemoryNote(
      { scope: "general", userId: null, content: "Standup is at 09:30.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Standup is at 09:30."}']).deps);
    // It is genuinely stored...
    expect((await getGeneralMemory(ctx.db))?.content).toBe("Standup is at 09:30.");
    // ...and deliberately unreachable by search.
    expect(
      await searchMemories(ctx.db, { queryText: "standup", queryVector: null, limit: 8 }),
    ).toEqual([]);
  });

  it("does NOT find a pending note â€” the tools read consolidated memory only", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Ada bakes sourdough.", chatId: CHAT_ID },
      ctx.db,
    );

    // The note is queued but not consolidated, so it is not memory yet. What the
    // tools return is exactly what is stored â€” no shadow set of facts in between.
    expect(await searchMemory({ queries: ["sourdough"], limit: 8 }, ctx.db)).toEqual([]);
  });
});

describe("readMemory (memory_get)", () => {
  it("returns a person's consolidated document, and not their pending notes", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Lisbon."}']).deps);
    // Saved after consolidation â€” still queued, so still not memory.
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Likes rye.", chatId: CHAT_ID },
      ctx.db,
    );

    const facts = await readMemory({ userId: ADA }, ctx.db);
    expect(facts).toEqual([{ scope: "user", userId: ADA, content: "Lives in Lisbon." }]);
  });
});

describe("operator edits", () => {
  it("rewrites a person's document and re-embeds it, traced", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Porto.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Porto."}']).deps);

    // No embedding endpoint is configured in the test env, so the rewrite stores
    // the corrected text with a null vector rather than keeping a vector that
    // describes text the document no longer contains.
    const updated = await editUserMemory(ADA, { content: "Lives in Lisbon." }, ctx.db);
    expect(updated.content).toBe("Lives in Lisbon.");
    expect(updated.embedded).toBe(false);

    const traces = await listTraces({ feature: "memory", limit: 10, offset: 0 });
    const edit = traces.traces.find((t) => t.action === "edit-user-memory");
    expect(edit?.status).toBe("success");
  });

  it("rewrites the general document by hand", async () => {
    await ctx.db.insert(generalMemories).values({ content: "Standup is at 09:30." });
    const updated = await editGeneralMemory({ content: "Standup is at 10:00." }, ctx.db);
    expect(updated.content).toBe("Standup is at 10:00.");
    expect((await getGeneralMemory(ctx.db))?.content).toBe("Standup is at 10:00.");
  });

  it("forgets all general knowledge", async () => {
    await ctx.db.insert(generalMemories).values({ content: "Standup is at 09:30." });
    await forgetGeneralMemory(ctx.db);
    expect(await getGeneralMemory(ctx.db)).toBeNull();
  });
});

describe("tracing", () => {
  it("records one consolidation trace with the merge request, response, and outcome", async () => {
    await seedUser(ADA, "Ada");
    await saveMemoryNote(
      { scope: "user", userId: ADA, content: "Lives in Lisbon.", chatId: CHAT_ID },
      ctx.db,
    );
    await runMemoryConsolidation(scriptedLlm(['{"memory": "Lives in Lisbon."}']).deps);

    const traces = await listTraces({ feature: "memory", limit: 10, offset: 0 });
    const run = traces.traces.find((t) => t.action === "consolidate");
    expect(run?.status).toBe("success");
    expect(run?.outputSummary).toContain("1 user memory updated");
  });

  it("records no trace at all when there is nothing to consolidate", async () => {
    const result = await runMemoryConsolidation(scriptedLlm([]).deps);
    expect(result.summary).toBe("nothing to consolidate");
    const traces = await listTraces({ feature: "memory", limit: 10, offset: 0 });
    expect(traces.traces).toHaveLength(0);
  });
});

describe("passive extraction (the un-addressed half of memory)", () => {
  /** A day in the past, so the due-scan considers it finished. */
  const DAY = "2026-07-13";
  const NOW = new Date("2026-07-15T12:00:00.000Z");

  /** Mirror a message into history, exactly as the runtime does for every update. */
  async function seedMessage(input: {
    telegramMessageId: number;
    userId: string | null;
    content: string;
    at?: string;
  }): Promise<void> {
    await ctx.db.insert(chatMessages).values({
      chatId: GROUP_ID,
      telegramMessageId: input.telegramMessageId,
      role: input.userId ? "user" : "assistant",
      userId: input.userId,
      content: input.content,
      sentAt: new Date(input.at ?? `${DAY}T10:00:00.000Z`),
    });
  }

  /** A deterministic LLM for the extraction pass (no embeddings involved). */
  function scriptedExtractor(responses: string[]): { deps: ExtractDeps; calls: ChatMessage[][] } {
    const calls: ChatMessage[][] = [];
    let i = 0;
    return {
      calls,
      deps: {
        complete: async (messages): Promise<ChatCompletionResult> => {
          calls.push(messages);
          return {
            content: responses[i++] ?? "",
            model: "test-model",
            latencyMs: 1,
          } as ChatCompletionResult;
        },
        timeZone: "UTC",
        now: () => NOW,
      },
    };
  }

  it("learns from a day the bot was never addressed in â€” the whole point", async () => {
    await seedUser(ADA, "Ada");
    await seedUser(GRACE, "Grace");
    await seedGroup();
    // Two people talking to each other. The bot is not mentioned once, so under the
    // reply path alone none of this would ever have reached memory.
    await seedMessage({ telegramMessageId: 1, userId: ADA, content: "I finally moved to Lisbon." });
    await seedMessage({ telegramMessageId: 2, userId: GRACE, content: "nice! I'm still in Porto" });

    const { deps, calls } = scriptedExtractor([
      JSON.stringify({
        facts: [
          { scope: "user", user_id: ADA, content: "Ada moved to Lisbon." },
          { scope: "user", user_id: GRACE, content: "Grace lives in Porto." },
        ],
      }),
    ]);
    const result = await runMemoryExtraction(deps, ctx.db);

    expect(result).toMatchObject({ days: 1, notes: 2, failures: 0 });
    // The model was shown the roster it must attribute facts with.
    expect(calls[0][1].content).toContain(`[id:${ADA}] Ada`);

    const entries = await listMemoryEntries(ctx.db);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.content).sort()).toEqual([
      "Ada moved to Lisbon.",
      "Grace lives in Porto.",
    ]);
    // Queued against the chat they were said in, like any other note.
    expect(entries.every((e) => e.chatId === GROUP_ID)).toBe(true);
  });

  /**
   * The defect behind the operator's wrong memory: `known_users.aliases` was
   * curated, and already injected into DM replies, but extraction built its roster
   * from the display label alone. A group calls people by nickname, so the model
   * saw statements by "Гоша"-equivalents it could not tie to any offered id — and
   * with nowhere to file them, such facts are now dropped outright. The aliases are
   * what keep them attributable instead of lost.
   */
  it("puts each person's aliases on the roster, so a nickname in chat still reaches their id", async () => {
    await seedUser(ADA, "Ada", ["Ace", "A."]);
    await seedUser(GRACE, "Grace");
    await seedGroup();
    await seedMessage({ telegramMessageId: 1, userId: ADA, content: "Ace here, I'm a vet" });
    await seedMessage({ telegramMessageId: 2, userId: GRACE, content: "hi Ace" });

    const { deps, calls } = scriptedExtractor([JSON.stringify({ facts: [] })]);
    await runMemoryExtraction(deps, ctx.db);

    const roster = calls[0][1].content as string;
    expect(roster).toContain(`[id:${ADA}] Ada (@ada) — also called: Ace, A.`);
    // Someone with no aliases is offered plainly, with no dangling clause.
    expect(roster).toContain(`[id:${GRACE}] Grace (@grace)\n`);
  });

  it("hands the extracted facts to consolidation, reaching durable memory the same night", async () => {
    await seedUser(ADA, "Ada");
    await seedMessage({ telegramMessageId: 1, userId: ADA, content: "I'm a vet, by the way" });

    await runMemoryExtraction(
      scriptedExtractor([
        JSON.stringify({
          facts: [{ scope: "user", user_id: ADA, content: "Ada is a veterinarian." }],
        }),
      ]).deps,
      ctx.db,
    );
    // The consolidator neither knows nor cares which producer queued the note.
    await runMemoryConsolidation(
      scriptedLlm([JSON.stringify({ memory: "Ada is a veterinarian." })]).deps,
    );

    const stored = await getUserMemory(ctx.db, ADA);
    expect(stored?.content).toBe("Ada is a veterinarian.");
    expect(await listMemoryEntries(ctx.db)).toHaveLength(0);
  });

  it("never re-reads an unchanged day, but re-reads one that gained messages", async () => {
    await seedUser(ADA, "Ada");
    await seedMessage({ telegramMessageId: 1, userId: ADA, content: "hi" });

    const first = scriptedExtractor([JSON.stringify({ facts: [] })]);
    await runMemoryExtraction(first.deps, ctx.db);
    expect(first.calls).toHaveLength(1);

    // A day that yielded nothing is still marked read â€” otherwise a chat-day of
    // pure noise would cost an LLM pass every single night, forever.
    const second = scriptedExtractor([JSON.stringify({ facts: [] })]);
    const rerun = await runMemoryExtraction(second.deps, ctx.db);
    expect(second.calls).toHaveLength(0);
    expect(rerun.summary).toBe("nothing to extract");

    // But a day that gained a message is genuinely new work again (self-healing).
    await seedMessage({ telegramMessageId: 2, userId: ADA, content: "I'm a vet" });
    const third = scriptedExtractor([
      JSON.stringify({ facts: [{ scope: "user", user_id: ADA, content: "Ada is a vet." }] }),
    ]);
    const healed = await runMemoryExtraction(third.deps, ctx.db);
    expect(third.calls).toHaveLength(1);
    expect(healed).toMatchObject({ days: 1, notes: 1 });
  });

  it("skips today â€” it is unfinished and already injected verbatim", async () => {
    await seedUser(ADA, "Ada");
    await seedMessage({
      telegramMessageId: 1,
      userId: ADA,
      content: "said today",
      at: NOW.toISOString(),
    });

    const { deps, calls } = scriptedExtractor([JSON.stringify({ facts: [] })]);
    const result = await runMemoryExtraction(deps, ctx.db);
    expect(calls).toHaveLength(0);
    expect(result.summary).toBe("nothing to extract");
  });

  /**
   * Regression from the first live run: imported history holds senders who were
   * never registered as known users, and `memory_entries.user_id` references
   * `known_users`. The roster used to be built from the transcript's ids, so the
   * model extracted a good fact about such a person and the store refused it.
   */
  it("keeps an unregistered sender off the roster instead of harvesting facts it cannot store", async () => {
    await seedUser(ADA, "Ada");
    // GRACE speaks in the mirror but was never registered as a known user.
    await seedMessage({ telegramMessageId: 1, userId: ADA, content: "I'm a vet" });
    await seedMessage({ telegramMessageId: 2, userId: GRACE, content: "I live in Porto" });

    const { deps, calls } = scriptedExtractor([
      JSON.stringify({
        facts: [{ scope: "user", user_id: ADA, content: "Ada is a veterinarian." }],
      }),
    ]);
    const result = await runMemoryExtraction(deps, ctx.db);

    const prompt = calls[0][1].content as string;
    expect(prompt).toContain(`[id:${ADA}] Ada`);
    expect(prompt).not.toContain(`[id:${GRACE}]`);
    // Still present as context — what they said may be evidence about Ada.
    expect(prompt).toContain("I live in Porto");

    expect(result.notes).toBe(1);
    expect(await listMemoryEntries(ctx.db)).toHaveLength(1);
  });

  it("drops a fact attributed to someone who was not in the day", async () => {
    await seedUser(ADA, "Ada");
    await seedMessage({ telegramMessageId: 1, userId: ADA, content: "hey" });

    const result = await runMemoryExtraction(
      scriptedExtractor([
        JSON.stringify({
          facts: [
            { scope: "user", user_id: "999999", content: "A stranger lives on Mars." },
            { scope: "general", content: "The office is closed on Fridays." },
          ],
        }),
      ]).deps,
      ctx.db,
    );

    expect(result.notes).toBe(1);
    const entries = await listMemoryEntries(ctx.db);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: "general", userId: null });
  });

  it("traces the day under its own feature, so the operator can audit what it decided", async () => {
    await seedUser(ADA, "Ada");
    await seedMessage({ telegramMessageId: 1, userId: ADA, content: "I have a dog named Rex" });

    await runMemoryExtraction(
      scriptedExtractor([
        JSON.stringify({
          facts: [{ scope: "user", user_id: ADA, content: "Ada has a dog named Rex." }],
        }),
      ]).deps,
      ctx.db,
    );

    const traces = await listTraces({
      feature: "memory-extraction",
      limit: 10,
      offset: 0,
    });
    expect(traces.traces).toHaveLength(1);
    expect(traces.traces[0]).toMatchObject({ action: "extract", status: "success" });
    expect(traces.traces[0].outputSummary).toContain("1 fact(s)");
  });
});
