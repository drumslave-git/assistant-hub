import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import { runWithToolContext } from "@/server/mcp/context";

import { registerImageGenMcpTools, IMAGE_GENERATE_TOOL } from "./mcp-tools";

/**
 * The image tool's defining property is where the *bytes* go: to the turn's
 * `collectImage` sink, and nowhere else. Anything that leaks them into the tool
 * result would put a megabyte of base64 into both the model's context and the
 * trace row — so these tests pin the sink contract rather than the generation,
 * which `generate.test.ts` covers.
 */

vi.mock("./generate", () => ({
  runImageGeneration: vi.fn(),
}));

const { runImageGeneration } = await import("./generate");
const mockedRun = vi.mocked(runImageGeneration);

/** Register the tool and return its handler, as the MCP server would invoke it. */
function toolHandler() {
  const registered: Record<string, unknown> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: unknown) => {
      registered[name] = handler;
    },
  } as unknown as McpServer;
  registerImageGenMcpTools(server);
  return registered[IMAGE_GENERATE_TOOL] as (args: {
    prompt: string;
    size?: [number, number];
  }) => Promise<{
    content: { type: string; text: string }[];
    structuredContent: { ok: boolean; count: number; size: [number, number] };
    isError?: boolean;
  }>;
}

describe("image_generate", () => {
  it("hands the bytes to the sink and keeps them out of the result", async () => {
    mockedRun.mockResolvedValue({
      ok: true,
      images: ["AAAA", "BBBB"],
      size: [1024, 1024],
      context: "Generated 2 images…",
      reason: "generated 2",
    });
    const collected: string[] = [];
    const handler = toolHandler();

    const result = await runWithToolContext(
      { chatId: "42", collectImage: (b64) => collected.push(b64) },
      () => handler({ prompt: "a red car" }),
    );

    expect(collected).toEqual(["AAAA", "BBBB"]);
    expect(result.structuredContent).toEqual({ ok: true, count: 2, size: [1024, 1024] });
    // The bytes must not ride along in the result: it goes to the model and, verbatim,
    // into trace storage.
    expect(JSON.stringify(result)).not.toContain("AAAA");
  });

  it("refuses before generating when the turn cannot send images", async () => {
    mockedRun.mockClear();
    const handler = toolHandler();

    // A bound turn with no sink — e.g. a text-only scheduled-task fire.
    const result = await runWithToolContext({ chatId: "42" }, () =>
      handler({ prompt: "a red car" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot be sent in this context");
    // Spending minutes on bytes nothing can deliver is the failure being avoided.
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("reports a failed generation as an error result and collects nothing", async () => {
    mockedRun.mockResolvedValue({
      ok: false,
      images: [],
      size: [1024, 1024],
      context: "Image generation failed: endpoint unreachable…",
      reason: "endpoint unreachable",
    });
    const collected: string[] = [];
    const handler = toolHandler();

    const result = await runWithToolContext(
      { chatId: "42", collectImage: (b64) => collected.push(b64) },
      () => handler({ prompt: "a red car" }),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ ok: false, count: 0, size: [1024, 1024] });
    expect(collected).toEqual([]);
  });
});
