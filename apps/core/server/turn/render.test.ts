import {
  inboundMessageEventSchema,
  type HistoryMessage,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import { describe, expect, it } from "vitest";

import {
  botTranscriptLabel,
  renderChatContext,
  renderCurrentTurn,
  renderHistoryWindow,
} from "./render";

/**
 * Transcript attribution in a chat several assistants share (Phase 3, slice
 * E). The rest of the rendering — anchors, reaction badges, media notes — is
 * the v1 format, covered where those primitives live.
 */

const NAMES = new Map([
  ["assistant-1", "Aria"],
  ["assistant-2", "Nova"],
]);

function line(input: {
  id: string;
  role: "user" | "assistant";
  assistantId?: string | null;
  content: string;
}): HistoryMessage {
  return {
    sourceMessageId: input.id,
    role: input.role,
    assistantId: input.assistantId ?? null,
    senderRef: input.role === "user" ? "tg:user:5001" : null,
    senderLabel: input.role === "user" ? "Alice (@alice_example)" : null,
    content: input.content,
    sentAt: new Date().toISOString(),
  };
}

function crossFedEvent(authoredByAssistantId?: string): InboundMessageEvent {
  return inboundMessageEventSchema.parse({
    v: 1,
    eventId: "evt-render",
    occurredAt: new Date().toISOString(),
    correlationId: "-300:42:assistant-2",
    type: "message.inbound",
    source: "tg",
    assistantId: "assistant-2",
    connection: { botUsername: "second_bot", botDisplayName: "Second Bot" },
    chat: { ref: "tg:chat:-300", kind: "group", title: "Fixture Group" },
    sender: { ref: "tg:user:9001", isOwner: false, label: "First Bot" },
    ...(authoredByAssistantId ? { authoredByAssistantId } : {}),
    addressing: { addressed: true, source: "mention", needsAnalyzer: false },
    message: {
      sourceMessageId: "42",
      content: "@second_bot what do you make of it?",
      sentAt: new Date().toISOString(),
    },
    context: { history: [], participants: [] },
  });
}

describe("renderHistoryWindow attribution", () => {
  const history = [
    line({ id: "10", role: "user", content: "morning both" }),
    line({ id: "11", role: "assistant", assistantId: "assistant-1", content: "morning!" }),
    line({ id: "12", role: "assistant", assistantId: "assistant-2", content: "hello" }),
    line({ id: "13", role: "assistant", assistantId: null, content: "an unattributed line" }),
  ];

  it("renders the reading assistant's own lines as 'You' and the others by name", () => {
    const { messages } = renderHistoryWindow(history, botTranscriptLabel(), {
      voices: { selfAssistantId: "assistant-2", assistantNames: NAMES },
    });
    const transcript = String(messages[0].content);
    expect(transcript).toContain("[#11] Aria: morning!");
    expect(transcript).toContain("[#12] You: hello");
    expect(transcript).toContain("[#10] Alice (@alice_example): morning both");
  });

  it("reads the same window as its own from the other assistant's side", () => {
    const { messages } = renderHistoryWindow(history, botTranscriptLabel(), {
      voices: { selfAssistantId: "assistant-1", assistantNames: NAMES },
    });
    const transcript = String(messages[0].content);
    expect(transcript).toContain("[#11] You: morning!");
    expect(transcript).toContain("[#12] Nova: hello");
  });

  it("treats an unattributed assistant line as the reader's own", () => {
    const { messages } = renderHistoryWindow(history, botTranscriptLabel(), {
      voices: { selfAssistantId: "assistant-2", assistantNames: NAMES },
    });
    expect(String(messages[0].content)).toContain("[#13] You: an unattributed line");
  });

  it("names an assistant the store no longer knows without claiming its words", () => {
    const { messages } = renderHistoryWindow(
      [line({ id: "14", role: "assistant", assistantId: "assistant-gone", content: "an old reply" })],
      botTranscriptLabel(),
      { voices: { selfAssistantId: "assistant-2", assistantNames: NAMES } },
    );
    expect(String(messages[0].content)).toContain("[#14] Another assistant: an old reply");
  });

  it("without voices, every assistant line reads as the reader's own (v1 behavior)", () => {
    const { messages } = renderHistoryWindow(history, botTranscriptLabel());
    const transcript = String(messages[0].content);
    expect(transcript).toContain("[#11] You: morning!");
    expect(transcript).toContain("[#12] You: hello");
  });
});

describe("renderCurrentTurn attribution", () => {
  it("speaks a cross-fed message as the authoring ASSISTANT, not the bot account", () => {
    const turn = renderCurrentTurn(crossFedEvent("assistant-1"), {
      voices: { selfAssistantId: "assistant-2", assistantNames: NAMES },
    });
    expect(turn.senderLabel).toBe("Aria");
    expect(turn.content).toBe("[#42] Aria: @second_bot what do you make of it?");
  });

  it("keeps the source's sender label for an ordinary message", () => {
    const turn = renderCurrentTurn(crossFedEvent(), {
      voices: { selfAssistantId: "assistant-2", assistantNames: NAMES },
    });
    expect(turn.senderLabel).toBe("First Bot");
  });
});

/**
 * Where the turn is happening. The base system prompt used to assert
 * "a Telegram chat", so a web thread confidently told the operator it was in
 * Telegram; the truth is now said per turn, from the event's own source.
 */
describe("renderChatContext", () => {
  const eventIn = (source: "tg" | "chat", kind: "direct" | "group"): InboundMessageEvent =>
    inboundMessageEventSchema.parse({
      v: 1,
      eventId: "evt-surface",
      occurredAt: new Date().toISOString(),
      correlationId: "c:1:assistant-1",
      type: "message.inbound",
      source,
      assistantId: "assistant-1",
      ...(source === "tg"
        ? { connection: { botUsername: "a_bot", botDisplayName: "Aria" } }
        : {}),
      chat: {
        ref: source === "tg" ? "tg:chat:-300" : "chat:thread:t1",
        kind,
        title: "Somewhere",
      },
      sender: {
        ref: source === "tg" ? "tg:user:5001" : "chat:user:u1",
        isOwner: true,
        label: "Alice",
      },
      addressing: { addressed: true, source: "private", needsAnalyzer: false },
      message: { sourceMessageId: "1", content: "hi", sentAt: new Date().toISOString() },
      context: { history: [], participants: [] },
    });

  it("names the telegram surface", () => {
    expect(renderChatContext(eventIn("tg", "group"))?.content).toContain(
      "This conversation is a Telegram group chat.",
    );
  });

  it("names the web-chat surface instead of inheriting telegram's", () => {
    const context = renderChatContext(eventIn("chat", "direct"));
    expect(context?.content).toContain("web chat");
    expect(context?.content).not.toContain("Telegram");
    expect(context?.data).toMatchObject({ source: "chat" });
  });
});
