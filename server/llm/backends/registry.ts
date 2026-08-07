import "server-only";

import { type LlmBackendId, toLlmBackendId } from "@/lib/llm-backend";

import { LLM_BACKEND_ADAPTERS } from "./adapters";
import type { ChatRequestIntent, JsonValue, LlmBackendAdapter } from "./types";

/**
 * Lookup from a configured backend id to its adapter, plus the small helpers
 * every caller would otherwise re-derive. Pure — see `./types` for why the
 * adapters hold no I/O.
 */

/**
 * The adapter for a backend id. Unknown/absent input resolves to the generic
 * adapter rather than throwing: a settings row written before this field existed
 * must keep working, and an endpoint whose server we cannot name is exactly the
 * case the conservative adapter is for.
 */
export function adapterFor(id: LlmBackendId | string | null | undefined): LlmBackendAdapter {
  return LLM_BACKEND_ADAPTERS[toLlmBackendId(id)];
}

/**
 * The provider-options body a chat request needs for `intent` on this backend.
 * Returns `{}` when the backend has no knob for what was asked.
 */
export function chatBodyExtrasFor(
  id: LlmBackendId | string | null | undefined,
  intent: ChatRequestIntent,
): Record<string, JsonValue> {
  return adapterFor(id).chatBodyExtras(intent);
}

/**
 * The hidden reasoning text on a raw response, or null.
 *
 * Exposed separately from the adapter so trace/analytics callers do not have to
 * know which backend produced the body they are holding — a stored trace outlives
 * the setting that produced it.
 */
export function readReasoningFor(
  id: LlmBackendId | string | null | undefined,
  rawResponse: unknown,
): string | null {
  return adapterFor(id).readReasoning(rawResponse);
}

/** Whether this backend silently truncates instead of raising on overflow. */
export function truncatesOnOverflow(id: LlmBackendId | string | null | undefined): boolean {
  return adapterFor(id).contextOverflowBehavior === "truncate";
}
