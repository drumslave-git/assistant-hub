CREATE TABLE "self_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"correction" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users_communication_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"model" text NOT NULL,
	"likes" text NOT NULL,
	"dislikes" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users_feedbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"reaction" text NOT NULL,
	"feedback" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"menu_message_id" bigint,
	"model" text NOT NULL,
	"prefs_version" integer,
	"corrections_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "self_improvement_run_time" text DEFAULT '04:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "users_communication_preferences" ADD CONSTRAINT "users_communication_preferences_user_id_known_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."known_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users_feedbacks" ADD CONSTRAINT "users_feedbacks_user_id_known_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."known_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "self_corrections_version_idx" ON "self_corrections" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "users_comm_prefs_user_version_idx" ON "users_communication_preferences" USING btree ("user_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "users_feedbacks_msg_user_idx" ON "users_feedbacks" USING btree ("chat_id","telegram_message_id","user_id");--> statement-breakpoint
CREATE INDEX "users_feedbacks_status_idx" ON "users_feedbacks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_feedbacks_prefs_idx" ON "users_feedbacks" USING btree ("user_id","prefs_version");