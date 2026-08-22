-- Hand-written: extension the schema needs before any table exists.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "addressing_exclusions" (
	"id" text PRIMARY KEY NOT NULL,
	"term" text NOT NULL,
	"normalized" text NOT NULL,
	"bot_display_name" text NOT NULL,
	"chat_ref" text,
	"source_message_id" bigint,
	"user_ref" text,
	"feedback_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"persona" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backends" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text,
	"type" text DEFAULT 'openai-compatible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_summary_days" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_summary_days_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_ref" text NOT NULL,
	"summary_date" text NOT NULL,
	"message_count" integer NOT NULL,
	"topic_count" integer NOT NULL,
	"summarized_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_ref" text NOT NULL,
	"model" text NOT NULL,
	"likes" text NOT NULL,
	"dislikes" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "general_memories" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"content" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"user_ref" text,
	"content" text NOT NULL,
	"origin_chat_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entries_scope_check" CHECK ("memory_entries"."scope" in ('user', 'general')),
	CONSTRAINT "memory_entries_user_ref_check" CHECK (("memory_entries"."scope" = 'user') = ("memory_entries"."user_ref" is not null))
);
--> statement-breakpoint
CREATE TABLE "memory_extraction_days" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "memory_extraction_days_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_ref" text NOT NULL,
	"extraction_date" text NOT NULL,
	"message_count" integer NOT NULL,
	"note_count" integer NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_link_members" (
	"link_id" text NOT NULL,
	"user_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_link_members_link_id_user_ref_pk" PRIMARY KEY("link_id","user_ref")
);
--> statement-breakpoint
CREATE TABLE "person_links" (
	"id" text PRIMARY KEY NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "self_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"correction" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"chat_backend_id" text,
	"model" text,
	"operator_password_hash" text,
	"session_secret" text,
	"tavily_api_key" text,
	"embedding_backend_id" text,
	"embedding_model" text,
	"image_backend_id" text,
	"image_model" text,
	"speech_backend_id" text,
	"speech_model" text,
	"speech_voice" text,
	"audio_backend_id" text,
	"audio_model" text,
	"audio_transcription_mode" text DEFAULT 'transcriptions' NOT NULL,
	"vision_backend_id" text,
	"vision_model" text,
	"classifier_backend_id" text,
	"classifier_model" text,
	"background_backend_id" text,
	"background_model" text,
	"browser_backend_id" text,
	"browser_model" text,
	"maintenance_mode_enabled" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"daily_jobs_run_time" text DEFAULT '04:00' NOT NULL,
	"browser_download_limit_gb" integer DEFAULT 10 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("settings"."id" = 'singleton')
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"assistant_id" text NOT NULL,
	"chat_ref" text,
	"thread_id" bigint,
	"created_by_user_ref" text,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"instruction" text NOT NULL,
	"context" text,
	"trigger" text NOT NULL,
	"target_user_refs" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"every_minutes" integer,
	"delay_minutes" integer,
	"time_of_day" text,
	"weekdays" integer[],
	"run_date" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"recent_deliveries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_trigger_check" CHECK ("tasks"."trigger" in ('message', 'on-reply', 'interval', 'timeout', 'schedule')),
	CONSTRAINT "tasks_source_check" CHECK ("tasks"."source" in ('chat', 'dashboard')),
	CONSTRAINT "tasks_scope_check" CHECK ("tasks"."chat_ref" is not null or "tasks"."trigger" in ('message', 'on-reply')),
	CONSTRAINT "tasks_targets_scope_check" CHECK ("tasks"."chat_ref" is not null or cardinality("tasks"."target_user_refs") = 0)
);
--> statement-breakpoint
CREATE TABLE "user_memories" (
	"user_ref" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_link_members" ADD CONSTRAINT "person_link_members_link_id_person_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."person_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_chat_backend_id_backends_id_fk" FOREIGN KEY ("chat_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_embedding_backend_id_backends_id_fk" FOREIGN KEY ("embedding_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_image_backend_id_backends_id_fk" FOREIGN KEY ("image_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_speech_backend_id_backends_id_fk" FOREIGN KEY ("speech_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_audio_backend_id_backends_id_fk" FOREIGN KEY ("audio_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_vision_backend_id_backends_id_fk" FOREIGN KEY ("vision_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_classifier_backend_id_backends_id_fk" FOREIGN KEY ("classifier_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_background_backend_id_backends_id_fk" FOREIGN KEY ("background_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_browser_backend_id_backends_id_fk" FOREIGN KEY ("browser_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addressing_exclusions_normalized_idx" ON "addressing_exclusions" USING btree ("normalized");--> statement-breakpoint
CREATE INDEX "assistants_name_idx" ON "assistants" USING btree ("name");--> statement-breakpoint
CREATE INDEX "backends_name_idx" ON "backends" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_summary_days_chat_date_idx" ON "chat_summary_days" USING btree ("chat_ref","summary_date");--> statement-breakpoint
CREATE UNIQUE INDEX "comm_prefs_user_version_idx" ON "communication_preferences" USING btree ("user_ref","version");--> statement-breakpoint
CREATE INDEX "memory_entries_scope_user_idx" ON "memory_entries" USING btree ("scope","user_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_days_chat_date_idx" ON "memory_extraction_days" USING btree ("chat_ref","extraction_date");--> statement-breakpoint
CREATE UNIQUE INDEX "person_link_members_ref_idx" ON "person_link_members" USING btree ("user_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "self_corrections_version_idx" ON "self_corrections" USING btree ("version");--> statement-breakpoint
CREATE INDEX "tasks_chat_idx" ON "tasks" USING btree ("chat_ref","enabled");--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "user_memories_embedding_idx" ON "user_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
-- Hand-written: FTS expression index drizzle-kit cannot express (carried
-- over from the v1 chain) — the full-text half of memory search.
CREATE INDEX "user_memories_content_fts_idx" ON "user_memories" USING gin (to_tsvector('simple', "content"));
