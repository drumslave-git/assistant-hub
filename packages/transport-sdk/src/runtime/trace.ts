import { scopedRef, type SourceTraceClient, type TurnToolMeta } from "@assistant-hub-swarm/contracts";

import type { TransportDescriptor } from "./types";

/**
 * Tracing a hosted MCP tool.
 *
 * A transport's tools are the one place that knows what a tool call actually
 * DID: whether the mirror refused the id, whether the platform accepted the
 * send, what message id came back. None of that was recorded anywhere — the
 * core's turn trace ends at the LLM response, and the tool round trip left no
 * mark on either side, so a reaction that silently failed looked identical to
 * one that worked.
 *
 * The binding already carried what this needs. `turnToolMeta.correlationId` is
 * documented as "the turn's trace correlation, so a hosted tool's work joins
 * the turn" and nothing used it: a trace opened on it lands beside the turn's
 * own reply trace in the core's one Debug explorer, in the order it happened.
 *
 * One client per service, shared with the delivery consumer, so every trace a
 * transport emits is built the same way.
 */

/** What a tool trace needs from the turn it is bound to. */
export function toolTrigger(descriptor: TransportDescriptor, turn: TurnToolMeta) {
  return {
    kind: "transport" as const,
    actor: scopedRef(descriptor.id, "chat", turn.chatId),
    // Falls back to the turn's own shape when the core did not stamp one, so a
    // tool call is never orphaned from the conversation it happened in.
    correlationId:
      turn.correlationId ??
      `${scopedRef(descriptor.id, "chat", turn.chatId)}:${turn.replyToSourceMessageId ?? "fire"}`,
  };
}

/**
 * Run one hosted tool inside a trace. The tool's own result is returned
 * untouched — recording must never change what the model is told, and a
 * failure to record must never fail the call.
 *
 * A result carrying `isError` settles the trace as a refusal rather than a
 * success: from Debug, a tool that told the model "nothing was changed" should
 * not read as having worked.
 */
export async function tracedTool<T extends { isError?: boolean; content?: unknown }>(
  input: {
    traces: SourceTraceClient | null;
    descriptor: TransportDescriptor;
    turn: TurnToolMeta | null;
    action: string;
    inputSummary?: string;
  },
  run: (event: (e: {
    message: string;
    type?: "step" | "input" | "output" | "external_call" | "db" | "error";
    level?: "debug" | "info" | "success" | "warn" | "error";
    data?: Record<string, unknown>;
  }) => void) => Promise<T>,
): Promise<T> {
  // No turn binding means the tool is about to refuse anyway, and there is no
  // conversation to hang the trace on.
  if (!input.traces || !input.turn) return run(() => undefined);

  const trace = input.traces.startTrace({
    feature: "bot-messaging",
    action: input.action,
    assistantId: input.turn.assistantId ?? undefined,
    trigger: toolTrigger(input.descriptor, input.turn),
    inputSummary: input.inputSummary,
  });

  try {
    const result = await run((e) =>
      trace.event({ type: "step", level: "info", ...e }),
    );
    if (result.isError) {
      // The refusal text is the whole account of why nothing happened.
      const text = firstText(result.content) ?? "refused";
      trace.event({ message: text, type: "output", level: "warn" });
      await trace.succeed({ outputSummary: text });
    } else {
      await trace.succeed({ outputSummary: firstText(result.content) ?? undefined });
    }
    return result;
  } catch (error) {
    await trace.fail(error);
    throw error;
  }
}

/** The text an MCP result leads with, for the trace's one-line summary. */
function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return undefined;
}
