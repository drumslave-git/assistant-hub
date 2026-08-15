ALTER TABLE "chat_messages" ADD COLUMN "bot_reaction" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "bot_reacted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "chat_messages" m SET "bot_reaction" = r."emoji", "bot_reacted_at" = r."reacted_at" FROM "bot_reactions" r WHERE r."chat_id" = m."chat_id" AND r."telegram_message_id" = m."telegram_message_id";--> statement-breakpoint
DROP TABLE "bot_reactions" CASCADE;
