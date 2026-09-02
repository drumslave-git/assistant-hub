import { fileURLToPath } from "node:url";

import {
  inboundMessageEventSchema,
  replyDeliveryEventSchema,
  turnLifecycleEventSchema,
  type InboundMessageEvent,
} from "@assistant-hub-swarm/contracts";
import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistant-hub-swarm/db/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetEnvCache } from "@/server/env";
import { closeStorePool } from "@/server/store/db";
import type { MediaRecord } from "@/features/vision/server/repository";
import type { DescribeDeps, MediaStorePort } from "@/features/vision/server/service";
import type { ChatMessage } from "@/server/llm/client";
import { getTraceDetail, listTraces } from "@/server/trace";

import { createTurnActionMarkers } from "./actions";
import { handleInboundJob, type TurnConsumerContext } from "./consume";

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
    const storeUrl = await pg.createDatabase("core_store");
    await applyMigrations(storeUrl, STORE_MIGRATIONS);
    // The whole brain reads the ONE core store since the Phase 10 cutover.
    process.env.DATABASE_URL = storeUrl;
    storePool = new Pool({ connectionString: storeUrl });
    // The event's assistant: its NAME is the spoken-summons identity the
    // core-side name check and analyzer match (user decision, 2026-08-24) —
    // the connection's botDisplayName never drives addressing.
    await storePool.query(
      `INSERT INTO assistants (id, name, persona) VALUES ('assistant-1', 'Aria', ''),
                                                        ('assistant-2', 'Nova', '')`,
    );
    // The loop-guard setting lives in the v2 store; the env was set above, so
    // drop the cached parse before any code reads it.
    resetEnvCache();
  });

  afterAll(async () => {
    await storePool?.end();
    // The persona/tasks reads open the process-global store pool through
    // production code — close it before the container stops, or its dying
    // clients surface as unhandled errors and fail an all-green run.
    await closeStorePool();
    await pg?.stop();
  });

  beforeEach(async () => {
    published = [];
    reEnqueued = [];
    await storePool.query(`DELETE FROM turn_actions`);
    await storePool.query(`DELETE FROM settings`);
  });

  /**
   * A message ANOTHER assistant delivered into the same group, handed over by
   * the source's cross-feed (slice E): `assistant-1` speaking, `assistant-2`
   * receiving. `history` is the shared group window, newest last.
   */
  function crossFedEvent(history: InboundMessageEvent["context"]["history"]): InboundMessageEvent {
    return inboundMessageEventSchema.parse({
      v: 1,
      eventId: "evt-crossfed",
      occurredAt: new Date().toISOString(),
      correlationId: "-300:40:assistant-2",
      type: "message.inbound",
      source: "tg",
      assistantId: "assistant-2",
      connection: { botUsername: "second_bot", botDisplayName: "Second Bot" },
      chat: { ref: "tg:chat:-300", kind: "group", title: "Fixture Group" },
      // The authoring bot's ACCOUNT — never a person.
      sender: { ref: "tg:user:9001", isOwner: false, label: "First Bot" },
      authoredByAssistantId: "assistant-1",
      addressing: { addressed: true, source: "mention", needsAnalyzer: false },
      message: {
        sourceMessageId: "40",
        content: "@second_bot what do you make of it?",
        sentAt: new Date().toISOString(),
      },
      context: { history, participants: [] },
    });
  }

  /** One line of a shared group window. */
  function historyLine(input: {
    id: string;
    role: "user" | "assistant";
    assistantId?: string;
    content: string;
  }): InboundMessageEvent["context"]["history"][number] {
    return {
      sourceMessageId: input.id,
      role: input.role,
      assistantId: input.role === "assistant" ? (input.assistantId ?? "assistant-1") : null,
      senderRef: input.role === "user" ? "tg:user:5001" : null,
      senderLabel: input.role === "user" ? "Alice (@alice_example)" : null,
      content: input.content,
      sentAt: new Date().toISOString(),
    };
  }

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
    // The learned state the reply must read back: the sender's latest
    // communication preferences and the latest global self-correction
    // (moved here from the deleted v1-runtime prompt-injection test — the
    // consumer is the one path composing prompts now).
    const { insertPreference, insertCorrection } = await import(
      "@/features/self-improvement/server/repository"
    );
    const { getStoreDb } = await import("@/server/store/db");
    const { upsertKnownUser } = await import("@/features/known-users/server/repository");
    await upsertKnownUser(getStoreDb(), {
      userId: "5001",
      username: "alice_example",
      firstName: "Alice",
      lastName: null,
    });
    await insertPreference(getStoreDb(), {
      id: crypto.randomUUID(),
      userId: "5001",
      model: "fixture-model",
      likes: "short answers",
      dislikes: "emoji walls",
      version: 1,
    });
    await insertCorrection(getStoreDb(), {
      id: crypto.randomUUID(),
      model: "fixture-model",
      correction: "Answer in fewer words.",
      version: 1,
    });

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
    expect(transcript?.content).toContain("[#9] You: an earlier reply");
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
    // The system prompt carries the correction block, and a system message
    // carries the sender's learned preferences.
    expect(String(messages[0].content)).toContain("Answer in fewer words.");
    const prefsMessage = messages.find(
      (m) => m.role === "system" && String(m.content).includes("Communication preferences"),
    );
    expect(prefsMessage).toBeDefined();
    expect(String(prefsMessage!.content)).toContain("short answers");
    expect(String(prefsMessage!.content)).toContain("emoji walls");

    // The send marked the turn as acted, and the terminal settle cleared it.
    const markers = await storePool.query(`SELECT * FROM turn_actions`);
    expect(markers.rows).toEqual([]);

    // Identity capture is the INGEST's job since the shadow directory died
    // (Phase 10): the consumer no longer writes any directory rows — the
    // ingest suite owns that behavior against source_users/source_chats.
  });

  it("runs a web-thread turn: no bot account, its own surface, its own trigger", async () => {
    // The same pipeline, from the source that has none of Telegram's
    // furniture: no connection identity, uuid ids, and a trigger Debug can
    // tell apart from an operator pressing a button.
    const event = inboundMessageEventSchema.parse({
      v: 1,
      eventId: "evt-chat-1",
      occurredAt: new Date().toISOString(),
      correlationId: "thread-abc:7:assistant-1",
      type: "message.inbound",
      source: "chat",
      assistantId: "assistant-1",
      chat: { ref: "chat:thread:thread-abc", kind: "direct", title: "A thread" },
      sender: { ref: "chat:user:user-abc", isOwner: true, label: "Operator" },
      addressing: { addressed: true, source: "private", needsAnalyzer: false },
      message: {
        sourceMessageId: "7",
        content: "where are we talking?",
        sentAt: new Date().toISOString(),
      },
      context: { history: [], participants: [] },
    });

    const seen: ChatMessage[][] = [];
    const result = await handleInboundJob(event, 1, ctx({
      generateReply: async (messages) => {
        seen.push(messages);
        return { content: "in the dashboard", model: "fixture-model", latencyMs: 1 };
      },
    }));
    expect(result.status).toBe("handled");

    // The reply is delivered to the thread, not to a chat id nobody has.
    const delivery = replyDeliveryEventSchema.parse(
      published.find((p) => (p as { type?: string }).type === "reply.delivery"),
    );
    expect(delivery).toMatchObject({
      source: "chat",
      chatRef: "chat:thread:thread-abc",
      correlationId: "thread-abc:7:assistant-1",
    });

    // The model is told where it is — and it is not Telegram.
    const systemBlocks = seen[0]
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join(" | ");
    expect(systemBlocks).toContain("web chat");
    expect(systemBlocks).not.toContain("Telegram");

    // The trace says which way in this was, with an id that is a real id.
    const traces = await listTraces({ correlationId: "thread-abc:7:assistant-1" });
    const reply = traces.traces.find((trace) => trace.action === "reply");
    expect(reply?.trigger).toMatchObject({ kind: "chat", actor: "user-abc" });
  });

  it("names a conversation whose source has no name for it, once", async () => {
    const named: Array<{ chatId: string; title: string }> = [];
    const outbound = {
      sendMessage: async () => ({ messageId: 1 }),
      sendVoice: async () => ({ messageId: 1, asVoice: true }),
      sendPhotos: async () => ({ delivered: [] }),
      sendFile: async () => ({ messageId: 1 }),
      deleteMessage: async () => ({ deleted: true }),
      setReaction: async () => ({ status: "unsupported" as const, recorded: false }),
      setChatTitle: async (chatId: string, title: string) => {
        named.push({ chatId, title });
        return { title };
      },
    };
    const webEvent = (overrides: {
      eventId: string;
      messageId: string;
      titleProvisional: boolean;
      history?: InboundMessageEvent["context"]["history"];
    }): InboundMessageEvent =>
      inboundMessageEventSchema.parse({
        v: 1,
        eventId: overrides.eventId,
        occurredAt: new Date().toISOString(),
        correlationId: `thread-name:${overrides.messageId}:assistant-1`,
        type: "message.inbound",
        source: "chat",
        assistantId: "assistant-1",
        chat: {
          ref: "chat:thread:thread-name",
          kind: "direct",
          title: "New chat",
          titleProvisional: overrides.titleProvisional,
        },
        sender: { ref: "chat:user:user-abc", isOwner: true, label: "Operator" },
        addressing: { addressed: true, source: "private", needsAnalyzer: false },
        message: {
          sourceMessageId: overrides.messageId,
          content: "how do I get to the airport?",
          sentAt: new Date().toISOString(),
        },
        context: { history: overrides.history ?? [], participants: [] },
      });

    const ctxWith = (): TurnConsumerContext => ({
      ...ctx({
        generateReply: async () => ({
          content: "take the metro",
          model: "fixture-model",
          latencyMs: 1,
        }),
        generateTitle: async () => "Getting to the airport",
      }),
      outbound,
    });

    await handleInboundJob(
      webEvent({ eventId: "evt-name-1", messageId: "1", titleProvisional: true }),
      1,
      ctxWith(),
    );
    expect(named).toEqual([{ chatId: "thread-name", title: "Getting to the airport" }]);

    // A thread that already has a name asks for nothing, so nothing is spent
    // on naming it again.
    await handleInboundJob(
      webEvent({ eventId: "evt-name-2", messageId: "2", titleProvisional: false }),
      1,
      ctxWith(),
    );
    expect(named).toHaveLength(1);
  });

  it("answers another assistant's cross-fed message, in that assistant's voice", async () => {
    const seen: ChatMessage[][] = [];
    const result = await handleInboundJob(
      crossFedEvent([
        historyLine({ id: "38", role: "user", content: "what do you two think?" }),
        historyLine({ id: "39", role: "assistant", assistantId: "assistant-1", content: "I say yes" }),
      ]),
      1,
      ctx({
        generateReply: async (messages) => {
          seen.push(messages);
          return { content: "I say no", model: "fixture-model", latencyMs: 1 };
        },
      }),
    );

    expect(result.status === "handled" && result.outcome.status).toBe("replied");
    const delivery = replyDeliveryEventSchema.parse(published[1]);
    expect(delivery).toMatchObject({
      assistantId: "assistant-2",
      replyToSourceMessageId: "40",
      correlationId: "-300:40:assistant-2",
      text: "I say no",
    });

    // The other assistant's words are attributed to IT — reading them as its
    // own would make the turn incoherent.
    const messages = seen[0];
    const transcript = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[#39]"),
    );
    expect(transcript?.content).toContain("[#39] Aria: I say yes");
    const currentTurn = messages.find(
      (m) => typeof m.content === "string" && m.content.startsWith("[#40]"),
    );
    expect(currentTurn?.content).toBe("[#40] Aria: @second_bot what do you make of it?");

    // The authoring bot account is not a person: it never enters the
    // directory the brain reads (capture is the ingest's, which skips bot
    // senders; the consumer writes no directory rows at all since Phase 10).
    const botRows = await storePool.query(
      `SELECT count(*)::int AS n FROM source_users WHERE user_id = '9001'`,
    );
    expect(botRows.rows[0].n).toBe(0);
  });

  it("goes silent once the chat holds the configured run of assistant messages", async () => {
    const history = [
      historyLine({ id: "37", role: "user", content: "what do you two think?" }),
      historyLine({ id: "38", role: "assistant", assistantId: "assistant-1", content: "I say yes" }),
      historyLine({ id: "39", role: "assistant", assistantId: "assistant-2", content: "I say no" }),
    ];
    let generated = 0;
    const result = await handleInboundJob(
      crossFedEvent(history),
      1,
      ctx({
        generateReply: async () => {
          generated += 1;
          return { content: "never sent", model: "fixture-model", latencyMs: 1 };
        },
      }),
    );

    // Default limit 3, and this message is the third in the run.
    expect(result.status === "handled" && result.outcome).toMatchObject({
      status: "ignored",
      reason: "loop_guard",
    });
    expect(generated).toBe(0);
    // Nothing delivered — but the turn still settles, so the source releases
    // its hold on the message.
    expect(published.map((p) => (p as { type: string; phase?: string }).phase ?? "")).toEqual([
      "settled",
    ]);
    // And the silence is on the record, under the turn's own correlation.
    const traces = await listTraces({ correlationId: "-300:40:assistant-2" });
    const trace = traces.traces.find((t) => t.action === "reply");
    expect(trace?.status).toBe("skipped");
    const detail = await getTraceDetail(trace!.id);
    expect(detail?.events.some((e) => e.message?.includes("loop guard"))).toBe(true);
  });

  it("honors the operator's limit — 0 keeps assistants from answering each other", async () => {
    await storePool.query(
      `INSERT INTO settings (id, assistant_loop_guard_turns) VALUES ('singleton', 0)
       ON CONFLICT (id) DO UPDATE SET assistant_loop_guard_turns = 0`,
    );
    const result = await handleInboundJob(
      crossFedEvent([historyLine({ id: "39", role: "user", content: "go on" })]),
      1,
      ctx({
        generateReply: async () => ({
          content: "never sent",
          model: "fixture-model",
          latencyMs: 1,
        }),
      }),
    );
    expect(result.status === "handled" && result.outcome).toMatchObject({
      status: "ignored",
      reason: "loop_guard",
    });
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
      sendFile: async () => ({ messageId: 0 }),
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
      sendFile: async () => ({ messageId: 0 }),
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
