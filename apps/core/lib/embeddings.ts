/**
 * Width of every embedding vector the app stores. The constant itself moved to
 * `@assistant-hub/contracts` (Phase 1) — it is a cross-app data commitment now
 * that the tg store's search vectors must agree with the core's embeddings
 * client. Re-exported here so v1 code keeps one import path until cutover.
 */
export { EMBEDDING_DIMENSIONS } from "@assistant-hub/contracts";
