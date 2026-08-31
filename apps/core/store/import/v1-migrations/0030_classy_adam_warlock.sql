-- pg_trgm powers the substring-ILIKE index below. Added by hand: drizzle-kit
-- emits the index but never the extension it depends on, so without this the
-- migration fails on a fresh database. The Postgres image (pgvector/pgvector)
-- ships the extension; this only enables it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "chat_messages_content_trgm_idx" ON "chat_messages" USING gin ("content" gin_trgm_ops);
