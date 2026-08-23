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
 *
 * Since the source split the reaction lands through the owning source's API:
 * a reply turn carries the binding on its tool context (`reactToMessage`),
 * and a turn without one (a task fire) falls back to the source port. Both
 * paths answer the same refusal states.
 */

vi.mock("@/server/turn/tg-outbound", () => ({ resolveSourceOutbound: vi.fn() }));

const { resolveSourceOutbound } = await import("@/server/turn/tg-outbound");
const mockedResolve = vi.mocked(resolveSourceOutbound);

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

/** A source port whose setReaction records its calls (the fire's fallback). */
function fakePort(outcome?: { status: "ok" | "not_found" | "own_message"; recorded: boolean }) {
  const setReaction = vi.fn().mockResolvedValue(outcome ?? { status: "ok", recorded: true });
  mockedResolve.mockReturnValue({ setReaction } as never);
  return setReaction;
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

describe("set_message_reaction over the source-port fallback", () => {
  beforeEach(() => {
    mockedResolve.mockReset();
    mockedResolve.mockReturnValue(null);
  });

  it("offers exactly the reactions the Bot API documents", () => {
    expect(missingEmoji).toEqual([]);
    expect(TELEGRAM_REACTION_EMOJI).toContain("\u{1F44D}");
  });

  it("reacts through the source port when the turn carries no binding (a fire)", async () => {
    const setReaction = fakePort();

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 4321, emoji: "\u{1F44D}", big: false }),
    );

    expect(setReaction).toHaveBeenCalledWith("-100", 4321, "\u{1F44D}", { big: false });
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
    const setReaction = fakePort();

    await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 10, emoji: "❤️", big: false }),
    );

    expect(setReaction).toHaveBeenCalledWith("-100", 10, "❤", { big: false });
  });

  it("removes the reaction when no emoji is given", async () => {
    const setReaction = fakePort();

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 10, emoji: "", big: false }),
    );

    expect(setReaction).toHaveBeenCalledWith("-100", 10, null, { big: false });
    expect(result.structuredContent).toEqual({ ok: true, message_id: 10, emoji: null });
    expect(result.content[0].text).toContain("Removed your reaction");
  });

  it("refuses an emoji Telegram has no reaction for, without touching the source", async () => {
    const setReaction = fakePort();

    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 10, emoji: "\u{1F355}", big: false }),
    );

    expect(setReaction).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    // The refusal carries the whole menu, so the retry can succeed.
    expect(result.content[0].text).toContain("\u{1F44D}");
    expect(result.structuredContent).toEqual({ ok: false, message_id: null, emoji: null });
  });

  it("refuses coherently when the telegram service is not configured", async () => {
    // No binding on the context and no source API from env: the tool must
    // refuse rather than claim a reaction nothing could deliver.
    const result = await runWithToolContext({ chatId: "-100" }, () =>
      reactionHandler()({ message_id: 10, emoji: "\u{1F44D}", big: false }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("telegram service is not configured");
    expect(result.content[0].text).toContain("do not claim you reacted");
  });
});

describe("set_message_reaction over the turn's port binding", () => {
  beforeEach(() => {
    mockedResolve.mockReset();
    mockedResolve.mockReturnValue(null);
  });

  /** A consumer-path turn: the source owns the mirror and the platform call. */
  function portTurn(port: {
    calls: Array<{ messageId: number; emoji: string | null; big?: boolean }>;
    outcome?: { status: "ok" | "not_found" | "own_message"; recorded: boolean };
    error?: Error;
  }) {
    return {
      chatId: "-100",
      reactToMessage: async (input: { messageId: number; emoji: string | null; big?: boolean }) => {
        port.calls.push(input);
        if (port.error) throw port.error;
        return port.outcome ?? { status: "ok" as const, recorded: true };
      },
    };
  }

  it("reacts through the binding and never resolves the env port", async () => {
    const port = { calls: [] as Array<{ messageId: number; emoji: string | null }> };

    const result = await runWithToolContext(portTurn(port), () =>
      reactionHandler()({ message_id: 21, emoji: "❤️", big: false }),
    );

    // Normalized to Telegram's canonical form before crossing the port.
    expect(port.calls).toEqual([{ messageId: 21, emoji: "❤", big: false }]);
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({ ok: true, message_id: 21, emoji: "❤" });
  });

  it("words the source's not_found as the no-guessing refusal", async () => {
    const port = {
      calls: [],
      outcome: { status: "not_found" as const, recorded: false },
    };

    const result = await runWithToolContext(portTurn(port), () =>
      reactionHandler()({ message_id: 999, emoji: "\u{1F44D}", big: false }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No message #999 in this chat");
  });

  it("words the source's own_message as the self-reaction refusal", async () => {
    const port = {
      calls: [],
      outcome: { status: "own_message" as const, recorded: false },
    };

    const result = await runWithToolContext(portTurn(port), () =>
      reactionHandler()({ message_id: 22, emoji: "\u{1F44D}", big: false }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("is your own");
  });

  it("relays a platform refusal the port throws", async () => {
    const port = { calls: [], error: new Error("Bad Request: REACTION_INVALID") };

    const result = await runWithToolContext(portTurn(port), () =>
      reactionHandler()({ message_id: 21, emoji: "\u{1F44D}", big: false }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("REACTION_INVALID");
    expect(result.content[0].text).toContain("Do not claim you reacted");
  });

  it("reports success with the memory warning when the source could not record", async () => {
    const port = { calls: [], outcome: { status: "ok" as const, recorded: false } };

    const result = await runWithToolContext(portTurn(port), () =>
      reactionHandler()({ message_id: 21, emoji: "\u{1F44D}", big: false }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("could not be recorded");
  });
});
