CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text,
	"thread_id" bigint,
	"created_by_user_id" text,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"instruction" text NOT NULL,
	"context" text,
	"trigger" text NOT NULL,
	"target_user_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
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
	CONSTRAINT "tasks_scope_check" CHECK ("tasks"."chat_id" is not null or "tasks"."trigger" in ('message', 'on-reply')),
	CONSTRAINT "tasks_targets_scope_check" CHECK ("tasks"."chat_id" is not null or cardinality("tasks"."target_user_ids") = 0)
);
--> statement-breakpoint
CREATE INDEX "tasks_chat_idx" ON "tasks" USING btree ("chat_id","enabled");--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("enabled","next_run_at");