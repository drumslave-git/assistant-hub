import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/**
 * A real MCP server over Streamable HTTP, for tests that exercise a remote
 * tool connection end to end (discovery, apply, and calling a tool).
 *
 * Real rather than a stubbed client: the parts most likely to be wrong are
 * the wire ones — transport negotiation, whether auth headers actually reach
 * the server, whether `_meta` survives the round trip — and a fake client
 * proves none of them. Stateless (a fresh server per request) so a test can
 * change the offered toolset between calls, which is exactly the drift the
 * snapshot rule exists for.
 */

/** One tool the fake server offers. */
export interface FakeTool {
  name: string;
  description: string;
  /** Zod shape for the tool's arguments (empty = no arguments). */
  inputShape?: z.ZodRawShape;
  /** What the tool answers; receives the call arguments and the request `_meta`. */
  handler?: (args: Record<string, unknown>, meta: Record<string, unknown> | undefined) => string;
}

export interface FakeMcpServer {
  url: string;
  /** Replace the offered toolset (the next discovery sees this). */
  setTools(tools: FakeTool[]): void;
  /** Auth headers seen on the most recent request. */
  lastHeaders(): Record<string, string | string[] | undefined>;
  /** Fail every request with this status until cleared (null = serve normally). */
  failWith(status: number | null): void;
  close(): Promise<void>;
}

/** Start the server on an ephemeral port. */
export async function startFakeMcpServer(initial: FakeTool[] = []): Promise<FakeMcpServer> {
  let tools = initial;
  let headers: Record<string, string | string[] | undefined> = {};
  let failStatus: number | null = null;

  const http: Server = createServer(async (req, res) => {
    headers = req.headers;
    if (failStatus !== null) {
      res.writeHead(failStatus).end("nope");
      return;
    }
    const mcp = new McpServer({ name: "fake-mcp", version: "1.0.0" });
    for (const tool of tools) {
      mcp.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputShape ?? {} },
        async (args: Record<string, unknown>, extra: { _meta?: Record<string, unknown> }) => ({
          content: [
            {
              type: "text" as const,
              text: tool.handler?.(args, extra?._meta) ?? `${tool.name} ran`,
            },
          ],
        }),
      );
    }
    // Stateless: no session id, one server instance per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    setTools: (next) => {
      tools = next;
    },
    lastHeaders: () => headers,
    failWith: (status) => {
      failStatus = status;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        http.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
