/**
 * Cross-app contracts (PLAN.md, "The source-app contract").
 *
 * Present: scoped entity refs and the shared embedding width. Landing with
 * later phases: the source-app contract (inbound events with conversation
 * context, reply-delivery events, turn-lifecycle events, the operator
 * listing/CRUD API shapes), queue payloads, bus events — Phase 2.
 */
export { DEFAULT_ASSISTANT_ID } from "./assistants";
export { EMBEDDING_DIMENSIONS } from "./embeddings";
export {
  REF_KINDS,
  SOURCE_IDS,
  formatScopedRef,
  isScopedRef,
  parseScopedRef,
  scopedRef,
  scopedRefSchema,
  tryParseScopedRef,
  type RefKind,
  type ScopedRef,
  type ScopedRefString,
  type SourceId,
} from "./scoped-ref";
