ALTER TABLE "messages" ADD COLUMN "reply_to_message_id" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "language" text;