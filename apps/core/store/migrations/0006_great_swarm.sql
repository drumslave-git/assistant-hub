CREATE TABLE "web_media" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"described_at" timestamp with time zone,
	CONSTRAINT "web_media_status_check" CHECK ("web_media"."status" in ('pending', 'described', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE "web_media_blobs" (
	"media_id" text NOT NULL,
	"frame_index" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "web_media_blobs_media_id_frame_index_pk" PRIMARY KEY("media_id","frame_index")
);
--> statement-breakpoint
CREATE TABLE "web_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"reply_to_message_id" bigint,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_messages_role_check" CHECK ("web_messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "web_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"name" text NOT NULL,
	"title_provisional" boolean DEFAULT false NOT NULL,
	"notes" text,
	"language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_operator" boolean DEFAULT false NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_media" ADD CONSTRAINT "web_media_message_id_web_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."web_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_media_blobs" ADD CONSTRAINT "web_media_blobs_media_id_web_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."web_media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_messages" ADD CONSTRAINT "web_messages_thread_id_web_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."web_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_threads" ADD CONSTRAINT "web_threads_user_id_web_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."web_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "web_media_message_idx" ON "web_media" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "web_media_status_idx" ON "web_media" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "web_messages_thread_sent_idx" ON "web_messages" USING btree ("thread_id","sent_at");--> statement-breakpoint
CREATE INDEX "web_threads_user_idx" ON "web_threads" USING btree ("user_id");--> statement-breakpoint
DELETE FROM "tool_connections" WHERE "slug" = 'chat' AND "managed" = true;
