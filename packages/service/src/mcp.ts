import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Context } from "hono";

/**
 * Serving a source app's own MCP server over its Hono surface (PLAN.md: "it
 * exposes an MCP server for its outbound actions").
 *
 * Stateless: one `McpServer` per request, no session ids. A source app's
 * tools are called by one client — the core, inside a turn — and every call
 * carries its whole context in the request's `_meta`, so there is no session
 * state worth keeping alive between calls, and nothing to reconcile when the
 * app restarts mid-conversation.
 *
 * The transport wants Node's `req`/`res`, which Hono's node adapter exposes
 * as the request env; the handler writes the response itself and hands Hono
 * the sentinel saying so.
 */

/** Node req/res as the Hono node-server adapter exposes them. */
interface NodeEnv {
  incoming: Parameters<StreamableHTTPServerTransport["handleRequest"]>[0];
  outgoing: Parameters<StreamableHTTPServerTransport["handleRequest"]>[1];
}

/**
 * Answer one MCP request with a freshly built server. `createServer` is
 * called per request and closed with it, so a tool's registration can depend
 * on nothing but the app's own state.
 */
export async function serveMcp(
  c: Context,
  createServer: () => McpServer,
): Promise<Response> {
  const { incoming, outgoing } = c.env as unknown as NodeEnv;
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  outgoing.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(incoming, outgoing);
  return RESPONSE_ALREADY_SENT;
}
