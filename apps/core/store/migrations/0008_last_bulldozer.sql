CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"session_secret" text NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_role_check" CHECK ("accounts"."role" in ('admin', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_username_unique" ON "accounts" USING btree (lower("username"));--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "operator_password_hash";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "session_secret";