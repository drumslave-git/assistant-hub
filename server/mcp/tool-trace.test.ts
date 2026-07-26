import { describe, expect, it } from "vitest";

import { listTraces } from "@/server/trace";
import { setupTempTraceStore } from "@/test/trace-store";
import type { McpToolCallResult } from "./tool-result";
import { tracedToolCall } from "./tool-trace";

/**
 * `tracedToolCall` wraps every MCP tool call in its own `mcp-tools-<owner>` trace.
 * Traces live in the file-backed store now (no database), so this is Docker-free.
 */

const ok: McpToolCallResult = { text: "echo: hi", isError: false };

setupTempTraceStore();

describe("tracedToolCall", () => {
  it("records a success trace scoped to mcp-tools-<owner> with the tool name as action", async () => {
    const result = await tracedToolCall("history", "history_search", { query: "hi" }, async () => ok);
    expect(result).toEqual(ok);

    const { traces } = await listTraces({ feature: "mcp-tools-history" });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ action: "history_search", status: "success" });
  });

  it("settles success but flags an error result (isError) rather than failing the trace", async () => {
    await tracedToolCall("memory", "memory_search", { q: "x" }, async () => ({
      text: "nope",
      isError: true,
    }));
    const { traces } = await listTraces({ feature: "mcp-tools-memory" });
    expect(traces[0]).toMatchObject({ action: "memory_search", status: "success" });
    expect(traces[0].outputSummary).toBe("error result");
  });

  it("fails the trace and rethrows when the tool throws", async () => {
    await expect(
      tracedToolCall("history", "history_search", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);

    const { traces } = await listTraces({ feature: "mcp-tools-history" });
    expect(traces[0].status).toBe("error");
  });
});
