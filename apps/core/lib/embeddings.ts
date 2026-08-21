/**
 * Width of every embedding vector the app stores.
 *
 * A code constant, not a setting (recorded decision): pgvector cannot index a
 * vector of unspecified width, so the column type itself commits to a size, and a
 * "configurable" dimension could not be honoured without recreating the column
 * and re-embedding everything. 1024 fits `bge-m3` and most self-hosted embedding
 * models; the configured model is *probed* against this number (Settings → Test
 * embeddings) rather than trusted, so a mismatch surfaces as a clear message
 * instead of an opaque Postgres error inside a background job.
 *
 * Lives in `lib/` (client-safe, no imports) because three layers need it: the
 * Drizzle schema declares the column with it, the embeddings client validates
 * against it, and the Settings form tells the operator what to pick.
 */
export const EMBEDDING_DIMENSIONS = 1024;
