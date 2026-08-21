import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

import { InProcessTransport } from "./in-process-transport";
import { mcpToolToOpenAi, toToolCallResult, type McpListedTool } from "./openai-tools";
import { tracedToolCall } from "./tool-trace";
import type { McpToolCallResult } from "./tool-result";

/**
 * A tool registrar contributes one feature's MCP tools to the shared server. It
 * receives the raw `McpServer`; handlers read per-turn state (the current chat)
 * from {@link import("./context").getToolContext} and their own persistence.
 */
export type McpToolRegistrar = (server: McpServer) => void;

/** Registered tool metadata for the dashboard (name/description + owning feature). */
export interface RegisteredTool {
  name: string;
  description: string;
  /** The feature that contributes the tool (for grouping in the UI). */
  feature: string;
}

/**
 * The shared MCP host: one in-process `McpServer` with every feature's tools,
 * connected to a `Client` over a linked in-process transport. Every registered
 * tool is always available — converted to the OpenAI tool shape for the
 * chat-completion loop and callable in a turn (there is no per-tool switch).
 */
export class BotMcpRegistry {
  readonly server: McpServer;
  private client: Client | null = null;
  private connectPromise: Promise<Client> | null = null;
  /** name -> owning feature, for dashboard grouping. */
  private toolFeatures = new Map<string, string>();
  /**
   * OpenAI-shaped tool list, built once. The registry is append-only and frozen
   * after boot, but every reply turn asks for this list — without the cache each
   * turn pays an MCP `listTools` round trip plus schema conversion.
   */
  private openAiTools: Promise<ChatCompletionFunctionTool[]> | null = null;

  constructor() {
    this.server = new McpServer({ name: "llm-tg-bot", version: "1.0.0" });
  }

  /** Register one feature's tools. Call before {@link finishRegistration}. */
  registerTools(feature: string, registrar: McpToolRegistrar, toolNames: string[]): void {
    registrar(this.server);
    for (const name of toolNames) this.toolFeatures.set(name, feature);
    this.openAiTools = null;
  }

  /** Connect the in-process client/server pair. Idempotent. */
  async finishRegistration(): Promise<void> {
    await this.ensureConnected();
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        const [serverTransport, clientTransport] = InProcessTransport.createLinkedPair();
        const client = new Client({ name: "llm-tg-bot-host", version: "1.0.0" });
        await this.server.connect(serverTransport);
        await client.connect(clientTransport);
        this.client = client;
        return client;
      })();
    }
    return this.connectPromise;
  }

  /**
   * The tool names registered on this instance, as registrars declared them.
   * Read without connecting or awaiting anything, so the runtime can tell a
   * cached registry apart from the code that is loaded now.
   */
  get registeredToolNames(): string[] {
    return [...this.toolFeatures.keys()];
  }

  /** Every registered tool with metadata (name/description + owning feature). */
  async listTools(): Promise<RegisteredTool[]> {
    const client = await this.ensureConnected();
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      feature: this.toolFeatures.get(tool.name) ?? "unknown",
    }));
  }

  /** Every registered tool in OpenAI tool shape, for the chat-completion request. */
  async listOpenAiTools(): Promise<ChatCompletionFunctionTool[]> {
    if (!this.openAiTools) {
      this.openAiTools = (async () => {
        const client = await this.ensureConnected();
        const { tools } = await client.listTools();
        return tools.map((tool) => mcpToolToOpenAi(tool as McpListedTool));
      })().catch((err) => {
        // A failed build must not be pinned as the forever-answer.
        this.openAiTools = null;
        throw err;
      });
    }
    return this.openAiTools;
  }

  /**
   * Call a registered tool by name, wrapped in its own `mcp-tools-<owner>` trace
   * so every tool has an independent Debug scope.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const client = await this.ensureConnected();
    const owningFeature = this.toolFeatures.get(name) ?? "unknown";
    return tracedToolCall(owningFeature, name, args, async () => {
      const result = await client.callTool({ name, arguments: args });
      return toToolCallResult(result);
    });
  }
}
