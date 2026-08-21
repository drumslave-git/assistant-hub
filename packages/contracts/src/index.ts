/**
 * Cross-app contracts (PLAN.md, "The source-app contract").
 *
 * Carved out in Phase 0 as the home for the schemas every app shares; the
 * content lands with the phases that introduce each concern:
 *
 * - scoped entity refs (`source:kind:id`) — Phase 1
 * - the source-app contract: inbound events with conversation context,
 *   reply-delivery events, turn-lifecycle events, the operator listing/CRUD
 *   API shapes — Phase 2
 * - queue payloads and bus events — Phase 2
 *
 * Nothing is exported yet on purpose: v1 has no schema that crosses an app
 * boundary, and inventing shapes ahead of their consumers is how contracts
 * drift from reality.
 */
export {};
