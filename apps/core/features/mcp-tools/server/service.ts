import "server-only";

import type { SourceId } from "@assistant-hub/contracts";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

import { REPLY_TO_MESSAGE_TOOL } from "@/features/bot-messaging/server/mcp-tools";
import { SEND_MESSAGE_TOOL } from "@/features/tasks/server/outbound-tools";
import { resolveConnectionToolset } from "@/features/tool-connections/server/toolset";
import { tryGetToolContext } from "@/server/mcp/context";
import type { McpToolCallResult } from "@/server/mcp/tool-result";
import { loadMcpRegistry } from "@/server/mcp/runtime";
import type { StoreDb } from "@/server/store/db";
import type { ToolsView, ToolView } from "./schema";

/**
 * MCP-tools domain service — the boundary the Tools dashboard, its Route Handler,
 * and the reply runtime call. It composes the two halves of the toolset: the
 * in-process feature tools (code-defined, shared infra in `server/mcp`) and
 * the operator's tool connections (DB-backed, scoped per turn — Phase 5).
 * Feature tools keep their bare names; connection tools are offered under
 * their connection's slug prefix, so two connections can both have a
 * `search` without colliding.
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
  /**
   * The turn's scope, deciding which connections are offered. Defaults to the
   * bound tool context — a fire resolves its toolset inside the context it
   * already runs in, so it needs no plumbing of its own — and callers that
   * build the toolset before binding (the reply path) state it explicitly.
   */
  source?: SourceId;
  assistantId?: string | null;
  db?: StoreDb;
}): Promise<Toolset | null> {
  const registry = await loadMcpRegistry();
  const all = await registry.listOpenAiTools();
  const offered = options?.delivery ? DELIVERY_TOOLS[options.delivery] : null;
  const builtins = all.filter(
    (tool) =>
      !ALL_DELIVERY_TOOLS.includes(tool.function.name) || tool.function.name === offered,
  );

  const ctx = tryGetToolContext();
  const connections = await resolveConnectionToolset(
    {
      source: options?.source ?? ctx?.source,
      assistantId: options?.assistantId ?? ctx?.assistantId ?? null,
    },
    options?.db,
  );

  const tools = [...builtins, ...connections.tools];
  if (tools.length === 0) return null;
  return {
    tools,
    callTool: (name, args) =>
      connections.owns(name)
        ? connections.callTool(name, args)
        : registry.callTool(name, args),
  };
}
