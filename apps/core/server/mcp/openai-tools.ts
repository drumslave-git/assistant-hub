import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

import type { McpToolCallResult } from "./tool-result";

/**
 * Conversions between the MCP wire shapes and the OpenAI-compatible tool shapes.
 * Pure functions (no server-only marker) — unit-tested directly.
 */

/** A tool as returned by MCP `client.listTools()`. */
export interface McpListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Convert an MCP-listed tool to the OpenAI `ChatCompletionTool` shape. The MCP
 * SDK emits a JSON Schema with a `$schema` marker; strip it since some strict
 * OpenAI-compatible endpoints reject unknown top-level keys in `parameters`.
 */
export function mcpToolToOpenAi(tool: McpListedTool): ChatCompletionFunctionTool {
  const schema = tool.inputSchema ?? { type: "object", properties: {} };
  const { $schema: _drop, ...parameters } = schema as Record<string, unknown>;
  void _drop;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters,
    },
  };
}

/** Raw MCP call-tool result (a subset of the SDK's `CallToolResult`). */
interface RawToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** Flatten an MCP tool result's text content blocks into one string. */
export function callToolResultToText(result: unknown): string {
  const payload = result as RawToolResult;
  const parts =
    payload.content
      ?.filter((item) => item.type === "text" && item.text)
      .map((item) => item.text!.trim())
      .filter(Boolean) ?? [];

  if (parts.length === 0) {
    return payload.isError ? "Tool returned an error." : "Tool returned no content.";
  }
  return parts.join("\n\n");
}

/** Normalize a raw MCP call-tool result into the loop's {@link McpToolCallResult}. */
export function toToolCallResult(result: unknown): McpToolCallResult {
  const payload = result as RawToolResult;
  return {
    text: callToolResultToText(result),
    structuredContent: payload.structuredContent,
    isError: payload.isError === true,
  };
}
