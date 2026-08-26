import {
  inboundMessageEventSchema,
  type HistoryMessage,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import { describe, expect, it } from "vitest";

import { assistantTurnStreak, checkLoopGuard } from "./loop-guard";

/** Synthetic history line (invented ids/names only). */
function line(
  role: "user" | "assistant",
  sourceMessageId: string,
  assistantId?: string,
): HistoryMessage {
  return {
    sourceMessageId,
    role,
    assistantId: role === "assistant" ? (assistantId ?? "assistant-1") : null,
    senderRef: role === "user" ? "tg:user:5001" : null,
    senderLabel: role === "user" ? "Alice (@alice_example)" : null,
    content: `message ${sourceMessageId}`,
    sentAt: new Date().toISOString(),
  };
}

/** An inbound event with the given history, optionally cross-fed. */
function event(input: {
  history: HistoryMessage[];
  authoredByAssistantId?: string;
}): InboundMessageEvent {
  return inboundMessageEventSchema.parse({
    v: 1,
    eventId: "evt-guard",
    occurredAt: new Date().toISOString(),
    correlationId: "-300:40",
    type: "message.inbound",
    source: "tg",
    assistantId: "assistant-2",
    connection: { botUsername: "second_bot", botDisplayName: "Second" },
    chat: { ref: "tg:chat:-300", kind: "group", title: "Fixture Group" },
    sender: { ref: "tg:user:5001", isOwner: false, label: "Alice (@alice_example)" },
    ...(input.authoredByAssistantId
      ? { authoredByAssistantId: input.authoredByAssistantId }
      : {}),
    addressing: { addressed: true, source: "mention", needsAnalyzer: false },
    message: {
      sourceMessageId: "40",
      content: "and what do you think?",
      sentAt: new Date().toISOString(),
    },
    context: { history: input.history, participants: [] },
  });
}

describe("assistantTurnStreak", () => {
  it("is zero for a message a person wrote, whatever precedes it", () => {
    expect(assistantTurnStreak([line("assistant", "1"), line("assistant", "2")], false)).toBe(0);
  });

  it("counts the incoming assistant message itself", () => {
    expect(assistantTurnStreak([line("user", "1")], true)).toBe(1);
  });

  it("counts the trailing run of assistant messages, stopping at the last human", () => {
    const history = [
      line("assistant", "1"),
      line("user", "2"),
      line("assistant", "3", "assistant-1"),
      line("assistant", "4", "assistant-2"),
    ];
    expect(assistantTurnStreak(history, true)).toBe(3);
  });

  it("counts an empty window as the incoming message alone", () => {
    expect(assistantTurnStreak([], true)).toBe(1);
  });
});

describe("checkLoopGuard", () => {
  it("never silences a turn a person opened", () => {
    const verdict = checkLoopGuard(
      event({ history: [line("assistant", "1"), line("assistant", "2")] }),
      3,
    );
    expect(verdict).toMatchObject({ silenced: false, streak: 0 });
  });

  it("lets the exchange run while the streak is under the limit", () => {
    const verdict = checkLoopGuard(
      event({ history: [line("user", "1")], authoredByAssistantId: "assistant-1" }),
      3,
    );
    expect(verdict).toMatchObject({ silenced: false, streak: 1, limit: 3 });
  });

  it("silences the chat once the streak reaches the limit", () => {
    const history = [
      line("user", "1"),
      line("assistant", "2", "assistant-1"),
      line("assistant", "3", "assistant-2"),
    ];
    const verdict = checkLoopGuard(event({ history, authoredByAssistantId: "assistant-1" }), 3);
    expect(verdict.silenced).toBe(true);
    expect(verdict.streak).toBe(3);
    expect(verdict.reason).toContain("limit 3");
  });

  it("stays silenced past the limit (a late job never slips through)", () => {
    const history = [
      line("user", "1"),
      line("assistant", "2"),
      line("assistant", "3"),
      line("assistant", "4"),
    ];
    expect(checkLoopGuard(event({ history, authoredByAssistantId: "assistant-1" }), 3).silenced).toBe(
      true,
    );
  });

  it("a limit of 0 stops assistants answering each other at all", () => {
    const verdict = checkLoopGuard(
      event({ history: [line("user", "1")], authoredByAssistantId: "assistant-1" }),
      0,
    );
    expect(verdict.silenced).toBe(true);
    expect(verdict.reason).toBe("assistants are configured not to answer each other");
  });
});
