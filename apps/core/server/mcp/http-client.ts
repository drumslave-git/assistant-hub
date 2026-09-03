import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { mcpToolToOpenAi, toToolCallResult, type McpListedTool } from "./openai-tools";
import type { McpToolCallResult } from "./tool-result";

/**
 * The client side of a remote MCP tool connection (PLAN.md, "MCP tool
 * connections"): one short-lived session per operation, over Streamable HTTP
 * with the legacy SSE transport as fallback.
 *
 * Short-lived rather than pooled on purpose. A connection is used at two
 * moments — the operator's discovery, and a tool call inside a turn — and a
 * kept-open session to somebody else's server buys nothing but a socket that
 * can die between uses, plus a reconnect path to get wrong. The transports
 * carry the operator's auth headers on every request either way.
 */

/** What a remote connection needs to be reached. */
export interface RemoteEndpoint {
  endpointUrl: string;
  authHeaders: Record<string, string>;
}

/** How long a connect / list / call may take before it is an error. */
export const REMOTE_TIMEOUT_MS = 20_000;

/** The client identity remote servers see. */
const CLIENT_INFO = { name: "assistant-hub-swarm", version: "1.0.0" };

function endpointUrl(endpoint: RemoteEndpoint): URL {
  try {
    return new URL(endpoint.endpointUrl);
  } catch {
    throw new Error(`Invalid endpoint URL: ${endpoint.endpointUrl}`);
  }
}

/**
 * Connect, preferring Streamable HTTP. A server that only speaks the legacy
 * HTTP+SSE transport answers the POST handshake with 4xx, which is the
 * documented signal to retry on `SSEClientTransport` — so the fallback is
 * taken on a failed *connect*, never on a failed call (that would replay
 * work). Both attempts' failures are reported, since "which transport did
 * you try" is the first question a misconfigured endpoint raises.
 */
async function connect(endpoint: RemoteEndpoint): Promise<Client> {
  const url = endpointUrl(endpoint);
  const requestInit = { headers: { ...endpoint.authHeaders } };
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }), {
      timeout: REMOTE_TIMEOUT_MS,
    });
    return client;
  } catch (streamableErr) {
    const fallback = new Client(CLIENT_INFO);
    try {
      await fallback.connect(new SSEClientTransport(url, { requestInit }), {
        timeout: REMOTE_TIMEOUT_MS,
      });
      return fallback;
    } catch (sseErr) {
      throw new Error(
        `Could not connect to ${url.host}: streamable-http — ${message(streamableErr)}; ` +
          `sse — ${message(sseErr)}`,
      );
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run one operation on a freshly connected session, closing it after. */
async function withSession<T>(
  endpoint: RemoteEndpoint,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connect(endpoint);
  try {
    return await run(client);
  } finally {
    // Closing is best-effort: a server that already hung up must not turn a
    // successful call into a failure.
    await client.close().catch(() => {});
  }
}

/** A remote tool as discovered, in the shape the snapshot stores. */
export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** List what a remote server currently offers. */
export async function listRemoteTools(endpoint: RemoteEndpoint): Promise<DiscoveredTool[]> {
  return withSession(endpoint, async (client) => {
    const { tools } = await client.listTools(undefined, { timeout: REMOTE_TIMEOUT_MS });
    return tools.map((tool) => {
      const listed = tool as McpListedTool;
      return {
        name: listed.name,
        description: listed.description ?? "",
        inputSchema: listed.inputSchema ?? { type: "object", properties: {} },
      };
    });
  });
}

/**
 * Call one remote tool. `meta` becomes the request's MCP `_meta`, which is
 * how a turn's binding (source, chat ref, reply target, assistant) reaches a
 * source app's tool without ever appearing in the schema the model sees.
 */
export async function callRemoteTool(
  endpoint: RemoteEndpoint,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<McpToolCallResult> {
  return withSession(endpoint, async (client) => {
    const result = await client.callTool(
      { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
      undefined,
      { timeout: REMOTE_TIMEOUT_MS },
    );
    return toToolCallResult(result);
  });
}

/** Convert a discovered tool to the OpenAI shape under its offered name. */
export function discoveredToolToOpenAi(tool: DiscoveredTool, offeredName: string) {
  return mcpToolToOpenAi({
    name: offeredName,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
}
