/**
 * Width of every embedding vector any app stores.
 *
 * A code constant, not a setting (recorded decision): pgvector cannot index a
 * vector of unspecified width, so the column type itself commits to a size, and
 * a "configurable" dimension could not be honoured without recreating the
 * column and re-embedding everything. 1024 fits `bge-m3` and most self-hosted
 * embedding models; the configured model is *probed* against this number
 * (Settings → Test embeddings) rather than trusted.
 *
 * Lives in contracts because it is a cross-app data commitment: the core
 * store's memory vectors and the tg store's message-search vectors must agree
 * with the embeddings client that fills them.
 */
export const EMBEDDING_DIMENSIONS = 1024;
