CREATE TABLE "addressing_exclusions" (
	"id" text PRIMARY KEY NOT NULL,
	"term" text NOT NULL,
	"normalized" text NOT NULL,
	"bot_display_name" text NOT NULL,
	"chat_id" text,
	"telegram_message_id" bigint,
	"user_id" text,
	"feedback_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users_feedbacks" ADD COLUMN "topic" text DEFAULT 'quality' NOT NULL;--> statement-breakpoint
ALTER TABLE "addressing_exclusions" ADD CONSTRAINT "addressing_exclusions_user_id_known_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."known_users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addressing_exclusions" ADD CONSTRAINT "addressing_exclusions_feedback_id_users_feedbacks_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."users_feedbacks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addressing_exclusions_normalized_idx" ON "addressing_exclusions" USING btree ("normalized");--> statement-breakpoint
ALTER TABLE "users_feedbacks" ADD CONSTRAINT "users_feedbacks_topic_check" CHECK ("users_feedbacks"."topic" in ('quality', 'addressing'));