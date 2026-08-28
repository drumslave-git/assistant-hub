import "server-only";

import { turnMetaEnvelope, type SourceId, type TurnToolMeta } from "@assistant-hub/contracts";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

import { tryGetToolContext } from "@/server/mcp/context";
import { callRemoteTool, discoveredToolToOpenAi } from "@/server/mcp/http-client";
import { tracedToolCall } from "@/server/mcp/tool-trace";
import type { McpToolCallResult } from "@/server/mcp/tool-result";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { listToolConnections, type ToolConnectionRecord } from "./repository";
import { prefixedToolName } from "./schema";

/**
 * Turning stored connections into the tools one turn may call.
 *
 * The three scope dimensions (user decision, 2026-08-28) are resolved here,
 * once, for every source: a connection is offered when it is enabled, when
 * its app scope is unset or names this turn's source, and when it is open to
 * every assistant or lists this turn's. Nothing in this file knows what
 * Telegram is — a source is an id it compares.
 *
 * What is offered is always the APPLIED snapshot. The remote server is not
 * asked anything at turn time: its answer could differ from the last one an
 * operator approved, and a toolset that changes mid-conversation breaks the
 * prompt's prefix cache and, on a strict provider, the whole request.
 */

/** The scope a turn resolves its connection tools against. */
export interface ToolScope {
  source?: SourceId;
  assistantId?: string | null;
}

/** One offered tool, and the connection that answers it. */
interface OfferedTool {
  connection: ToolConnectionRecord;
  toolName: string;
}

export interface ConnectionToolset {
  /** OpenAI-shaped tools under their prefixed, model-visible names. */
  tools: ChatCompletionFunctionTool[];
  /** Whether a model-visible name belongs to a connection. */
  owns(name: string): boolean;
  /** Call one; a name this toolset does not own is a caller error. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
}

/** Whether a connection's tools reach a turn with this scope. */
export function isInScope(connection: ToolConnectionRecord, scope: ToolScope): boolean {
  if (!connection.enabled) return false;
  if (connection.appScope && connection.appScope !== scope.source) return false;
  if (connection.allAssistants) return true;
  return scope.assistantId != null && connection.assistantIds.includes(scope.assistantId);
}

/** The turn binding a hosted tool receives, or null outside a bound turn. */
function turnMeta(scope: ToolScope): TurnToolMeta | null {
  const ctx = tryGetToolContext();
  if (!ctx) return null;
  return {
    source: ctx.source ?? scope.source ?? "tg",
    chatId: ctx.chatId,
    assistantId: ctx.assistantId ?? scope.assistantId ?? null,
    threadId: ctx.threadId ?? null,
    ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    userId: ctx.userId ?? null,
    senderIsOwner: ctx.senderIsOwner ?? false,
  };
}

/**
 * The connection tools this turn may call. Reads the store on every turn
 * rather than caching: two small queries cost nothing next to an inference,
 * and a cache here would mean an applied snapshot that the running process
 * keeps ignoring — the failure mode is a tool the operator can see on the
 * dashboard and the bot swears does not exist.
 */
export async function resolveConnectionToolset(
  scope: ToolScope,
  db: StoreDb = getStoreDb(),
): Promise<ConnectionToolset> {
  const connections = (await listToolConnections(db)).filter((c) => isInScope(c, scope));
  const offered = new Map<string, OfferedTool>();
  const tools: ChatCompletionFunctionTool[] = [];

  for (const connection of connections) {
    for (const tool of connection.tools) {
      const name = prefixedToolName(connection.slug, tool.name);
      offered.set(name, { connection, toolName: tool.name });
      tools.push(discoveredToolToOpenAi(tool, name));
    }
  }

  return {
    tools,
    owns: (name) => offered.has(name),
    async callTool(name, args) {
      const entry = offered.get(name);
      if (!entry) {
        // Not a throw: an unknown tool name is something the model did, and
        // it can recover from being told so.
        return { text: `Unknown tool: ${name}`, isError: true };
      }
      const meta = turnMeta(scope);
      return tracedToolCall("connections", name, args, async () => {
        try {
          return await callRemoteTool(
            entry.connection,
            entry.toolName,
            args,
            meta ? turnMetaEnvelope(meta) : undefined,
          );
        } catch (err) {
          // A dead endpoint is a failed tool call, not a failed turn: the
          // model gets the reason and can answer without it (user decision,
          // 2026-08-28 — the toolset never shrinks because a server blinked).
          const reason = err instanceof Error ? err.message : String(err);
          return {
            text: `Tool "${name}" could not be reached: ${reason}`,
            isError: true,
          };
        }
      });
    },
  };
}
