CREATE TABLE "known_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "known_users_username_idx" ON "known_users" USING btree ("username");