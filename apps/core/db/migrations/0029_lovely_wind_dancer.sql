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
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_hour_insights_chat_hour_idx" ON "chat_hour_insights" USING btree ("chat_id","insight_hour");--> statement-breakpoint
CREATE UNIQUE INDEX "period_insights_key_idx" ON "period_insights" USING btree ("granularity","bucket","chat_id");