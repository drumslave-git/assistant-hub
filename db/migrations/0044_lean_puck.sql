CREATE TABLE "chat_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text,
	"text" text NOT NULL,
	"trigger" text DEFAULT 'on-reply' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_rules_trigger_check" CHECK ("chat_rules"."trigger" in ('on-reply', 'always')),
	CONSTRAINT "chat_rules_source_check" CHECK ("chat_rules"."source" in ('chat', 'dashboard'))
);
--> statement-breakpoint
CREATE INDEX "chat_rules_chat_idx" ON "chat_rules" USING btree ("chat_id","enabled");