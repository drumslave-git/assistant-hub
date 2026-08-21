CREATE TABLE "llm_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"feature" text NOT NULL,
	"action" text NOT NULL,
	"trigger_actor" text,
	"correlation_id" text,
	"model" text,
	"served_model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"latency_ms" double precision,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"feature" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"trigger_actor" text,
	"correlation_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "llm_usage_feature_started_idx" ON "llm_usage" USING btree ("feature","started_at");--> statement-breakpoint
CREATE INDEX "trace_facts_feature_started_idx" ON "trace_facts" USING btree ("feature","started_at");