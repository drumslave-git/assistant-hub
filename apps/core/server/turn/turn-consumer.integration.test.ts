import { fileURLToPath } from "node:url";

import {
  inboundMessageEventSchema,
  replyDeliveryEventSchema,
  turnLifecycleEventSchema,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub/db/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import type { MediaRecord } from "@/features/vision/server/repository";
import type { DescribeDeps, MediaStorePort } from "@/features/vision/server/service";
import type { ChatMessage } from "@/server/llm/client";

import { createTurnActionMarkers } from "./actions";
import { handleInboundJob, type TurnConsumerContext } from "./consume";

const V1_MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const STORE_MIGRATIONS = fileURLToPath(new URL("../../store/migrations", import.meta.url));

/** A fully-addressed synthetic inbound event (invented ids/names only). */
function inboundEvent(overrides?: {
  addressed?: boolean;
  needsAnalyzer?: boolean;
  eventId?: string;
}): InboundMessageEvent {
  return inboundMessageEventSchema.parse({
    v: 1,
    eventId: overrides?.eventId ?? "evt-1",
    occurredAt: new Date().toISOString(),
    correlationId: "-300:11",
    type: "message.inbound",
    source: "tg",
    assistantId: "assistant-1",
    connection: { botUsername: "fixture_bot", botDisplayName: "Fixture" },
    chat: {
      ref: "tg:chat:-300",
      kind: "group",
      title: "Fixture Group",
      notes: "seeded for the consumer test",
      language: "English",
    },
    sender: {
      ref: "tg:user:5001",
      isOwner: false,
      label: "Alice (@alice_example)",
      username: "alice_example",
      aliases: ["Al"],
    },
    addressing: {
      addressed: overrides?.addressed ?? true,
      source: overrides?.addressed === false ? null : "mention",
      needsAnalyzer: overrides?.needsAnalyzer ?? false,
    },
    message: {
      sourceMessageId: "11",
      content: "@fixture_bot what did Bob say?",
      sentAt: new Date().toISOString(),
      replyTo: {
        sourceMessageId: "10",
        stored: true,
        senderLabel: "Bob (@bob_example)",
        text: "earlier chatter",
      },
    },
    context: {
      history: [
        {
          sourceMessageId: "10",
          role: "user",
          senderRef: "tg:user:5002",
          senderLabel: "Bob (@bob_example)",
          content: "earlier chatter",
          sentAt: new Date(Date.now() - 60_000).toISOString(),
          botReaction: "👍",
        },
        {
          sourceMessageId: "9",
          role: "assistant",
          senderRef: null,
          senderLabel: null,
          content: "an earlier reply",
          sentAt: new Date(Date.now() - 120_000).toISOString(),
        },
      ],
      participants: [
        { ref: "tg:user:5001", label: "Alice (@alice_example)", aliases: ["Al"] },
        { ref: "tg:user:5002", label: "Bob (@bob_example)", aliases: [] },
      ],
    },
  });
}

describe("inbound turn consumer", () => {
  let pg: TestPostgres;
  let storePool: Pool;
  let published: unknown[];
  let reEnqueued: Array<{ eventId: string; attempt: number }>;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const v1Url = await pg.createDatabase("v1_brain");
    const storeUrl = await pg.createDatabase("core_store");
    await applyMigrations(v1Url, V1_MIGRATIONS);
    await applyMigrations(storeUrl, STORE_MIGRATIONS);
    // The brain services (policy, persona, memory, tasks) read the v1 DB via
    // the app's own pool; the markers live in the v2 store.
    process.env.DATABASE_URL = v1Url;
    process.env.STORE_DATABASE_URL = storeUrl;
    storePool = new Pool({ connectionString: storeUrl });
  });

  afterAll(async () => {
    await storePool?.end();
    await closePool();
    await pg?.stop();
  });

  beforeEach(async () => {
    published = [];
    reEnqueued = [];
    await storePool.query(`DELETE FROM turn_actions`);
  });

  function ctx(overrides?: TurnConsumerContext["overrides"]): TurnConsumerContext {
    return {
      publish: async (payload) => {
        published.push(payload);
      },
      markers: createTurnActionMarkers(storePool),
      reEnqueue: async (event, attempt) => {
        reEnqueued.push({ eventId: event.eventId, attempt });
      },
      overrides,
    };
  }

  it("runs an addressed turn: composed context in, delivery + lifecycle out, marker cleared", async () => {
    const seen: ChatMessage[][] = [];
    const result = await handleInboundJob(inboundEvent(), 1, ctx({
      generateReply: async (messages) => {
        seen.push(messages);
        return { content: "the consumer answer", model: "fixture-model", latencyMs: 1 };
      },
    }));

    expect(result.status).toBe("handled");
    expect(result.status === "handled" && result.outcome.status).toBe("replied");

    // Lifecycle + delivery, in order: accepted → delivery → settled.
    const types = published.map((p) => (p as { type: string; phase?: string }));
    expect(types.map((p) => p.phase ?? p.type)).toEqual([
      "accepted",
      "reply.delivery",
      "settled",
    ]);
    const delivery = replyDeliveryEventSchema.parse(published[1]);
    expect(delivery).toMatchObject({
      chatRef: "tg:chat:-300",
      assistantId: "assistant-1",
      replyToSourceMessageId: "11",
      text: "the consumer answer",
      correlationId: "-300:11",
    });
    for (const lifecycle of [published[0], published[2]]) {
      expect(turnLifecycleEventSchema.parse(lifecycle)).toMatchObject({
        chatRef: "tg:chat:-300",
        sourceMessageId: "11",
      });
    }

    // The prompt was composed from the event: v1 transcript format with the
    // event-supplied labels, reactions, and reply anchors; the roster block
    // carries the participants and notes.
    const messages = seen[0];
    const transcript = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[#10]"),
    );
    expect(transcript?.content).toContain(
      "[#10] Bob (@bob_example): earlier chatter [you reacted: 👍]",
    );
    expect(transcript?.content).toContain("[#9] You (@fixture_bot): an earlier reply");
    const roster = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("Known participants"),
    );
    expect(roster?.content).toContain("Alice (@alice_example) [user id 5001] — also known as: Al");
    expect(roster?.content).toContain("About this group: seeded for the consumer test");
    const currentTurn = messages.find(
      (m) => typeof m.content === "string" && m.content.startsWith("[#11]"),
    );
    expect(currentTurn?.content).toBe(
      '[#11] Alice (@alice_example) [reply to #10]: @fixture_bot what did Bob say?',
    );

    // The send marked the turn as acted, and the terminal settle cleared it.
    const markers = await storePool.query(`SELECT * FROM turn_actions`);
    expect(markers.rows).toEqual([]);
  });

  it("ignores an unaddressed turn but still settles it (the source releases its hold)", async () => {
    const result = await handleInboundJob(
      inboundEvent({ addressed: false, needsAnalyzer: false, eventId: "evt-2" }),
      1,
      ctx({
        generateReply: async () => {
          throw new Error("must not generate for an unaddressed turn");
        },
      }),
    );
    expect(result.status === "handled" && result.outcome.status).toBe("ignored");
    // No typing for chatter nobody addressed — only the settle.
    expect(
      published.map((p) => (p as { phase?: string; type: string }).phase ?? (p as { type: string }).type),
    ).toEqual(["settled"]);
  });

  it("delivers the v1 error notice on a generation failure — an action, so no retry", async () => {
    const result = await handleInboundJob(inboundEvent({ eventId: "evt-err" }), 1, ctx({
      generateReply: async () => {
        throw new Error("provider exploded");
      },
    }));
    // The service catches its own turn errors and apologizes in-chat (v1
    // behavior); that send IS an action, so the job is handled, not retried.
    expect(result.status === "handled" && result.outcome.status).toBe("error");
    expect(reEnqueued).toEqual([]);
    const delivery = published.find((p) => (p as { type: string }).type === "reply.delivery");
    expect(replyDeliveryEventSchema.parse(delivery).text.length).toBeGreaterThan(0);
    const phases = published.map((p) => (p as { phase?: string }).phase);
    expect(phases).toContain("settled");
    const markers = await storePool.query(`SELECT * FROM turn_actions`);
    expect(markers.rows).toEqual([]);
  });

  const failingRunTurn = async (): Promise<never> => {
    throw new Error("infrastructure failure before the turn ran");
  };

  it("re-enqueues a pre-action failure without settling the turn", async () => {
    const result = await handleInboundJob(
      inboundEvent({ eventId: "evt-3" }),
      1,
      ctx(),
      failingRunTurn,
    );
    expect(result.status).toBe("retried");
    expect(reEnqueued).toEqual([{ eventId: "evt-3", attempt: 2 }]);
    // The turn is still live: no settled event, so the source keeps its
    // mirror hold in place until a later attempt settles.
    const phases = published.map((p) => (p as { phase?: string }).phase);
    expect(phases).not.toContain("settled");
  });

  it("never retries once the turn has acted: fails, settles, clears", async () => {
    const event = inboundEvent({ eventId: "evt-4" });
    const context = ctx();
    // An action started (a tool began, a send left) before the failure.
    await context.markers.mark(event.correlationId);

    await expect(handleInboundJob(event, 1, context, failingRunTurn)).rejects.toThrow(
      "infrastructure failure",
    );
    expect(reEnqueued).toEqual([]);
    const phases = published.map((p) => (p as { phase?: string }).phase);
    expect(phases).toContain("settled");
    const markers = await storePool.query(`SELECT * FROM turn_actions`);
    expect(markers.rows).toEqual([]);
  });

  it("recognizes a pending photo through the media store and folds the text into the turn", async () => {
    let record: MediaRecord = {
      id: "media-1",
      chatId: "-300",
      telegramMessageId: 12,
      kind: "photo",
      fileId: "",
      fileUniqueId: null,
      mimeType: "image/jpeg",
      dataBase64: Buffer.from("fake-jpeg").toString("base64"),
      frames: null,
      visionHint: null,
      description: null,
      status: "pending",
      createdAt: new Date().toISOString(),
      describedAt: null,
    };
    const described: string[] = [];
    const mediaStore: MediaStorePort = {
      getByMessage: async () => record,
      markDescribed: async (_id, description) => {
        described.push(description);
        record = { ...record, description, status: "described", dataBase64: null, frames: null };
        return record;
      },
      getById: async () => record,
    };
    const describeDeps: DescribeDeps = {
      complete: async () => ({
        content: "a red bicycle",
        model: "vision-model",
        latencyMs: 1,
        requestBody: {},
        responseBody: {},
      }),
    };
    const seen: ChatMessage[][] = [];

    const event = inboundMessageEventSchema.parse({
      ...inboundEvent({ eventId: "evt-photo" }),
      message: {
        ...inboundEvent().message,
        sourceMessageId: "12",
        content: "look at this",
        replyTo: null,
        media: [{ id: "media-1", kind: "photo", description: null, status: "pending" }],
      },
    });
    const result = await handleInboundJob(event, 1, {
      ...ctx({
        generateReply: async (messages) => {
          seen.push(messages);
          return { content: "nice bike", model: "fixture-model", latencyMs: 1 };
        },
        describeDeps,
      }),
      mediaStore,
    });
    expect(result.status === "handled" && result.outcome.status).toBe("replied");
    // The describe pass ran against the source's store and folded its text
    // into the current turn (caption case).
    expect(described).toEqual(["a red bicycle"]);
    const userTurn = seen[0].find(
      (m) => typeof m.content === "string" && m.content.startsWith("[#12]"),
    );
    expect(userTurn?.content).toContain("look at this");
    expect(userTurn?.content).toContain("Recognition of the media above: a red bicycle");
  });

  it("answers a voice turn from its transcript, re-running the name check on the words", async () => {
    // Re-delivery shape: the transcript already exists on the row, so no
    // ffmpeg/STT machinery is needed to exercise the flow.
    const event = inboundMessageEventSchema.parse({
      ...inboundEvent({ eventId: "evt-voice", addressed: false, needsAnalyzer: false }),
      connection: { botUsername: "fixture_bot", botDisplayName: "Aria" },
      message: {
        ...inboundEvent().message,
        sourceMessageId: "13",
        content: "",
        replyTo: null,
        media: [
          {
            id: "media-v1",
            kind: "voice",
            description: "Aria, what time is it?",
            status: "described",
          },
        ],
      },
    });
    const seen: ChatMessage[][] = [];
    const result = await handleInboundJob(event, 1, ctx({
      generateReply: async (messages) => {
        seen.push(messages);
        return { content: "it is late", model: "fixture-model", latencyMs: 1 };
      },
    }));
    // The group voice message named the bot in speech: addressed by the
    // transcript-aware name check, answered from the words.
    expect(result.status === "handled" && result.outcome.status).toBe("replied");
    const userTurn = seen[0].find(
      (m) => typeof m.content === "string" && m.content.startsWith("[#13]"),
    );
    expect(userTurn?.content).toContain("Aria, what time is it?");
    expect(userTurn?.content).toContain("voice message");
    const delivery = published.find((p) => (p as { type: string }).type === "reply.delivery");
    expect(replyDeliveryEventSchema.parse(delivery).text).toBe("it is late");
  });

  it("delivers a voice turn's reply as a voice bubble through the source's API", async () => {
    const voiceSends: Array<{ chatId: string; text: string; audioBytes: number }> = [];
    const outbound = {
      sendMessage: async () => ({ messageId: 601 }),
      sendVoice: async (
        chatId: string,
        opts: { audioBase64: string; text: string },
      ) => {
        voiceSends.push({
          chatId,
          text: opts.text,
          audioBytes: Buffer.from(opts.audioBase64, "base64").length,
        });
        return { messageId: 602, asVoice: true };
      },
      sendPhotos: async () => ({ delivered: [] }),
      deleteMessage: async () => ({ deleted: true }),
      setReaction: async () => ({ status: "ok" as const, recorded: true }),
    };
    const event = inboundMessageEventSchema.parse({
      ...inboundEvent({ eventId: "evt-voice-tts", addressed: true }),
      message: {
        ...inboundEvent().message,
        sourceMessageId: "14",
        content: "",
        replyTo: null,
        media: [
          { id: "media-v2", kind: "voice", description: "what time is it?", status: "described" },
        ],
      },
    });

    const result = await handleInboundJob(event, 1, {
      ...ctx({
        generateReply: async () => ({ content: "it is late", model: "fixture-model", latencyMs: 1 }),
        synthesizeVoice: async () => ({
          base64: Buffer.from("fake-opus").toString("base64"),
          filename: "voice.ogg",
        }),
      }),
      outbound,
    });

    expect(result.status === "handled" && result.outcome.status).toBe("replied");
    // The audio crossed the API with the spoken text; no reply-delivery
    // event doubled the answer, and the turn still settled.
    expect(voiceSends).toEqual([
      { chatId: "-300", text: "it is late", audioBytes: Buffer.from("fake-opus").length },
    ]);
    const types = published.map((p) => (p as { type: string; phase?: string }));
    expect(types.some((p) => p.type === "reply.delivery")).toBe(false);
    expect(types.map((p) => p.phase).filter(Boolean)).toContain("settled");
  });

  it("degrades a voice reply to the text event when synthesis is unavailable", async () => {
    const voiceSends: string[] = [];
    const outbound = {
      sendMessage: async () => ({ messageId: 603 }),
      sendVoice: async (_chatId: string, opts: { text: string }) => {
        voiceSends.push(opts.text);
        return { messageId: 604, asVoice: true };
      },
      sendPhotos: async () => ({ delivered: [] }),
      deleteMessage: async () => ({ deleted: true }),
      setReaction: async () => ({ status: "ok" as const, recorded: true }),
    };
    const event = inboundMessageEventSchema.parse({
      ...inboundEvent({ eventId: "evt-voice-text", addressed: true }),
      message: {
        ...inboundEvent().message,
        sourceMessageId: "15",
        content: "",
        replyTo: null,
        media: [
          { id: "media-v3", kind: "voice", description: "and now?", status: "described" },
        ],
      },
    });

    const result = await handleInboundJob(event, 1, {
      ...ctx({
        generateReply: async () => ({ content: "still late", model: "fixture-model", latencyMs: 1 }),
        synthesizeVoice: async () => null,
      }),
      outbound,
    });

    expect(result.status === "handled" && result.outcome.status).toBe("replied");
    expect(voiceSends).toEqual([]);
    const delivery = published.find((p) => (p as { type: string }).type === "reply.delivery");
    expect(replyDeliveryEventSchema.parse(delivery).text).toBe("still late");
  });

  it("fails for good when tries run out, even without actions", async () => {
    await expect(
      handleInboundJob(inboundEvent({ eventId: "evt-5" }), 5, ctx(), failingRunTurn),
    ).rejects.toThrow("infrastructure failure");
    expect(reEnqueued).toEqual([]);
    const phases = published.map((p) => (p as { phase?: string }).phase);
    expect(phases).toContain("settled");
  });
});
