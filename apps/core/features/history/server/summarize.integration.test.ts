import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { insertMedia, markDescribed } from "@/features/vision/server/repository";
import { EMBEDDING_DIMENSIONS } from "@/lib/embeddings";
import type { ChatCompletionResult, ChatMessage } from "@/server/llm/client";
import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";

import { recordAssistantMessage, recordIncomingMessage } from "./service";
import {
  countDaysNeedingSummary,
  listChatSummaries,
  listDaysNeedingSummary,
  searchChatSummaries,
} from "./summaries-repository";
import { runSummarization, summarizeChatDay, type SummarizeDeps } from "./summarize";

/**
 * Summarization end to end against real Postgres (with pgvector), driven by a
 * deterministic model and embedder — no LLM, no network. Proves the whole path:
 * due-scan → LLM pass → embed → store → search, plus the idempotency and
 * self-healing rules the job leans on.
 */

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const CHAT = "555";
/** "Now" for the run: the 14th, so the 13th is a finished, summarizable day. */
const NOW = new Date("2026-07-14T12:00:00.000Z");
const YESTERDAY = "2026-07-13";

/** A completion carrying `content`, shaped like the real client's result. */
function completion(content: string): ChatCompletionResult {
  return {
    content,
    model: "test-model",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    latencyMs: 1,
    requestBody: {},
    responseBody: { choices: [{ message: { content } }] },
  };
}

/** A deterministic vector — distinct per text, so ranking is meaningful. */
function fakeVector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === seed % EMBEDDING_DIMENSIONS ? 1 : 0));
}

/** Deps whose model returns `topics` verbatim and whose embedder is deterministic. */
function deps(overrides: Partial<SummarizeDeps> = {}): SummarizeDeps {
  return {
    complete: vi.fn(async () =>
      completion(
        JSON.stringify({
          topics: [{ content: "They discussed the broken deploy", message_ids: [1, 2] }],
        }),
      ),
    ),
    embed: vi.fn(async (texts: string[]) => texts.map((_, i) => fakeVector(i + 1))),
    timeZone: "UTC",
    now: () => NOW,
    ...overrides,
  };
}

/** Seed a two-message exchange on the given day. */
async function seedDay(date: string, startId = 1): Promise<void> {
  await recordIncomingMessage(
    {
      chatId: CHAT,
      telegramMessageId: startId,
      userId: "100",
      content: "the deploy is broken again",
      sentAt: new Date(`${date}T10:00:00.000Z`),
    },
    ctx.db,
  );
  await recordAssistantMessage(
    {
      chatId: CHAT,
      telegramMessageId: startId + 1,
      content: "I rolled it back",
      replyToMessageId: startId,
      sentAt: new Date(`${date}T10:00:05.000Z`),
    },
    ctx.db,
  );
}

describe("summarizeChatDay", () => {
  it("summarizes a day, embeds the topics, and stores them with their message ids", async () => {
    await seedDay(YESTERDAY);

    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps(),
      { kind: "test" },
      ctx.db,
    );

    expect(result).toMatchObject({ messageCount: 2, topicCount: 1, embedded: true });

    const stored = await listChatSummaries(ctx.db, CHAT);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      summaryDate: YESTERDAY,
      content: "They discussed the broken deploy",
      messageIds: [1, 2],
      embedded: true,
    });
  });

  it("shows the model an id-anchored transcript with resolved speakers", async () => {
    await seedDay(YESTERDAY);
    const d = deps();

    await summarizeChatDay({ chatId: CHAT, summaryDate: YESTERDAY }, d, { kind: "test" }, ctx.db);

    const [messages] = (d.complete as unknown as { mock: { calls: [ChatMessage[]][] } }).mock
      .calls[0];
    const prompt = messages[1].content as string;
    expect(prompt).toContain("[#1]");
    expect(prompt).toContain("the deploy is broken again");
    // The bot's own turns are labelled, so the model knows who said what.
    expect(prompt).toContain("Bot: I rolled it back");
  });

  it("is idempotent: re-summarizing a day replaces its topics rather than duplicating them", async () => {
    await seedDay(YESTERDAY);

    await summarizeChatDay({ chatId: CHAT, summaryDate: YESTERDAY }, deps(), { kind: "test" }, ctx.db);
    await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps({
        complete: async () =>
          completion(JSON.stringify({ topics: [{ content: "A better summary", message_ids: [2] }] })),
      }),
      { kind: "test" },
      ctx.db,
    );

    const stored = await listChatSummaries(ctx.db, CHAT);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("A better summary");
  });

  it("stores the topics even when embedding fails — recall degrades, the summary is not lost", async () => {
    await seedDay(YESTERDAY);

    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps({
        embed: async () => {
          throw new Error("embedding endpoint down");
        },
      }),
      { kind: "test" },
      ctx.db,
    );

    expect(result).toMatchObject({ topicCount: 1, embedded: false });
    const stored = await listChatSummaries(ctx.db, CHAT);
    expect(stored[0]).toMatchObject({ content: "They discussed the broken deploy", embedded: false });
  });

  it("stores topics without vectors when no embedding model is configured", async () => {
    await seedDay(YESTERDAY);

    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps({ embed: null }),
      { kind: "test" },
      ctx.db,
    );

    expect(result).toMatchObject({ topicCount: 1, embedded: false });
    expect((await listChatSummaries(ctx.db, CHAT))[0].embedded).toBe(false);
  });

  it("marks a day of pure noise as done, so it is never re-summarized", async () => {
    await seedDay(YESTERDAY);

    await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps({ complete: async () => completion('{"topics":[]}') }),
      { kind: "test" },
      ctx.db,
    );

    expect(await listChatSummaries(ctx.db, CHAT)).toHaveLength(0);
    // The marker was still written: the day no longer counts as pending work.
    expect(
      await listDaysNeedingSummary(ctx.db, { timeZone: "UTC", today: "2026-07-14", limit: 10 }),
    ).toEqual([]);
  });

  it("splits a busy day into several model passes and unions the topics", async () => {
    // 40 long messages blow past the batch budget.
    for (let i = 1; i <= 40; i += 1) {
      await recordIncomingMessage(
        {
          chatId: CHAT,
          telegramMessageId: i,
          userId: "100",
          content: "x".repeat(1000),
          sentAt: new Date(`${YESTERDAY}T10:00:00.000Z`),
        },
        ctx.db,
      );
    }
    let call = 0;
    const complete = vi.fn(async () => {
      call += 1;
      return completion(
        JSON.stringify({ topics: [{ content: `Topic from pass ${call}`, message_ids: [call] }] }),
      );
    });

    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps({ complete }),
      { kind: "test" },
      ctx.db,
    );

    expect(complete.mock.calls.length).toBeGreaterThan(1);
    expect(result.topicCount).toBe(complete.mock.calls.length);
  });

  it("annotates media messages with their descriptions and drops unreadable blank lines", async () => {
    await seedDay(YESTERDAY);
    // #3: a photo with no caption whose image vision has described.
    await recordIncomingMessage(
      {
        chatId: CHAT,
        telegramMessageId: 3,
        userId: "100",
        content: "",
        sentAt: new Date(`${YESTERDAY}T11:00:00.000Z`),
        hasMedia: true,
      },
      ctx.db,
    );
    const media = await insertMedia(ctx.db, {
      id: crypto.randomUUID(),
      chatId: CHAT,
      telegramMessageId: 3,
      kind: "photo",
      fileId: "file-3",
      dataBase64: "aGk=",
    });
    await markDescribed(ctx.db, media!.id, "a cat asleep on a keyboard");
    // #4: an empty media row the vision feature knows nothing about — unreadable.
    await recordIncomingMessage(
      {
        chatId: CHAT,
        telegramMessageId: 4,
        userId: "100",
        content: "",
        sentAt: new Date(`${YESTERDAY}T11:01:00.000Z`),
        hasMedia: true,
      },
      ctx.db,
    );

    const d = deps();
    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      d,
      { kind: "test" },
      ctx.db,
    );

    const [messages] = (d.complete as unknown as { mock: { calls: [ChatMessage[]][] } }).mock
      .calls[0];
    const prompt = messages[1].content as string;
    // The described photo reads as text; the unreadable row makes no blank line.
    expect(prompt).toContain("[photo: a cat asleep on a keyboard]");
    expect(prompt).not.toContain("[#4]");
    // The marker records the raw day count (4 rows), so the count comparison in
    // the due-scan still sees the day as unchanged.
    expect(result.messageCount).toBe(4);
    expect(
      await listDaysNeedingSummary(ctx.db, { timeZone: "UTC", today: "2026-07-14", limit: 10 }),
    ).toEqual([]);
  });

  it("recovers from a model context overflow by re-batching smaller", async () => {
    for (let i = 1; i <= 40; i += 1) {
      await recordIncomingMessage(
        {
          chatId: CHAT,
          telegramMessageId: i,
          userId: "100",
          content: "x".repeat(1000),
          sentAt: new Date(`${YESTERDAY}T10:00:00.000Z`),
        },
        ctx.db,
      );
    }
    // A model whose real context fits ~20k prompt chars: the first 24k-budget
    // batch is rejected the way llama.cpp words it (pinned live phrasing); the
    // re-batched halves fit.
    let pass = 0;
    const complete = vi.fn(async (messages: ChatMessage[]) => {
      const prompt = messages[1].content as string;
      if (prompt.length > 20_000) {
        throw new Error("LLM endpoint error (500): Context size has been exceeded.");
      }
      pass += 1;
      return completion(
        JSON.stringify({ topics: [{ content: `Topic from pass ${pass}`, message_ids: [pass] }] }),
      );
    });

    const result = await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps({ complete }),
      { kind: "test" },
      ctx.db,
    );

    // Every pass eventually succeeded and the day settled — no stuck retry loop.
    expect(result.topicCount).toBe(pass);
    expect(complete.mock.calls.length).toBeGreaterThan(pass); // at least one rejection
    expect(
      await listDaysNeedingSummary(ctx.db, { timeZone: "UTC", today: "2026-07-14", limit: 10 }),
    ).toEqual([]);
  });

  it("records the run as a trace with the full request and response bodies", async () => {
    await seedDay(YESTERDAY);

    await summarizeChatDay({ chatId: CHAT, summaryDate: YESTERDAY }, deps(), { kind: "test" }, ctx.db);

    const { traces } = await listTraces({ feature: "history-summaries" });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ action: "summarize", status: "success" });
    expect(traces[0].outputSummary).toContain("1 topic(s) from 2 message(s)");
  });
});

describe("listDaysNeedingSummary", () => {
  it("offers finished days with messages, and never today", async () => {
    await seedDay(YESTERDAY, 1);
    await seedDay("2026-07-14", 10); // today — unfinished

    const pending = await listDaysNeedingSummary(ctx.db, {
      timeZone: "UTC",
      today: "2026-07-14",
      limit: 10,
    });

    expect(pending).toEqual([{ chatId: CHAT, summaryDate: YESTERDAY, messageCount: 2 }]);
  });

  it("buckets days by the operator's wall clock, not UTC's", async () => {
    // 22:00 UTC on the 13th is already the 14th in Kyiv (UTC+3) — i.e. today, and
    // therefore not yet summarizable there, though it would be under UTC.
    await recordIncomingMessage(
      {
        chatId: CHAT,
        telegramMessageId: 1,
        userId: "100",
        content: "late night",
        sentAt: new Date("2026-07-13T22:00:00.000Z"),
      },
      ctx.db,
    );

    expect(
      await listDaysNeedingSummary(ctx.db, { timeZone: "UTC", today: "2026-07-14", limit: 10 }),
    ).toEqual([{ chatId: CHAT, summaryDate: "2026-07-13", messageCount: 1 }]);

    expect(
      await listDaysNeedingSummary(ctx.db, {
        timeZone: "Europe/Kyiv",
        today: "2026-07-14",
        limit: 10,
      }),
    ).toEqual([]);
  });

  it("re-offers a day that gained messages after it was summarized (a CSV import, a late edit)", async () => {
    await seedDay(YESTERDAY);
    await summarizeChatDay({ chatId: CHAT, summaryDate: YESTERDAY }, deps(), { kind: "test" }, ctx.db);

    expect(
      await countDaysNeedingSummary(ctx.db, { timeZone: "UTC", today: "2026-07-14" }),
    ).toBe(0);

    // A third message lands on that same (already summarized) day.
    await recordIncomingMessage(
      {
        chatId: CHAT,
        telegramMessageId: 3,
        userId: "100",
        content: "one more thing",
        sentAt: new Date(`${YESTERDAY}T18:00:00.000Z`),
      },
      ctx.db,
    );

    expect(
      await listDaysNeedingSummary(ctx.db, { timeZone: "UTC", today: "2026-07-14", limit: 10 }),
    ).toEqual([{ chatId: CHAT, summaryDate: YESTERDAY, messageCount: 3 }]);
  });
});

describe("runSummarization", () => {
  it("summarizes the whole backlog, oldest day first", async () => {
    await seedDay("2026-07-11", 1);
    await seedDay("2026-07-12", 10);
    await seedDay(YESTERDAY, 20);

    const d = deps();
    const result = await runSummarization(d, ctx.db);

    expect(result).toMatchObject({ days: 3, topics: 3, failures: 0 });
    expect(result.summary).toBe("3 day(s) summarized, 3 topic(s)");
    expect(await countDaysNeedingSummary(ctx.db, { timeZone: "UTC", today: "2026-07-14" })).toBe(0);

    const stored = await listChatSummaries(ctx.db, CHAT);
    expect(stored.map((s) => s.summaryDate)).toEqual(["2026-07-13", "2026-07-12", "2026-07-11"]);
  });

  it("summarizes retroactively: a whole history back to its oldest day, in one run", async () => {
    // 60 days of history — more than one due-scan page (25), which is what a real
    // pre-existing chat or a CSV import looks like on the first run.
    const days: string[] = [];
    for (let i = 1; i <= 60; i += 1) {
      const date = new Date(Date.UTC(2026, 4, 1) + (i - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      days.push(date);
      await seedDay(date, i * 10);
    }

    const result = await runSummarization(deps(), ctx.db);

    // Every day, back to the oldest — not just the most recent page of them.
    expect(result.days).toBe(60);
    expect(await countDaysNeedingSummary(ctx.db, { timeZone: "UTC", today: "2026-07-14" })).toBe(0);
    const stored = await listChatSummaries(ctx.db, CHAT, 500);
    expect(new Set(stored.map((s) => s.summaryDate)).size).toBe(60);
    expect(stored.at(-1)?.summaryDate).toBe(days[0]);
  });

  it("is a no-op when everything is already summarized", async () => {
    await seedDay(YESTERDAY);
    await runSummarization(deps(), ctx.db);

    const d = deps();
    const second = await runSummarization(d, ctx.db);

    expect(second).toMatchObject({ days: 0, topics: 0, summary: "nothing to summarize" });
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("keeps going when one day fails, and leaves that day pending for the next run", async () => {
    await seedDay("2026-07-12", 1);
    await seedDay(YESTERDAY, 10);

    let call = 0;
    const complete = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("model exploded");
      return completion(JSON.stringify({ topics: [{ content: "Second day", message_ids: [10] }] }));
    });

    const result = await runSummarization(deps({ complete }), ctx.db);

    expect(result).toMatchObject({ days: 1, topics: 1, failures: 1 });
    // The failed (oldest) day is still owed; the successful one is not.
    expect(
      await listDaysNeedingSummary(ctx.db, { timeZone: "UTC", today: "2026-07-14", limit: 10 }),
    ).toEqual([{ chatId: CHAT, summaryDate: "2026-07-12", messageCount: 2 }]);
  });
});

describe("searchChatSummaries", () => {
  /** Store three topics with known vectors so both halves of the hybrid can be checked. */
  async function seedTopics(): Promise<void> {
    await seedDay(YESTERDAY);
    await summarizeChatDay(
      { chatId: CHAT, summaryDate: YESTERDAY },
      deps({
        complete: async () =>
          completion(
            JSON.stringify({
              topics: [
                { content: "The deploy broke and was rolled back", message_ids: [1, 2] },
                { content: "Lunch plans for Friday", message_ids: [3] },
                { content: "Someone adopted a kitten", message_ids: [4] },
              ],
            }),
          ),
        // Topic i gets the unit vector on axis i+1.
        embed: async (texts) => texts.map((_, i) => fakeVector(i + 1)),
      }),
      { kind: "test" },
      ctx.db,
    );
  }

  it("finds a topic by wording (full text) with no vector at all", async () => {
    await seedTopics();

    const hits = await searchChatSummaries(ctx.db, {
      chatId: CHAT,
      queryText: "kitten",
      queryVector: null,
      limit: 5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("kitten");
  });

  it("finds a topic by meaning (vector) when the wording does not match", async () => {
    await seedTopics();

    // A query whose words appear in no summary, but whose vector is the second
    // topic's: pure full text would return nothing here.
    const hits = await searchChatSummaries(ctx.db, {
      chatId: CHAT,
      queryText: "zzzz-nonmatching-token",
      queryVector: fakeVector(2),
      limit: 3,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toBe("Lunch plans for Friday");
  });

  it("ranks a topic found by both halves above one found by only one", async () => {
    await seedTopics();

    const hits = await searchChatSummaries(ctx.db, {
      chatId: CHAT,
      // Lexically matches "deploy"; vector points at the deploy topic too.
      queryText: "deploy",
      queryVector: fakeVector(1),
      limit: 5,
    });

    expect(hits[0].content).toBe("The deploy broke and was rolled back");
    expect(hits[0].score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("never leaks another chat's topics", async () => {
    await seedTopics();

    const hits = await searchChatSummaries(ctx.db, {
      chatId: "999",
      queryText: "deploy",
      queryVector: fakeVector(1),
      limit: 5,
    });

    expect(hits).toEqual([]);
  });
});
