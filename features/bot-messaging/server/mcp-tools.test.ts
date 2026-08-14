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
vi.mock("@/server/telegram/bot-manager", () => ({ reactToChatMessage: vi.fn() }));

const { getChatMessagesByTelegramIds } = await import("@/features/history/server/repository");
const mockedLookup = vi.mocked(getChatMessagesByTelegramIds);
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
  return handlers()[REPLY_TO_MESSAGE_TOOL] as (args: { message_id: number }) => Promise<ToolResult>;
}

function reactionHandler() {
  return handlers()[SET_MESSAGE_REACTION_TOOL] as (args: {
    message_id: number;
    emoji: string;
    big: boolean;
  }) => Promise<ToolResult>;
}

/** A mirrored message, as the lookup returns it (only the id is read). */
function mirrored(telegramMessageId: number) {
  return [{ telegramMessageId }] as never;
}

describe("reply_to_message", () => {
  it("moves the turn's reply target to the requested message", async () => {
    mockedLookup.mockResolvedValue(mirrored(4321));
    const targets: number[] = [];

    const result = await runWithToolContext(
      { chatId: "-100", setReplyTarget: (id) => targets.push(id) },
      () => toolHandler()({ message_id: 4321 }),
    );

    expect(targets).toEqual([4321]);
    expect(result.structuredContent).toEqual({ ok: true, message_id: 4321 });
    // The chat sees the quote, so telling the model to quote it too would double it.
    expect(result.content[0].text).toContain("no need to quote");
  });

  it("scopes the lookup to the bound chat, never a chat the model names", async () => {
    mockedLookup.mockResolvedValue(mirrored(7));
    await runWithToolContext({ chatId: "-100", setReplyTarget: () => {} }, () =>
      toolHandler()({ message_id: 7 }),
    );
    expect(mockedLookup).toHaveBeenCalledWith(expect.anything(), "-100", [7]);
  });

  it("refuses an id that is not in this chat, and moves nothing", async () => {
    // The failure this prevents: Telegram rejects a send whose reply target it
    // cannot find, so a guessed id would cost the whole reply.
    mockedLookup.mockResolvedValue([] as never);
    const targets: number[] = [];

    const result = await runWithToolContext(
      { chatId: "-100", setReplyTarget: (id) => targets.push(id) },
      () => toolHandler()({ message_id: 999 }),
    );

    expect(targets).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No message #999 in this chat");
    expect(result.structuredContent).toEqual({ ok: false, message_id: null });
  });

  it("refuses when the turn has no reply to aim, without touching the database", async () => {
    mockedLookup.mockClear();

    // A bound turn with no sink — e.g. a text-only scheduled-task fire.
    const result = await runWithToolContext({ chatId: "-100" }, () =>
      toolHandler()({ message_id: 4321 }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no reply to attach");
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("lets a later call replace an earlier target", async () => {
    mockedLookup.mockResolvedValue(mirrored(1));
    const targets: number[] = [];
    const handler = toolHandler();

    await runWithToolContext({ chatId: "-100", setReplyTarget: (id) => targets.push(id) }, async () => {
      await handler({ message_id: 1 });
      await handler({ message_id: 2 });
    });

    // The pipeline reads the last value written, so the tool needs no state of
    // its own — but the contract is worth pinning, since the description says so.
    expect(targets).toEqual([1, 2]);
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
  });

  it("offers exactly the reactions the Bot API documents", () => {
    expect(missingEmoji).toEqual([]);
    expect(TELEGRAM_REACTION_EMOJI).toContain("\u{1F44D}");
  });

  it("reacts to a message of the bound chat", async () => {
    mockedLookup.mockResolvedValue(mirrored(4321));

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 4321, emoji: "\u{1F44D}", big: false }),
    );

    expect(mockedLookup).toHaveBeenCalledWith(expect.anything(), "-100", [4321]);
    expect(mockedReact).toHaveBeenCalledWith("-100", 4321, "\u{1F44D}", { big: false });
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

  it("removes the reaction when no emoji is given", async () => {
    mockedLookup.mockResolvedValue(mirrored(10));

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 10, emoji: "", big: false }),
    );

    expect(mockedReact).toHaveBeenCalledWith("-100", 10, null, { big: false });
    expect(result.structuredContent).toEqual({ ok: true, message_id: 10, emoji: null });
    expect(result.content[0].text).toContain("Removed your reaction");
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
  });
});
