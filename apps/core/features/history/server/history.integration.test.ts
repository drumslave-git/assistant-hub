import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { upsertKnownUser } from "@/features/known-users/server/repository";
import { listTraces, startTrace } from "@/server/trace";
import { fakeSourceContent, type FakeSourceContent } from "@/test/fake-source-content";
import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";

import { getChatHistory, getHistoryOverview, loadChatDayTranscript } from "./service";

/**
 * The history feature's read side since the swap: the mirror lives with the
 * owning source (the in-memory fake here), and this side composes the
 * dashboard views and the day transcripts the nightly jobs read. What the
 * source's own SQL does (windows, aggregates) is pinned in the tg content
 * suite; what THIS file pins is the composition — labels, annotations,
 * trace links, day filtering.
 */

let content: FakeSourceContent;
vi.mock("@/server/source/tg-content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/source/tg-content")>();
  return { ...actual, requireSourceContent: () => content, resolveSourceContent: () => content };
});
vi.mock("@/server/source-store/directory-client", () => ({
  sourceDirectoryClient: () => ({
    listChats: async () => [
      {
        id: "-1009",
        kind: "group",
        title: "Fixture Group",
        type: "supergroup",
        notes: null,
        language: null,
        messageCount: 3,
        lastMessageAt: "2026-07-14T12:00:00.000Z",
      },
      {
        id: "-1010",
        kind: "group",
        title: "Quiet Group",
        type: "supergroup",
        notes: null,
        language: null,
        messageCount: 0,
        lastMessageAt: null,
      },
    ],
  }),
}));

let ctx: TestStoreDb;

beforeAll(async () => {
  ctx = await startTestStoreDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
  content = fakeSourceContent();
});

const CHAT = "555";

describe("getChatHistory", () => {
  it("annotates rows with media descriptions, reactions, and trace links", async () => {
    content.addMessage({
      chatId: CHAT,
      telegramMessageId: 10,
      userId: "100",
      content: "what's this?",
      botReaction: "👍",
    });
    content.addMessage({
      chatId: CHAT,
      telegramMessageId: 11,
      role: "assistant",
      content: "a lighthouse",
      replyToMessageId: 10,
    });
    content.addMessage({
      chatId: CHAT,
      telegramMessageId: 12,
      userId: "100",
      content: "",
      media: { kind: "photo", status: "described", description: "a striped lighthouse" },
    });
    // The trace that handled the #10 turn: both its rows must link to it.
    const trace = await startTrace({
      feature: "bot-messaging",
      action: "reply",
      trigger: { kind: "transport", actor: "100", correlationId: `${CHAT}:10` },
    });
    await trace.succeed();

    const rows = await getChatHistory(CHAT);
    expect(rows).toHaveLength(3);
    const asked = rows.find((r) => r.telegramMessageId === 10)!;
    const answered = rows.find((r) => r.telegramMessageId === 11)!;
    const photo = rows.find((r) => r.telegramMessageId === 12)!;
    expect(asked.traceId).not.toBeNull();
    expect(answered.traceId).toBe(asked.traceId);
    expect(asked.mediaSuffix).toContain("you reacted");
    expect(photo.mediaSuffix).toContain("[photo: a striped lighthouse]");
    expect(photo.traceId).toBeNull();
  });
});

describe("getHistoryOverview", () => {
  it("lists chats with traffic, from the source's aggregates", async () => {
    const overview = await getHistoryOverview();
    expect(overview).toEqual([
      { chatId: "-1009", messageCount: 3, lastSentAt: "2026-07-14T12:00:00.000Z" },
    ]);
    const { traces } = await listTraces({ feature: "history" });
    // Reads stay untraced, like every dashboard read.
    expect(traces).toEqual([]);
  });
});

describe("loadChatDayTranscript", () => {
  it("loads one wall-clock day with labels and annotations, dropping blank rows", async () => {
    await upsertKnownUser(ctx.db, {
      userId: "100",
      username: "alice_example",
      firstName: "Alice",
      lastName: null,
    });
    content.addMessage({
      chatId: CHAT,
      telegramMessageId: 1,
      userId: "100",
      content: "morning",
      sentAt: new Date("2026-07-13T08:00:00.000Z"),
    });
    content.addMessage({
      chatId: CHAT,
      telegramMessageId: 2,
      role: "assistant",
      content: "good morning",
      sentAt: new Date("2026-07-13T08:00:05.000Z"),
    });
    // Blank and unreadable — counted, not rendered.
    content.addMessage({
      chatId: CHAT,
      telegramMessageId: 3,
      userId: "100",
      content: "",
      sentAt: new Date("2026-07-13T09:00:00.000Z"),
    });
    // The next day stays out of this day's read.
    content.addMessage({
      chatId: CHAT,
      telegramMessageId: 4,
      userId: "100",
      content: "next day",
      sentAt: new Date("2026-07-14T08:00:00.000Z"),
    });

    const day = await loadChatDayTranscript(content, ctx.db, CHAT, "2026-07-13", "UTC");
    expect(day.dayMessageCount).toBe(3);
    expect(day.messages.map((m) => m.telegramMessageId)).toEqual([1, 2]);
    expect(day.messages[0].label).toContain("Alice");
    expect(day.messages[1].label).toBe("Bot");
  });
});
