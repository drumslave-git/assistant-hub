import "server-only";

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

import { REPLY_TO_MESSAGE_TOOL } from "@/features/bot-messaging/server/mcp-tools";
import { SEND_MESSAGE_TOOL } from "@/features/tasks/server/outbound-tools";
import type { McpToolCallResult } from "@/server/mcp/tool-result";
import { loadMcpRegistry } from "@/server/mcp/runtime";
import type { ToolsView, ToolView } from "./schema";

/**
 * MCP-tools domain service — the boundary the Tools dashboard, its Route Handler,
 * and the reply runtime call. Every registered tool is always available to the
 * model; this service exposes the operator-facing list and resolves the toolset
 * for a reply turn. The registry itself is shared infra (`server/mcp`) and is
 * code-defined, not DB-backed — so these reads take no db handle.
 */

/** Build the dashboard view: every registered tool. */
export async function getToolsView(): Promise<ToolsView> {
  const registry = await loadMcpRegistry();
  const registered = await registry.listTools();
  const tools: ToolView[] = registered
    .map((tool) => ({ name: tool.name, description: tool.description, feature: tool.feature }))
    .sort((a, b) => a.feature.localeCompare(b.feature) || a.name.localeCompare(b.name));
  return { tools };
}

/** The toolset for a reply turn, ready for the tool-call loop. */
export interface Toolset {
  tools: ChatCompletionFunctionTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
}

/** How a turn delivers, which decides which delivery tool it is offered. */
export type DeliveryKind = "reply" | "send";

/** The two delivery tools, keyed by the turn kind that may use one. */
const DELIVERY_TOOLS: Record<DeliveryKind, string> = {
  reply: REPLY_TO_MESSAGE_TOOL,
  send: SEND_MESSAGE_TOOL,
};

const ALL_DELIVERY_TOOLS = Object.values(DELIVERY_TOOLS);

/**
 * Server-only: the tools available for a turn, or null when none are registered
 * (so the caller takes the plain single-inference path).
 *
 * Every registered tool is offered, with one carve-out — the delivery tools.
 * A turn gets **at most one** of them, and which one is a fact about the turn,
 * not a choice for the model (user decision, 2026-08-14):
 *
 * | Turn | Offered | Why |
 * | --- | --- | --- |
 * | Ordinary reply | neither | Its own text is the delivery; a send tool here would double-send |
 * | `message`-triggered task | `reply_to_message` | It is acting on a message somebody posted, so the answer belongs under it |
 * | Timed fire | `send_message` | Nothing triggered it, so there is nothing to reply to |
 *
 * The handlers refuse without the matching context binding too, so this filter
 * is what the model *sees*, not the boundary that holds.
 */
export async function getToolset(options?: {
  delivery?: DeliveryKind;
}): Promise<Toolset | null> {
  const registry = await loadMcpRegistry();
  const all = await registry.listOpenAiTools();
  const offered = options?.delivery ? DELIVERY_TOOLS[options.delivery] : null;
  const tools = all.filter(
    (tool) =>
      !ALL_DELIVERY_TOOLS.includes(tool.function.name) || tool.function.name === offered,
  );
  if (tools.length === 0) return null;
  return {
    tools,
    callTool: (name, args) => registry.callTool(name, args),
  };
}
