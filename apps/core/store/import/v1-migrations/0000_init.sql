CREATE TABLE "trace_events" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"usage" jsonb
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" text PRIMARY KEY NOT NULL,
	"feature" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_actor" text,
	"correlation_id" text,
	"input_summary" text,
	"output_summary" text,
	"error" jsonb,
	"related_ids" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trace_events_trace_seq_idx" ON "trace_events" USING btree ("trace_id","seq");--> statement-breakpoint
CREATE INDEX "traces_feature_started_idx" ON "traces" USING btree ("feature","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "traces_correlation_idx" ON "traces" USING btree ("correlation_id");