-- pgvector powers the semantic half of history recall. Added by hand: drizzle-kit
-- emits the `vector(1024)` column type but never the extension it depends on, so
-- without this the migration fails on a fresh database. The Postgres image
-- (pgvector/pgvector) ships the extension; this only enables it.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "chat_summaries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_summaries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_id" text NOT NULL,
	"summary_date" text NOT NULL,
	"content" text NOT NULL,
	"message_ids" bigint[] DEFAULT '{}' NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_summary_days" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_summary_days_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_id" text NOT NULL,
	"summary_date" text NOT NULL,
	"message_count" integer NOT NULL,
	"topic_count" integer NOT NULL,
	"summarized_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "embedding_base_url" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "embedding_api_key" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "history_summary_run_time" text DEFAULT '04:30' NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_summaries_chat_date_idx" ON "chat_summaries" USING btree ("chat_id","summary_date");--> statement-breakpoint
CREATE INDEX "chat_summaries_embedding_idx" ON "chat_summaries" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_summary_days_chat_date_idx" ON "chat_summary_days" USING btree ("chat_id","summary_date");--> statement-breakpoint
-- Lexical half of the hybrid summary search. Added by hand: an expression index
-- has no Drizzle column to hang off, so drizzle-kit cannot generate it. The
-- `simple` configuration (no stemming/stopwords) is language-agnostic — the chats
-- are multilingual, and a language-specific config would silently drop terms.
CREATE INDEX "chat_summaries_content_fts_idx" ON "chat_summaries" USING gin (to_tsvector('simple', "content"));