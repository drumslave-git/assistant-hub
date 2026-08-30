CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "assistant_transports" (
	"id" text PRIMARY KEY NOT NULL,
	"assistant_id" text NOT NULL,
	"transport" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_chat_assistants" (
	"source" text NOT NULL,
	"chat_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_chat_assistants_source_chat_id_assistant_id_pk" PRIMARY KEY("source","chat_id","assistant_id")
);
--> statement-breakpoint
CREATE TABLE "source_chat_members" (
	"source" text NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_chat_members_source_chat_id_user_id_pk" PRIMARY KEY("source","chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "source_chats" (
	"source" text NOT NULL,
	"chat_id" text NOT NULL,
	"title" text,
	"type" text,
	"notes" text,
	"language" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_chats_source_chat_id_pk" PRIMARY KEY("source","chat_id")
);
--> statement-breakpoint
CREATE TABLE "source_feedbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"chat_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reaction" text NOT NULL,
	"feedback" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"topic" text DEFAULT 'quality' NOT NULL,
	"menu_message_id" text,
	"model" text,
	"reflection" text,
	"reflection_model" text,
	"prefs_version" integer,
	"corrections_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_feedbacks_reaction_check" CHECK ("source_feedbacks"."reaction" in ('up', 'down')),
	CONSTRAINT "source_feedbacks_status_check" CHECK ("source_feedbacks"."status" in ('pending', 'awaiting_text', 'completed')),
	CONSTRAINT "source_feedbacks_topic_check" CHECK ("source_feedbacks"."topic" in ('quality', 'addressing'))
);
--> statement-breakpoint
CREATE TABLE "source_media" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"chat_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"kind" text NOT NULL,
	"file_id" text NOT NULL,
	"file_unique_id" text,
	"mime_type" text,
	"vision_hint" text,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"described_at" timestamp with time zone,
	CONSTRAINT "source_media_status_check" CHECK ("source_media"."status" in ('pending', 'described', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE "source_media_blobs" (
	"media_id" text NOT NULL,
	"frame_index" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "source_media_blobs_media_id_frame_index_pk" PRIMARY KEY("media_id","frame_index")
);
--> statement-breakpoint
CREATE TABLE "source_message_search" (
	"source" text NOT NULL,
	"chat_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_message_search_source_chat_id_source_message_id_pk" PRIMARY KEY("source","chat_id","source_message_id")
);
--> statement-breakpoint
CREATE TABLE "source_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"chat_id" text NOT NULL,
	"assistant_id" text,
	"source_message_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"role" text NOT NULL,
	"user_id" text,
	"content" text NOT NULL,
	"reply_to_source_message_id" text,
	"sent_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"bot_reaction" text,
	"bot_reacted_at" timestamp with time zone,
	"processed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_messages_role_check" CHECK ("source_messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "source_summaries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_summaries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"chat_id" text NOT NULL,
	"summary_date" text NOT NULL,
	"content" text NOT NULL,
	"message_ids" text[] DEFAULT '{}' NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_users" (
	"source" text NOT NULL,
	"user_id" text NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"language" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_users_source_user_id_pk" PRIMARY KEY("source","user_id")
);
--> statement-breakpoint
CREATE TABLE "transports" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"mcp_path" text,
	"connection_config_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transport_config_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_transports" ADD CONSTRAINT "assistant_transports_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_media_blobs" ADD CONSTRAINT "source_media_blobs_media_id_source_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."source_media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_transports_idx" ON "assistant_transports" USING btree ("assistant_id","transport");--> statement-breakpoint
CREATE INDEX "source_chat_members_user_idx" ON "source_chat_members" USING btree ("source","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_feedbacks_msg_user_idx" ON "source_feedbacks" USING btree ("source","chat_id","source_message_id","user_id");--> statement-breakpoint
CREATE INDEX "source_feedbacks_status_idx" ON "source_feedbacks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "source_feedbacks_prefs_idx" ON "source_feedbacks" USING btree ("user_id","prefs_version");--> statement-breakpoint
CREATE UNIQUE INDEX "source_media_chat_msg_idx" ON "source_media" USING btree ("source","chat_id","source_message_id");--> statement-breakpoint
CREATE INDEX "source_media_status_idx" ON "source_media" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "source_message_search_embedding_idx" ON "source_message_search" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "source_messages_dedupe_idx" ON "source_messages" USING btree ("source","dedupe_key");--> statement-breakpoint
CREATE INDEX "source_messages_chat_sent_idx" ON "source_messages" USING btree ("source","chat_id","sent_at");--> statement-breakpoint
CREATE INDEX "source_messages_chat_msg_idx" ON "source_messages" USING btree ("source","chat_id","source_message_id");--> statement-breakpoint
CREATE INDEX "source_messages_content_trgm_idx" ON "source_messages" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "source_summaries_chat_date_idx" ON "source_summaries" USING btree ("source","chat_id","summary_date");--> statement-breakpoint
CREATE INDEX "source_summaries_embedding_idx" ON "source_summaries" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "source_users_username_idx" ON "source_users" USING btree ("source","username");--> statement-breakpoint
CREATE INDEX "source_message_search_content_fts_idx" ON "source_message_search" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE INDEX "source_message_search_content_trgm_idx" ON "source_message_search" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "source_summaries_content_fts_idx" ON "source_summaries" USING gin (to_tsvector('simple', "content"));
