import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { BotMcpRegistry } from "./registry";

/**
 * Exercises the in-process MCP host end to end (server ↔ client over the linked
 * transport). Also proves the installed MCP SDK works with this project's zod 4:
 * a registered tool's schema round-trips to JSON Schema and the call executes.
 */

function registerEcho(server: McpServer): void {
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo the given text",
      inputSchema: { text: z.string().describe("text to echo") },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
}

async function buildRegistry(): Promise<BotMcpRegistry> {
  const registry = new BotMcpRegistry();
  registry.registerTools("test", registerEcho, ["echo"]);
  await registry.finishRegistration();
  return registry;
}

describe("BotMcpRegistry", () => {
  it("lists registered tools with feature + description", async () => {
    const registry = await buildRegistry();
    const tools = await registry.listTools();
    expect(tools).toEqual([{ name: "echo", description: "Echo the given text", feature: "test" }]);
  });

  it("offers every registered tool in OpenAI shape", async () => {
    const registry = await buildRegistry();
    const openai = await registry.listOpenAiTools();
    expect(openai).toHaveLength(1);
    expect(openai[0].function.name).toBe("echo");
    expect(openai[0].function.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    expect(openai[0].function.parameters).not.toHaveProperty("$schema");
  });

  it("calls a registered tool and normalizes its result", async () => {
    const registry = await buildRegistry();
    const result = await registry.callTool("echo", { text: "hi" });
    expect(result.text).toBe("echo: hi");
    expect(result.isError).toBe(false);
  });
});
