import "server-only";

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

import { TASKS_OUTBOUND_TOOL_NAMES } from "@/features/tasks/server/outbound-tools";
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

/**
 * Server-only: the tools available for a turn, or null when none are registered
 * (so the caller takes the plain single-inference path).
 *
 * Every registered tool is offered, with one carve-out: the outbound delivery
 * tools (`send_message`, `reply_to_message`) are offered only when the caller
 * says the turn is a **task fire** (`outbound: true`). A reply turn's own text
 * already delivers itself, so offering a send tool there would invite a
 * double-send; a fire delivers *only* through them. The handlers also refuse
 * without the fire's context binding, so this filter is UX for the model, not
 * the security boundary.
 */
export async function getToolset(options?: { outbound?: boolean }): Promise<Toolset | null> {
  const registry = await loadMcpRegistry();
  const all = await registry.listOpenAiTools();
  const tools = options?.outbound
    ? all
    : all.filter((tool) => !TASKS_OUTBOUND_TOOL_NAMES.includes(tool.function.name));
  if (tools.length === 0) return null;
  return {
    tools,
    callTool: (name, args) => registry.callTool(name, args),
  };
}
