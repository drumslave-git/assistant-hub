CREATE TABLE "personalities" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "active_personality_id" text;--> statement-breakpoint
CREATE INDEX "personalities_name_idx" ON "personalities" USING btree ("name");--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_active_personality_id_personalities_id_fk" FOREIGN KEY ("active_personality_id") REFERENCES "public"."personalities"("id") ON DELETE set null ON UPDATE no action;