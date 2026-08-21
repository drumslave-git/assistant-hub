CREATE TABLE "general_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"content" text NOT NULL,
	"chat_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entries_scope_check" CHECK ("memory_entries"."scope" in ('user', 'general')),
	CONSTRAINT "memory_entries_user_id_check" CHECK (("memory_entries"."scope" = 'user') = ("memory_entries"."user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "user_memories" (
	"user_id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_user_id_known_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."known_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_user_id_known_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."known_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "general_memories_embedding_idx" ON "general_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_entries_scope_user_idx" ON "memory_entries" USING btree ("scope","user_id");--> statement-breakpoint
CREATE INDEX "user_memories_embedding_idx" ON "user_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
-- Full-text half of the hybrid memory search. Hand-added: an expression index has
-- no Drizzle column to hang off, so `db:generate` cannot emit it (same as
-- `chat_summaries`). Keep in sync with the search queries in
-- `features/memory/server/repository.ts`.
CREATE INDEX "general_memories_content_fts_idx" ON "general_memories" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE INDEX "user_memories_content_fts_idx" ON "user_memories" USING gin (to_tsvector('simple', "content"));