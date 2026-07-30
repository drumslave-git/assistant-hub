import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";

import { compactAgentConversation } from "./agent";

/** The assistant turn that requested one tool call, as the loop appends it. */
function assistantCall(id: string, name: string): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  };
}

function toolResult(id: string, content: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: id, content };
}

/** One tool round: the assistant turn asking plus the tool turn answering. */
function round(id: string, name: string, content: string): ChatCompletionMessageParam[] {
  return [assistantCall(id, name), toolResult(id, content)];
}

const imageTurn = (url: string): ChatCompletionMessageParam => ({
  role: "user",
  content: [
    { type: "text", text: "Image(s) produced by the tool call(s) above:" },
    { type: "image_url", image_url: { url } },
  ],
});

const seed: ChatCompletionMessageParam[] = [
  { role: "system", content: "You are a web-browsing agent." },
  { role: "user", content: "Goal: find the file" },
];

const contentsOf = (conversation: ChatCompletionMessageParam[]) =>
  conversation.filter((m) => m.role === "tool").map((m) => m.content);

describe("compactAgentConversation", () => {
  it("stubs every page-state snapshot but the latest", () => {
    const conversation = [
      ...seed,
      ...round("c1", "browser_navigate", "PAGE STATE 1"),
      ...round("c2", "browser_click", "PAGE STATE 2"),
      ...round("c3", "browser_scroll", "PAGE STATE 3"),
    ];

    const compacted = compactAgentConversation(conversation);

    const [first, second, third] = contentsOf(compacted);
    expect(first).toMatch(/superseded page state/);
    expect(second).toMatch(/superseded page state/);
    expect(third).toBe("PAGE STATE 3");
  });

  it("keeps only the latest two page-source chunks", () => {
    const conversation = [
      ...seed,
      ...round("c1", "browser_navigate", "PAGE STATE"),
      ...round("c2", "browser_source", "SOURCE @0"),
      ...round("c3", "browser_source", "SOURCE @20000"),
      ...round("c4", "browser_source", "SOURCE @40000"),
    ];

    const compacted = compactAgentConversation(conversation);

    expect(contentsOf(compacted)).toEqual([
      "PAGE STATE",
      expect.stringMatching(/superseded page-source chunk/),
      "SOURCE @20000",
      "SOURCE @40000",
    ]);
  });

  it("keeps search results, network listings, and download outcomes verbatim", () => {
    const conversation = [
      ...seed,
      ...round("c1", "browser_search", "1. Title — https://example.com"),
      ...round("c2", "browser_navigate", "PAGE STATE 1"),
      ...round("c3", "browser_get_network", "GET https://cdn.example.com/v.m3u8 200"),
      ...round("c4", "browser_navigate", "PAGE STATE 2"),
      ...round("c5", "browser_download_stream", "Downloaded v.mp4 (12 MB)"),
    ];

    const compacted = compactAgentConversation(conversation);

    expect(contentsOf(compacted)).toEqual([
      "1. Title — https://example.com",
      expect.stringMatching(/superseded page state/),
      "GET https://cdn.example.com/v.m3u8 200",
      "PAGE STATE 2",
      "Downloaded v.mp4 (12 MB)",
    ]);
  });

  it("replaces every screenshot vision turn but the latest with a text stub", () => {
    const conversation = [
      ...seed,
      ...round("c1", "browser_screenshot", "screenshot 1 captured"),
      imageTurn("data:image/jpeg;base64,OLD"),
      ...round("c2", "browser_screenshot", "screenshot 2 captured"),
      imageTurn("data:image/jpeg;base64,NEW"),
    ];

    const compacted = compactAgentConversation(conversation);

    const userTurns = compacted.filter((m) => m.role === "user");
    // Goal turn untouched, old screenshot stubbed to text, latest kept as parts.
    expect(userTurns[0].content).toBe("Goal: find the file");
    expect(userTurns[1].content).toMatch(/superseded screenshot/);
    expect(Array.isArray(userTurns[2].content)).toBe(true);
  });

  it("leaves the conversation structurally intact for the provider", () => {
    const conversation = [
      ...seed,
      ...round("c1", "browser_navigate", "PAGE STATE 1"),
      ...round("c2", "browser_read", "PAGE STATE 2"),
    ];

    const compacted = compactAgentConversation(conversation);

    // Same shape: every tool turn keeps its id, and the input is not mutated.
    expect(compacted.map((m) => m.role)).toEqual(conversation.map((m) => m.role));
    const stubbed = compacted[3] as { tool_call_id: string };
    expect(stubbed.tool_call_id).toBe("c1");
    expect(contentsOf(conversation)).toEqual(["PAGE STATE 1", "PAGE STATE 2"]);
  });
});
