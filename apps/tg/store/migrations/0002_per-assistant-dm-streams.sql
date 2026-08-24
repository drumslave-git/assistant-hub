ALTER TABLE "media" DROP CONSTRAINT "media_message_fk";
--> statement-breakpoint
ALTER TABLE "message_search" DROP CONSTRAINT "message_search_message_fk";
--> statement-breakpoint
DROP INDEX "messages_chat_msg_idx";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "assistant_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_group_msg_idx" ON "messages" USING btree ("chat_id","telegram_message_id") WHERE "messages"."chat_id" like '-%';--> statement-breakpoint
CREATE UNIQUE INDEX "messages_dm_msg_idx" ON "messages" USING btree ("chat_id","assistant_id","telegram_message_id") WHERE "messages"."chat_id" not like '-%';