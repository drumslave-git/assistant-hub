import { describe, expect, it } from "vitest";

import { callToolResultToText, mcpToolToOpenAi, toToolCallResult } from "./openai-tools";

describe("mcpToolToOpenAi", () => {
  it("maps name/description and strips the $schema marker from parameters", () => {
    const tool = mcpToolToOpenAi({
      name: "history_search",
      description: "Search history",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    });
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("history_search");
    expect(tool.function.description).toBe("Search history");
    expect(tool.function.parameters).not.toHaveProperty("$schema");
    expect(tool.function.parameters).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  it("falls back to the name when no description is given", () => {
    expect(mcpToolToOpenAi({ name: "t" }).function.description).toBe("t");
  });
});

describe("callToolResultToText", () => {
  it("joins text content blocks", () => {
    expect(
      callToolResultToText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    ).toBe("a\n\nb");
  });

  it("reports an error result with no text", () => {
    expect(callToolResultToText({ content: [], isError: true })).toBe("Tool returned an error.");
  });

  it("reports empty content", () => {
    expect(callToolResultToText({ content: [] })).toBe("Tool returned no content.");
  });
});

describe("toToolCallResult", () => {
  it("normalizes text, structured content, and the error flag", () => {
    const result = toToolCallResult({
      content: [{ type: "text", text: "hi" }],
      structuredContent: { ok: true },
      isError: false,
    });
    expect(result).toEqual({ text: "hi", structuredContent: { ok: true }, isError: false });
  });
});
