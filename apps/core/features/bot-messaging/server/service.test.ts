import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the policy from persistence: a no-op trace recorder and a stub db.
// `vi.hoisted` runs before the hoisted vi.mock factory below.
const recorder = vi.hoisted(() => ({
  id: "t1",
  event: vi.fn().mockResolvedValue(undefined),
  setInputSummary: vi.fn(),
  relate: vi.fn(),
  succeed: vi.fn().mockResolvedValue(undefined),
  skip: vi.fn().mockResolvedValue(undefined),
  fail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/trace", () => ({ startTrace: vi.fn().mockResolvedValue(recorder) }));
vi.mock("@/db/drizzle", () => ({ getDb: () => ({}) }));

import { openPolicy } from "@/test/__mocks__/policy";
import { BOT, BOT_USER, makeMessage } from "@/test/__mocks__/telegram";
import {
  recordLlmRequest,
  recordLlmResponse,
  recordLlmRetry,
  type LlmCallTrace,
} from "@/server/llm/client";
import { startTrace } from "@/server/trace";
import { TASK_ENFORCEMENT_DIRECTIVE } from "@/features/tasks/format";
import { ACTION_CLAIM_ENFORCEMENT_DIRECTIVE, ACTION_NOT_TAKEN_REPLY } from "./action-claim";
import { REPLY_INTEGRITY_DIRECTIVE, REPLY_NOT_PRODUCED_REPLY } from "./reply-integrity";
import { BASE_SYSTEM_PROMPT } from "./prompt";
import { handleIncomingMessage, type BotMessagingDeps, type IncomingMessage } from "./service";

/** The connection the fakes pretend to send to (named in recorded request events). */
const TEST_CONN = { baseUrl: "https://llm.test/v1" };

/**
 * Mirror the real generator: record the exchange through the shared LLM tracing
 * layer exactly as `chatCompletion` does, so the event assertions in this file
 * pin the same titles and shapes production writes.
 */
async function recordExchange(
  trace: LlmCallTrace | undefined,
  messages: unknown,
  result: { content: string; model: string; latencyMs: number; responseBody?: unknown },
) {
  await recordLlmRequest(TEST_CONN, trace, { model: result.model, messages });
  await recordLlmResponse(trace, {
    model: result.model,
    latencyMs: result.latencyMs,
    responseBody: result.responseBody,
    content: result.content,
  });
}

function incoming(partial: Partial<IncomingMessage>): IncomingMessage {
  return {
    message: makeMessage({ message_id: 7, chat: { id: 5, type: "private" } }),
    chatId: "5",
    chatType: "private",
    messageId: 7,
    fromId: "100",
    fromIsBot: false,
    text: "hello",
    ...partial,
  };
}

const stopTyping = vi.fn();

const OPEN_POLICY = openPolicy;

function deps(over: Partial<BotMessagingDeps> = {}): BotMessagingDeps {
  return {
    bot: BOT,
    policy: OPEN_POLICY,
    senderIsOwner: false,
    // Mirror the real generator: the shared LLM tracing layer records the
    // "request" and "response" events, driven by the trace options the service
    // passes. A reply with no tools is one round, and that round is the answer.
    generateReply: vi.fn().mockImplementation(async (messages, trace) => {
      const result = { content: "hi back", model: "m", latencyMs: 5 };
      await recordExchange(trace, messages, result);
      return result;
    }),
    sendReply: vi.fn().mockResolvedValue({ messageId: 99 }),
    loadHistory: vi.fn().mockResolvedValue({ messages: [], count: 0 }),
    recordReply: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn().mockReturnValue(stopTyping),
    ...over,
  };
}

describe("handleIncomingMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores messages from other bots without tracing or generating", async () => {
    const d = deps();
    const out = await handleIncomingMessage(incoming({ fromIsBot: true }), d);
    expect(out).toEqual({ status: "ignored", reason: "from_bot" });
    expect(startTrace).not.toHaveBeenCalled();
    expect(d.generateReply).not.toHaveBeenCalled();
    expect(d.startTyping).not.toHaveBeenCalled();
  });

  it("ignores empty messages", async () => {
    const d = deps();
    const out = await handleIncomingMessage(incoming({ text: "   " }), d);
    expect(out).toEqual({ status: "ignored", reason: "no_content" });
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("processes a caption-less media message (empty text but hasVision) like any other", async () => {
    const d = deps({
      loadVision: vi
        .fn()
        .mockResolvedValue({ note: "The user sent a photo (no caption). Its content: a cat." }),
    });
    const out = await handleIncomingMessage(incoming({ text: "", hasVision: true }), d);
    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(d.generateReply).toHaveBeenCalledOnce();
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(messages.at(-1).content)).toContain("a cat");
  });

  it("folds the recognition into the turn text (media-only)", async () => {
    const d = deps({
      loadVision: vi.fn().mockResolvedValue({
        note: "The user sent a photo (no caption). Its content: a red car.",
      }),
    });
    await handleIncomingMessage(incoming({ text: "", hasVision: true }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userTurn = messages.at(-1);
    // The reply model reads text, always — raw bytes never ride the request.
    expect(typeof userTurn.content).toBe("string");
    expect(userTurn.content).toContain("a red car");
    const step = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "vision context composed");
    expect(step.data).toEqual({ hasNote: true });
  });

  it("ignores un-addressed group chatter without tracing", async () => {
    const d = deps();
    const m = makeMessage({ message_id: 7, chat: { id: 5, type: "group" }, text: "chatter" });
    const out = await handleIncomingMessage(
      incoming({ message: m, chatType: "group", text: "chatter" }),
      d,
    );
    expect(out).toEqual({ status: "ignored", reason: "not_addressed" });
    expect(startTrace).not.toHaveBeenCalled();
    expect(d.generateReply).not.toHaveBeenCalled();
    expect(d.startTyping).not.toHaveBeenCalled();
  });

  it("adopts a pre-opened trace instead of opening a second one, and settles it", async () => {
    // The runtime opens the reply trace before the service for a voice turn
    // (its transcription records there first) — one trace per message, still.
    const pre = {
      id: "pre",
      event: vi.fn().mockResolvedValue(undefined),
      setInputSummary: vi.fn(),
      relate: vi.fn(),
      succeed: vi.fn().mockResolvedValue(undefined),
      skip: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const d = deps({ trace: pre });
    const out = await handleIncomingMessage(incoming({ text: "hello", isVoice: true }), d);
    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(startTrace).not.toHaveBeenCalled();
    expect(pre.succeed).toHaveBeenCalledOnce();
  });

  it("settles a pre-opened trace as skipped on an early ignore (failed voice turn)", async () => {
    // A voice message whose transcription failed arrives with empty text and no
    // vision — the pre-opened trace (carrying the transcription events) must not
    // be left running.
    const pre = {
      id: "pre",
      event: vi.fn().mockResolvedValue(undefined),
      setInputSummary: vi.fn(),
      relate: vi.fn(),
      succeed: vi.fn().mockResolvedValue(undefined),
      skip: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const d = deps({ trace: pre });
    const out = await handleIncomingMessage(
      incoming({ text: "", hasVision: false, isVoice: true }),
      d,
    );
    expect(out).toEqual({ status: "ignored", reason: "no_content" });
    expect(pre.skip).toHaveBeenCalledWith("no_content");
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("settles a pre-opened trace as skipped for un-addressed group voice chatter", async () => {
    const pre = {
      id: "pre",
      event: vi.fn().mockResolvedValue(undefined),
      setInputSummary: vi.fn(),
      relate: vi.fn(),
      succeed: vi.fn().mockResolvedValue(undefined),
      skip: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const d = deps({ trace: pre });
    const m = makeMessage({ message_id: 7, chat: { id: 5, type: "group" }, text: "" });
    const out = await handleIncomingMessage(
      incoming({ message: m, chatType: "group", text: "unrelated words", isVoice: true, hasVision: true }),
      d,
    );
    expect(out).toMatchObject({ status: "ignored", reason: "not_addressed" });
    expect(pre.skip).toHaveBeenCalledOnce();
    expect(startTrace).not.toHaveBeenCalled();
  });

  it("passes the reply trace to loadVision so recognition records into the same flow", async () => {
    const loadVision = vi.fn().mockResolvedValue(null);
    const d = deps({ loadVision });
    await handleIncomingMessage(incoming({ text: "look at this", hasVision: true }), d);
    expect(loadVision).toHaveBeenCalledWith(recorder);
  });

  it("generates and delivers a reply for an addressed message, and traces it", async () => {
    const d = deps();
    const out = await handleIncomingMessage(incoming({ text: "hello there" }), d);
    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(d.generateReply).toHaveBeenCalledOnce();
    // system + user turns
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "hello there" });
    expect(d.sendReply).toHaveBeenCalledWith("hi back");
    expect(recorder.succeed).toHaveBeenCalledOnce();
    // The delivered reply is mirrored into history, threaded to the triggering msg.
    expect(d.recordReply).toHaveBeenCalledWith({
      content: "hi back",
      telegramMessageId: 99,
      replyToMessageId: 7,
    });
    // Typing shown while generating, then stopped once the turn settles.
    expect(d.startTyping).toHaveBeenCalledOnce();
    expect(stopTyping).toHaveBeenCalledOnce();
  });

  it("injects the time context as a system message right before the current turn", async () => {
    const timeContext = "Current date and time: 2026-07-14 16:34 (Tuesday), timezone Europe/Kyiv.";
    const d = deps({ timeContext });
    await handleIncomingMessage(incoming({ text: "remind me in 5m" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // [system prompt, time context, user] — the time line sits immediately before
    // the message being answered so relative times resolve against it.
    expect(messages.at(-2)).toEqual({ role: "system", content: timeContext });
    expect(messages.at(-1)).toEqual({ role: "user", content: "remind me in 5m" });
    // Recorded for debug.
    const step = recorder.event.mock.calls.map((c) => c[0]).find((e) => e.message === "time context");
    expect(step.data).toEqual({ timeContext });
  });

  it("omits the time line (and its trace step) when no time context is provided", async () => {
    const d = deps();
    await handleIncomingMessage(incoming({ text: "hello there" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Just [system prompt, user] — no injected time line.
    expect(messages).toHaveLength(2);
    const step = recorder.event.mock.calls.map((c) => c[0]).find((e) => e.message === "time context");
    expect(step).toBeUndefined();
  });

  it("keeps the turn a plain string with the recognition folded in (text + media)", async () => {
    // Raw bytes never reach the reply request — the vision pass exists so the
    // reply model reads text (user decision, 2026-08-15; the old attach path
    // 400'd wholesale on a text-only chat provider, trace `f37d84b9…`).
    const d = deps({
      loadVision: vi.fn().mockResolvedValue({
        note: "Recognition of the media above: a dark SUV on a road.",
      }),
    });
    await handleIncomingMessage(incoming({ text: "what car is this?" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userTurn = messages.at(-1);
    expect(typeof userTurn.content).toBe("string");
    expect(userTurn.content).toContain("what car is this?");
    expect(userTurn.content).toContain("a dark SUV");
    const step = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "vision context composed");
    expect(step.data).toEqual({ hasNote: true });
  });

  it("folds the replied-to media description into the turn text", async () => {
    const d = deps({
      loadVision: vi.fn().mockResolvedValue({
        note: "The user is asking about the photo they replied to. Its content: a red car.",
      }),
    });
    await handleIncomingMessage(incoming({ text: "explain" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const content = String(messages.at(-1).content);
    expect(content).toContain("explain");
    expect(content).toContain("replied to");
    expect(content).toContain("a red car");
  });

  it("injects the required-language directive as the final system message before the turn", async () => {
    const d = deps({ requiredLanguage: "Ukrainian" });
    await handleIncomingMessage(incoming({ text: "hello there" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // [system prompt, language directive, user] — the directive sits last so it
    // overrides the language of the message/history/personality.
    const directive = messages.at(-2);
    expect(directive.role).toBe("system");
    expect(directive.content).toContain("Ukrainian");
    expect(messages.at(-1)).toEqual({ role: "user", content: "hello there" });
    // Recorded for debug.
    const step = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "language directive");
    expect(step.data.requiredLanguage).toBe("Ukrainian");
  });

  it("omits the language directive (and its trace step) when none is provided", async () => {
    const d = deps();
    await handleIncomingMessage(incoming({ text: "hello there" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages).toHaveLength(2);
    const step = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "language directive");
    expect(step).toBeUndefined();
  });

  it("injects the loaded history window as prior turns between system and current", async () => {
    const priorTurns = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    const d = deps({
      loadHistory: vi.fn().mockResolvedValue({ messages: priorTurns, count: 2 }),
    });
    await handleIncomingMessage(incoming({ text: "follow up" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[1]).toEqual(priorTurns[0]);
    expect(messages[2]).toEqual(priorTurns[1]);
    expect(messages[3]).toEqual({ role: "user", content: "follow up" });
    // The window size is recorded as a step.
    const loaded = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "history window loaded");
    expect(loaded.data).toEqual({ messageCount: 2 });
  });

  it("uses the composed current turn as the final user message and traces it", async () => {
    const d = deps({
      loadCurrentTurn: vi.fn().mockResolvedValue({
        content: "[#7] Bob (@bob): hello there",
        senderLabel: "Bob (@bob)",
        data: { line: "[#7] Bob (@bob): hello there", replyTo: null },
      }),
    });
    await handleIncomingMessage(incoming({ text: "hello there" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages.at(-1)).toEqual({ role: "user", content: "[#7] Bob (@bob): hello there" });

    const events = recorder.event.mock.calls.map((c) => c[0]);
    const composed = events.find((e) => e.message === "current turn composed");
    expect(composed.data).toEqual({
      line: "[#7] Bob (@bob): hello there",
      replyTo: null,
      // Private chat → no group addressing hint.
      addressingHint: null,
    });
  });

  it("falls back to the raw text when the current-turn loader resolves null", async () => {
    const d = deps({ loadCurrentTurn: vi.fn().mockResolvedValue(null) });
    await handleIncomingMessage(incoming({ text: "plain" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages.at(-1)).toEqual({ role: "user", content: "plain" });
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.some((e) => e.message === "current turn composed")).toBe(false);
  });

  it("injects a group addressing hint naming the sender and address source", async () => {
    // A group message that mentions the bot by @username entity.
    const m = makeMessage({
      message_id: 7,
      chat: { id: 5, type: "group" },
      text: "@MyBot explain",
      entities: [{ type: "mention", offset: 0, length: 6 }],
    });
    const d = deps({
      loadChatContext: vi.fn().mockResolvedValue({ content: "roster", data: {} }),
      loadCurrentTurn: vi.fn().mockResolvedValue({
        content: "[#7] Bob (@bob): @MyBot explain",
        senderLabel: "Bob (@bob)",
        data: {},
      }),
      loadHistory: vi.fn().mockResolvedValue({ messages: [{ role: "user", content: "t" }], count: 1 }),
    });
    await handleIncomingMessage(incoming({ message: m, chatType: "group", text: "@MyBot explain" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // system prompt, chat context, transcript, addressing hint, current message.
    //
    // The order is load-bearing, not incidental: everything per-*chat* sits
    // above the history window and everything per-*sender* below it, so a change
    // of speaker cannot invalidate the endpoint's KV prefix and force the whole
    // window to be re-read. Measured on the live endpoint, getting this wrong
    // cost 532ms → 3923ms on every turn where the speaker changed.
    expect(messages.map((msg: { role: string }) => msg.role)).toEqual([
      "system",
      "system",
      "user",
      "system",
      "user",
    ]);
    expect(messages[3].content).toContain("from Bob (@bob), who mentioned you");
    expect(messages.at(-1)).toEqual({ role: "user", content: "[#7] Bob (@bob): @MyBot explain" });

    const events = recorder.event.mock.calls.map((c) => c[0]);
    const composed = events.find((e) => e.message === "current turn composed");
    expect(composed.data.addressingHint).toContain("from Bob (@bob), who mentioned you");
  });

  it("injects chat context as a system message after the base prompt", async () => {
    const priorTurns = [{ role: "user", content: "Ann: earlier" }];
    const d = deps({
      loadChatContext: vi
        .fn()
        .mockResolvedValue({ content: "Known participants:\n- Ann", data: { memberCount: 1 } }),
      loadHistory: vi.fn().mockResolvedValue({ messages: priorTurns, count: 1 }),
    });
    await handleIncomingMessage(incoming({ text: "who is ann?" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // system prompt, chat-context system message, prior turn, current message.
    expect(messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "system",
      "user",
      "user",
    ]);
    expect(messages[1]).toEqual({ role: "system", content: "Known participants:\n- Ann" });
    expect(messages[2]).toEqual(priorTurns[0]);
    expect(messages[3]).toEqual({ role: "user", content: "who is ann?" });

    // The context is recorded as a step, between system prompt and history.
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.message)).toEqual([
      "addressing check",
      "system prompt composed",
      "chat context loaded",
      "history window loaded",
      "request",
      "response",
      "send message",
    ]);
    const loaded = events.find((e) => e.message === "chat context loaded");
    expect(loaded.data).toEqual({ memberCount: 1 });
  });

  it("omits the chat-context step when the loader resolves null", async () => {
    const d = deps({ loadChatContext: vi.fn().mockResolvedValue(null) });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // No extra system message when there is nothing to inject.
    expect(messages).toHaveLength(2);
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.some((e) => e.message === "chat context loaded")).toBe(false);
  });

  it("injects the sender's communication preferences after the chat context and traces the step", async () => {
    const prefs = "Communication preferences of Bob (@bob):\n- They like: short answers";
    const d = deps({
      loadChatContext: vi.fn().mockResolvedValue({ content: "You are chatting with Bob." }),
      loadSenderPreferences: vi
        .fn()
        .mockResolvedValue({ content: prefs, data: { userId: "100", version: 2 } }),
    });
    await handleIncomingMessage(incoming({ text: "hi" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // system prompt, chat context, preferences, current message.
    expect(messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
    ]);
    expect(messages[2]).toEqual({ role: "system", content: prefs });

    const events = recorder.event.mock.calls.map((c) => c[0]);
    const loaded = events.find((e) => e.message === "communication preferences loaded");
    expect(loaded.data).toEqual({ userId: "100", version: 2 });
  });

  it("omits the preferences step when the loader resolves null", async () => {
    const d = deps({ loadSenderPreferences: vi.fn().mockResolvedValue(null) });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages).toHaveLength(2);
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.some((e) => e.message === "communication preferences loaded")).toBe(false);
  });

  it("composes the latest self-correction into the system prompt and flags it on the trace", async () => {
    const correction = "Answer in fewer words; do not open with a summary.";
    const d = deps({ selfCorrection: correction });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages[0].content).toContain(BASE_SYSTEM_PROMPT);
    expect(messages[0].content).toContain("Self-correction guidelines");
    expect(messages[0].content).toContain(correction);
    const composed = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "system prompt composed");
    expect(composed.data.selfCorrectionApplied).toBe(true);
    expect(composed.data.systemPrompt).toBe(messages[0].content);
  });

  it("records an empty data object for the chat-context step when the loader omits data", async () => {
    const d = deps({
      loadChatContext: vi.fn().mockResolvedValue({ content: "You are chatting with Bob." }),
    });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const events = recorder.event.mock.calls.map((c) => c[0]);
    const loaded = events.find((e) => e.message === "chat context loaded");
    expect(loaded.data).toEqual({});
  });

  it("uses the base system prompt when no personality is configured", async () => {
    const d = deps();
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages[0]).toEqual({ role: "system", content: BASE_SYSTEM_PROMPT });
    const composed = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "system prompt composed");
    expect(composed.data.personalityApplied).toBe(false);
    expect(composed.data.systemPrompt).toBe(BASE_SYSTEM_PROMPT);
  });

  it("appends the configured personality prompt to the system prompt", async () => {
    const persona = "You are a laconic pirate.";
    const d = deps({ personalityPrompt: persona });
    await handleIncomingMessage(incoming({ text: "hi" }), d);
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(BASE_SYSTEM_PROMPT);
    expect(messages[0].content).toContain("Additional instructions:");
    expect(messages[0].content).toContain(persona);
    const composed = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "system prompt composed");
    expect(composed.data.personalityApplied).toBe(true);
    expect(composed.data.systemPrompt).toBe(messages[0].content);
  });

  it("records the full untrimmed message, request, and raw response bodies", async () => {
    const longText = "x".repeat(500);
    const reply = "y".repeat(300);
    const responseBody = { id: "cmpl-1", choices: [{ message: { content: reply } }] };
    const d = deps({
      generateReply: vi.fn().mockImplementation(async (messages, trace) => {
        const result = { content: reply, model: "m", latencyMs: 5, responseBody };
        await recordExchange(trace, messages, result);
        return result;
      }),
    });
    await handleIncomingMessage(incoming({ text: longText }), d);

    // The trace input is the whole message, never trimmed.
    const startInput = (startTrace as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(startInput.inputSummary).toBe(longText);

    const events = recorder.event.mock.calls.map((c) => c[0]);
    const byMessage = (message: string) => events.find((e) => e.message === message);

    // Fixed flow: addressing → system prompt → history → request → response → send.
    expect(events.map((e) => e.message)).toEqual([
      "addressing check",
      "system prompt composed",
      "history window loaded",
      "request",
      "response",
      "send message",
    ]);
    // Addressing check is a passed check (green).
    expect(byMessage("addressing check").level).toBe("success");
    expect(byMessage("addressing check").data).toEqual({
      addressed: true,
      source: "private",
      // No analyzer ran, so the trace holds no exchange to read back — which
      // is why the verdict has to say for itself what addressed the bot.
      reason: "a direct chat — every message in it is for the bot",
      // No cited word either (only the analyzer cites one) — but the identity
      // the check was made against is always recorded (the exclusion flow
      // reads it).
      matchedText: null,
      botDisplayName: "Aria",
    });
    // Request event carries the whole request body (model + full messages), not
    // just the messages — the exact object the generator sent to the provider.
    expect(byMessage("request").data.model).toBe("m");
    expect(byMessage("request").data.messages[1]).toEqual({ role: "user", content: longText });
    // Response step records the raw provider body verbatim.
    expect(byMessage("response").data).toEqual(responseBody);
    // Delivered message carries the full content.
    expect(byMessage("send message").data.content).toBe(reply);
  });

  it("records tool calls reported by the generator as external_call events on the reply trace", async () => {
    // A generator that loops once through a tool before answering — the real shape:
    // round 0 asks for the tool, the tool runs, round 1 is the answer. Recording
    // mirrors what the shared tool loop writes for each of those.
    const d = deps({
      generateReply: vi.fn().mockImplementation(async (messages, trace, onToolCall) => {
        await recordLlmRequest(TEST_CONN, trace, { model: "m", messages });
        await recordLlmResponse(
          trace,
          { model: "m", latencyMs: 900, responseBody: undefined },
          { title: "tool turn 1 response", callKind: trace?.toolTurnCallKind },
        );
        const call = {
          name: "history_search",
          args: { query: "pizza" },
          result: { text: "found 2 messages" },
          ok: true,
        };
        await trace?.recorder.event({
          type: "external_call",
          level: "info",
          message: `tool: ${call.name}`,
          data: { args: call.args, result: call.result },
        });
        await onToolCall?.(call);
        const result = { content: "here you go", model: "m", latencyMs: 5 };
        await recordLlmResponse(trace, {
          model: "m",
          latencyMs: 5,
          responseBody: undefined,
          content: result.content,
        });
        return result;
      }),
    });
    const out = await handleIncomingMessage(incoming({ text: "what did we say about pizza?" }), d);
    expect(out).toEqual({ status: "replied", text: "here you go" });

    const events = recorder.event.mock.calls.map((c) => c[0]);
    // Each model round is its own response event, in loop order, with the tool call
    // between the turn that asked for it and the answer that used it.
    expect(events.map((e) => e.message)).toEqual([
      "addressing check",
      "system prompt composed",
      "history window loaded",
      "request",
      "tool turn 1 response",
      "tool: history_search",
      "response",
      "send message",
    ]);
    // The whole point of per-round recording: the slow tool turn is measurable on
    // its own instead of being summed into the reply it belonged to.
    const turn = events.find((e) => e.message === "tool turn 1 response");
    expect(turn.usage).toMatchObject({ callKind: "reply-tool-turn", latencyMs: 900 });
    const answer = events.find((e) => e.message === "response");
    expect(answer.usage).toMatchObject({ callKind: "reply-final", latencyMs: 5 });
    const toolEvent = events.find((e) => e.message === "tool: history_search");
    expect(toolEvent.type).toBe("external_call");
    expect(toolEvent.data).toEqual({
      args: { query: "pizza" },
      result: { text: "found 2 messages" },
    });
  });

  it("blocks a non-owner in maintenance mode: sends a static notice, traces (skipped), no LLM", async () => {
    const d = deps({ policy: { maintenanceModeEnabled: true }, senderIsOwner: false });
    const out = await handleIncomingMessage(incoming({ text: "hello", fromId: "100" }), d);
    expect(out).toEqual({ status: "ignored", reason: "maintenance_mode", source: "private" });
    // Addressed-but-blocked is still traced for operator visibility, then skipped.
    expect(startTrace).toHaveBeenCalledOnce();
    expect(recorder.skip).toHaveBeenCalledOnce();
    expect(recorder.succeed).not.toHaveBeenCalled();
    // No LLM call, but a static maintenance notice is sent to the user.
    expect(d.generateReply).not.toHaveBeenCalled();
    expect(d.sendReply).toHaveBeenCalledOnce();
    expect((d.sendReply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/maintenance mode/i);
    expect(d.startTyping).not.toHaveBeenCalled();
    const blocked = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "maintenance mode — blocked");
    expect(blocked.data).toEqual({ reason: "not_owner" });
  });

  it("lets the owner through in maintenance mode (source's isOwner stamp)", async () => {
    const d = deps({ policy: { maintenanceModeEnabled: true }, senderIsOwner: true });
    const out = await handleIncomingMessage(incoming({ text: "hi", fromId: "7" }), d);
    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(d.generateReply).toHaveBeenCalledOnce();
    expect(recorder.succeed).toHaveBeenCalledOnce();
  });

  it("keeps the owner fully functional in a group during maintenance (reply-to-bot)", async () => {
    // Reply-to-bot addressing (not a direct mention) still gets a normal reply —
    // maintenance mode imposes no extra restriction on the owner.
    const m = makeMessage({
      message_id: 7,
      chat: { id: 5, type: "group" },
      text: "thanks",
      reply_to_message: { message_id: 1, from: BOT_USER },
    });
    const d = deps({ policy: { maintenanceModeEnabled: true }, senderIsOwner: true });
    const out = await handleIncomingMessage(
      incoming({ message: m, chatType: "group", text: "thanks", fromId: "7" }),
      d,
    );
    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(d.generateReply).toHaveBeenCalledOnce();
    expect(recorder.succeed).toHaveBeenCalledOnce();
  });

  it("fails the trace and sends a fallback reply when generation throws", async () => {
    const d = deps({ generateReply: vi.fn().mockRejectedValue(new Error("provider down")) });
    const out = await handleIncomingMessage(incoming({ text: "hi" }), d);
    expect(out).toEqual({ status: "error", message: "provider down" });
    expect(recorder.fail).toHaveBeenCalledOnce();
    expect(d.sendReply).toHaveBeenCalledOnce();
    expect((d.sendReply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/could not generate/i);
    // Typing is always stopped, even on the error path.
    expect(stopTyping).toHaveBeenCalledOnce();
  });
});

/**
 * A request too large for the model's context window is the one provider failure
 * the service can fix itself: re-inject less history and try again. The shrink
 * must be stepwise (halving, newest messages kept), end at a no-history attempt,
 * and leave a warn step in the trace for every retry.
 */
describe("handleIncomingMessage — context-overflow retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const overflow = () =>
    new Error(
      "LLM endpoint error (400): request (36280 tokens) exceeds the available context size (32768 tokens), try increasing it",
    );

  /** A window whose transcript names its own size, so calls are distinguishable. */
  const window = (n: number) => ({
    messages: [{ role: "user" as const, content: `transcript of ${n}` }],
    count: n,
  });

  /** A generator that overflows `failures` times, then answers normally. */
  function generatorFailing(failures: number) {
    const fn = vi.fn();
    for (let i = 0; i < failures; i++) fn.mockRejectedValueOnce(overflow());
    return fn.mockImplementation(async (messages, trace) => {
      const result = { content: "hi back", model: "m", latencyMs: 5 };
      await recordExchange(trace, messages, result);
      return result;
    });
  }

  it("halves the history window per overflow until the request fits, tracing each retry", async () => {
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce(window(8)) // initial load
      .mockResolvedValueOnce(window(4))
      .mockResolvedValueOnce(window(2));
    const generateReply = generatorFailing(2);
    const d = deps({ loadHistory, generateReply });

    const out = await handleIncomingMessage(incoming({ text: "hi" }), d);
    expect(out).toEqual({ status: "replied", text: "hi back" });

    // Reloads ask for the newest half of the previous cap: 8 → 4 → 2.
    expect(loadHistory).toHaveBeenCalledTimes(3);
    expect(loadHistory.mock.calls[1][0]).toEqual({ maxMessages: 4 });
    expect(loadHistory.mock.calls[2][0]).toEqual({ maxMessages: 2 });
    // The attempt that succeeded was composed from the shrunken window.
    const finalMessages = generateReply.mock.calls[2][0];
    expect(finalMessages.some((m: { content: unknown }) => m.content === "transcript of 2")).toBe(
      true,
    );

    const retries = recorder.event.mock.calls
      .map((c) => c[0])
      .filter((e) => e.message.startsWith("context overflow"));
    expect(retries).toHaveLength(2);
    expect(retries[0].level).toBe("warn");
    expect(retries[0].message).toContain("shrunk to 4 messages");
    expect(retries[0].data).toMatchObject({
      attempt: 1,
      previousMessageCount: 8,
      retryMessageCount: 4,
      error: expect.stringContaining("exceeds the available context size"),
    });
    expect(retries[1].data).toMatchObject({
      attempt: 2,
      previousMessageCount: 4,
      retryMessageCount: 2,
    });
  });

  it("drops to a no-history attempt when the window can shrink no further", async () => {
    const loadHistory = vi.fn().mockResolvedValue(window(1));
    const generateReply = generatorFailing(1);
    const d = deps({ loadHistory, generateReply });

    const out = await handleIncomingMessage(incoming({ text: "hi" }), d);
    expect(out).toEqual({ status: "replied", text: "hi back" });

    // Cap 1 → 0: no reload — the retry simply omits the transcript entirely.
    expect(loadHistory).toHaveBeenCalledTimes(1);
    const retryMessages = generateReply.mock.calls[1][0];
    expect(retryMessages.some((m: { content: unknown }) => m.content === "transcript of 1")).toBe(
      false,
    );
    const retry = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "context overflow — retrying without history");
    expect(retry.level).toBe("warn");
    expect(retry.data).toMatchObject({ previousMessageCount: 1, retryMessageCount: 0 });
  });

  it("fails when the request overflows even with no history injected", async () => {
    const generateReply = vi.fn().mockRejectedValue(overflow());
    const d = deps({ generateReply }); // default loadHistory: empty window
    const out = await handleIncomingMessage(incoming({ text: "hi" }), d);
    expect(out.status).toBe("error");
    // Nothing left to shrink → no retry, the overflow surfaces as-is.
    expect(generateReply).toHaveBeenCalledOnce();
    expect(recorder.fail).toHaveBeenCalledOnce();
  });

  it("does not retry a non-overflow provider failure", async () => {
    const loadHistory = vi.fn().mockResolvedValue(window(4));
    const generateReply = vi.fn().mockRejectedValue(new Error("provider down"));
    const d = deps({ loadHistory, generateReply });
    const out = await handleIncomingMessage(incoming({ text: "hi" }), d);
    expect(out).toEqual({ status: "error", message: "provider down" });
    expect(generateReply).toHaveBeenCalledOnce();
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
});

/**
 * The analyzer only ever sees a group message the deterministic checks could not
 * settle — i.e. one that may be calling the bot by name in another alphabet or an
 * inflected form.
 */
describe("handleIncomingMessage — LLM addressing check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A group message naming neither the @handle nor the literal display name. */
  function groupChatter(text: string) {
    const m = makeMessage({ message_id: 7, chat: { id: 5, type: "group" }, text });
    return incoming({ message: m, chatType: "group", text });
  }

  /**
   * An analyzer that answers the classification call (citing `matchedText` when
   * given), then the verifier call — confirming unless `verified` is false.
   */
  function analyzer(nameMatch: string, matchedText?: string, verified = true) {
    const classification = matchedText
      ? `{"name_match": "${nameMatch}", "matched_text": "${matchedText}"}`
      : `{"name_match": "${nameMatch}"}`;
    const confirmation = `{"base_form": "x", "refers_to": "x", "is_display_name": ${verified}}`;
    const answers = [classification, confirmation];
    let call = 0;
    // Records itself through the shared layer like the real classifier, so the
    // event titles asserted below come from the labels the service passes.
    return vi.fn().mockImplementation(async (messages, trace) => {
      const content = answers[Math.min(call++, answers.length - 1)];
      const result = {
        content,
        model: "m",
        latencyMs: 3,
        responseBody: { id: "cmpl-1" },
      };
      await recordExchange(trace, messages, result);
      return result;
    });
  }

  it("replies when the analyzer finds the name in another alphabet", async () => {
    const analyzeAddressing = analyzer("other_alphabet", "Ари");
    const d = deps({ analyzeAddressing });
    const out = await handleIncomingMessage(groupChatter("Ари, привет"), d);

    expect(out).toEqual({ status: "replied", text: "hi back" });
    // One classification call about this message, then one verifier call about
    // the word the classification cited.
    expect(analyzeAddressing).toHaveBeenCalledTimes(2);
    expect(analyzeAddressing.mock.calls[0][0][1].content).toContain("Ари, привет");
    expect(analyzeAddressing.mock.calls[1][0][1].content).toContain("Word from the message: Ари");
    expect(recorder.succeed).toHaveBeenCalledOnce();
  });

  // The failure the verifier stage exists for: the classification cites a word
  // that really is in the message but is not the name (e.g. a declined generic
  // word), and the focused second look rejects it.
  it("stays silent when the verifier rejects the cited word", async () => {
    const analyzeAddressing = analyzer("other_alphabet", "Ари", false);
    const d = deps({ analyzeAddressing });
    const out = await handleIncomingMessage(groupChatter("Ари, привет"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed", source: "analyzer" });
    expect(analyzeAddressing).toHaveBeenCalledTimes(2);
    expect(d.generateReply).not.toHaveBeenCalled();
    expect(recorder.skip).toHaveBeenCalledOnce();
  });

  // The feedback loop's payoff: a word the chat reported as "wasn't talking to
  // you" must stop summoning the bot even when the model matches it again.
  it("stays silent when the analyzer cites a word the chat has excluded", async () => {
    const analyzeAddressing = analyzer("other_alphabet", "Георгій");
    const d = deps({
      analyzeAddressing,
      loadAddressExclusions: vi.fn().mockResolvedValue(["Георгій"]),
    });
    const out = await handleIncomingMessage(groupChatter("Георгій, ти йдеш?"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed", source: "analyzer" });
    expect(d.generateReply).not.toHaveBeenCalled();
    // The classification still ran — an exclusion overrules an answer, it never
    // skips asking — but the excluded citation costs no verifier call.
    expect(analyzeAddressing).toHaveBeenCalledTimes(1);
    expect(analyzeAddressing.mock.calls[0][0][1].content).toContain("- Георгій");
    expect(recorder.skip.mock.calls[0][1].outputSummary).toContain("exclusion list");
  });

  it("records the applied exclusions and the matched word on the trace", async () => {
    const d = deps({
      analyzeAddressing: analyzer("other_alphabet", "Ари"),
      loadAddressExclusions: vi.fn().mockResolvedValue(["Георгій"]),
    });
    await handleIncomingMessage(groupChatter("Ари, привет"), d);

    const events = recorder.event.mock.calls.map((c) => c[0]);
    const applied = events.find((e) => e.message.startsWith("addressing exclusions applied"));
    expect(applied?.data).toEqual({ exclusions: ["Георгій"] });
    // The word the bot answered to — what a "wasn't talking to you" report reads.
    const check = events.find((e) => e.message === "addressing check");
    expect(check?.data).toMatchObject({ matchedText: "Ари", botDisplayName: "Aria" });
  });

  // An unreadable exclusion list is an infrastructure problem, not a reason to
  // drop someone's message.
  it("still answers when the exclusion list cannot be read", async () => {
    const d = deps({
      analyzeAddressing: analyzer("other_alphabet", "Ари"),
      loadAddressExclusions: vi.fn().mockRejectedValue(new Error("db down")),
    });
    expect(await handleIncomingMessage(groupChatter("Ари, привет"), d)).toEqual({
      status: "replied",
      text: "hi back",
    });
  });

  it("replies when the analyzer finds an inflected form of the name", async () => {
    const d = deps({ analyzeAddressing: analyzer("inflected", "Арию") });
    expect(await handleIncomingMessage(groupChatter("Арию спросите"), d)).toEqual({
      status: "replied",
      text: "hi back",
    });
  });

  // The whole point of tracing the analyzer: a message the bot stayed silent on
  // is the one an operator needs explained.
  it("traces and skips — not silently drops — a message the analyzer rejects", async () => {
    const d = deps({ analyzeAddressing: analyzer("absent") });
    const out = await handleIncomingMessage(groupChatter("how was your weekend?"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed", source: "analyzer" });
    expect(d.generateReply).not.toHaveBeenCalled();
    expect(d.sendReply).not.toHaveBeenCalled();
    expect(d.startTyping).not.toHaveBeenCalled();
    expect(recorder.skip).toHaveBeenCalledOnce();
    expect(recorder.skip.mock.calls[0][1]).toEqual({
      outputSummary: "not addressed — display name absent",
    });

    // Full request and response bodies are on the trace, then the verdict.
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.message)).toEqual([
      "addressing analyzer request",
      "addressing analyzer response",
      "addressing check",
    ]);
    expect(events[1].data).toEqual({ id: "cmpl-1" });
    expect(events[2].data).toEqual({
      addressed: false,
      source: "analyzer",
      reason: "display name absent",
      matchedText: null,
      botDisplayName: "Aria",
    });
  });

  // A weak model can claim a match on a message that never names the bot (seen
  // live: every Cyrillic message classified "other_alphabet"). The uncorroborated
  // claim must read as absent, not become a reply.
  it("stays silent when the analyzer claims a match it cannot cite from the message", async () => {
    const d = deps({ analyzeAddressing: analyzer("other_alphabet") });
    const out = await handleIncomingMessage(groupChatter("Тупо без причини"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed", source: "analyzer" });
    expect(d.generateReply).not.toHaveBeenCalled();
    expect(recorder.skip).toHaveBeenCalledOnce();
  });

  it("opens exactly one trace for a message the analyzer accepts", async () => {
    const d = deps({ analyzeAddressing: analyzer("other_alphabet", "Ариа") });
    await handleIncomingMessage(groupChatter("Ариа, ты тут?"), d);

    expect(startTrace).toHaveBeenCalledOnce();
    // The analyzer's exchanges and the reply's land on the same trace, in order.
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.message)).toEqual([
      "addressing analyzer request",
      "addressing analyzer response",
      "addressing verifier request",
      "addressing verifier response",
      "addressing check",
      "system prompt composed",
      "history window loaded",
      "request",
      "response",
      "send message",
    ]);
  });

  // A failed classification is not evidence the bot was called.
  it("stays silent and does not fail the trace when the analyzer call throws", async () => {
    const analyzeAddressing = vi.fn().mockRejectedValue(new Error("provider down"));
    const d = deps({ analyzeAddressing });
    const out = await handleIncomingMessage(groupChatter("anyone around?"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed", source: "analyzer" });
    expect(d.sendReply).not.toHaveBeenCalled();
    expect(recorder.fail).not.toHaveBeenCalled();
    expect(recorder.skip).toHaveBeenCalledOnce();
    const failure = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "addressing analyzer failed — staying silent");
    expect(failure.data).toEqual({ error: "provider down" });
  });

  it("does not pay for the analyzer when the message already named the bot", async () => {
    const analyzeAddressing = analyzer("exact");
    const d = deps({ analyzeAddressing });
    const m = makeMessage({
      message_id: 7,
      chat: { id: 5, type: "group" },
      text: "aria, hello",
    });
    const out = await handleIncomingMessage(
      incoming({ message: m, chatType: "group", text: "aria, hello" }),
      d,
    );

    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(analyzeAddressing).not.toHaveBeenCalled();
  });

  // Maintenance means no LLM work beyond deterministically addressed turns —
  // settling an undecided message is itself an LLM call, so it never happens.
  it("does not consult the analyzer in maintenance mode: silent ignore, no trace, no notice", async () => {
    const analyzeAddressing = analyzer("other_alphabet", "Ари");
    const d = deps({
      analyzeAddressing,
      policy: { maintenanceModeEnabled: true },
    });
    const out = await handleIncomingMessage(groupChatter("Ари, привет"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed" });
    expect(analyzeAddressing).not.toHaveBeenCalled();
    expect(startTrace).not.toHaveBeenCalled();
    expect(d.sendReply).not.toHaveBeenCalled();
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("keeps the analyzer off for the owner too during maintenance", async () => {
    const analyzeAddressing = analyzer("other_alphabet", "Ари");
    const d = deps({
      analyzeAddressing,
      policy: { maintenanceModeEnabled: true },
      senderIsOwner: true,
    });
    const out = await handleIncomingMessage(groupChatter("Ари, привет"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed" });
    expect(analyzeAddressing).not.toHaveBeenCalled();
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("does not consult the analyzer in a private chat", async () => {
    const analyzeAddressing = analyzer("absent");
    const d = deps({ analyzeAddressing });
    const out = await handleIncomingMessage(incoming({ text: "hello there" }), d);

    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(analyzeAddressing).not.toHaveBeenCalled();
  });

  it("tells the model it was called by name when the analyzer decided so", async () => {
    const d = deps({
      analyzeAddressing: analyzer("inflected", "Арию"),
      loadCurrentTurn: vi.fn().mockResolvedValue({
        content: "[#7] Bob (@bob): Арию спросите",
        senderLabel: "Bob (@bob)",
        data: {},
      }),
    });
    await handleIncomingMessage(groupChatter("Арию спросите"), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const hint = messages.find((msg: { content: string }) =>
      String(msg.content).includes("called you by name"),
    );
    expect(hint.content).toContain("Bob (@bob)");
  });
});

describe("voice turns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers the reply through sendVoiceReply and records a voice send", async () => {
    const sendVoiceReply = vi.fn().mockResolvedValue({ messageId: 42, asVoice: true });
    const d = deps({ sendVoiceReply });
    const out = await handleIncomingMessage(
      incoming({ text: "what's the weather?", isVoice: true, hasVision: true }),
      d,
    );
    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(sendVoiceReply).toHaveBeenCalledWith("hi back");
    expect(d.sendReply).not.toHaveBeenCalled();
    const output = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "output");
    expect(output.message).toBe("send voice message");
    expect(output.data).toMatchObject({ content: "hi back", messageId: 42, asVoice: true });
    // The text form is still what history mirrors.
    expect(d.recordReply).toHaveBeenCalledWith({
      content: "hi back",
      telegramMessageId: 42,
      replyToMessageId: 7,
    });
  });

  it("records a plain text send when the voice path fell back internally", async () => {
    const sendVoiceReply = vi.fn().mockResolvedValue({ messageId: 43, asVoice: false });
    const d = deps({ sendVoiceReply });
    await handleIncomingMessage(incoming({ text: "hi", isVoice: true }), d);
    const output = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "output");
    expect(output.message).toBe("send message");
    expect(output.data).toMatchObject({ asVoice: false });
  });

  it("addresses a group voice message by its transcript (spoken display name)", async () => {
    const m = makeMessage({ message_id: 7, chat: { id: 5, type: "group" } });
    const d = deps();
    const out = await handleIncomingMessage(
      incoming({
        message: m,
        chatType: "group",
        text: "aria, what time is it?",
        isVoice: true,
        hasVision: true,
      }),
      d,
    );
    expect(out).toEqual({ status: "replied", text: "hi back" });
    const step = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "addressing check");
    expect(step.data).toMatchObject({ addressed: true, source: "name" });
  });

  it("ignores a group voice message whose transcript names nobody (no analyzer wired)", async () => {
    const m = makeMessage({ message_id: 7, chat: { id: 5, type: "group" } });
    const d = deps();
    const out = await handleIncomingMessage(
      incoming({
        message: m,
        chatType: "group",
        text: "how was your weekend?",
        isVoice: true,
        hasVision: true,
      }),
      d,
    );
    expect(out).toEqual({ status: "ignored", reason: "not_addressed" });
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("keeps the maintenance notice on the text path even for a voice turn", async () => {
    const sendVoiceReply = vi.fn();
    const d = deps({
      sendVoiceReply,
      policy: { maintenanceModeEnabled: true },
    });
    const out = await handleIncomingMessage(
      incoming({ text: "hello", isVoice: true, fromId: "100" }),
      d,
    );
    expect(out).toMatchObject({ status: "ignored", reason: "maintenance_mode" });
    expect(sendVoiceReply).not.toHaveBeenCalled();
    expect(d.sendReply).toHaveBeenCalledOnce();
    expect((d.sendReply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/maintenance/i);
  });
});

/**
 * Standing `always` rules — the one path by which the bot answers a message
 * nobody addressed to it. The matcher itself (prompt + citation check) is unit
 * tested in `features/tasks/server/matcher.test.ts`; what matters here is
 * that the service only consults it when the addressing check has already said
 * no, that a match produces a real reply carrying the directive, and that no
 * match leaves the message ignored.
 */
describe("handleIncomingMessage — standing tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function groupChatter(text: string) {
    const m = makeMessage({ message_id: 7, chat: { id: 5, type: "group" }, text });
    return incoming({ message: m, chatType: "group", text });
  }

  const matched = (directive: string | null = "RULE DIRECTIVE") =>
    vi.fn().mockResolvedValue({ directive, taskIds: ["r1"] });

  /**
   * A generator that actually calls a tool — what a rule-opened turn must do to
   * be delivered at all (see the enforcement suite below). The default `deps`
   * generator answers with words only, which on a rule turn is now suppressed.
   */
  const actsOnTheRule = () =>
    vi.fn().mockImplementation(async (messages, trace, onToolCall) => {
      await onToolCall?.({ name: "browse_web", args: {}, result: { text: "queued" }, ok: true });
      const result = { content: "hi back", model: "m", latencyMs: 5 };
      await recordExchange(trace, messages, result);
      return result;
    });

  it("replies to an un-addressed message when a rule matched, injecting the directive last", async () => {
    const applyStandingTasks = matched();
    const d = deps({ applyStandingTasks, generateReply: actsOnTheRule() });

    const out = await handleIncomingMessage(groupChatter("look https://example.com/clip"), d);

    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(applyStandingTasks).toHaveBeenCalledOnce();
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Last system message before the turn being answered: maximum recency.
    expect(messages.at(-2)).toEqual({ role: "system", content: "RULE DIRECTIVE" });
    expect(messages.at(-1).role).toBe("user");
  });

  it("tells the model the sender did not address it", async () => {
    const d = deps({ applyStandingTasks: matched(), generateReply: actsOnTheRule() });
    await handleIncomingMessage(groupChatter("look https://example.com/clip"), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const hint = messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === "system" && typeof m.content === "string" && m.content.includes("did not address you"),
    );
    expect(hint).toBeDefined();
  });

  it("stays silent when no rule matched", async () => {
    const applyStandingTasks = vi.fn().mockResolvedValue(null);
    const d = deps({ applyStandingTasks });

    const out = await handleIncomingMessage(groupChatter("just chatter"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed" });
    expect(applyStandingTasks).toHaveBeenCalledOnce();
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("stays silent when the matcher fails — a broken call is never an invitation", async () => {
    const applyStandingTasks = vi.fn().mockRejectedValue(new Error("provider down"));
    const d = deps({ applyStandingTasks });

    const out = await handleIncomingMessage(groupChatter("just chatter"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed" });
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("does not consult the matcher in maintenance mode", async () => {
    const applyStandingTasks = matched();
    const d = deps({
      applyStandingTasks,
      policy: { maintenanceModeEnabled: true },
    });

    const out = await handleIncomingMessage(groupChatter("look https://example.com/clip"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed" });
    expect(applyStandingTasks).not.toHaveBeenCalled();
  });

  it("still applies the rules on an addressed turn — that is where the authority is bound", async () => {
    const applyStandingTasks = matched();
    const d = deps({ applyStandingTasks });

    const out = await handleIncomingMessage(incoming({ text: "hello" }), d);

    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(applyStandingTasks).toHaveBeenCalledWith(expect.anything(), { addressed: true });
    // No directive on an addressed turn: the person asked, and the rules are
    // already in the system prompt.
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages.at(-2).content).not.toBe("RULE DIRECTIVE");
  });

  it("applies the rules exactly once on a turn a rule opened", async () => {
    const applyStandingTasks = matched();
    const d = deps({ applyStandingTasks, generateReply: actsOnTheRule() });

    await handleIncomingMessage(groupChatter("look https://example.com/clip"), d);

    expect(applyStandingTasks).toHaveBeenCalledOnce();
    expect(applyStandingTasks).toHaveBeenCalledWith(expect.anything(), { addressed: false });
  });

  it("runs the rule match concurrently with the addressing analyzer", async () => {
    // The analyzer's answer is held until the matcher has been consulted, so
    // this turn only completes when the two classifications run side by side —
    // the sequential order (analyzer first, matcher after) would deadlock.
    let releaseAnalyzer!: (reply: { content: string; model: string; latencyMs: number }) => void;
    const analyzeAddressing = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAnalyzer = resolve;
        }),
    );
    const applyStandingTasks = vi.fn().mockImplementation(async () => {
      // Next macrotask: the service has started the analyzer by then.
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseAnalyzer({ content: '{"name_match": "absent"}', model: "m", latencyMs: 1 });
      return { taskIds: ["r1"], directive: "RULE DIRECTIVE" };
    });
    const d = deps({ analyzeAddressing, applyStandingTasks, generateReply: actsOnTheRule() });

    const out = await handleIncomingMessage(groupChatter("look https://example.com/clip"), d);

    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(applyStandingTasks).toHaveBeenCalledOnce();
    expect(applyStandingTasks).toHaveBeenCalledWith(expect.anything(), { addressed: false });
  });

  it("settles the concurrent rule match, then re-applies the rules, when the analyzer opens the turn", async () => {
    // Analyzer says addressed: the already-started unaddressed match is settled
    // (its directive is moot), and the addressed-turn pass — the one that binds
    // authority from the full rule set — still runs and has the last word.
    const analyzeAddressing = vi
      .fn()
      .mockResolvedValueOnce({
        content: '{"name_match": "other_alphabet", "matched_text": "Ари"}',
        model: "m",
        latencyMs: 1,
      })
      .mockResolvedValue({
        content: '{"base_form": "x", "refers_to": "x", "is_display_name": true}',
        model: "m",
        latencyMs: 1,
      });
    const applyStandingTasks = matched();
    const d = deps({ analyzeAddressing, applyStandingTasks });

    const out = await handleIncomingMessage(groupChatter("Ари, привет"), d);

    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(applyStandingTasks).toHaveBeenCalledTimes(2);
    expect(applyStandingTasks.mock.calls[0][1]).toEqual({ addressed: false });
    expect(applyStandingTasks.mock.calls[1][1]).toEqual({ addressed: true });
    // The rule directive from the unaddressed pass is not injected — the person
    // addressed the bot themselves.
    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages.at(-2).content).not.toBe("RULE DIRECTIVE");
  });

  it("stays silent when the only matched rules cannot open a turn (no directive)", async () => {
    // An `on-reply` rule matched: it lends its author's rights on a turn the bot
    // was addressed in, but it can never start one.
    const applyStandingTasks = vi.fn().mockResolvedValue({ taskIds: ["r1"], directive: null });
    const d = deps({ applyStandingTasks });

    const out = await handleIncomingMessage(groupChatter("just chatter"), d);

    expect(out).toEqual({ status: "ignored", reason: "not_addressed" });
    expect(d.generateReply).not.toHaveBeenCalled();
  });

  it("does not fail the reply when applying the rules throws on an addressed turn", async () => {
    const applyStandingTasks = vi.fn().mockRejectedValue(new Error("provider down"));
    const d = deps({ applyStandingTasks });

    const out = await handleIncomingMessage(incoming({ text: "hello" }), d);

    expect(out).toEqual({ status: "replied", text: "hi back" });
  });

  it("composes the rules block into the system prompt and records that it applied", async () => {
    const d = deps({ standingTasks: "Standing rules for this chat:\n1. Answer briefly." });

    await handleIncomingMessage(incoming({ text: "hello" }), d);

    const messages = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(messages[0].content).toContain("1. Answer briefly.");
    const step = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "system prompt composed");
    expect(step.data.standingTasksApplied).toBe(true);
  });
});

/**
 * A rule-opened turn that ran no tool.
 *
 * The turn exists only because a standing rule demanded an action, and an action
 * happens only through a tool call — so an answer with zero calls cannot be true
 * however confident it sounds. Live incident (2026-08-03, trace `ec543b22…`): a
 * social-media link matched the chat's download rule, the model reasoned its way
 * to `browse_web`, then emitted "downloaded the video from x.com" with an
 * invented author handle and no call. The chat believed it.
 *
 * The check here is mechanical on purpose — a directive was injected, and
 * `onToolCall` never fired — so nothing depends on reading the answer.
 */
describe("handleIncomingMessage — a rule turn that called no tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function groupChatter(text: string) {
    const m = makeMessage({ message_id: 7, chat: { id: 5, type: "group" }, text });
    return incoming({ message: m, chatType: "group", text });
  }

  const matched = () =>
    vi.fn().mockResolvedValue({ directive: "RULE DIRECTIVE", taskIds: ["r1"] });

  /** Answers with words only, as the incident did — no tool call, ever. */
  const allTalk = (content = "downloaded the video") =>
    vi.fn().mockImplementation(async (messages, trace) => {
      const result = { content, model: "m", latencyMs: 5 };
      await recordExchange(trace, messages, result);
      return result;
    });

  /** Talks first, then acts when told — the recovery the enforcement is for. */
  const actsOnSecondAsking = () =>
    vi
      .fn()
      .mockImplementationOnce(async (messages, trace) => {
        const result = { content: "downloaded the video", model: "m", latencyMs: 5 };
        await recordExchange(trace, messages, result);
        return result;
      })
      .mockImplementation(async (messages, trace, onToolCall) => {
        await onToolCall?.({ name: "browse_web", args: {}, result: { text: "queued" }, ok: true });
        const result = { content: "on it", model: "m", latencyMs: 5 };
        await recordExchange(trace, messages, result);
        return result;
      });

  it("retries once with the answer and the correction appended", async () => {
    const d = deps({ applyStandingTasks: matched(), generateReply: actsOnSecondAsking() });

    await handleIncomingMessage(groupChatter("look https://example.com/clip"), d);

    const second = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[1][0];
    // The empty-handed answer, then the correction — shown, not merely asserted.
    expect(second.at(-2)).toEqual({ role: "assistant", content: "downloaded the video" });
    expect(second.at(-1).role).toBe("system");
    expect(second.at(-1).content).toBe(TASK_ENFORCEMENT_DIRECTIVE);
    // Everything before the correction is the same turn, unchanged.
    const first = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(second.slice(0, first.length)).toEqual(first);
  });

  it("settles the turn without sending its own text once the retry calls a tool", async () => {
    const d = deps({ applyStandingTasks: matched(), generateReply: actsOnSecondAsking() });

    const out = await handleIncomingMessage(groupChatter("look https://example.com/clip"), d);

    expect(out).toEqual({ status: "replied", text: "on it" });
    expect(d.generateReply).toHaveBeenCalledTimes(2);
    // A task-opened turn delivers through `reply_to_message`, so the pipeline
    // sends nothing of its own (user decision, 2026-08-14). "on it" is the
    // model's working-out, not a message: sending it here would post the reply
    // twice on a rule that *did* say something, and post chatter on one whose
    // action was a download.
    expect(d.sendReply).not.toHaveBeenCalled();
    expect(recorder.succeed).toHaveBeenCalled();
  });

  it("never sends the claim when the retry is also all talk, and says so instead", async () => {
    const d = deps({ applyStandingTasks: matched(), generateReply: allTalk() });

    const out = await handleIncomingMessage(groupChatter("look https://example.com/clip"), d);

    expect(out.status).toBe("error");
    expect(d.generateReply).toHaveBeenCalledTimes(2);
    const sent = (d.sendReply as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("downloaded the video");
    // Not silence: the chat is told the rule did not run (user decision, 2026-08-03).
    expect(sent[0]).toContain("System:");
    expect(sent[0]).toContain("not carried out");
  });

  it("fails the trace so a rule that did not run is findable on Debug", async () => {
    const d = deps({ applyStandingTasks: matched(), generateReply: allTalk() });

    await handleIncomingMessage(groupChatter("look https://example.com/clip"), d);

    expect(recorder.fail).toHaveBeenCalled();
    expect(recorder.succeed).not.toHaveBeenCalled();
    const messages = recorder.event.mock.calls.map((c) => c[0].message);
    expect(messages).toContain("task turn answered without calling any tool — retrying");
    expect(messages).toContain("task turn called no tool on the retry either — answer suppressed");
  });

  it("does not mirror the suppressed answer or the notice into history", async () => {
    const d = deps({ applyStandingTasks: matched(), generateReply: allTalk() });

    await handleIncomingMessage(groupChatter("look https://example.com/clip"), d);

    expect(d.recordReply).not.toHaveBeenCalled();
  });

  it("leaves an ordinary addressed turn alone — no rule, no enforcement", async () => {
    // The guard keys on the directive, which only a turn nobody addressed gets.
    // A normal reply that needs no tool is not a lie and must not be touched.
    const d = deps({ generateReply: allTalk("sure, whatever") });

    const out = await handleIncomingMessage(incoming({ text: "hello" }), d);

    expect(out).toEqual({ status: "replied", text: "sure, whatever" });
    expect(d.generateReply).toHaveBeenCalledOnce();
  });

  it("leaves an addressed turn alone even when a rule matched it", async () => {
    // An `on-reply` match binds authority but sets no directive: the person asked
    // a question, and answering it in words is a complete answer.
    const applyStandingTasks = vi.fn().mockResolvedValue({ taskIds: ["r1"], directive: null });
    const d = deps({ applyStandingTasks, generateReply: allTalk("no idea") });

    const out = await handleIncomingMessage(incoming({ text: "hello" }), d);

    expect(out).toEqual({ status: "replied", text: "no idea" });
    expect(d.generateReply).toHaveBeenCalledOnce();
  });
});

/**
 * Transient provider failures the completion path recovered from on its own. The
 * service does not retry these — it records them, so a turn the endpoint had to
 * be asked twice for cannot pass for a clean one on the dashboard.
 */
describe("handleIncomingMessage — recorded LLM retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a warn step for a retried LLM call", async () => {
    const generateReply = vi.fn().mockImplementation(async (messages, trace) => {
      await recordLlmRequest(TEST_CONN, trace, { model: "m", messages });
      await recordLlmRetry(trace, {
        attempt: 1,
        attempts: 2,
        error: "Connection to http://llm timed out",
        delayMs: 3000,
      });
      const result = { content: "hi back", model: "m", latencyMs: 5 };
      await recordLlmResponse(trace, {
        model: "m",
        latencyMs: 5,
        responseBody: undefined,
        content: result.content,
      });
      return result;
    });
    const d = deps({ generateReply });

    const out = await handleIncomingMessage(incoming({ text: "hello" }), d);

    expect(out).toEqual({ status: "replied", text: "hi back" });
    const step = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => String(e.message).startsWith("LLM call failed — retrying"));
    expect(step.level).toBe("warn");
    expect(step.data.error).toContain("timed out");
  });
});

/**
 * The honesty gate — the guard over an *addressed* turn's answer.
 *
 * The rule-turn check above is mechanical because that turn's whole purpose is
 * the action. An ordinary turn has no such signal: most zero-tool replies are
 * perfectly honest conversation, and only the text says which is which. So the
 * gate runs on every zero-tool turn, asks the model whether the answer asserts
 * something was done, and retries only when it says yes with a quote that is
 * really in the reply.
 *
 * Live incident (2026-08-06, trace `3db16957…`): asked twice to cancel a
 * scheduled task, the model planned the lookup in its reasoning, decided the
 * lookup would find nothing, called nothing, and reported the task removed.
 */
describe("handleIncomingMessage — the honesty gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A gate verdict, in the shape the real classifier returns it — recorded
   *  through the shared layer with the labels the service passes. */
  const gate = (claim: string, quote: string | null) =>
    vi.fn().mockImplementation(async (messages, trace) => {
      const result = {
        content: JSON.stringify({ claim, quote }),
        model: "m",
        latencyMs: 2,
      };
      await recordExchange(trace, messages, result);
      return result;
    });

  /** Answers with words only — no tool call, ever. */
  const allTalk = (content: string) =>
    vi.fn().mockImplementation(async (messages, trace) => {
      const result = { content, model: "m", latencyMs: 5 };
      await recordExchange(trace, messages, result);
      return result;
    });

  /** Talks first, then actually calls the tool when corrected. */
  const actsOnSecondAsking = (first: string, second: string) =>
    vi
      .fn()
      .mockImplementationOnce(async (messages, trace) => {
        const result = { content: first, model: "m", latencyMs: 5 };
        await recordExchange(trace, messages, result);
        return result;
      })
      .mockImplementation(async (messages, trace, onToolCall) => {
        await onToolCall?.({ name: "tasks_delete", args: {}, result: { text: "ok" }, ok: true });
        const result = { content: second, model: "m", latencyMs: 5 };
        await recordExchange(trace, messages, result);
        return result;
      });

  it("leaves an ordinary reply alone and never asks twice", async () => {
    const checkActionClaim = gate("none", null);
    const d = deps({ checkActionClaim });

    const out = await handleIncomingMessage(incoming({ text: "how are you" }), d);

    expect(out).toEqual({ status: "replied", text: "hi back" });
    expect(checkActionClaim).toHaveBeenCalledTimes(1);
    expect(d.generateReply).toHaveBeenCalledTimes(1);
    expect(d.sendReply).toHaveBeenCalledWith("hi back");
  });

  it("costs nothing on a turn that actually called a tool", async () => {
    const checkActionClaim = gate("performed", "deleted it");
    const generateReply = vi.fn().mockImplementation(async (messages, trace, onToolCall) => {
      await onToolCall?.({ name: "tasks_delete", args: {}, result: { text: "ok" }, ok: true });
      const result = { content: "deleted it", model: "m", latencyMs: 5 };
      await recordExchange(trace, messages, result);
      return result;
    });
    const d = deps({ checkActionClaim, generateReply });

    const out = await handleIncomingMessage(incoming({ text: "cancel the task" }), d);

    expect(out).toEqual({ status: "replied", text: "deleted it" });
    expect(checkActionClaim).not.toHaveBeenCalled();
  });

  it("retries with the answer and the correction appended when the answer lies", async () => {
    const d = deps({
      checkActionClaim: gate("performed", "task deleted"),
      generateReply: actsOnSecondAsking("task deleted", "gone"),
    });

    await handleIncomingMessage(incoming({ text: "cancel the task" }), d);

    const second = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(second.at(-2)).toEqual({ role: "assistant", content: "task deleted" });
    expect(second.at(-1).role).toBe("system");
    expect(second.at(-1).content).toBe(ACTION_CLAIM_ENFORCEMENT_DIRECTIVE);
    // Everything before the correction is the same turn, unchanged.
    const first = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(second.slice(0, first.length)).toEqual(first);
  });

  it("delivers the retry and stops checking once the retry calls the tool", async () => {
    const checkActionClaim = gate("performed", "task deleted");
    const d = deps({
      checkActionClaim,
      generateReply: actsOnSecondAsking("task deleted", "gone"),
    });

    const out = await handleIncomingMessage(incoming({ text: "cancel the task" }), d);

    expect(out).toEqual({ status: "replied", text: "gone" });
    expect(d.sendReply).toHaveBeenCalledWith("gone");
    // The action happened; there is nothing left for the gate to answer for.
    expect(checkActionClaim).toHaveBeenCalledTimes(1);
    expect(recorder.succeed).toHaveBeenCalled();
  });

  // The exit the directive deliberately offers as an equal option.
  it("delivers a retry that owned up instead of calling anything", async () => {
    const checkActionClaim = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({ claim: "performed", quote: "task deleted" }),
        model: "m",
        latencyMs: 2,
      })
      .mockResolvedValue({
        content: JSON.stringify({ claim: "none", quote: null }),
        model: "m",
        latencyMs: 2,
      });
    const honest = "I could not — I found no such task";
    const d = deps({
      checkActionClaim,
      generateReply: vi
        .fn()
        .mockImplementationOnce(async (messages, trace) => {
          const r = { content: "task deleted", model: "m", latencyMs: 5 };
          await recordExchange(trace, messages, r);
          return r;
        })
        .mockImplementation(async (messages, trace) => {
          const r = { content: honest, model: "m", latencyMs: 5 };
          await recordExchange(trace, messages, r);
          return r;
        }),
    });

    const out = await handleIncomingMessage(incoming({ text: "cancel the task" }), d);

    expect(out).toEqual({ status: "replied", text: honest });
    expect(checkActionClaim).toHaveBeenCalledTimes(2);
    expect(recorder.succeed).toHaveBeenCalled();
  });

  it("never sends the claim when the retry lies again, and says so instead", async () => {
    const d = deps({
      checkActionClaim: gate("performed", "task deleted"),
      generateReply: allTalk("task deleted"),
    });

    const out = await handleIncomingMessage(incoming({ text: "cancel the task" }), d);

    expect(out.status).toBe("error");
    expect(d.generateReply).toHaveBeenCalledTimes(2);
    const sent = (d.sendReply as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("task deleted");
    expect(sent[0]).toBe(ACTION_NOT_TAKEN_REPLY);
    // Failed, not green: an undelivered answer is exactly the turn an operator
    // has to be able to find on the Debug page.
    expect(recorder.fail).toHaveBeenCalled();
    expect(recorder.succeed).not.toHaveBeenCalled();
    const messages = recorder.event.mock.calls.map((c) => c[0].message);
    expect(messages).toContain("reply claimed an action no tool performed — retrying");
    expect(messages).toContain("reply claimed the action again on the retry — answer suppressed");
  });

  // Fail open: a guard against lies must not become a new way for turns to break.
  it("delivers the reply as written when the gate call fails", async () => {
    const d = deps({
      checkActionClaim: vi.fn().mockRejectedValue(new Error("endpoint down")),
      generateReply: allTalk("task deleted"),
    });

    const out = await handleIncomingMessage(incoming({ text: "cancel the task" }), d);

    expect(out).toEqual({ status: "replied", text: "task deleted" });
    expect(d.generateReply).toHaveBeenCalledTimes(1);
    const warn = recorder.event.mock.calls
      .map((c) => c[0])
      .find((e) => e.message === "honesty gate failed — reply left as written");
    expect(warn.level).toBe("warn");
  });

  it("delivers the reply when the gate quotes words that are not in it", async () => {
    const d = deps({
      checkActionClaim: gate("performed", "I have scheduled the reminder"),
      generateReply: allTalk("task deleted"),
    });

    const out = await handleIncomingMessage(incoming({ text: "cancel the task" }), d);

    expect(out).toEqual({ status: "replied", text: "task deleted" });
    expect(d.generateReply).toHaveBeenCalledTimes(1);
  });

  it("records the gate call on the reply trace as its own kind", async () => {
    const d = deps({ checkActionClaim: gate("none", null) });

    await handleIncomingMessage(incoming({ text: "how are you" }), d);

    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(events.some((e) => e.message === "honesty gate request")).toBe(true);
    const response = events.find((e) => e.message === "honesty gate response");
    expect(response.usage.callKind).toBe("action-claim-check");
  });

  it("stays out of a rule turn, which has its own stricter check", async () => {
    const checkActionClaim = gate("performed", "downloaded the video");
    const text = "look https://example.com/clip";
    const d = deps({
      checkActionClaim,
      applyStandingTasks: vi.fn().mockResolvedValue({ directive: "RULE DIRECTIVE", taskIds: ["r1"] }),
      generateReply: allTalk("downloaded the video"),
    });
    const m = makeMessage({ message_id: 7, chat: { id: 5, type: "group" }, text });

    const out = await handleIncomingMessage(incoming({ message: m, chatType: "group", text }), d);

    expect(out.status).toBe("error");
    expect(checkActionClaim).not.toHaveBeenCalled();
    const sent = (d.sendReply as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(sent[0]).toContain("not carried out");
  });
});

/**
 * Reply integrity: a thinking model that stops using its thought channel sends
 * its working-out as the answer. Measured 10/10 on the live endpoint against
 * the request behind trace `3491c387` — and 10/10 recovered by exactly this
 * retry (2026-08-24). The turn must not deliver the notes, and must not go
 * silent either when the second attempt fails as well.
 */
describe("handleIncomingMessage — reply integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A generator whose answers are scripted per attempt. */
  const scripted = (answers: string[], finishReasons: (string | undefined)[] = []) =>
    vi.fn().mockImplementation(async (messages: unknown, trace: LlmCallTrace | undefined) => {
      const attempt = (scriptedCalls.count += 1) - 1;
      const responseBody = finishReasons[attempt]
        ? { choices: [{ finish_reason: finishReasons[attempt] }] }
        : undefined;
      const result = { content: answers[attempt], model: "m", latencyMs: 5, responseBody };
      await recordExchange(trace, messages, result);
      return result;
    });
  const scriptedCalls = { count: 0 };
  beforeEach(() => {
    scriptedCalls.count = 0;
  });

  it("retries deliberation written in the transcript format, then delivers the real answer", async () => {
    const leaked =
      '[#616] drumslave (@drumslave): як тебе звуть?\nThe user is asking again. I should say';
    const d = deps({ generateReply: scripted([leaked, "I'm Anna."]) });

    const out = await handleIncomingMessage(incoming({ text: "як тебе звуть?" }), d);
    expect(out).toEqual({ status: "replied", text: "I'm Anna." });

    // The correction turn is the one the module defines, and it is shown the
    // rejected answer — same shape as the other two enforcement retries.
    const second = (d.generateReply as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(JSON.stringify(second)).toContain(REPLY_INTEGRITY_DIRECTIVE.slice(0, 40));
    const events = recorder.event.mock.calls.map((c) => c[0]);
    const warn = events.find((e) => e.message === "reply is deliberation, not an answer — retrying");
    expect(warn?.level).toBe("warn");
    expect((warn?.data as { reason?: string }).reason).toMatch(/\[#616\]/);
    // Only the real answer reaches the chat.
    expect((d.sendReply as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      "I'm Anna.",
    ]);
  });

  it("retries an answer cut off at the token cap", async () => {
    const d = deps({
      generateReply: scripted(["a long answer that never finished because it hit the", "Short."], [
        "length",
      ]),
    });
    const out = await handleIncomingMessage(incoming({ text: "tell me" }), d);
    expect(out).toEqual({ status: "replied", text: "Short." });
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(
      events.find((e) => e.message === "reply is deliberation, not an answer — retrying"),
    ).toMatchObject({ data: { reason: expect.stringMatching(/token cap/) } });
  });

  it("suppresses a second deliberation, says so in the chat, and fails the trace", async () => {
    const leaked = "[#1] someone: hi\nI should answer by saying";
    const d = deps({ generateReply: scripted([leaked, `${leaked} something else`]) });

    const out = await handleIncomingMessage(incoming({ text: "hi" }), d);
    expect(out.status).toBe("error");
    // The chat is told, in the labeled system voice — never left in silence.
    expect((d.sendReply as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      REPLY_NOT_PRODUCED_REPLY,
    ]);
    expect(recorder.fail).toHaveBeenCalledOnce();
    // Failed, not succeeded: this is a turn an operator has to find on /debug.
    const events = recorder.event.mock.calls.map((c) => c[0]);
    expect(
      events.find((e) => e.message === "second attempt was deliberation as well — answer suppressed"),
    ).toMatchObject({ level: "error" });
    expect(stopTyping).toHaveBeenCalledOnce();
  });

  it("leaves an ordinary reply alone, including one citing a message id", async () => {
    const d = deps({ generateReply: scripted(["You asked me that in #611 — still Anna."]) });
    const out = await handleIncomingMessage(incoming({ text: "again?" }), d);
    expect(out).toEqual({ status: "replied", text: "You asked me that in #611 — still Anna." });
    expect(d.generateReply).toHaveBeenCalledOnce();
  });
});
