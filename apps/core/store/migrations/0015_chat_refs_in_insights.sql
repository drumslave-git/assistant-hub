ALTER TABLE "chat_hour_insights" RENAME COLUMN "chat_id" TO "chat_ref";--> statement-breakpoint
ALTER TABLE "period_insights" RENAME COLUMN "chat_id" TO "chat_ref";--> statement-breakpoint
UPDATE "chat_hour_insights" SET "chat_ref" = 'tg:chat:' || "chat_ref" WHERE "chat_ref" NOT LIKE '%:chat:%';--> statement-breakpoint
UPDATE "period_insights" SET "chat_ref" = 'tg:chat:' || "chat_ref" WHERE "chat_ref" NOT LIKE '%:chat:%';--> statement-breakpoint
ALTER TABLE "browser_agent_runs" RENAME COLUMN "chat_id" TO "chat_ref";--> statement-breakpoint
ALTER TABLE "browser_agent_runs" RENAME COLUMN "created_by_user_id" TO "created_by_user_ref";--> statement-breakpoint
UPDATE "browser_agent_runs" SET "chat_ref" = 'tg:chat:' || "chat_ref" WHERE "chat_ref" IS NOT NULL AND "chat_ref" NOT LIKE '%:chat:%';--> statement-breakpoint
UPDATE "browser_agent_runs" SET "created_by_user_ref" = 'tg:user:' || "created_by_user_ref" WHERE "created_by_user_ref" IS NOT NULL AND "created_by_user_ref" NOT LIKE '%:user:%';--> statement-breakpoint
ALTER TABLE "addressing_exclusions" ALTER COLUMN "source_message_id" SET DATA TYPE text;
