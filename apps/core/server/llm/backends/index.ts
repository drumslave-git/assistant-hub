import "server-only";

/**
 * The backend normalization layer: one place where each inference server's
 * behavioral quirks live, instead of a patch wherever a quirk happened to
 * surface (user decision, 2026-08-07).
 *
 * See `./types` for what counts as a backend difference and why the adapters are
 * pure, and `@/lib/llm-backend` for the client-safe ids the Settings form binds
 * to.
 */

export { detectBackend, type BackendDetection } from "./detect";
export {
  adapterFor,
  chatBodyExtrasFor,
  readReasoningFor,
  truncatesOnOverflow,
} from "./registry";
export type {
  ChatRequestIntent,
  ContextOverflowBehavior,
  JsonValue,
  LlmBackendAdapter,
  ReasoningMode,
} from "./types";
