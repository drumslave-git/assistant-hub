CREATE TABLE "scheduled_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"thread_id" bigint,
	"created_by_user_id" text,
	"instruction" text NOT NULL,
	"schedule_kind" text NOT NULL,
	"time_of_day" text NOT NULL,
	"weekdays" integer[],
	"run_date" text,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"recent_deliveries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
CREATE INDEX "scheduled_tasks_chat_idx" ON "scheduled_tasks" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_due_idx" ON "scheduled_tasks" USING btree ("enabled","next_run_at");