import "server-only";

import { startTrace } from "@/server/trace";
import { tryGetToolContext } from "./context";
import type { McpToolCallResult } from "./tool-result";

/**
 * Per-tool trace recording — every MCP tool call runs inside its own trace,
 * scoped to a `mcp-tools-<owning-feature>` feature (e.g. `mcp-tools-history`) with
 * the tool name as the trace action. This gives each tool an independent Debug
 * scope (`/debug?feature=mcp-tools-<owner>`), separate from the inline
 * `external_call` step the bot-messaging reply trace also records. Wrapping the
 * single `BotMcpRegistry.callTool` choke point means every current and future tool
 * gets its own scope automatically — no per-tool wiring.
 */

const MCP_FEATURE_PREFIX = "mcp-tools-";

/** The trace `feature` id for a tool owned by `owningFeature`. */
export function toolTraceFeature(owningFeature: string): string {
  return `${MCP_FEATURE_PREFIX}${owningFeature}`;
}

/**
 * Run one tool call wrapped in its own scoped trace. An error *result*
 * (`isError`) settles the trace as failed, the same as a thrown error: the tool
 * ran, but the action the model asked for did not happen. This used to settle
 * `success` on the reasoning that "it ran" — which is the wrong unit for an
 * operator, who is scanning Debug for turns that did not do what they claimed.
 * The `tasks_delete` that failed on a mistyped id (2026-08-05) sat in the list as
 * a green row while the reply told the user the task was cancelled.
 */
export async function tracedToolCall(
  owningFeature: string,
  name: string,
  args: Record<string, unknown>,
  run: () => Promise<McpToolCallResult>,
): Promise<McpToolCallResult> {
  const ctx = tryGetToolContext();
  let trace: Awaited<ReturnType<typeof startTrace>>;
  try {
    trace = await startTrace(
      {
        feature: toolTraceFeature(owningFeature),
        action: name,
        trigger: {
          kind: "telegram",
          actor: ctx?.chatId,
          // The turn's correlation, so the tool call groups with the reply (or
          // fire) that made it; the bare chat id only as a legacy fallback.
          correlationId: ctx?.correlationId ?? ctx?.chatId,
        },
        inputSummary: name,
      }
    );
  } catch {
    // Trace backend unavailable — never block the tool call on it (the reply trace
    // still records the call inline). Run the tool untraced.
    return run();
  }
  try {
    await trace.event({ type: "input", message: "tool args", data: { args } });
    const result = await run();
    await trace.event({
      type: "output",
      level: result.isError ? "warn" : "success",
      message: result.isError ? "tool returned error result" : "tool result",
      data: {
        text: result.text,
        structuredContent: result.structuredContent,
        isError: result.isError ?? false,
      },
    });
    if (result.isError) {
      await trace.fail(new Error(result.text), { outputSummary: "error result" });
    } else {
      await trace.succeed({ outputSummary: "ok" });
    }
    return result;
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
