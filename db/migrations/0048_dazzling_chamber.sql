CREATE TABLE "chat_message_search" (
	"chat_id" text NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_search_chat_id_telegram_message_id_pk" PRIMARY KEY("chat_id","telegram_message_id")
);
--> statement-breakpoint
ALTER TABLE "chat_message_search" ADD CONSTRAINT "chat_message_search_message_fk" FOREIGN KEY ("chat_id","telegram_message_id") REFERENCES "public"."chat_messages"("chat_id","telegram_message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_message_search_embedding_idx" ON "chat_message_search" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chat_message_search_content_fts_idx" ON "chat_message_search" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE INDEX "chat_message_search_content_trgm_idx" ON "chat_message_search" USING gin ("content" gin_trgm_ops);