CREATE TABLE "browser_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text,
	"thread_id" bigint,
	"created_by_user_id" text,
	"is_owner" boolean DEFAULT false NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"report" text,
	"error" text,
	"steps" integer DEFAULT 0 NOT NULL,
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
ALTER TABLE "settings" ADD COLUMN "browser_download_max_mb" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_run_screenshots" ADD CONSTRAINT "browser_run_screenshots_run_id_browser_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."browser_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_agent_runs_status_idx" ON "browser_agent_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "browser_agent_runs_chat_idx" ON "browser_agent_runs" USING btree ("chat_id");