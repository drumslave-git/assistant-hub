CREATE TABLE "message_media" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"file_id" text NOT NULL,
	"file_unique_id" text,
	"mime_type" text,
	"data_base64" text,
	"vision_hint" text,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"described_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "message_media_chat_msg_idx" ON "message_media" USING btree ("chat_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "message_media_status_idx" ON "message_media" USING btree ("status","created_at");