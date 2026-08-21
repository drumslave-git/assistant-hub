ALTER TABLE "settings" ADD COLUMN "owner_username" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "maintenance_mode_enabled" boolean DEFAULT false NOT NULL;