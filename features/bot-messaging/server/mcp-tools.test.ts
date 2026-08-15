import type { ReactionTypeEmoji } from "@grammyjs/types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TELEGRAM_REACTION_EMOJI, type TelegramReactionEmoji } from "@/lib/telegram";
import { runWithToolContext } from "@/server/mcp/context";

import {
  registerBotMessagingMcpTools,
  REPLY_TO_MESSAGE_TOOL,
  SET_MESSAGE_REACTION_TOOL,
} from "./mcp-tools";

/**
 * Both tools in this toolkit are about *not* lying to the chat: they must act
 * only on a target that really exists in this conversation, and refuse audibly
 * when they cannot — a silent no-op would leave the model saying "here it is"
 * pointing at nothing, or claiming a reaction Telegram never accepted.
 */

vi.mock("@/db/drizzle", () => ({ getDb: () => ({}) }));
vi.mock("@/features/history/server/repository", () => ({
  getChatMessagesByTelegramIds: vi.fn(),
}));
vi.mock("@/features/history/server/service", () => ({ recordBotReaction: vi.fn() }));
vi.mock("@/server/telegram/bot-manager", () => ({ reactToChatMessage: vi.fn() }));

const { getChatMessagesByTelegramIds } = await import("@/features/history/server/repository");
const mockedLookup = vi.mocked(getChatMessagesByTelegramIds);
const { recordBotReaction } = await import("@/features/history/server/service");
const mockedRecord = vi.mocked(recordBotReaction);
const { reactToChatMessage } = await import("@/server/telegram/bot-manager");
const mockedReact = vi.mocked(reactToChatMessage);

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent: { ok: boolean; message_id: number | null; emoji?: string | null };
  isError?: boolean;
}

/** Register the toolkit and return one tool's handler, as the MCP server would invoke it. */
function handlers() {
  const registered: Record<string, unknown> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: unknown) => {
      registered[name] = handler;
    },
  } as unknown as McpServer;
  registerBotMessagingMcpTools(server);
  return registered;
}

function toolHandler() {
  return handlers()[REPLY_TO_MESSAGE_TOOL] as (args: { text: string }) => Promise<ToolResult>;
}

function reactionHandler() {
  return handlers()[SET_MESSAGE_REACTION_TOOL] as (args: {
    message_id: number;
    emoji: string;
    big: boolean;
  }) => Promise<ToolResult>;
}

/** A mirrored message from a person, as the lookup returns it (id + role are read). */
function mirrored(telegramMessageId: number) {
  return [{ telegramMessageId, role: "user" }] as never;
}

/** A mirrored message the bot itself sent. */
function mirroredOwn(telegramMessageId: number) {
  return [{ telegramMessageId, role: "assistant" }] as never;
}

describe("reply_to_message", () => {
  /** A turn opened by a `message` task: the one kind that may reply. */
  function replyTurn(sent: string[]) {
    return {
      chatId: "-100",
      deliveryKind: "reply" as const,
      deliver: async (text: string) => {
        sent.push(text);
        return { messageId: 555 };
      },
    };
  }

  it("delivers the text and reports the sent message's own id", async () => {
    const sent: string[] = [];

    const result = await runWithToolContext(replyTurn(sent), () =>
      toolHandler()({ text: "you are wrong about that" }),
    );

    expect(sent).toEqual(["you are wrong about that"]);
    expect(result.structuredContent).toEqual({ ok: true, message_id: 555 });
  });

  it("sends once per call, so two calls are two messages", async () => {
    const sent: string[] = [];
    const handler = toolHandler();

    await runWithToolContext(replyTurn(sent), async () => {
      await handler({ text: "first" });
      await handler({ text: "second" });
    });

    expect(sent).toEqual(["first", "second"]);
  });

  it("refuses in an ordinary reply turn, where the answer is already the message", async () => {
    // The turn that has no delivery binding is the one whose own text is on its
    // way to the chat; delivering here too would post the reply twice.
    const result = await runWithToolContext({ chatId: "-100" }, () =>
      toolHandler()({ text: "hello" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("your own answer is the message");
    expect(result.structuredContent).toEqual({ ok: false, message_id: null });
  });

  it("refuses in a fire, which has no message to reply to", async () => {
    // A stale registry can hand the model the wrong delivery tool. Answering
    // "replied to the message" in a turn where no message triggered anything is
    // exactly the quiet lie the refusals exist to prevent, so the binding's kind
    // is checked, not merely its presence.
    const sent: string[] = [];
    const result = await runWithToolContext(
      {
        chatId: "-100",
        deliveryKind: "send",
        deliver: async (text: string) => {
          sent.push(text);
          return { messageId: 1 };
        },
      },
      () => toolHandler()({ text: "hello" }),
    );

    expect(result.isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it("needs no message id, so there is none for the model to get wrong", async () => {
    // The regression this pins: the tool used to take a `message_id` plus an
    // optional `text` that one of its two modes silently discarded, which is how
    // a whole reply ended up in a dropped argument (trace 224ef60a…).
    mockedLookup.mockClear();
    const sent: string[] = [];

    await runWithToolContext(replyTurn(sent), () => toolHandler()({ text: "hi" }));

    expect(sent).toEqual(["hi"]);
    // No target to validate means no lookup to perform.
    expect(mockedLookup).not.toHaveBeenCalled();
  });
});

/**
 * Compile-time proof that the offered set is Telegram's whole documented set: if
 * an emoji were missing from `TELEGRAM_REACTION_EMOJI`, the `Exclude` would not
 * be `never` and this assignment would not typecheck. (The opposite direction —
 * an entry that is not a real reaction, e.g. one mangled by an encoding step —
 * is caught by the `satisfies` clause on the constant itself.)
 */
const missingEmoji: never[] = [] as Exclude<
  ReactionTypeEmoji["emoji"],
  TelegramReactionEmoji
>[];

describe("set_message_reaction", () => {
  beforeEach(() => {
    mockedReact.mockReset();
    mockedLookup.mockReset();
    mockedRecord.mockReset();
  });

  it("offers exactly the reactions the Bot API documents", () => {
    expect(missingEmoji).toEqual([]);
    expect(TELEGRAM_REACTION_EMOJI).toContain("\u{1F44D}");
  });

  it("reacts to a message of the bound chat and records it in history", async () => {
    mockedLookup.mockResolvedValue(mirrored(4321));

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 4321, emoji: "\u{1F44D}", big: false }),
    );

    expect(mockedLookup).toHaveBeenCalledWith(expect.anything(), "-100", [4321]);
    expect(mockedReact).toHaveBeenCalledWith("-100", 4321, "\u{1F44D}", { big: false });
    // The memory of the reaction — without it, the next turn denies having
    // reacted (operator report, 2026-08-15).
    expect(mockedRecord).toHaveBeenCalledWith({
      chatId: "-100",
      telegramMessageId: 4321,
      emoji: "\u{1F44D}",
    });
    expect(result.structuredContent).toEqual({
      ok: true,
      message_id: 4321,
      emoji: "\u{1F44D}",
    });
    // The badge is already visible in the chat; saying it too would double it.
    expect(result.content[0].text).toContain("no need to also say");
  });

  it("accepts a variation-selector spelling and sends Telegram's own form", async () => {
    // The failure this prevents: the Bot API names the heart U+2764 and rejects
    // U+2764 U+FE0F, which is how clients (and models) usually write it.
    mockedLookup.mockResolvedValue(mirrored(10));

    await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 10, emoji: "❤️", big: false }),
    );

    expect(mockedReact).toHaveBeenCalledWith("-100", 10, "❤", { big: false });
  });

  it("removes the reaction when no emoji is given, clearing the history record too", async () => {
    mockedLookup.mockResolvedValue(mirrored(10));

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 10, emoji: "", big: false }),
    );

    expect(mockedReact).toHaveBeenCalledWith("-100", 10, null, { big: false });
    expect(mockedRecord).toHaveBeenCalledWith({
      chatId: "-100",
      telegramMessageId: 10,
      emoji: null,
    });
    expect(result.structuredContent).toEqual({ ok: true, message_id: 10, emoji: null });
    expect(result.content[0].text).toContain("Removed your reaction");
  });

  it("reports success with a warning — never a refusal — when only the history write fails", async () => {
    // The reaction IS on the message once Telegram accepted it; a failed mirror
    // write must not make the tool claim Telegram refused. It only says the
    // memory of it is missing.
    mockedLookup.mockResolvedValue(mirrored(11));
    mockedRecord.mockRejectedValue(new Error("db down"));

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 11, emoji: "\u{1F44D}", big: false }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, message_id: 11, emoji: "\u{1F44D}" });
    expect(result.content[0].text).toContain("could not be recorded");
  });

  it("refuses an emoji Telegram has no reaction for, without calling Telegram", async () => {
    mockedLookup.mockResolvedValue(mirrored(10));

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 10, emoji: "\u{1F355}", big: false }),
    );

    expect(mockedReact).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    // The refusal carries the whole menu, so the retry can succeed.
    expect(result.content[0].text).toContain("\u{1F44D}");
    expect(result.structuredContent).toEqual({ ok: false, message_id: null, emoji: null });
  });

  it("refuses an id that is not in this chat, without calling Telegram", async () => {
    mockedLookup.mockResolvedValue([] as never);

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 999, emoji: "\u{1F44D}", big: false }),
    );

    expect(mockedReact).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No message #999 in this chat");
  });

  it("refuses to react to the bot's own message", async () => {
    // Telegram would allow it, so the guard has to live here: a badge the bot
    // put on its own message tells nobody anything.
    mockedLookup.mockResolvedValue(mirroredOwn(55));

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 55, emoji: "\u{1F44D}", big: false }),
    );

    expect(mockedReact).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("is your own");
    expect(result.structuredContent).toEqual({ ok: false, message_id: null, emoji: null });
  });

  it("still reacts to another bot's message, which the mirror files as a person's", async () => {
    mockedLookup.mockResolvedValue(mirrored(56));

    await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 56, emoji: "\u{1F44D}", big: false }),
    );

    expect(mockedReact).toHaveBeenCalledWith("-100", 56, "\u{1F44D}", { big: false });
  });

  it("relays a Telegram refusal instead of reporting a reaction that never landed", async () => {
    // A chat may allow only some emoji, a message can be too old, the poller can
    // be down — all only knowable from Telegram's answer.
    mockedLookup.mockResolvedValue(mirrored(10));
    mockedReact.mockRejectedValue(new Error("Bad Request: REACTION_INVALID"));

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 10, emoji: "\u{1F44D}", big: false }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("REACTION_INVALID");
    expect(result.content[0].text).toContain("Do not claim you reacted");
    expect(result.structuredContent).toEqual({ ok: false, message_id: null, emoji: null });
    // A reaction Telegram refused never happened — nothing to remember.
    expect(mockedRecord).not.toHaveBeenCalled();
  });
});
