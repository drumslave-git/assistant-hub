-- Hand-written: extensions the schema needs before any table exists.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "chat_members" (
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_members_chat_id_user_id_pk" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"title" text,
	"type" text,
	"notes" text,
	"language" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"assistant_id" text NOT NULL,
	"bot_token" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"reaction" text NOT NULL,
	"feedback" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"topic" text DEFAULT 'quality' NOT NULL,
	"menu_message_id" bigint,
	"model" text NOT NULL,
	"reflection" text,
	"reflection_model" text,
	"prefs_version" integer,
	"corrections_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedbacks_reaction_check" CHECK ("feedbacks"."reaction" in ('up', 'down')),
	CONSTRAINT "feedbacks_status_check" CHECK ("feedbacks"."status" in ('pending', 'awaiting_text', 'completed')),
	CONSTRAINT "feedbacks_topic_check" CHECK ("feedbacks"."topic" in ('quality', 'addressing'))
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"file_id" text NOT NULL,
	"file_unique_id" text,
	"mime_type" text,
	"vision_hint" text,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"described_at" timestamp with time zone,
	CONSTRAINT "media_status_check" CHECK ("media"."status" in ('pending', 'described', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE "media_blobs" (
	"media_id" text NOT NULL,
	"frame_index" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "media_blobs_media_id_frame_index_pk" PRIMARY KEY("media_id","frame_index")
);
--> statement-breakpoint
CREATE TABLE "message_search" (
	"chat_id" text NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_search_chat_id_telegram_message_id_pk" PRIMARY KEY("chat_id","telegram_message_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_id" text NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"role" text NOT NULL,
	"user_id" text,
	"content" text NOT NULL,
	"reply_to_message_id" bigint,
	"sent_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"bot_reaction" text,
	"bot_reacted_at" timestamp with time zone,
	"processed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"owner_username" text,
	"owner_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("settings"."id" = 'singleton')
);
--> statement-breakpoint
CREATE TABLE "summaries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "summaries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_id" text NOT NULL,
	"summary_date" text NOT NULL,
	"content" text NOT NULL,
	"message_ids" bigint[] DEFAULT '{}' NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"language" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-moved above the FK constraints: media and message_search reference
-- (chat_id, telegram_message_id), which needs this unique index to exist first.
CREATE UNIQUE INDEX "messages_chat_msg_idx" ON "messages" USING btree ("chat_id","telegram_message_id");--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_id_chats_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_message_fk" FOREIGN KEY ("chat_id","telegram_message_id") REFERENCES "public"."messages"("chat_id","telegram_message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_blobs" ADD CONSTRAINT "media_blobs_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_search" ADD CONSTRAINT "message_search_message_fk" FOREIGN KEY ("chat_id","telegram_message_id") REFERENCES "public"."messages"("chat_id","telegram_message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_members_chat_idx" ON "chat_members" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "chat_members_user_idx" ON "chat_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_assistant_idx" ON "connections" USING btree ("assistant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedbacks_msg_user_idx" ON "feedbacks" USING btree ("chat_id","telegram_message_id","user_id");--> statement-breakpoint
CREATE INDEX "feedbacks_status_idx" ON "feedbacks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "feedbacks_prefs_idx" ON "feedbacks" USING btree ("user_id","prefs_version");--> statement-breakpoint
CREATE UNIQUE INDEX "media_chat_msg_idx" ON "media" USING btree ("chat_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "media_status_idx" ON "media" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "message_search_embedding_idx" ON "message_search" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "messages_chat_sent_idx" ON "messages" USING btree ("chat_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_content_trgm_idx" ON "messages" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "summaries_chat_date_idx" ON "summaries" USING btree ("chat_id","summary_date");--> statement-breakpoint
CREATE INDEX "summaries_embedding_idx" ON "summaries" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "users_username_idx" ON "users" USING btree ("username");--> statement-breakpoint
-- Hand-written: expression indexes drizzle-kit cannot express (carried over
-- from the v1 chain) — the FTS/substring halves of message and summary search.
CREATE INDEX "message_search_content_fts_idx" ON "message_search" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE INDEX "message_search_content_trgm_idx" ON "message_search" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "summaries_content_fts_idx" ON "summaries" USING gin (to_tsvector('simple', "content"));
