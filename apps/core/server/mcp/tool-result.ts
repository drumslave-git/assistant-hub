/**
 * Normalized result of an MCP tool call, as consumed by the tool-call loop.
 * Pure type (no server-only marker) so both the loop and trace UI can import it.
 */
export interface McpToolCallResult {
  /** Human/model-readable text (joined from the tool's text content blocks). */
  text: string;
  /** Structured payload the tool returned, when any (recorded in traces). */
  structuredContent?: unknown;
  /** True when the tool reported an error result (`isError`). */
  isError?: boolean;
  /**
   * Images the tool produced *for the model to look at* (e.g. a browser
   * screenshot), as `data:` URLs. The tool loop shows them to the model as a
   * vision turn after the tool result; callers recording results into traces
   * must redact these bytes (the trace convention for binary payloads).
   */
  images?: string[];
}
