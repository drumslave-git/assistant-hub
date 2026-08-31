CREATE TABLE "browser_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text,
	"thread_id" bigint,
	"created_by_user_id" text,
	"is_owner" boolean DEFAULT false NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"report" text,
	"error" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"activity" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"downloads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "browser_agent_runs_status_check" CHECK ("browser_agent_runs"."status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "browser_run_screenshots" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"url" text,
	"title" text,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_run_screenshots_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "chat_hour_insights" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_hour_insights_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_id" text NOT NULL,
	"insight_hour" text NOT NULL,
	"mood_score" integer NOT NULL,
	"mood_label" text NOT NULL,
	"mood_summary" text NOT NULL,
	"top_topic" text NOT NULL,
	"word" text,
	"message_count" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "period_insights" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "period_insights_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"granularity" text NOT NULL,
	"bucket" text NOT NULL,
	"chat_id" text NOT NULL,
	"word_of_period" text NOT NULL,
	"top_topic" text NOT NULL,
	"mood_score" integer NOT NULL,
	"mood_label" text NOT NULL,
	"source_units" integer NOT NULL,
	"message_count" integer NOT NULL,
	"model" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "period_insights_granularity_check" CHECK ("period_insights"."granularity" in ('hour', 'day', 'week', 'month', 'year', 'all'))
);
--> statement-breakpoint
CREATE TABLE "search_engine_stats" (
	"engine" text PRIMARY KEY NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_run_screenshots" ADD CONSTRAINT "browser_run_screenshots_run_id_browser_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."browser_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_agent_runs_status_idx" ON "browser_agent_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "browser_agent_runs_chat_idx" ON "browser_agent_runs" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_hour_insights_chat_hour_idx" ON "chat_hour_insights" USING btree ("chat_id","insight_hour");--> statement-breakpoint
CREATE UNIQUE INDEX "period_insights_key_idx" ON "period_insights" USING btree ("granularity","bucket","chat_id");